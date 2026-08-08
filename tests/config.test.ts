import { describe, expect, it } from 'vitest';
import { ConfigError, isAuthDevMode, loadConfig } from '../src/config.js';
import { makeEnv } from './helpers.js';

describe('конфигурация', () => {
  it('без обязательной переменной падает с понятной ошибкой', () => {
    const env = makeEnv();
    delete env['DATABASE_URL'];

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('пустая строка — это «не задано», а не пустое значение', () => {
    const config = loadConfig(makeEnv({ AUTH_JWKS_URL: '' }));
    expect(config.auth.jwksUrl).toBeNull();
    expect(isAuthDevMode(config)).toBe(true);
  });

  // Главная страховка: без JWKS auth-сервиса подпись пользовательского токена
  // не проверяется, поэтому в production такой конфиг просто не поднимется.
  it('в production без AUTH_JWKS_URL сервис не стартует', () => {
    expect(() => loadConfig(makeEnv({ NODE_ENV: 'production' }))).toThrow(/AUTH_JWKS_URL/);
  });

  it('в production с AUTH_JWKS_URL стартует', () => {
    const config = loadConfig(
      makeEnv({
        NODE_ENV: 'production',
        AUTH_JWKS_URL: 'https://auth.api.ttg.club/.well-known/jwks.json',
      }),
    );

    expect(isAuthDevMode(config)).toBe(false);
    expect(config.auth.jwksUrl).toBe('https://auth.api.ttg.club/.well-known/jwks.json');
  });

  it('короткий секрет нод не принимается', () => {
    expect(() => loadConfig(makeEnv({ NODE_SHARED_SECRET: 'short' }))).toThrow(/NODE_SHARED_SECRET/);
  });

  // Без соли суффикс мира вычисляется из одного worldId, и адреса чужих миров
  // становятся подбираемыми. Поэтому переменная обязательная.
  it('без SLUG_SALT сервис не стартует', () => {
    const env = makeEnv();
    delete env['SLUG_SALT'];

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/SLUG_SALT/);
  });

  it('короткая соль не принимается', () => {
    expect(() => loadConfig(makeEnv({ SLUG_SALT: 'коротко' }))).toThrow(/SLUG_SALT/);
  });

  it('умолчания соответствуют заданию', () => {
    const config = loadConfig(makeEnv());

    expect(config.ticket.alg).toBe('EdDSA');
    expect(config.ticket.ttlSeconds).toBe(900);
    expect(config.subscriber.cacheTtlSeconds).toBe(180);
    expect(config.subscriber.statusPath).toBe('/api/subscriptions/status');
  });
});
