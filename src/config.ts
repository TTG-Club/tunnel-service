import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TicketAlg = 'EdDSA' | 'ES256';

export interface AppConfig {
  readonly env: NodeEnv;
  readonly http: { readonly host: string; readonly port: number; readonly trustProxy: boolean };
  readonly logLevel: LogLevel;
  readonly shutdownTimeoutMs: number;
  readonly db: { readonly url: string; readonly poolMax: number; readonly ssl: boolean };
  readonly publicDomain: string;
  readonly ticket: {
    readonly alg: TicketAlg;
    readonly ttlSeconds: number;
    readonly issuer: string;
    readonly audience: string;
    readonly privateKeyCurrent: string;
    readonly privateKeyPrevious: string | null;
  };
  readonly auth: {
    /** null — dev-режим: подпись токена пользователя не проверяется. */
    readonly jwksUrl: string | null;
    readonly issuer: string | null;
    readonly audience: string | null;
    readonly jwksCacheSeconds: number;
    readonly nameClaims: readonly string[];
  };
  readonly subscriber: {
    readonly baseUrl: string;
    readonly statusPath: string;
    readonly timeoutMs: number;
    readonly cacheTtlSeconds: number;
    readonly staleMaxSeconds: number;
    readonly defaultTier: string;
  };
  readonly nodes: {
    readonly sharedSecret: string;
    readonly heartbeatTimeoutSeconds: number;
  };
  readonly slug: {
    readonly stoplistPath: string;
    /** Соль для суффиксов слагов миров. Менять нельзя, см. README. */
    readonly salt: string;
  };
  readonly rateLimit: {
    readonly ticketPerAccount: number;
    readonly ticketPerIp: number;
    readonly windowSeconds: number;
  };
  readonly quota: {
    /** С какого процента расхода писать warning. */
    readonly warnPercent: number;
    /** Прирост за сутки, после которого расход помечается подозрительным. */
    readonly spikeGbPerDay: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Некорректная конфигурация окружения:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const TRUE_VALUES = ['true', '1', 'yes', 'on'];

const envBool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .optional()
    .transform((value) => (value === undefined ? defaultValue : TRUE_VALUES.includes(value)));

const envInt = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: envInt(3000, 1, 65535),
  // За Dokploy/Traefik реальный адрес клиента приходит в X-Forwarded-For.
  // Если сервис когда-нибудь будет смотреть в интернет напрямую — выключить,
  // иначе заголовок можно подделать и обойти лимит по IP.
  TRUST_PROXY: envBool(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SHUTDOWN_TIMEOUT_MS: envInt(15_000, 0, 300_000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: envInt(10, 1, 200),
  DATABASE_SSL: envBool(false),

  PUBLIC_DOMAIN: z
    .string()
    .min(3)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'должен быть доменом в нижнем регистре, например play.ttg.club'),

  TICKET_ALG: z.enum(['EdDSA', 'ES256']).default('EdDSA'),
  TICKET_TTL_SECONDS: envInt(900, 60, 3600),
  TICKET_ISSUER: z.string().min(1).default('tunnel.ttg.club'),
  TICKET_AUDIENCE: z.string().min(1).default('ttg-tunnel-node'),
  TICKET_PRIVATE_KEY_CURRENT: z.string().min(1, 'приватный ключ подписи тикетов обязателен (npm run keygen)'),
  TICKET_PRIVATE_KEY_PREVIOUS: z.string().min(1).optional(),

  AUTH_JWKS_URL: z.url().optional(),
  AUTH_JWT_ISSUER: z.string().min(1).optional(),
  AUTH_JWT_AUDIENCE: z.string().min(1).optional(),
  AUTH_JWKS_CACHE_SECONDS: envInt(3600, 60, 86_400),
  AUTH_NAME_CLAIMS: z
    .string()
    .default('name,username,preferred_username,nickname,login')
    .transform((value) => value.split(',').map((c) => c.trim()).filter(Boolean)),

  SUBSCRIBER_BASE_URL: z.url(),
  SUBSCRIBER_STATUS_PATH: z.string().startsWith('/').default('/api/subscriptions/status'),
  SUBSCRIBER_TIMEOUT_MS: envInt(3000, 100, 30_000),
  SUBSCRIPTION_CACHE_TTL_SECONDS: envInt(180, 30, 900),
  SUBSCRIPTION_STALE_MAX_SECONDS: envInt(86_400, 60, 30 * 86_400),
  SUBSCRIPTION_DEFAULT_TIER: z.string().min(1).default('pro'),

  NODE_SHARED_SECRET: z.string().min(32, 'должен быть не короче 32 символов (npm run gen:secret)'),
  NODE_HEARTBEAT_TIMEOUT_SECONDS: envInt(90, 10, 3600),

  SLUG_STOPLIST_PATH: z.string().min(1).default('data/stoplist.txt'),
  SLUG_SALT: z
    .string()
    .min(16, 'должна быть не короче 16 символов (npm run gen:salt). Менять её нельзя — см. README'),

  TICKET_RATE_LIMIT_PER_ACCOUNT: envInt(20, 1, 10_000),
  TICKET_RATE_LIMIT_PER_IP: envInt(60, 1, 100_000),
  TICKET_RATE_LIMIT_WINDOW_SECONDS: envInt(60, 1, 3600),

  QUOTA_WARN_PERCENT: envInt(80, 1, 100),
  QUOTA_SPIKE_GB_PER_DAY: envInt(100, 1, 1_000_000),
});

/**
 * Пустая строка в окружении — это «не задано», а не «задано пустым».
 * Dokploy и docker-compose легко подсовывают пустые значения, и без этого
 * `AUTH_JWKS_URL=` роняло бы старт вместо включения dev-режима.
 */
function dropEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') result[key] = value.trim();
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(dropEmpty(env));

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(корень)';
      return issue.code === 'invalid_type' && issue.message.toLowerCase().includes('undefined')
        ? `${path}: переменная не задана`
        : `${path}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  const raw = parsed.data;
  const problems: string[] = [];

  // Главная защита от «однажды уедет в прод и будет выдавать туннели кому
  // угодно»: без JWKS auth-сервиса production просто не стартует.
  if (raw.NODE_ENV === 'production' && !raw.AUTH_JWKS_URL) {
    problems.push(
      'AUTH_JWKS_URL: при NODE_ENV=production обязателен. Без него подпись токена ' +
        'пользователя не проверяется, и тикет сможет получить кто угодно.',
    );
  }

  if (raw.SUBSCRIPTION_STALE_MAX_SECONDS < raw.SUBSCRIPTION_CACHE_TTL_SECONDS) {
    problems.push(
      'SUBSCRIPTION_STALE_MAX_SECONDS: должен быть не меньше SUBSCRIPTION_CACHE_TTL_SECONDS',
    );
  }

  if (
    raw.TICKET_PRIVATE_KEY_PREVIOUS !== undefined &&
    raw.TICKET_PRIVATE_KEY_PREVIOUS === raw.TICKET_PRIVATE_KEY_CURRENT
  ) {
    problems.push('TICKET_PRIVATE_KEY_PREVIOUS: совпадает с текущим ключом — ротация не начата');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: raw.NODE_ENV,
    http: { host: raw.HTTP_HOST, port: raw.HTTP_PORT, trustProxy: raw.TRUST_PROXY },
    logLevel: raw.LOG_LEVEL,
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    db: { url: raw.DATABASE_URL, poolMax: raw.DATABASE_POOL_MAX, ssl: raw.DATABASE_SSL },
    publicDomain: raw.PUBLIC_DOMAIN,
    ticket: {
      alg: raw.TICKET_ALG,
      ttlSeconds: raw.TICKET_TTL_SECONDS,
      issuer: raw.TICKET_ISSUER,
      audience: raw.TICKET_AUDIENCE,
      privateKeyCurrent: raw.TICKET_PRIVATE_KEY_CURRENT,
      privateKeyPrevious: raw.TICKET_PRIVATE_KEY_PREVIOUS ?? null,
    },
    auth: {
      jwksUrl: raw.AUTH_JWKS_URL ?? null,
      issuer: raw.AUTH_JWT_ISSUER ?? null,
      audience: raw.AUTH_JWT_AUDIENCE ?? null,
      jwksCacheSeconds: raw.AUTH_JWKS_CACHE_SECONDS,
      nameClaims: raw.AUTH_NAME_CLAIMS,
    },
    subscriber: {
      baseUrl: raw.SUBSCRIBER_BASE_URL.replace(/\/+$/, ''),
      statusPath: raw.SUBSCRIBER_STATUS_PATH,
      timeoutMs: raw.SUBSCRIBER_TIMEOUT_MS,
      cacheTtlSeconds: raw.SUBSCRIPTION_CACHE_TTL_SECONDS,
      staleMaxSeconds: raw.SUBSCRIPTION_STALE_MAX_SECONDS,
      defaultTier: raw.SUBSCRIPTION_DEFAULT_TIER,
    },
    nodes: {
      sharedSecret: raw.NODE_SHARED_SECRET,
      heartbeatTimeoutSeconds: raw.NODE_HEARTBEAT_TIMEOUT_SECONDS,
    },
    slug: { stoplistPath: raw.SLUG_STOPLIST_PATH, salt: raw.SLUG_SALT },
    rateLimit: {
      ticketPerAccount: raw.TICKET_RATE_LIMIT_PER_ACCOUNT,
      ticketPerIp: raw.TICKET_RATE_LIMIT_PER_IP,
      windowSeconds: raw.TICKET_RATE_LIMIT_WINDOW_SECONDS,
    },
    quota: {
      warnPercent: raw.QUOTA_WARN_PERCENT,
      spikeGbPerDay: raw.QUOTA_SPIKE_GB_PER_DAY,
    },
  };
}

/** Проверка JWT пользователя выключена (нет AUTH_JWKS_URL). */
export function isAuthDevMode(config: AppConfig): boolean {
  return config.auth.jwksUrl === null;
}
