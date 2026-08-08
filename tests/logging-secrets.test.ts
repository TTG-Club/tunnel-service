import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/logger.js';
import { capturingLogger } from './helpers.js';

const JWT =
  'eyJhbGciOiJFZERTQSIsImtpZCI6ImFiYyJ9.eyJzdWIiOiIxMjM0NSIsInNsdWciOiJpdmFuIn0.c2lnbmF0dXJlLWhlcmU';

describe('секреты в логах', () => {
  it('значения по опасным ключам не печатаются', () => {
    const logger = capturingLogger();

    logger.info('запрос', {
      authorization: 'Bearer secret-value',
      accessToken: 'abc123',
      NODE_SHARED_SECRET: 'shared',
      ticket: JWT,
      privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQ\n-----END PRIVATE KEY-----',
      cookie: 'session=1',
      accountId: '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b',
    });

    const line = logger.lines[0] as string;

    expect(line).not.toContain('secret-value');
    expect(line).not.toContain('abc123');
    expect(line).not.toContain('shared');
    expect(line).not.toContain('session=1');
    expect(line).not.toContain('MC4CAQ');
    // Неопасные поля остаются на месте, иначе логи бесполезны.
    expect(line).toContain('018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b');
  });

  it('токен вырезается, даже если оказался в неожиданном поле', () => {
    const logger = capturingLogger();
    logger.info('что-то пошло не так', { note: `пришёл ${JWT}`, list: [JWT] });

    const line = logger.lines[0] as string;
    expect(line).not.toContain('eyJhbGciOiJFZERTQSI');
    expect(line).toContain('[redacted]');
  });

  it('токен вырезается и из текста сообщения', () => {
    const logger = capturingLogger();
    logger.warn(`отклонён токен ${JWT}`);
    expect(logger.lines[0]).not.toContain('eyJzdWIiOiIxMjM0NSI');
  });

  it('PEM из текста ошибки не утекает', () => {
    const logger = capturingLogger();
    const error = new Error(
      'не удалось прочитать -----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIH\n-----END PRIVATE KEY----- ключ',
    );

    logger.error('ошибка', { error });

    expect(logger.lines[0]).not.toContain('MC4CAQAwBQYDK2VwBCIEIH');
  });

  it('объекты ключей node:crypto не сериализуются', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(redact({ signingKey: privateKey })).toEqual({ signingKey: '[redacted]' });
    // Даже без «опасного» имени поля сам объект ключа наружу не идёт.
    expect(redact([privateKey])).toEqual(['[key]']);
    expect(redact({ anything: privateKey })).toEqual({ anything: '[key]' });
  });

  it('лог остаётся валидным JSON на любых входных данных', () => {
    const logger = capturingLogger();

    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    logger.info('странные данные', {
      circular,
      big: 10_000_000_000n,
      when: new Date('2026-08-08T00:00:00.000Z'),
      fn: () => undefined,
      buffer: Buffer.from('hello'),
    });

    const parsed = JSON.parse(logger.lines[0] as string) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['big']).toBe('10000000000');
    expect(parsed['when']).toBe('2026-08-08T00:00:00.000Z');
    expect(parsed['circular']).toEqual({ name: 'loop', self: '[circular]' });
  });

  it('уровень ниже порога не пишется', () => {
    const logger = capturingLogger();
    logger.debug('видно на debug');
    expect(logger.lines).toHaveLength(1);
  });
});
