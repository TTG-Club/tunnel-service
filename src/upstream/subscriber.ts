import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../logger.js';

export interface SubscriptionStatus {
  /** Единственный признак доступа. Всё остальное — справочное. */
  readonly active: boolean;
  /**
   * «Когда-либо имел подписку», включая истёкшую и неактивированную.
   * На доступ НЕ влияет: у отозванного пользователя он остаётся true.
   */
  readonly registered: boolean;
  readonly expiresAt: string | null;
  readonly startsAt: string | null;
  /** `GIFT` | `BUY` — способ появления подписки, не тариф. В доступе не участвует. */
  readonly type: string | null;
}

/** Откуда взят ответ: свежий запрос, свежий кэш или протухший кэш. */
export type SubscriptionSource = 'fresh' | 'cache' | 'stale';

export interface SubscriptionResult {
  readonly status: SubscriptionStatus;
  readonly source: SubscriptionSource;
  readonly fetchedAt: Date;
}

/** Сервис подписок недоступен и подстраховаться нечем. */
export class SubscriptionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SubscriptionUnavailableError';
  }
}

/** Сервис подписок ответил «не пущу» на наш запрос — это не сбой, а отказ. */
export class SubscriberRejectedError extends Error {
  constructor(readonly httpStatus: number) {
    super(`subscriber.api отклонил запрос: HTTP ${httpStatus}`);
    this.name = 'SubscriberRejectedError';
  }
}

/** Кого спрашиваем: ключ в subscriber.api — username, account_id нужен логам. */
export interface SubscriptionSubject {
  readonly accountId: string;
  readonly username: string;
}

export interface SubscriptionService {
  get(subject: SubscriptionSubject): Promise<SubscriptionResult>;
  readonly cacheSize: number;
}

/**
 * Формат дат у subscriber не зафиксирован конфигом — работает умолчание Spring
 * (ISO-8601), но включённый однажды `WRITE_DATES_AS_TIMESTAMPS` превратил бы их
 * в числа. Поэтому разбираем защищённо и на непонятном значении отдаём null:
 * даты у нас справочные, ронять из-за них выдачу тикета нельзя.
 */
function toIsoOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Jackson с таймстампами отдаёт секунды (возможно, дробные), с отключёнными
    // наносекундами — миллисекунды. Различаем по порядку величины: 1e11 секунд —
    // это 5138 год, 1e11 миллисекунд — 1973-й.
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}

/**
 * Строго обязателен только `active` — именно он решает вопрос доступа, и
 * подставлять вместо него умолчание нельзя. Остальные поля справочные, поэтому
 * их тип не проверяется: неожиданное значение станет null, а не отказом в тикете.
 */
const responseSchema = z.object({
  active: z.boolean(),
  registered: z.boolean().optional(),
  expiresAt: z.unknown().optional(),
  startsAt: z.unknown().optional(),
  type: z.unknown().optional(),
});

const MAX_CACHE_ENTRIES = 10_000;

/** Коды, за которыми стоит «сервису сейчас плохо», а не «наш запрос неправильный». */
const TRANSIENT_STATUSES = new Set([408, 429]);

interface CacheEntry {
  readonly status: SubscriptionStatus;
  readonly fetchedAt: number;
}

export interface SubscriptionServiceDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Подменяется в тестах. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * username идёт в path, а auth-сервис не ограничивает его ничем, кроме длины:
 * там законно окажется пробел, кириллица, слэш или решётка. Всё это закрывает
 * encodeURIComponent.
 *
 * Кроме ровно двух имён — `.` и `..`: их нормализатор URL схлопывает как
 * сегменты пути ещё до отправки, и запрос ушёл бы молча на соседний эндпоинт.
 * Кодированием от этого не спастись, `%2E%2E` схлопывается точно так же, —
 * поэтому такое имя отклоняется. Выдать его auth-сервис не может (он требует от
 * имени минимум три символа), но полагаться в построении URL на чужую
 * валидацию не стоит.
 */
function encodeUsername(username: string): string {
  if (username === '.' || username === '..') {
    throw ApiError.unauthorized(
      'Имя пользователя в токене нельзя использовать как адрес — статус подписки по нему не проверить',
    );
  }
  return encodeURIComponent(username);
}

/**
 * Статус подписки с кэшем в памяти.
 *
 * Ходим в service-to-service ручку с заголовком `X-Service-Token`: ключ там —
 * username из токена, а не account_id, и токен пользователя ей не нужен.
 *
 * Правила ровно те, что в задании:
 *   есть свежий кэш                -> отдаём его, в сеть не идём;
 *   кэш протух и сервис недоступен -> отдаём протухший и пишем warning;
 *   кэша нет и сервис недоступен   -> отказ с внятной ошибкой.
 *
 * Смысл: падение биллинга не должно мешать людям играть, но выдавать туннели
 * вслепую нельзя. Поэтому «протухший» ограничен по возрасту
 * (SUBSCRIPTION_STALE_MAX_SECONDS), а явный отказ сервиса подписок под это
 * послабление не подпадает.
 */
