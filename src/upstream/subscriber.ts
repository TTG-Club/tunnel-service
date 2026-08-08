import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface SubscriptionStatus {
  readonly active: boolean;
  readonly registered: boolean;
  readonly expiresAt: string | null;
  /** Поля `tier` в ответе пока нет — тогда null, тариф берётся по умолчанию. */
  readonly tier: string | null;
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

export interface SubscriptionService {
  get(accountId: string, accessToken: string): Promise<SubscriptionResult>;
  readonly cacheSize: number;
}

const responseSchema = z.object({
  active: z.boolean(),
  registered: z.boolean().optional(),
  expiresAt: z.string().nullish(),
  tier: z.string().nullish(),
});

const MAX_CACHE_ENTRIES = 10_000;

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
 * Статус подписки с кэшем в памяти.
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
  const url = `${settings.baseUrl}${settings.statusPath}`;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<SubscriptionStatus>>();

  function remember(accountId: string, status: SubscriptionStatus): void {
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(accountId)) {
      // Map хранит порядок вставки — выкидываем самую старую запись.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(accountId, { status, fetchedAt: now() });
  }

  async function request(accessToken: string): Promise<SubscriptionStatus> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (error) {
      throw new SubscriptionUnavailableError('subscriber.api не ответил', { cause: error });
    }

    if (response.status === 404) {
      // Аккаунт сервису подписок неизвестен — это определённый ответ.
      return { active: false, registered: false, expiresAt: null, tier: null };
    }

    if (response.status === 401 || response.status === 403) {
      // Наш запрос отклонён. Прикрываться протухшим кэшем здесь нельзя:
      // это не «сервис лежит», а «нам ответили нет».
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
      registered: parsed.data.registered ?? parsed.data.active,
      expiresAt: parsed.data.expiresAt ?? null,
      tier: parsed.data.tier ?? null,
    };
  }

  /** Один запрос на аккаунт: пачка параллельных вызовов не размножает нагрузку. */
  function fetchOnce(accountId: string, accessToken: string): Promise<SubscriptionStatus> {
    const running = inflight.get(accountId);
    if (running) return running;

    const promise = request(accessToken).finally(() => inflight.delete(accountId));
    inflight.set(accountId, promise);
    return promise;
  }

  return {
    get cacheSize() {
      return cache.size;
    },

    async get(accountId, accessToken) {
      const startedAt = now();
      const cached = cache.get(accountId);

      if (cached && startedAt - cached.fetchedAt < ttlMs) {
        return { status: cached.status, source: 'cache', fetchedAt: new Date(cached.fetchedAt) };
      }

      try {
        const status = await fetchOnce(accountId, accessToken);
        remember(accountId, status);
        return { status, source: 'fresh', fetchedAt: new Date(now()) };
      } catch (error) {
        if (error instanceof SubscriberRejectedError) throw error;

        if (cached && startedAt - cached.fetchedAt <= staleMaxMs) {
          logger.warn('subscriber.api недоступен, использую протухший кэш подписки', {
            accountId,
            ageSeconds: Math.round((startedAt - cached.fetchedAt) / 1000),
            error,
          });
          return { status: cached.status, source: 'stale', fetchedAt: new Date(cached.fetchedAt) };
        }

        logger.error('subscriber.api недоступен и кэша нет — отказываю в тикете', { accountId, error });
        throw error instanceof SubscriptionUnavailableError
          ? error
          : new SubscriptionUnavailableError('не удалось получить статус подписки', { cause: error });
      }
    },
  };
}
