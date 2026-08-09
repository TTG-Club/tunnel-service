import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../logger.js';

export interface AuthenticatedUser {
  /** account_id: claim `sub` токена. UUID — в базе это тип uuid. */
  readonly accountId: string;
  /** claim `username`: единственное имя в токене и ключ в subscriber.api. */
  readonly username: string;
  readonly tokenExpiresAt: Date | null;
}

export type AuthMode = 'jwks' | 'shared-secret';

export interface UserTokenVerifier {
  readonly mode: AuthMode;
  verify(token: string): Promise<AuthenticatedUser>;
}

/**
 * UUID любой версии. Проверяем формат до похода в базу: иначе `sub` вида
 * `'; drop ...` дошёл бы до параметра типа uuid и обернулся 500-й вместо
 * внятной 401.
 */
export const ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Алгоритмы подписи — явным списком, отдельно на каждый режим.
 *
 * Без списка библиотека верит заголовку токена, и это классическая дыра: токен
 * с `alg: none` проходит без подписи, а токен с `alg: HS256` в режиме JWKS
 * проверяется публичным ключом как HMAC-секретом — ключ-то публичный, подпись
 * подделает кто угодно. Поэтому в режиме общего секрета принимается ровно
 * HS256, в режиме JWKS — только асимметричные.
 */
const SHARED_SECRET_ALGORITHMS = ['HS256'] as const;
const JWKS_ALGORITHMS = ['RS256', 'RS512', 'ES256', 'EdDSA'] as const;

/** Ошибки jose, означающие «не смогли добраться до ключей», а не «токен плохой». */
const JWKS_TRANSPORT_ERRORS = new Set([
  'ERR_JWKS_TIMEOUT',
  'ERR_JWKS_INVALID',
  'ERR_JOSE_GENERIC',
]);

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

/**
 * `sub` — UUID и ничего кроме. Угадывать нельзя: в старых токенах auth-сервиса
 * там лежал логин, и попытка «разобраться» превратила бы чужой логин в
 * account_id.
 */
function extractAccountId(payload: JWTPayload): string {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !ACCOUNT_ID_RE.test(sub)) {
    throw ApiError.unauthorized(
      'В токене нет идентификатора аккаунта в формате UUID (claim sub) — такой токен нам не подходит',
    );
  }
  // Приводим к нижнему регистру: Postgres нормализует uuid сам, а нам нужен
  // один и тот же ключ лимитов для одного аккаунта.
  return sub.toLowerCase();
}

/**
 * Имя в токене ровно одно — claim `username`. Никаких `name`,
 * `preferred_username` и прочего перебора: их auth-сервис не выдаёт, а молчаливый
 * фолбэк означал бы поход в subscriber.api не за тем пользователем.
 */
function extractUsername(payload: JWTPayload): string {
  const username = payload['username'];
  if (typeof username !== 'string' || username.trim() === '') {
    throw ApiError.unauthorized(
      'В токене нет claim username — по нему проверяется подписка, без него доступ выдать нельзя',
    );
  }
  return username.trim();
}

function toUser(payload: JWTPayload): AuthenticatedUser {
  return {
    accountId: extractAccountId(payload),
    username: extractUsername(payload),
    tokenExpiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null,
  };
}

/**
 * Проверка токена пользователя.
 *
 * Основной режим (`AUTH_JWT_SECRET`): auth-сервис подписывает токены общим
 * симметричным секретом (HS256), публичных ключей у него нет и не планируется.
 * Тот же секрет роздан остальным сервисам, каждый проверяет подпись локально.
 *
 * Режим JWKS (`AUTH_JWKS_URL`) оставлен рабочим на случай переезда auth на
 * асимметричную подпись: тогда переключение — одна переменная окружения, а не
 * правка кода. Заданы обе — выигрывает JWKS.
 *
 * Режима «декодировать без проверки подписи» не существует: без одной из двух
 * переменных сервис не стартует (проверка в loadConfig).
 */
export function createUserTokenVerifier(config: AppConfig, logger: Logger): UserTokenVerifier {
  const clockTolerance = config.auth.clockToleranceSeconds;

  // `exp` обязателен явно: сам по себе jose проверяет только то, что есть в
  // токене, и токен без `exp` считался бы вечным.
  const commonOptions = { clockTolerance, requiredClaims: ['exp'] };

  // `iss`, `aud`, `nbf`, `jti` не проверяются и не требуются: auth-сервис их
  // не выдаёт.

  if (config.auth.jwksUrl !== null) {
    if (config.auth.secret !== null) {
      logger.warn(
        'заданы и AUTH_JWKS_URL, и AUTH_JWT_SECRET — работаю по JWKS, секрет не используется',
        { jwksUrl: config.auth.jwksUrl },
      );
    }

    const jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), {
      cacheMaxAge: config.auth.jwksCacheSeconds * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });

    return {
      mode: 'jwks',
      async verify(token) {
        let payload: JWTPayload;
        try {
          ({ payload } = await jwtVerify(token, jwks, {
            ...commonOptions,
            algorithms: [...JWKS_ALGORITHMS],
          }));
        } catch (error) {
          const code = errorCode(error);
          if (code && JWKS_TRANSPORT_ERRORS.has(code)) {
            logger.error('не удалось получить JWKS auth-сервиса', { error, code });
            throw ApiError.authUnavailable(
              'Сервис авторизации временно недоступен, не можем проверить токен',
            );
          }

          logger.debug('токен пользователя отклонён', { code });
          throw ApiError.unauthorized('Токен недействителен');
        }

        return toUser(payload);
      },
    };
  }

  // Секрет уходит в ключ ровно так же, как его читает auth-сервис:
  // Keys.hmacShaKeyFor(secret.getBytes(UTF_8)) — сырые байты строки, без base64.
  const key = new TextEncoder().encode(config.auth.secret as string);

  return {
    mode: 'shared-secret',
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          ...commonOptions,
          algorithms: [...SHARED_SECRET_ALGORITHMS],
        }));
      } catch (error) {
        logger.debug('токен пользователя отклонён', { code: errorCode(error) });
        throw ApiError.unauthorized('Токен недействителен');
      }

      return toUser(payload);
    },
  };
}
