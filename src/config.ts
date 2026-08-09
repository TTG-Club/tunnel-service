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
    /** Значение claim `tier` в тикете. Тарифов у subscriber нет, это константа. */
    readonly tier: string;
  };
  readonly auth: {
    /** JWKS auth-сервиса. Задан — проверяем по ключу, он приоритетнее секрета. */
    readonly jwksUrl: string | null;
    /** Общий с остальными сервисами JWT_SECRET: HMAC по сырым байтам UTF-8. */
    readonly secret: string | null;
    readonly jwksCacheSeconds: number;
    /** Допуск на расхождение часов при проверке `exp`, секунды. */
    readonly clockToleranceSeconds: number;
  };
  readonly subscriber: {
    readonly baseUrl: string;
    /** Путь статуса с плейсхолдером `{username}`. */
    readonly statusPath: string;
    /** Значение заголовка `X-Service-Token` для internal-ручки. */
    readonly serviceToken: string;
    readonly timeoutMs: number;
    readonly cacheTtlSeconds: number;
    readonly staleMaxSeconds: number;
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
  TICKET_TIER: z.string().min(1).default('pro'),

  AUTH_JWKS_URL: z.url().optional(),
  // Тот же JWT_SECRET, что у остальных сервисов. auth-service требует от него
  // 32 байта (HS256), поэтому и мы: короче — значит, это не он.
  AUTH_JWT_SECRET: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') >= 32,
      'должен быть не короче 32 байт — столько требует HS256 и сам auth-сервис',
    )
    .optional(),
  AUTH_JWKS_CACHE_SECONDS: envInt(3600, 60, 86_400),
  AUTH_CLOCK_TOLERANCE_SECONDS: envInt(30, 0, 300),

  SUBSCRIBER_BASE_URL: z.url(),
  SUBSCRIBER_STATUS_PATH: z
    .string()
    .startsWith('/')
    .includes('{username}', { message: 'должен содержать плейсхолдер {username}' })
    .default('/api/internal/subscriptions/{username}/status'),
  INTERNAL_SERVICE_SECRET: z
    .string()
    .min(1, 'обязателен: без него internal-ручка подписок отвечает 401'),
  SUBSCRIBER_TIMEOUT_MS: envInt(3000, 100, 30_000),
  SUBSCRIPTION_CACHE_TTL_SECONDS: envInt(180, 30, 900),
  SUBSCRIPTION_STALE_MAX_SECONDS: envInt(86_400, 60, 30 * 86_400),

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
 * `AUTH_JWKS_URL=` роняло бы старт вместо переключения на общий секрет.
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

  // Режима «декодируем токен без проверки подписи» больше нет ни в каком виде,
  // ни в каком NODE_ENV. Проверять подпись нечем — сервис не стартует.
  if (!raw.AUTH_JWKS_URL && !raw.AUTH_JWT_SECRET) {
    problems.push(
      'AUTH_JWT_SECRET: обязателен. Это общий JWT_SECRET auth-сервиса, которым ' +
        'проверяется подпись токена пользователя. Альтернатива — AUTH_JWKS_URL, ' +
        'когда auth переедет на асимметричную подпись. Без одного из двух проверить ' +
        'токен нечем, и тикет получил бы кто угодно.',
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
      tier: raw.TICKET_TIER,
    },
    auth: {
      jwksUrl: raw.AUTH_JWKS_URL ?? null,
      secret: raw.AUTH_JWT_SECRET ?? null,
      jwksCacheSeconds: raw.AUTH_JWKS_CACHE_SECONDS,
      clockToleranceSeconds: raw.AUTH_CLOCK_TOLERANCE_SECONDS,
    },
    subscriber: {
      baseUrl: raw.SUBSCRIBER_BASE_URL.replace(/\/+$/, ''),
      statusPath: raw.SUBSCRIBER_STATUS_PATH,
      serviceToken: raw.INTERNAL_SERVICE_SECRET,
      timeoutMs: raw.SUBSCRIBER_TIMEOUT_MS,
      cacheTtlSeconds: raw.SUBSCRIPTION_CACHE_TTL_SECONDS,
      staleMaxSeconds: raw.SUBSCRIPTION_STALE_MAX_SECONDS,
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
