import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BYTES_IN_GB, TIERS, quotaLeftGb, ticketTier, type TierLimits } from '../src/domain/limits.js';
import { ApiError } from '../src/http/errors.js';
import {
  SubscriberRejectedError,
  SubscriptionUnavailableError,
  createSubscriptionService,
} from '../src/upstream/subscriber.js';
import { capturingLogger, makeConfig, type CapturedLogger } from './helpers.js';

const TTL_SECONDS = 180;
const STALE_MAX_SECONDS = 3600;

const SERVICE_TOKEN = 'internal-service-secret-for-tests';
const STATUS_URL = 'https://subscriber.api.ttg.club/api/internal/subscriptions/magistrus/status';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ боевой ручки: ровно пять полей. */
const ACTIVE = {
  active: true,
  registered: true,
  expiresAt: '2026-11-09T18:23:41.512Z',
  startsAt: '2026-08-09T18:23:41.512Z',
  type: 'GIFT',
};

const USER = { accountId: '550e8400-e29b-41d4-a716-446655440000', username: 'magistrus' };

describe('кэш подписки', () => {
  let clock: number;
  let logger: CapturedLogger;

  const config = makeConfig({
    SUBSCRIPTION_CACHE_TTL_SECONDS: String(TTL_SECONDS),
    SUBSCRIPTION_STALE_MAX_SECONDS: String(STALE_MAX_SECONDS),
  });

  const build = (fetchImpl: typeof fetch) =>
    createSubscriptionService({ config, logger, fetchImpl, now: () => clock });

  beforeEach(() => {
    clock = 1_700_000_000_000;
    logger = capturingLogger();
  });

  it('ходит в internal-ручку по username со своим service-токеном', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    const result = await service.get(USER);

    expect(result.source).toBe('fresh');
    expect(result.status.active).toBe(true);
    expect(result.status.type).toBe('GIFT');
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(STATUS_URL);

    const headers = init.headers as Record<string, string>;
    expect(headers['x-service-token']).toBe(SERVICE_TOKEN);
    // Токен пользователя сюда больше не пересылается.
    expect(headers['authorization']).toBeUndefined();
  });

  // Ситуация 1 из таблицы: есть свежий кэш — используем его.
  it('свежий кэш отдаётся без запроса к сервису', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS - 1) * 1000;
    const second = await service.get(USER);

    expect(second.source).toBe('cache');
    expect(second.status.active).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('после протухания идёт за свежим ответом', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS + 1) * 1000;
    const second = await service.get(USER);

    expect(second.source).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Ситуация 2: кэш протух, сервис недоступен — отдаём протухший с warning.
  it('при недоступном сервисе отдаёт протухший кэш и пишет warning', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS + 60) * 1000;
    const stale = await service.get(USER);

    expect(stale.source).toBe('stale');
    expect(stale.status.active).toBe(true);

    const warning = logger.records.find((record) => record.level === 'warn');
    expect(warning?.msg).toContain('протухший кэш');
  });

  it('падение биллинга на 5xx тоже прикрывается кэшем', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS + 60) * 1000;

    expect((await service.get(USER)).source).toBe('stale');
  });

  // Ситуация 3: кэша нет, сервис недоступен — отказ.
  it('без кэша и без сервиса — внятный отказ', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(build(fetchImpl as unknown as typeof fetch).get(USER)).rejects.toBeInstanceOf(
      SubscriptionUnavailableError,
    );
  });

  it('слишком старый кэш уже не спасает', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (STALE_MAX_SECONDS + 1) * 1000;

    await expect(service.get(USER)).rejects.toBeInstanceOf(SubscriptionUnavailableError);
  });

  it('отказ сервиса подписок не прикрывается кэшем', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS + 1) * 1000;

    // 401 — это «нам ответили нет» (не тот X-Service-Token), а не «сервис
    // лежит»: подстраховываться протухшим кэшем здесь нельзя.
    await expect(service.get(USER)).rejects.toBeInstanceOf(SubscriberRejectedError);
  });

  // Ключевое отличие internal-ручки: неизвестный пользователь получает
  // 200 active:false, а 404 означает, что мы попали не на тот URL.
  it('404 — это сломанный запрос, а не отсутствие подписки', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));

    await expect(build(fetchImpl as unknown as typeof fetch).get(USER)).rejects.toBeInstanceOf(
      SubscriberRejectedError,
    );

    const complaint = logger.records.find((record) => record.msg.includes('404'));
    expect(complaint?.level).toBe('error');
  });

  it('неизвестный пользователь — это 200 с active:false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ active: false, registered: false, expiresAt: null, startsAt: null, type: null }),
    );

    const result = await build(fetchImpl as unknown as typeof fetch).get(USER);

    expect(result.source).toBe('fresh');
    expect(result.status).toEqual({
      active: false,
      registered: false,
      expiresAt: null,
      startsAt: null,
      type: null,
    });
  });

  // Отзыв виден только опросом, поэтому фиксируем момент, когда узнали.
  it('переход в неактивную подписку попадает в лог', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValue(jsonResponse({ ...ACTIVE, active: false }));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get(USER);
    clock += (TTL_SECONDS + 1) * 1000;
    const second = await service.get(USER);

    expect(second.status.active).toBe(false);
    expect(logger.records.some((record) => record.msg.includes('стала неактивной'))).toBe(true);
  });

  it('пачка параллельных запросов даёт один поход в сервис', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    const results = await Promise.all([service.get(USER), service.get(USER), service.get(USER)]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(results.every((result) => result.status.active)).toBe(true);
  });

  it('кэш раздельный по пользователям', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValueOnce(jsonResponse({ ...ACTIVE, active: false }));

    const service = build(fetchImpl as unknown as typeof fetch);

    expect((await service.get(USER)).status.active).toBe(true);
    expect((await service.get({ accountId: USER.accountId, username: 'другой' })).status.active).toBe(
      false,
    );
    expect(service.cacheSize).toBe(2);
  });

  it('непонятный ответ считается сбоем сервиса, а не активной подпиской', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));

    await expect(build(fetchImpl as unknown as typeof fetch).get(USER)).rejects.toBeInstanceOf(
      SubscriptionUnavailableError,
    );
  });
});

