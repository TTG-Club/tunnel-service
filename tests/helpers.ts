import { generateKeyPairSync } from 'node:crypto';
import { loadConfig, type AppConfig, type TicketAlg } from '../src/config.js';
import { createLogger, type LogFields, type Logger } from '../src/logger.js';

/** Приватный ключ в том же виде, в каком он лежит в окружении: base64 от PEM. */
export function generateKeyMaterial(alg: TicketAlg = 'EdDSA'): string {
  const { privateKey } =
    alg === 'EdDSA'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString(
    'base64',
  );
}

export function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://tunnel:tunnel@localhost:5432/tunnel',
    PUBLIC_DOMAIN: 'play.ttg.club',
    SUBSCRIBER_BASE_URL: 'https://subscriber.api.ttg.club',
    TICKET_PRIVATE_KEY_CURRENT: generateKeyMaterial(),
    NODE_SHARED_SECRET: 'x'.repeat(48),
    ...overrides,
  };
}

export function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(makeEnv(overrides));
}

export interface CapturedLogger extends Logger {
  readonly records: { level: string; msg: string; fields: LogFields }[];
  readonly lines: string[];
}

/** Логгер, который ничего не печатает, но помнит всё, что ему сказали. */
export function capturingLogger(): CapturedLogger {
  const lines: string[] = [];
  const records: { level: string; msg: string; fields: LogFields }[] = [];

  const base = createLogger({
    level: 'debug',
    write: (line) => {
      lines.push(line);
      const parsed = JSON.parse(line) as { level: string; msg: string } & LogFields;
      const { level, msg, ...fields } = parsed;
      records.push({ level, msg, fields });
    },
  });

  return Object.assign(base, { records, lines });
}
