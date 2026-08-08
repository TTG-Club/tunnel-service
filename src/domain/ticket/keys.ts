import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose';
import type { AppConfig, TicketAlg } from '../../config.js';

export class TicketKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketKeyError';
  }
}

export interface TicketKey {
  readonly kid: string;
  readonly alg: TicketAlg;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicJwk: JWK;
}

export interface TicketKeyring {
  readonly alg: TicketAlg;
  /** Ключ, которым подписываем новые тикеты. */
  readonly signing: TicketKey;
  /** Все ключи, которым доверяем при проверке: активный и предыдущий. */
  readonly verification: readonly TicketKey[];
  jwks(): { keys: JWK[] };
  byKid(kid: string): TicketKey | undefined;
}

/**
 * Ключ в окружении лежит как base64 от PKCS#8 PEM — одной строкой, чтобы
 * переносы не ломались в Dokploy. Голый PEM тоже принимаем: удобно локально.
 */
function decodeKeyMaterial(material: string): string {
  const trimmed = material.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    throw new TicketKeyError('ключ не является ни PEM, ни base64 от PEM');
  }
  if (!decoded.includes('-----BEGIN')) {
    throw new TicketKeyError('после раскодирования base64 не получился PEM PKCS#8');
  }
  return decoded;
}

function assertAlgMatchesKey(key: KeyObject, alg: TicketAlg, label: string): void {
  const type = key.asymmetricKeyType;

  if (alg === 'EdDSA') {
    if (type !== 'ed25519') {
      throw new TicketKeyError(
        `${label}: TICKET_ALG=EdDSA требует ключ Ed25519, а получен ${type ?? 'неизвестный тип'}`,
      );
    }
    return;
  }

  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (type !== 'ec' || curve !== 'prime256v1') {
    throw new TicketKeyError(
      `${label}: TICKET_ALG=ES256 требует ключ EC P-256, а получен ${type ?? 'неизвестный тип'}${
        curve ? ` (${curve})` : ''
      }`,
    );
  }
}

export async function loadTicketKey(material: string, alg: TicketAlg, label: string): Promise<TicketKey> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(decodeKeyMaterial(material));
  } catch (error) {
    if (error instanceof TicketKeyError) throw new TicketKeyError(`${label}: ${error.message}`);
    throw new TicketKeyError(`${label}: не удалось прочитать приватный ключ (${(error as Error).message})`);
  }

  assertAlgMatchesKey(privateKey, alg, label);

  const publicKey = createPublicKey(privateKey);
  const jwk = await exportJWK(publicKey);
  // kid — RFC 7638 thumbprint: одинаков на всех инстансах и не может
  // разъехаться, потому что вычисляется из самого ключа.
  const kid = await calculateJwkThumbprint(jwk, 'sha256');

  return {
    kid,
    alg,
    privateKey,
    publicKey,
    publicJwk: { ...jwk, kid, alg, use: 'sig' },
  };
}

/**
 * Связка ключей: активный подписывает, предыдущий остаётся в JWKS.
 *
 * Без второго ключа ротация обрывает все живые туннели: нода, закэшировавшая
 * JWKS, перестаёт верить уже выданным тикетам. Поэтому ротация — всегда два
 * шага, и связка поддерживает оба ключа с самого начала.
 */
export async function createTicketKeyring(config: AppConfig): Promise<TicketKeyring> {
  const alg = config.ticket.alg;

  const signing = await loadTicketKey(config.ticket.privateKeyCurrent, alg, 'TICKET_PRIVATE_KEY_CURRENT');

  const previous = config.ticket.privateKeyPrevious
    ? await loadTicketKey(config.ticket.privateKeyPrevious, alg, 'TICKET_PRIVATE_KEY_PREVIOUS')
    : null;

  if (previous && previous.kid === signing.kid) {
    throw new TicketKeyError('TICKET_PRIVATE_KEY_PREVIOUS совпадает с текущим ключом — ротация не начата');
  }

  const verification = previous ? [signing, previous] : [signing];
  const byKid = new Map(verification.map((key) => [key.kid, key]));

  return {
    alg,
    signing,
    verification,
    jwks: () => ({ keys: verification.map((key) => key.publicJwk) }),
    byKid: (kid) => byKid.get(kid),
  };
}
