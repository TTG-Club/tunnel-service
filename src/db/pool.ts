import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export type { Pool, PoolClient } from 'pg';

export function createPool(config: AppConfig, logger: Logger): Pool {
  const options: PoolConfig = {
    connectionString: config.db.url,
    max: config.db.poolMax,
    application_name: 'tunnel-service',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };
  if (config.db.ssl) options.ssl = { rejectUnauthorized: true };

  const pool = new pg.Pool(options);

  // Ошибка простаивающего клиента не должна ронять процесс.
  pool.on('error', (error) => logger.error('ошибка пула postgres', { error }));

  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Соединение уже мертво — откат всё равно сделает сервер.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Код ошибки postgres, если это она. */
export function pgErrorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

/** Имя нарушенного ограничения — по нему различаем, какой именно конфликт. */
export function pgConstraint(error: unknown): string | null {
  return error !== null &&
    typeof error === 'object' &&
    'constraint' in error &&
    typeof error.constraint === 'string'
    ? error.constraint
    : null;
}

export const PG_UNIQUE_VIOLATION = '23505';
