import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { toNodeListener } from 'h3';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYTES_IN_GB, TIERS, type TierLimits } from '../src/domain/limits.js';
import type { NodeRow } from '../src/domain/nodes/repository.js';
import type { SlugRow } from '../src/domain/slug/repository.js';
import { createTicketKeyring } from '../src/domain/ticket/keys.js';
import { verifyTicket } from '../src/domain/ticket/issue.js';
import { createAbuseWatcher } from '../src/domain/usage/abuse.js';
import { createHttpApp } from '../src/http/app.js';
import { createRateLimiter } from '../src/http/rate-limit.js';
import type { AppServices } from '../src/services.js';
import { createUserTokenVerifier } from '../src/upstream/auth.js';
import type { SubscriptionResult } from '../src/upstream/subscriber.js';
import { capturingLogger, makeConfig, type CapturedLogger } from './helpers.js';

const ACCOUNT_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';
const PRO = TIERS['pro'] as TierLimits;

const NODE: NodeRow = {
  id: 'eu-1',
  hostname: 'eu-1.play.ttg.club',
  region: 'eu',
  status: 'active',
  lastSeenAt: new Date(),
  tunnels: 0,
  streams: 0,
};

function accountRow(accountId: string, slug: string): SlugRow {
  return { slug, accountId, kind: 'account', parentSlug: null, worldId: null, createdAt: new Date() };
}

function worldRow(accountId: string, slug: string, worldId: string): SlugRow {
  return { slug, accountId, kind: 'world', parentSlug: 'ivan', worldId, createdAt: new Date() };
}

const activeSubscription: SubscriptionResult = {
  status: { active: true, registered: true, expiresAt: '2027-01-01T00:00:00.000Z', tier: null },
  source: 'fresh',
  fetchedAt: new Date(),
};