describe('username в URL', () => {
  const config = makeConfig();

  async function urlFor(username: string): Promise<string> {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ active: true, registered: true, expiresAt: null, startsAt: null, type: null }),
    );

    await createSubscriptionService({
      config,
      logger: capturingLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).get({ accountId: '550e8400-e29b-41d4-a716-446655440000', username });

    return (fetchImpl.mock.calls[0] as unknown as [string])[0];
  }

  it('кириллица кодируется', async () => {
    expect(await urlFor('Иван')).toBe(
      'https://subscriber.api.ttg.club/api/internal/subscriptions/%D0%98%D0%B2%D0%B0%D0%BD/status',
    );
  });

  it('пробелы и спецсимволы кодируются', async () => {
    expect(await urlFor('иван петров#1?x=1&y')).toContain(
      '/subscriptions/%D0%B8%D0%B2%D0%B0%D0%BD%20%D0%BF%D0%B5%D1%82%D1%80%D0%BE%D0%B2%231%3Fx%3D1%26y/status',
    );
  });

  // Слэш в имени разрезал бы path на лишние сегменты.
  it('слэш не ломает путь', async () => {
    expect(await urlFor('a/b')).toBe(
      'https://subscriber.api.ttg.club/api/internal/subscriptions/a%2Fb/status',
    );
  });

  it('точка внутри имени остаётся обычным символом', async () => {
    expect(await urlFor('ivan.petrov')).toBe(
      'https://subscriber.api.ttg.club/api/internal/subscriptions/ivan.petrov/status',
    );
  });

  // Единственный случай, от которого не спасает кодирование: `.` и `..`
  // нормализатор URL схлопывает как сегменты пути (и `%2E%2E` тоже), поэтому
  // такое имя отклоняется, а не отправляется вслепую на соседний эндпоинт.
  it('имя из точек отклоняется, а не уводит запрос на другой эндпоинт', async () => {
    await expect(urlFor('..')).rejects.toBeInstanceOf(ApiError);
    await expect(urlFor('.')).rejects.toBeInstanceOf(ApiError);

    // Три точки — уже обычный сегмент, его схлопывать нечему.
    expect(await urlFor('...')).toBe(
      'https://subscriber.api.ttg.club/api/internal/subscriptions/.../status',
    );
  });

  // Кодированные точки приезжают строкой и сегментом пути не становятся.
  it('%2e%2e в имени безопасно', async () => {
    expect(await urlFor('%2e%2e')).toBe(
      'https://subscriber.api.ttg.club/api/internal/subscriptions/%252e%252e/status',
    );
  });
});

