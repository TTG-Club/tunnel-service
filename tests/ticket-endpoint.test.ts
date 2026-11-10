import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { toNodeListener } from 'h3';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYTES_IN_GB, TIERS, type TierLimits } from '../src/domain/limits.js';
import type { HeartbeatInput, NodeRow } from '../src/domain/nodes/repository.js';
import type { SlugRow } from '../src/domain/slug/repository.js';
import { createTicketKeyring } from '../src/domain/ticket/keys.js';
import { verifyTicket } from '../src/domain/ticket/issue.js';
import { createAbuseWatcher } from '../src/domain/usage/abuse.js';
import { createHttpApp } from '../src/http/app.js';
import { createRateLimiter } from '../src/http/rate-limit.js';
import type { AppServices } from '../src/services.js';
import { createUserTokenVerifier } from '../src/upstream/auth.js';
import type { SubscriptionResult } from '../src/upstream/subscriber.js';
import { AUTH_SECRET, capturingLogger, makeConfig, type CapturedLogger } from './helpers.js';

const ACCOUNT_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';
const USERNAME = 'magistrus';
const PRO = TIERS['pro'] as TierLimits;

const NODE: NodeRow = {
  id: 'eu-1',
  hostname: 'eu-1.play.ttg.club',
  region: 'eu',
  addresses: ['203.0.113.10', '2001:db8::10'],
  status: 'active',
  lastSeenAt: new Date(),
  tunnels: 0,
  streams: 0,
};

/** Что сервис записал из heartbeat нод — для проверки разбора адресов. */
const heartbeats: HeartbeatInput[] = [];

function accountRow(accountId: string, slug: string): SlugRow {
  return { slug, accountId, kind: 'account', parentSlug: null, worldId: null, createdAt: new Date() };
}

function worldRow(accountId: string, slug: string, worldId: string): SlugRow {
  return { slug, accountId, kind: 'world', parentSlug: 'ivan', worldId, createdAt: new Date() };
}

