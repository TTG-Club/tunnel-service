import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { makeEnv } from './helpers.js';

const JWKS_URL = 'https://auth.api.ttg.club/.well-known/jwks.json';

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
    expect(config.auth.secret).not.toBeNull();
  });

  // Главная страховка: проверять подпись пользовательского токена нечем —
  // сервис не поднимается. Ни в каком NODE_ENV, режима «без проверки» нет.
  it('без AUTH_JWT_SECRET и без AUTH_JWKS_URL сервис не стартует', () => {
    const env = makeEnv();
    delete env['AUTH_JWT_SECRET'];

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/AUTH_JWT_SECRET/);
  });

  it('короткий AUTH_JWT_SECRET не принимается', () => {
    expect(() => loadConfig(makeEnv({ AUTH_JWT_SECRET: 'коротко' }))).toThrow(/AUTH_JWT_SECRET/);
  });

  // Ветка JWKS живая: когда auth переедет на асимметричную подпись, это будет
  // настройкой, а не правкой кода.
  it('один AUTH_JWKS_URL без секрета — валидная конфигурация', () => {
    const env = makeEnv({ AUTH_JWKS_URL: JWKS_URL });
    delete env['AUTH_JWT_SECRET'];

    const config = loadConfig(env);

    expect(config.auth.jwksUrl).toBe(JWKS_URL);
    expect(config.auth.secret).toBeNull();
  });

  it('заданы обе переменные — конфигурация валидна, приоритет разбирается в проверяльщике', () => {
    const config = loadConfig(makeEnv({ AUTH_JWKS_URL: JWKS_URL }));

    expect(config.auth.jwksUrl).toBe(JWKS_URL);
    expect(config.auth.secret).not.toBeNull();
  });

  it('без INTERNAL_SERVICE_SECRET сервис не стартует', () => {
    const env = makeEnv();
    delete env['INTERNAL_SERVICE_SECRET'];

    expect(() => loadConfig(env)).toThrow(/INTERNAL_SERVICE_SECRET/);
  });

  // Без плейсхолдера URL собрался бы без username и ушёл бы не туда.
  it('путь статуса без {username} не принимается', () => {
    expect(() =>
      loadConfig(makeEnv({ SUBSCRIBER_STATUS_PATH: '/api/internal/subscriptions/status' })),
    ).toThrow(/SUBSCRIBER_STATUS_PATH/);
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
    expect(config.ticket.tier).toBe('pro');
    expect(config.subscriber.cacheTtlSeconds).toBe(180);
    expect(config.subscriber.statusPath).toBe('/api/internal/subscriptions/{username}/status');
    expect(config.auth.clockToleranceSeconds).toBe(30);
  });
});
