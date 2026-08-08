import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BYTES_IN_GB, TIERS, quotaLeftGb, resolveTier, type TierLimits } from '../src/domain/limits.js';
import {
  SubscriberRejectedError,
  SubscriptionUnavailableError,
  createSubscriptionService,
} from '../src/upstream/subscriber.js';
import { capturingLogger, makeConfig, type CapturedLogger } from './helpers.js';

const TTL_SECONDS = 180;
const STALE_MAX_SECONDS = 3600;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACTIVE = { active: true, registered: true, expiresAt: '2027-01-01T00:00:00.000Z' };

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

  it('ходит в сервис подписок с токеном пользователя', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    const result = await service.get('1', 'user-access-token');

    expect(result.source).toBe('fresh');
    expect(result.status.active).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://subscriber.api.ttg.club/api/subscriptions/status');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer user-access-token');
  });

  // Ситуация 1 из таблицы: есть свежий кэш — используем его.
  it('свежий кэш отдаётся без запроса к сервису', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get('1', 'token');
    clock += (TTL_SECONDS - 1) * 1000;
    const second = await service.get('1', 'token');

    expect(second.source).toBe('cache');
    expect(second.status.active).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('после протухания идёт за свежим ответом', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get('1', 'token');
    clock += (TTL_SECONDS + 1) * 1000;
    const second = await service.get('1', 'token');

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

    await service.get('1', 'token');
    clock += (TTL_SECONDS + 60) * 1000;
    const stale = await service.get('1', 'token');

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

    await service.get('1', 'token');
    clock += (TTL_SECONDS + 60) * 1000;

    expect((await service.get('1', 'token')).source).toBe('stale');
  });

  // Ситуация 3: кэша нет, сервис недоступен — отказ.
  it('без кэша и без сервиса — внятный отказ', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      build(fetchImpl as unknown as typeof fetch).get('1', 'token'),
    ).rejects.toBeInstanceOf(SubscriptionUnavailableError);
  });

  it('слишком старый кэш уже не спасает', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get('1', 'token');
    clock += (STALE_MAX_SECONDS + 1) * 1000;

    await expect(service.get('1', 'token')).rejects.toBeInstanceOf(SubscriptionUnavailableError);
  });

  it('отказ сервиса подписок не прикрывается кэшем', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    const service = build(fetchImpl as unknown as typeof fetch);

    await service.get('1', 'token');
    clock += (TTL_SECONDS + 1) * 1000;

    // 403 — это «нам ответили нет», а не «сервис лежит»: подстраховываться
    // протухшим кэшем здесь нельзя.
    await expect(service.get('1', 'token')).rejects.toBeInstanceOf(SubscriberRejectedError);
  });

  it('неизвестный сервису аккаунт — это определённый ответ, а не сбой', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    const result = await build(fetchImpl as unknown as typeof fetch).get('1', 'token');

    expect(result.status).toEqual({ active: false, registered: false, expiresAt: null, tier: null });
  });

  it('пачка параллельных запросов даёт один поход в сервис', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACTIVE));
    const service = build(fetchImpl as unknown as typeof fetch);

    const results = await Promise.all([
      service.get('1', 'token'),
      service.get('1', 'token'),
      service.get('1', 'token'),
    ]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(results.every((result) => result.status.active)).toBe(true);
  });

  it('кэш раздельный по аккаунтам', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(ACTIVE))
      .mockResolvedValueOnce(jsonResponse({ active: false, registered: true }));

    const service = build(fetchImpl as unknown as typeof fetch);

    expect((await service.get('1', 'token')).status.active).toBe(true);
    expect((await service.get('2', 'token')).status.active).toBe(false);
    expect(service.cacheSize).toBe(2);
  });

  it('непонятный ответ считается сбоем сервиса, а не активной подпиской', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));

    await expect(
      build(fetchImpl as unknown as typeof fetch).get('1', 'token'),
    ).rejects.toBeInstanceOf(SubscriptionUnavailableError);
  });
});

describe('тариф', () => {
  it('отсутствующий tier заменяется значением по умолчанию', () => {
    const logger = capturingLogger();
    expect(resolveTier(null, 'pro', logger).name).toBe('pro');
    expect(resolveTier(undefined, 'pro', logger).limits.maxWorlds).toBe(5);
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(0);
  });

  it('известный tier применяется как есть', () => {
    const tier = resolveTier('pro', 'pro', capturingLogger());

    expect(tier.name).toBe('pro');
    // Цифры беты: 5 миров, 1000 потоков, 10 ТБ в месяц.
    expect(tier.limits).toEqual({ maxWorlds: 5, maxStreams: 1000, quotaGb: 10_240 });
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

  it('незнакомый tier не ломает выдачу, но попадает в лог', () => {
    const logger = capturingLogger();
    const tier = resolveTier('platinum', 'pro', logger);

    expect(tier.name).toBe('pro');
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
  });
});