export function createSubscriptionService(deps: SubscriptionServiceDeps): SubscriptionService {
  const { logger } = deps;
  const settings = deps.config.subscriber;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const ttlMs = settings.cacheTtlSeconds * 1000;
  const staleMaxMs = settings.staleMaxSeconds * 1000;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<SubscriptionStatus>>();

  function statusUrl(username: string): string {
    return `${settings.baseUrl}${settings.statusPath.replace('{username}', encodeUsername(username))}`;
  }

  function remember(username: string, status: SubscriptionStatus): void {
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(username)) {
      // Map хранит порядок вставки — выкидываем самую старую запись.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(username, { status, fetchedAt: now() });
  }

  async function request(username: string): Promise<SubscriptionStatus> {
    // Собирается до try: непригодное имя — это отказ, а не «сервис не ответил».
    const url = statusUrl(username);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'x-service-token': settings.serviceToken,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (error) {
      throw new SubscriptionUnavailableError('subscriber.api не ответил', { cause: error });
    }

    // 404 здесь НЕ значит «нет такого пользователя»: неизвестному ручка отвечает
    // 200 с active:false. Значит, мы попали не на тот URL — почти наверняка
    // сломался username в path. Прикрывать это протухшим кэшем нельзя: свою
    // ошибку надо видеть, а не заметать.
    if (response.status === 404) {
      logger.error(
        'subscriber.api ответил 404 на internal-ручку — неверный URL, а не отсутствие подписки',
        { url, username },
      );
      throw new SubscriberRejectedError(response.status);
    }

    // Прочие 4xx — тоже про наш запрос (не тот секрет, не тот путь), а не про
    // «сервис лежит». Исключение — перегрузка и таймаут: это как раз авария.
    if (response.status >= 400 && response.status < 500 && !TRANSIENT_STATUSES.has(response.status)) {
      throw new SubscriberRejectedError(response.status);
    }

    if (!response.ok) {
      throw new SubscriptionUnavailableError(`subscriber.api ответил HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SubscriptionUnavailableError('subscriber.api вернул не JSON', { cause: error });
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SubscriptionUnavailableError(
        `непонятный ответ subscriber.api: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }

    return {
      active: parsed.data.active,
      registered: parsed.data.registered ?? false,
      expiresAt: toIsoOrNull(parsed.data.expiresAt),
      startsAt: toIsoOrNull(parsed.data.startsAt),
      type: typeof parsed.data.type === 'string' ? parsed.data.type : null,
    };
  }

  /** Один запрос на пользователя: пачка параллельных вызовов не размножает нагрузку. */
  function fetchOnce(username: string): Promise<SubscriptionStatus> {
    const running = inflight.get(username);
    if (running) return running;

    const promise = request(username).finally(() => inflight.delete(username));
    inflight.set(username, promise);
    return promise;
  }

  return {
    get cacheSize() {
      return cache.size;
    },

    async get(subject) {
      const { accountId, username } = subject;
      const startedAt = now();
      const cached = cache.get(username);

      if (cached && startedAt - cached.fetchedAt < ttlMs) {
        return { status: cached.status, source: 'cache', fetchedAt: new Date(cached.fetchedAt) };
      }

      try {
        const status = await fetchOnce(username);

        // Отзыв подписки виден только опросом: событий и вебхуков у subscriber
        // нет. Раз уж свежий ответ говорит «неактивна» — фиксируем это отдельной
        // записью, дальше решение принимается по одному полю active.
        if (!status.active && cached?.status.active === true) {
          logger.warn('подписка стала неактивной', {
            accountId,
            username,
            expiresAt: status.expiresAt,
            // Сколько человек ходил с активной подпиской по кэшу до того, как
            // мы узнали об отзыве: верхняя оценка задержки, см. README.
            cachedActiveForSeconds: Math.round((startedAt - cached.fetchedAt) / 1000),
          });
        }

        remember(username, status);
        return { status, source: 'fresh', fetchedAt: new Date(now()) };
      } catch (error) {
        // Отказ сервиса и непригодное имя — не «сервис лежит»: прикрываться
        // кэшем здесь нельзя.
        if (error instanceof SubscriberRejectedError || error instanceof ApiError) throw error;

        if (cached && startedAt - cached.fetchedAt <= staleMaxMs) {
          logger.warn('subscriber.api недоступен, использую протухший кэш подписки', {
            accountId,
            username,
            ageSeconds: Math.round((startedAt - cached.fetchedAt) / 1000),
            error,
          });
          return { status: cached.status, source: 'stale', fetchedAt: new Date(cached.fetchedAt) };
        }

        logger.error('subscriber.api недоступен и кэша нет — отказываю в тикете', {
          accountId,
          username,
          error,
        });
        throw error instanceof SubscriptionUnavailableError
          ? error
          : new SubscriptionUnavailableError('не удалось получить статус подписки', { cause: error });
      }
    },
  };
}
