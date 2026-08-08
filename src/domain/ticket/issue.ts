import { randomUUID } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import type { TicketKeyring } from './keys.js';

/** Лимиты в тикете — snake_case: их читает нода, формат зафиксирован. */
export interface TicketLimits {
  readonly max_streams: number;
  readonly max_worlds: number;
  readonly quota_left_gb: number;
}

export interface TicketPayload {
  readonly sub: string;
  readonly slug: string;
  readonly node: string;
  readonly hosts: readonly string[];
  readonly limits: TicketLimits;
  readonly tier: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
  readonly jti: string;
}

export interface TicketOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

export interface IssueTicketInput {
  readonly accountId: string;
  readonly slug: string;
  readonly nodeId: string;
  readonly hosts: readonly string[];
  readonly limits: TicketLimits;
  readonly tier: string;
}

export interface IssuedTicket {
  readonly token: string;
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly kid: string;
}

/**
 * Собирает и подписывает тикет. Нода проверяет подпись локально по JWKS,
 * в control plane за подтверждением не ходит — поэтому всё, что ей нужно,
 * лежит в самом тикете.
 */
export async function issueTicket(
  keyring: TicketKeyring,
  options: TicketOptions,
  input: IssueTicketInput,
): Promise<IssuedTicket> {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAtSeconds + options.ttlSeconds;
  const jti = randomUUID();

  const token = await new SignJWT({
    slug: input.slug,
    node: input.nodeId,
    hosts: [...input.hosts],
    limits: input.limits,
    tier: input.tier,
  })
    .setProtectedHeader({ alg: keyring.alg, kid: keyring.signing.kid, typ: 'JWT' })
    .setSubject(input.accountId)
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setJti(jti)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(keyring.signing.privateKey);

  return {
    token,
    jti,
    kid: keyring.signing.kid,
    issuedAt: new Date(issuedAtSeconds * 1000),
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

/**
 * Проверка тикета нашими же ключами. Ноде для этого сервис не нужен — метод
 * существует для тестов, отладки и локальной диагностики.
 */
export async function verifyTicket(
  keyring: TicketKeyring,
  options: Pick<TicketOptions, 'issuer' | 'audience'>,
  token: string,
): Promise<TicketPayload> {
  const header = decodeProtectedHeader(token);
  const candidates = header.kid ? [keyring.byKid(header.kid)] : keyring.verification;

  let lastError: unknown = new Error(`неизвестный kid: ${header.kid ?? '(нет)'}`);

  for (const key of candidates) {
    if (!key) continue;
    try {
      const { payload } = await jwtVerify(token, key.publicKey, {
        algorithms: [keyring.alg],
        issuer: options.issuer,
        audience: options.audience,
      });
      return payload as unknown as TicketPayload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
