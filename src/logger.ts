import { KeyObject } from 'node:crypto';
import type { LogLevel } from './config.js';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Ключи, значения которых не должны попадать в логи ни при каких условиях.
 * Совпадение по подстроке: `authorization`, `x-node-secret`, `apiKey`,
 * `privateKey`, `access_token` — всё ловится.
 */
const SECRET_KEY_RE =
  /(authorization|auth[-_]?header|cookie|token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|signing[-_]?key|ticket|jwt|bearer)/i;

/** Три base64url-сегмента через точку — похоже на JWT, что бы это ни было. */
const JWT_LIKE_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** PEM-блок: приватный ключ мог попасть в сообщение об ошибке. */
const PEM_LIKE_RE = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;

/** Глобальный CryptoKey есть не во всех рантаймах — берём осторожно. */
const CRYPTO_KEY = (globalThis as { CryptoKey?: new () => object }).CryptoKey;

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

function redactString(value: string): string {
  let result = value.replace(PEM_LIKE_RE, REDACTED).replace(JWT_LIKE_RE, REDACTED);
  if (result.length > MAX_STRING) result = `${result.slice(0, MAX_STRING)}…[truncated]`;
  return result;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return '[depth-limit]';

  const object = value as object;
  if (seen.has(object)) return '[circular]';
  seen.add(object);

  if (object instanceof Error) {
    return {
      name: object.name,
      message: redactString(object.message),
      ...(object.stack ? { stack: redactString(object.stack) } : {}),
      ...('code' in object && typeof object.code === 'string' ? { code: object.code } : {}),
    };
  }

  if (object instanceof Date) return object.toISOString();
  if (Array.isArray(object)) return object.map((item) => redact(item, depth + 1, seen));
  if (object instanceof Map || object instanceof Set) return `[${object.constructor.name}(${object.size})]`;
  if (Buffer.isBuffer(object)) return `[Buffer(${object.length})]`;

  // Ключи наружу не выводим никогда, как бы они ни попали в поля лога.
  // Проверяем по типу, а не по имени поля: node отдаёт подклассы KeyObject.
  if (object instanceof KeyObject) return '[key]';
  if (CRYPTO_KEY !== undefined && object instanceof CRYPTO_KEY) return '[key]';

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
    result[key] = SECRET_KEY_RE.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return result;
}

export interface LoggerOptions {
  level: LogLevel;
  base?: LogFields;
  /** Куда писать. По умолчанию stdout, ошибки — stderr. */
  write?: (line: string, level: LogLevel) => void;
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_WEIGHT[options.level];
  const base = options.base ?? {};
  const write = options.write ?? defaultWrite;

  const log = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;

    const payload = {
      time: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(redact({ ...base, ...fields }) as LogFields),
    };

    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      line = JSON.stringify({ time: payload.time, level, msg: payload.msg, logError: 'not serializable' });
    }
    write(line, level);
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
