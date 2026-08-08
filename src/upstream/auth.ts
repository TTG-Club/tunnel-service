import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../logger.js';

export interface AuthenticatedUser {
  /** account_id: `sub` токена. Только цифры — в базе это bigint. */
  readonly accountId: string;
  readonly displayName: string | null;
  readonly tokenExpiresAt: Date | null;
}

export type AuthMode = 'jwks' | 'insecure-dev';

export interface UserTokenVerifier {
  readonly mode: AuthMode;
  verify(token: string): Promise<AuthenticatedUser>;
}

const ACCOUNT_ID_RE = /^[0-9]{1,19}$/;

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

function extractAccountId(payload: JWTPayload): string {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !ACCOUNT_ID_RE.test(sub)) {
    throw ApiError.unauthorized(
      'В токене нет числового идентификатора аккаунта (claim sub) — такой токен нам не подходит',
    );
  }
  return sub;
}

function extractDisplayName(payload: JWTPayload, claims: readonly string[]): string | null {
  for (const claim of claims) {
    const value = payload[claim];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function toUser(payload: JWTPayload, claims: readonly string[]): AuthenticatedUser {
  return {
    accountId: extractAccountId(payload),
    displayName: extractDisplayName(payload, claims),
    tokenExpiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null,
  };
}

/**
 * Проверка токена пользователя.
 *
 * Целевой режим (`AUTH_JWKS_URL` задан): забираем JWKS auth-сервиса,
 * кэшируем на час, проверяем подпись локально.
 *
 * Временный режим (`AUTH_JWKS_URL` пуст): у auth-сервиса ещё нет JWKS-
 * эндпоинта, поэтому токен только декодируется. Подпись НЕ проверяется —
 * это дыра, через которую тикет получит кто угодно. Поэтому на каждый запрос
 * пишется warning, а при NODE_ENV=production сервис вообще не стартует
 * (проверка в loadConfig). Включение целевого режима — одна переменная.
 */
export function createUserTokenVerifier(config: AppConfig, logger: Logger): UserTokenVerifier {
  const claims = config.auth.nameClaims;

  if (config.auth.jwksUrl === null) {
    return {
      mode: 'insecure-dev',
      async verify(token) {
        let payload: JWTPayload;
        try {
          payload = decodeJwt(token);
        } catch {
          throw ApiError.unauthorized('Токен не является JWT');
        }

        const now = Math.floor(Date.now() / 1000);
        if (typeof payload.exp === 'number' && payload.exp <= now) {
          throw ApiError.unauthorized('Срок действия токена истёк');
        }
        if (typeof payload.nbf === 'number' && payload.nbf > now) {
          throw ApiError.unauthorized('Токен ещё не действителен');
        }

        const user = toUser(payload, claims);

        logger.warn(
          'ПОДПИСЬ ТОКЕНА ПОЛЬЗОВАТЕЛЯ НЕ ПРОВЕРЯЕТСЯ: AUTH_JWKS_URL не задан. ' +
            'Режим только для разработки, в production сервис не стартует.',
          { accountId: user.accountId, authMode: 'insecure-dev' },
        );

        return user;
      },
    };
  }

  const jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), {
    cacheMaxAge: config.auth.jwksCacheSeconds * 1000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });

  return {
    mode: 'jwks',
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          ...(config.auth.issuer ? { issuer: config.auth.issuer } : {}),
          ...(config.auth.audience ? { audience: config.auth.audience } : {}),
        });
        return toUser(payload, claims);
      } catch (error) {
        if (error instanceof ApiError) throw error;

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
    },
  };
}