interface Harness {
  readonly base: string;
  readonly config: AppServices['config'];
  readonly keyring: AppServices['keyring'];
  readonly logger: CapturedLogger;
  readonly ensureAccountSlug: ReturnType<typeof vi.fn>;
  readonly ensureWorldSlug: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

interface HarnessOptions {
  subscription?: SubscriptionResult;
  usedBytes?: bigint;
  nodes?: NodeRow[];
  env?: Record<string, string>;
}

/**
 * Поднимает настоящее HTTP-приложение с подставными зависимостями: база,
 * подписка и слаги — фейковые, тикет подписывается настоящим ключом.
 */
async function startApp(options: HarnessOptions = {}): Promise<Harness> {
  const config = makeConfig({
    // Лимит по IP не мешает: все запросы в тесте идут с 127.0.0.1.
    TICKET_RATE_LIMIT_PER_IP: '1000',
    TICKET_RATE_LIMIT_PER_ACCOUNT: '1000',
    ...options.env,
  });
  const logger = capturingLogger();

  const ensureAccountSlug = vi.fn(async (accountId: string) => accountRow(accountId, 'ivan'));
  const ensureWorldSlug = vi.fn(async (accountId: string, _parent: string, worldId: string) =>
    worldRow(accountId, `ivan-${worldId.replace(/[^a-z0-9]/g, '').slice(0, 6)}`, worldId),
  );

  const services: AppServices = {
    config,
    logger,
    version: 'test',
    pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as AppServices['pool'],
    keyring: await createTicketKeyring(config),
    slugs: { ensureAccountSlug, ensureWorldSlug } as unknown as AppServices['slugs'],
    slugRepository: {
      findAccountSlug: async () => null,
      findWorldSlug: async () => null,
      listWorldSlugs: async () => [],
      insertAccountSlug: async () => ({ ok: false, reason: 'slug_taken' }),
      insertWorldSlug: async () => ({ ok: false, reason: 'slug_taken' }),
    },
    nodes: {
      listHealthy: async () => options.nodes ?? [NODE],
      get: async () => NODE,
      upsertHeartbeat: async () => NODE,
    },
    usage: {
      getAccountUsage: async () => {
        const total = options.usedBytes ?? 0n;
        return { bytesIn: total, bytesOut: 0n, total };
      },
      applyNodeUsage: async () => ({ applied: 0, accounts: 0, regressions: 0, deltas: [] }),
    },
    subscription: {
      get: async () => options.subscription ?? activeSubscription,
      cacheSize: 0,
    },
    auth: createUserTokenVerifier(config, logger),
    rateLimit: {
      byAccount: createRateLimiter({
        limit: config.rateLimit.ticketPerAccount,
        windowSeconds: config.rateLimit.windowSeconds,
      }),
      byIp: createRateLimiter({
        limit: config.rateLimit.ticketPerIp,
        windowSeconds: config.rateLimit.windowSeconds,
      }),
    },
    abuse: createAbuseWatcher({ thresholdBytes: 100n * BYTES_IN_GB }),
    lifecycle: { shuttingDown: false },
  };

  const server: Server = createServer(toNodeListener(createHttpApp(services)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    config,
    keyring: services.keyring,
    logger,
    ensureAccountSlug,
    ensureWorldSlug,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Токен как у auth-сервиса: подпись в dev-режиме не проверяется. */
async function userToken(sub: string = ACCOUNT_ID): Promise<string> {
  return new SignJWT({ name: 'Иван Петров' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(randomBytes(32));
}

async function requestTicket(
  harness: Harness,
  token: string,
  worlds: { worldId: string; port: number }[] = [],
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${harness.base}/api/tunnel/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ worlds }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('POST /api/tunnel/ticket', () => {
  it('выдаёт тикет, ноду и раскладку хостов', async () => {
    harness = await startApp();
    const { status, body } = await requestTicket(harness, await userToken(), [
      { worldId: 'world-abc', port: 30_000 },
    ]);

    expect(status).toBe(200);
    expect(body['node']).toMatchObject({ id: 'eu-1', hostname: 'eu-1.play.ttg.club' });
    expect(body['account']).toEqual({ slug: 'ivan', host: 'ivan.play.ttg.club' });
    expect(body['tier']).toBe('pro');
    expect(body['limits']).toMatchObject({ maxWorlds: 5, maxStreams: 1000, quotaGb: 10_240 });
    expect(body['hosts']).toEqual([
      { kind: 'account', slug: 'ivan', host: 'ivan.play.ttg.club' },
      {
        kind: 'world',
        slug: 'ivan-worlda',
        host: 'ivan-worlda.play.ttg.club',
        worldId: 'world-abc',
        port: 30_000,
      },
    ]);

    // Тикет должен проверяться ключом сервиса — ровно то, что сделает нода.
    const payload = await verifyTicket(
      harness.keyring,
      { issuer: harness.config.ticket.issuer, audience: harness.config.ticket.audience },
      body['ticket'] as string,
    );

    expect(payload.sub).toBe(ACCOUNT_ID);
    expect(payload.hosts).toEqual(['ivan', 'ivan-worlda']);
    expect(payload.node).toBe('eu-1');
    expect(payload.limits).toEqual({
      max_streams: 1000,
      max_worlds: 5,
      quota_left_gb: PRO.quotaGb,
    });
  });

  // Главное требование: без подписки сервисом воспользоваться нельзя.
  it('без подписки отказывает и НЕ заводит слаг', async () => {
    harness = await startApp({
      subscription: {
        status: { active: false, registered: true, expiresAt: null, tier: null },
        source: 'fresh',
        fetchedAt: new Date(),
      },
    });

    const { status, body } = await requestTicket(harness, await userToken(), [
      { worldId: 'world-abc', port: 30_000 },
    ]);

    expect(status).toBe(403);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('subscription_inactive');
    expect(harness.ensureAccountSlug).not.toHaveBeenCalled();
    expect(harness.ensureWorldSlug).not.toHaveBeenCalled();
  });

  it('при исчерпанной квоте отказывает и не заводит слаг', async () => {
    harness = await startApp({ usedBytes: BigInt(PRO.quotaGb) * BYTES_IN_GB });

    const { status, body } = await requestTicket(harness, await userToken());

    expect(status).toBe(403);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('quota_exceeded');
    expect(harness.ensureAccountSlug).not.toHaveBeenCalled();
  });

  it('приближение к квоте попадает в лог как подозрительное', async () => {
    const used = (BigInt(PRO.quotaGb) * BYTES_IN_GB * 90n) / 100n;
    harness = await startApp({ usedBytes: used });

    await requestTicket(harness, await userToken());

    const warning = harness.logger.records.find((record) => record.msg.includes('приблизился к квоте'));
    expect(warning?.level).toBe('warn');
    expect(warning?.fields['accountId']).toBe(ACCOUNT_ID);
    expect(warning?.fields['suspicious']).toBe(true);
  });

  it('миров больше, чем допускает тариф — отказ до выдачи слага', async () => {
    harness = await startApp();
    const worlds = Array.from({ length: PRO.maxWorlds + 1 }, (_value, index) => ({
      worldId: `world-${index}`,
      port: 30_000 + index,
    }));

    const { status, body } = await requestTicket(harness, await userToken(), worlds);

    expect(status).toBe(403);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('worlds_limit_exceeded');
    expect(harness.ensureWorldSlug).not.toHaveBeenCalled();
  });

  it('без живых нод отказывает внятным кодом', async () => {
    harness = await startApp({ nodes: [] });

    const { status, body } = await requestTicket(harness, await userToken());

    expect(status).toBe(503);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('no_nodes_available');
  });

  it('нечисловой sub больше не нужен, а не-UUID отвергается', async () => {
    harness = await startApp();

    const { status, body } = await requestTicket(harness, await userToken('12345'));

    expect(status).toBe(401);
    expect((body['error'] as Record<string, unknown>)['message']).toContain('UUID');
  });

  it('лимит по аккаунту отдаёт 429 с Retry-After', async () => {
    harness = await startApp({ env: { TICKET_RATE_LIMIT_PER_ACCOUNT: '2' } });
    const token = await userToken();

    expect((await requestTicket(harness, token)).status).toBe(200);
    expect((await requestTicket(harness, token)).status).toBe(200);

    const third = await requestTicket(harness, token);
    expect(third.status).toBe(429);
    expect((third.body['error'] as Record<string, unknown>)['code']).toBe('rate_limited');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('лимит по IP срабатывает раньше проверки токена', async () => {
    harness = await startApp({ env: { TICKET_RATE_LIMIT_PER_IP: '1' } });

    expect((await requestTicket(harness, await userToken(randomUUID()))).status).toBe(200);

    // Другой аккаунт, тот же адрес — лимит общий.
    const second = await requestTicket(harness, await userToken(randomUUID()));
    expect(second.status).toBe(429);
  });
});