const activeSubscription: SubscriptionResult = {
  status: {
    active: true,
    registered: true,
    expiresAt: '2027-01-01T00:00:00.000Z',
    startsAt: '2026-01-01T00:00:00.000Z',
    type: 'GIFT',
  },
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
  readonly subscriptionFor: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

interface HarnessOptions {
  subscription?: SubscriptionResult;
  usedBytes?: bigint;
  nodes?: NodeRow[];
  env?: Record<string, string>;
  /** Ронять запись выдачи тикета — так ведёт себя недостающая таблица. */
  grantWriteFails?: boolean;
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
  const subscriptionFor = vi.fn(async () => options.subscription ?? activeSubscription);
  /** Кому и на какую ноду выдавался тикет: ключ `accountId:nodeId`. */
  const grants = new Set<string>();

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
      upsertHeartbeat: async (input: HeartbeatInput) => {
        heartbeats.push(input);
        return { ...NODE, ...input, id: input.nodeId, lastSeenAt: new Date() };
      },
    },
    usage: {
      getAccountUsage: async () => {
        const total = options.usedBytes ?? 0n;
        return { bytesIn: total, bytesOut: 0n, total };
      },
      applyNodeUsage: async () => ({ applied: 0, accounts: 0, regressions: 0, deltas: [] }),
      // Выдачи запоминаются в памяти: по ним проверяется, вправе ли нода
      // присылать расход по этому аккаунту.
      rememberTicketGrant: async (accountId: string, nodeId: string) => {
        if (options.grantWriteFails) {
          throw new Error('relation "ticket_grants" does not exist');
        }

        grants.add(`${accountId}:${nodeId}`);
      },
      filterGrantedAccounts: async (nodeId: string, accountIds: readonly string[]) =>
        new Set(accountIds.filter((accountId) => grants.has(`${accountId}:${nodeId}`))),
    },
    subscription: {
      get: subscriptionFor as unknown as AppServices['subscription']['get'],
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
    subscriptionFor,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Настоящий токен auth-сервиса: HS256 на общем секрете, sub — UUID, имя в username. */
async function userToken(sub: string = ACCOUNT_ID, username: string = USERNAME): Promise<string> {
  return new SignJWT({ username, email: 'user@example.com', roles: ['USER', 'VTTG'] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(AUTH_SECRET));
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
    expect(body['node']).toMatchObject({
      id: 'eu-1', hostname: 'eu-1.play.ttg.club', addresses: ['203.0.113.10', '2001:db8::10'],
    });
    expect(body['account']).toEqual({ slug: 'ivan', host: 'ivan.play.ttg.club' });
    // Тариф — константа из конфига: subscriber о тарифах ничего не сообщает.
    expect(body['tier']).toBe('pro');
    expect(body['subscription']).toMatchObject({ active: true, type: 'GIFT' });
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

  it('подписка спрашивается по username из токена, а не по account_id', async () => {
    harness = await startApp();
    await requestTicket(harness, await userToken(ACCOUNT_ID, 'Иван Петров'));

    expect(harness.subscriptionFor).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, username: 'Иван Петров' }),
    );
  });

  // Главное требование: без подписки сервисом воспользоваться нельзя.
  // `registered: true` здесь принципиален — «когда-либо имел подписку» доступа
  // не даёт, гейт строго по active.
  it('свежий active:false — отказ, и слаг НЕ заводится', async () => {
    harness = await startApp({
      subscription: {
        status: {
          active: false,
          registered: true,
          expiresAt: '2027-01-01T00:00:00.000Z',
          startsAt: '2026-01-01T00:00:00.000Z',
          type: 'GIFT',
        },
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

  it('не-UUID в sub отвергается', async () => {
    harness = await startApp();

    const { status, body } = await requestTicket(harness, await userToken('magistrus'));

    expect(status).toBe(401);
    expect((body['error'] as Record<string, unknown>)['message']).toContain('UUID');
  });

  it('токен, подписанный чужим секретом, отвергается', async () => {
    harness = await startApp();

    const foreign = await new SignJWT({ username: USERNAME })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ACCOUNT_ID)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('совершенно-другой-секрет-длиной-в-32+'));

    expect((await requestTicket(harness, foreign)).status).toBe(401);
    expect(harness.ensureAccountSlug).not.toHaveBeenCalled();
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

  it('тикет выдаётся, даже если запись выдачи не прошла', async () => {
    // Ровно то, что случилось на боевом стенде: миграция `ticket_grants` не
    // накаталась, запись падала — и вместе с ней падала ВСЯ выдача тикетов.
    // Туннель переставал работать у всех подписчиков при исправном сервисе.
    //
    // Бухгалтерия не вправе отменять услугу: потерянная запись лишь приведёт к
    // тому, что расход по этому аккаунту не засчитается.
    harness = await startApp({ grantWriteFails: true });

    const response = await requestTicket(harness, await userToken());

    expect(response.status).toBe(200);
    expect(response.body['ticket']).toBeTypeOf('string');
  });

  it('лимит по IP срабатывает раньше проверки токена', async () => {
    harness = await startApp({ env: { TICKET_RATE_LIMIT_PER_IP: '1' } });

    expect((await requestTicket(harness, await userToken(randomUUID()))).status).toBe(200);

    // Другой аккаунт, тот же адрес — лимит общий.
    const second = await requestTicket(harness, await userToken(randomUUID()));
    expect(second.status).toBe(429);
  });
});

describe('POST /api/internal/nodes/heartbeat', () => {
  async function heartbeat(target: Harness, body: Record<string, unknown>): Promise<number> {
    const response = await fetch(`${target.base}/api/internal/nodes/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(48)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  }

  it('сохраняет публичные IP ноды: без дублей и в нижнем регистре', async () => {
    harness = await startApp();
    heartbeats.length = 0;

    const status = await heartbeat(harness, {
      nodeId: 'ru-1', hostname: 'ru-1.play.ttg.club',
      addresses: ['195.208.122.150', '2A02:408:7722:54::150', '195.208.122.150'],
    });

    expect(status).toBe(200);
    expect(heartbeats.at(-1)?.addresses).toEqual(['195.208.122.150', '2a02:408:7722:54::150']);
  });

  it('старая нода без поля addresses получает пустой список', async () => {
    harness = await startApp();
    heartbeats.length = 0;

    expect(await heartbeat(harness, { nodeId: 'ru-1', hostname: 'ru-1.play.ttg.club' })).toBe(200);
    expect(heartbeats.at(-1)?.addresses).toEqual([]);
  });

  it('отвергает адрес, который не является IP', async () => {
    harness = await startApp();

    expect(await heartbeat(harness, {
      nodeId: 'ru-1', hostname: 'ru-1.play.ttg.club', addresses: ['ru-1.play.ttg.club'],
    })).toBe(400);
  });
});
