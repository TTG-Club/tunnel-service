import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Алфавит суффиксов: без `0`, `1`, `i`, `l`, `o` — чтобы адрес можно было
 * продиктовать голосом и не перепутать.
 */
export const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function randomToken(length = 6): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += TOKEN_ALPHABET[randomInt(0, TOKEN_ALPHABET.length)];
  }
  return result;
}

/**
 * Детерминированный короткий id из произвольной строки: один и тот же worldId
 * всегда даёт один и тот же суффикс, поэтому ссылка на мир не меняется.
 */
export function stableToken(input: string, length = 6): string {
  const digest = createHash('sha256').update(input, 'utf8').digest();
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += TOKEN_ALPHABET[(digest[i % digest.length] as number) % TOKEN_ALPHABET.length];
  }
  return result;
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
