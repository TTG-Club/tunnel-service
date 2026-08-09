import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, UnsecuredJWT, exportPKCS8, importPKCS8 } from 'jose';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/errors.js';
import { createUserTokenVerifier } from '../src/upstream/auth.js';
import { AUTH_SECRET, capturingLogger, makeConfig } from './helpers.js';

const ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440000';
const KEY = new TextEncoder().encode(AUTH_SECRET);

function verifier(overrides: Record<string, string | undefined> = {}) {
  return createUserTokenVerifier(makeConfig(overrides), capturingLogger());
}

/** Токен ровно той формы, что выдаёт auth-сервис: без iss, aud, jti, nbf и kid. */
function token(options: {
  alg?: string;
  sub?: string | null;
  username?: string | null;
  key?: Parameters<SignJWT['sign']>[0];
  expiresIn?: number;
  withoutExp?: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    email: 'user@example.com',
    roles: ['USER', 'VTTG'],
  };
  if (options.username !== null) claims['username'] = options.username ?? 'magistrus';

  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setIssuedAt(now);

  if (options.sub !== null) builder = builder.setSubject(options.sub ?? ACCOUNT_ID);
  if (!options.withoutExp) builder = builder.setExpirationTime(now + (options.expiresIn ?? 900));

  return builder.sign(options.key ?? KEY);
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(401);
  return error as ApiError;
}

describe('проверка токена общим секретом', () => {
  it('нормальный токен auth-сервиса принимается', async () => {
    const user = await verifier().verify(await token({}));

    expect(user.accountId).toBe(ACCOUNT_ID);
    expect(user.username).toBe('magistrus');
    expect(user.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('режим — проверка по общему секрету, а не «без проверки»', () => {
    expect(verifier().mode).toBe('shared-secret');
  });

  it('токен, подписанный чужим секретом, отвергается', async () => {
    const foreign = new TextEncoder().encode('another-secret-that-is-long-enough-x');

    await expectUnauthorized(verifier().verify(await token({ key: foreign })));
  });

  // Классическая атака: подпись выкидывается, alg объявляется none.
  it('alg: none отвергается', async () => {
    const unsecured = new UnsecuredJWT({ username: 'magistrus' })
      .setSubject(ACCOUNT_ID)
      .setIssuedAt()
      .setExpirationTime('15m')
      .encode();

    await expectUnauthorized(verifier().verify(unsecured));
  });

  // Вторая половина той же атаки: тело подписывается асимметрично, и
  // библиотека без явного списка алгоритмов проверила бы его чем попало.
  it('подменённый на асимметричный алгоритм отвергается', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = await importPKCS8(await exportPKCS8(privateKey as never), 'ES256');

    await expectUnauthorized(verifier().verify(await token({ alg: 'ES256', key })));
  });

  // Симметричный, но не тот: HS512 нашим секретом подписывается успешно,
  // и отклонить его может только явный список алгоритмов.
  it('HS512 тем же секретом отвергается', async () => {
    await expectUnauthorized(verifier().verify(await token({ alg: 'HS512' })));
  });

  it('истёкший токен отвергается', async () => {
    await expectUnauthorized(verifier().verify(await token({ expiresIn: -3600 })));
  });

  it('exp обязателен: вечных токенов не бывает', async () => {
    await expectUnauthorized(verifier().verify(await token({ withoutExp: true })));
  });

  it('свежепротухший токен проходит в пределах clockTolerance', async () => {
    const service = verifier({ AUTH_CLOCK_TOLERANCE_SECONDS: '60' });

    const user = await service.verify(await token({ expiresIn: -30 }));
    expect(user.accountId).toBe(ACCOUNT_ID);

    await expectUnauthorized(service.verify(await token({ expiresIn: -120 })));
  });

  // В старых токенах в sub лежал логин. Угадывать нельзя: чужой логин стал бы
  // account_id.
  it('логин вместо UUID в sub отвергается', async () => {
    const error = await expectUnauthorized(verifier().verify(await token({ sub: 'magistrus' })));
    expect(error.message).toContain('UUID');
  });

  it('токен без sub отвергается', async () => {
    await expectUnauthorized(verifier().verify(await token({ sub: null })));
  });

  it('токен без claim username отвергается', async () => {
    const error = await expectUnauthorized(verifier().verify(await token({ username: null })));
    expect(error.message).toContain('username');
  });

  // Перебора по name/preferred_username/nickname/login больше нет: этих
  // claim'ов auth-сервис не выдаёт, а молчаливый фолбэк увёл бы нас в
  // subscriber.api не за тем пользователем.
  it('claim name вместо username не спасает', async () => {
    const now = Math.floor(Date.now() / 1000);
    const withName = await new SignJWT({ name: 'Иван Петров' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ACCOUNT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(KEY);

    await expectUnauthorized(verifier().verify(withName));
  });

  it('sub приводится к нижнему регистру', async () => {
    const user = await verifier().verify(await token({ sub: ACCOUNT_ID.toUpperCase() }));
    expect(user.accountId).toBe(ACCOUNT_ID);
  });

  it('username с кириллицей и пробелами доезжает как есть', async () => {
    const user = await verifier().verify(await token({ username: '  Иван Петров  ' }));
    expect(user.username).toBe('Иван Петров');
  });

  it('мусор вместо JWT отвергается', async () => {
    await expectUnauthorized(verifier().verify('не-джейсон-веб-токен'));
  });

  // iss/aud/nbf/jti auth-сервис не выдаёт — требовать их нельзя.
  it('отсутствие iss, aud, nbf и jti не мешает', async () => {
    const user = await verifier().verify(await token({}));
    expect(user.accountId).toBe(ACCOUNT_ID);
  });
});

describe('ветка JWKS', () => {
  const JWKS_URL = 'https://auth.api.ttg.club/.well-known/jwks.json';

  it('включается одной переменной', () => {
    expect(verifier({ AUTH_JWKS_URL: JWKS_URL }).mode).toBe('jwks');
  });

  // Заданы обе — работаем по ключу, но молча это оставлять нельзя.
  it('при обеих переменных выигрывает JWKS, и это попадает в лог', () => {
    const logger = capturingLogger();
    const service = createUserTokenVerifier(makeConfig({ AUTH_JWKS_URL: JWKS_URL }), logger);

    expect(service.mode).toBe('jwks');
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
  });

  // Иначе токен, подписанный публичным ключом как HMAC-секретом, прошёл бы
  // проверку: ключ-то публичный.
  it('симметричный токен в режиме JWKS отвергается до похода за ключами', async () => {
    await expectUnauthorized(verifier({ AUTH_JWKS_URL: JWKS_URL }).verify(await token({})));
  });
});
