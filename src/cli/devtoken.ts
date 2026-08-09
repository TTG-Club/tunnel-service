import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';
import { ACCOUNT_ID_RE } from '../upstream/auth.js';
import { loadDotEnv } from '../util/dotenv.js';

/**
 * Тестовый токен пользователя для локальной разработки.
 *
 * Подписывается тем же `AUTH_JWT_SECRET`, которым сервис проверяет подпись, —
 * режима «не проверять подпись» больше нет. Форма токена повторяет настоящий
 * токен auth-сервиса: sub (UUID), username, email, roles, iat, exp; ни iss, ни
 * aud, ни kid там нет.
 */
async function main(): Promise<void> {
  loadDotEnv();

  const { values } = parseArgs({
    options: {
      sub: { type: 'string' },
      username: { type: 'string', default: 'magistrus' },
      email: { type: 'string' },
      ttl: { type: 'string', default: '3600' },
      alg: { type: 'string', default: 'HS256' },
    },
  });

  const secret = process.env['AUTH_JWT_SECRET']?.trim();
  if (!secret) {
    process.stderr.write(
      'Не задан AUTH_JWT_SECRET. Это общий JWT_SECRET auth-сервиса — тот же, ' +
        'с которым запускается сервис. Положите его в .env.\n',
    );
    process.exit(1);
  }

  // Без --sub каждый запуск даёт новый аккаунт: удобно проверять выдачу слага
  // «с нуля», не чистя базу.
  const sub = (values.sub ?? randomUUID()).toLowerCase();
  if (!ACCOUNT_ID_RE.test(sub)) {
    process.stderr.write('--sub должен быть UUID, как claim sub у auth-сервиса\n');
    process.exit(1);
  }

  const username = values.username as string;
  const ttl = Number(values.ttl);
  const now = Math.floor(Date.now() / 1000);

  // --alg существует только затем, чтобы вручную проверить отказ: сервис
  // принимает ровно HS256, всё остальное (включая none) должно отвергаться.
  const token = await new SignJWT({
    username,
    email: values.email ?? `${username}@example.com`,
    roles: ['USER', 'VTTG'],
  })
    .setProtectedHeader({ alg: values.alg as string, typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (Number.isFinite(ttl) ? ttl : 3600))
    .sign(new TextEncoder().encode(secret));

  // Токен — в stdout, чтобы его можно было подставить в $(...); всё
  // остальное — в stderr.
  process.stderr.write(`sub=${sub} username=${username} alg=${values.alg as string}\n`);
  process.stdout.write(`${token}\n`);
}

await main();