describe('разбор дат из ответа', () => {
  const config = makeConfig();

  async function statusFor(body: Record<string, unknown>) {
    const fetchImpl = vi.fn(async () => jsonResponse(body));

    return (
      await createSubscriptionService({
        config,
        logger: capturingLogger(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).get({ accountId: '550e8400-e29b-41d4-a716-446655440000', username: 'magistrus' })
    ).status;
  }

  const base = { active: true, registered: true };

  it('ISO-8601 — умолчание Spring', async () => {
    const status = await statusFor({ ...base, expiresAt: '2026-11-09T18:23:41.512Z' });
    expect(status.expiresAt).toBe('2026-11-09T18:23:41.512Z');
  });

  it('таймстамп в секундах понимается', async () => {
    const status = await statusFor({ ...base, expiresAt: 1_762_712_621.512 });
    expect(status.expiresAt).toBe('2025-11-09T18:23:41.512Z');
  });

  it('таймстамп в миллисекундах понимается', async () => {
    const status = await statusFor({ ...base, expiresAt: 1_762_712_621_512 });
    expect(status.expiresAt).toBe('2025-11-09T18:23:41.512Z');
  });

  // Даты справочные: непонятное значение не должно отнимать у человека тикет.
  it('мусор вместо даты становится null, а не отказом', async () => {
    const status = await statusFor({ ...base, expiresAt: { year: 2026 }, startsAt: 'вчера' });

    expect(status.active).toBe(true);
    expect(status.expiresAt).toBeNull();
    expect(status.startsAt).toBeNull();
  });

  it('незнакомый type переносится как есть и на доступ не влияет', async () => {
    const status = await statusFor({ ...base, type: 'PROMO' });

    expect(status.active).toBe(true);
    expect(status.type).toBe('PROMO');
  });
});

describe('тариф', () => {
  it('берётся из конфига, а не из ответа subscriber', () => {
    const tier = ticketTier('pro');

    expect(tier.name).toBe('pro');
    // Цифры беты: 5 миров, 1000 потоков, 10 ТБ в месяц.
    expect(tier.limits).toEqual({ maxWorlds: 5, maxStreams: 1000, quotaGb: 10_240 });
  });

  it('незнакомое имя тарифа — ошибка, а не тихий фолбэк', () => {
    expect(() => ticketTier('platinum')).toThrow(/platinum/);
  });

  it('бесплатного тарифа нет: без подписки сервисом не пользуются', () => {
    expect(Object.keys(TIERS)).toEqual(['pro']);
  });

  it('ноль остатка означает ровно «квота исчерпана»', () => {
    const limits = TIERS['pro'] as TierLimits;
    const quota = BigInt(limits.quotaGb) * BYTES_IN_GB;

    expect(quotaLeftGb(limits, 0n)).toBe(limits.quotaGb);
    // Остались последние мегабайты — это ещё не исчерпанная квота.
    expect(quotaLeftGb(limits, quota - 1n)).toBe(1);
    expect(quotaLeftGb(limits, quota)).toBe(0);
    expect(quotaLeftGb(limits, quota * 2n)).toBe(0);
  });
});
