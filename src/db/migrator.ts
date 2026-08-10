import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';
import { fromPackageRoot } from '../util/paths.js';

/** Ключ advisory-lock: одновременный запуск миграций на нескольких инстансах безопасен. */
const MIGRATION_LOCK_KEY = 8_534_771_002_001n;

const FILE_RE = /^(\d{4})_([a-z0-9_-]+)\.sql$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export function migrationsDir(): string {
  return fromPackageRoot('migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();

  return files.map((file) => {
    const match = FILE_RE.exec(file);
    if (!match) {
      throw new Error(`Файл миграции «${file}» не соответствует формату NNNN_описание.sql`);
    }
    // Нормализуем переводы строк: иначе checksum разъедется между Windows и Linux.
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return {
      version: match[1] as string,
      name: match[2] as string,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  });
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      name       text not null,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readApplied(client: PoolClient): Promise<Map<string, AppliedMigration>> {
  const { rows } = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('select version, name, checksum, applied_at from schema_migrations order by version');

  return new Map(
    rows.map((row) => [
      row.version,
      { version: row.version, name: row.name, checksum: row.checksum, appliedAt: row.applied_at },
    ]),
  );
}

function assertNotModified(files: readonly MigrationFile[], applied: Map<string, AppliedMigration>): void {
  for (const file of files) {
    const record = applied.get(file.version);
    if (record && record.checksum !== file.checksum) {
      throw new Error(
        `Миграция ${file.version}_${file.name} уже применена, но её содержимое изменилось. ` +
          'Применённые миграции править нельзя — добавьте новую.',
      );
    }
  }
}

export interface MigrationStatusRow {
  readonly version: string;
  readonly name: string;
  readonly applied: boolean;
  readonly appliedAt: Date | null;
  readonly modified: boolean;
}

export async function migrationStatus(pool: Pool, dir = migrationsDir()): Promise<MigrationStatusRow[]> {
  const files = loadMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);
    return files.map((file) => {
      const record = applied.get(file.version);
      return {
        version: file.version,
        name: file.name,
        applied: record !== undefined,
        appliedAt: record?.appliedAt ?? null,
        modified: record !== undefined && record.checksum !== file.checksum,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Применяет неприменённые миграции. Каждая — в своей транзакции, весь прогон —
 * под advisory-lock, поэтому одновременный запуск на нескольких инстансах
 * безопасен.
 *
 * Вызывается из CLI, а он — из `CMD` образа перед стартом приложения. Сам
 * серверный процесс миграции не накатывает: к моменту его запуска схема уже
 * приведена в порядок, иначе контейнер до него не дошёл бы.
 */
export async function migrateUp(pool: Pool, logger: Logger, dir = migrationsDir()): Promise<string[]> {
  const files = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    await ensureMigrationsTable(client);

    const already = await readApplied(client);
    assertNotModified(files, already);

    for (const file of files) {
      if (already.has(file.version)) continue;

      logger.info('применяю миграцию', { version: file.version, name: file.name });
      try {
        await client.query('begin');
        await client.query(file.sql);
        await client.query(
          'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [file.version, file.name, file.checksum],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Миграция ${file.version}_${file.name} не применилась: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(`${file.version}_${file.name}`);
    }

    return applied;
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } catch {
      // Соединение закрывается следом — лок снимет сервер.
    }
    client.release();
  }
}
