import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';
import { ACCOUNT_ID_RE } from '../upstream/auth.js';

/**
 * Тестовый токен пользователя для локальной разработки.
 *
 * Подписывается случайным ключом: он нужен только для того, чтобы токен был
 * синтаксически валидным JWT. Годится исключительно в dev-режиме, где
 * AUTH_JWKS_URL не задан и подпись не проверяется. С настоящим auth-сервисом
 * такой токен будет отвергнут — как и должно быть.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sub: { type: 'string' },
      name: { type: 'string', default: 'Иван Петров' },
      ttl: { type: 'string', default: '3600' },
    },
  });

  // Без --sub каждый запуск даёт новый аккаунт: удобно проверять выдачу слага
  // «с нуля», не чистя базу.
  const sub = (values.sub ?? randomUUID()).toLowerCase();
  if (!ACCOUNT_ID_RE.test(sub)) {
    process.stderr.write('--sub должен быть UUID, как claim sub у auth-сервиса\n');
    process.exit(1);
  }

  const ttl = Number(values.ttl);
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ name: values.name as string })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (Number.isFinite(ttl) ? ttl : 3600))
    .sign(randomBytes(32));

  // Токен — в stdout, чтобы его можно было подставить в $(...); всё
  // остальное — в stderr.
  process.stderr.write(`sub=${sub}\n`);
  process.stdout.write(`${token}\n`);
}

await main();
