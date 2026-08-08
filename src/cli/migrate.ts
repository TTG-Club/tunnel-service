import pg from 'pg';
import type { LogLevel } from '../config.js';
import { migrateUp, migrationStatus, migrationsDir } from '../db/migrator.js';
import { createLogger } from '../logger.js';
import { loadDotEnv } from '../util/dotenv.js';

/**
 * Миграции — отдельная команда, а не часть старта приложения.
 *
 * Специально не читает полный конфиг сервиса: шагу деплоя «накатить базу»
 * незачем знать про ключи подписи и адреса auth/subscriber, ему нужен только
 * DATABASE_URL.
 */
async function main(): Promise<void> {
  loadDotEnv();

  const command = process.argv[2] ?? 'up';
  const databaseUrl = process.env['DATABASE_URL'];

  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL не задан — накатывать миграции некуда\n');
    process.exit(1);
  }

  const level = (process.env['LOG_LEVEL'] ?? 'info') as LogLevel;
  const logger = createLogger({ level, base: { service: 'tunnel-service', component: 'migrate' } });

  const ssl = ['true', '1', 'yes', 'on'].includes((process.env['DATABASE_SSL'] ?? '').toLowerCase());
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'tunnel-service-migrate',
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    if (command === 'status') {
      const rows = await migrationStatus(pool);
      for (const row of rows) {
        const state = row.modified
          ? 'ИЗМЕНЕНА ПОСЛЕ ПРИМЕНЕНИЯ'
          : row.applied
            ? `применена ${row.appliedAt?.toISOString() ?? ''}`
            : 'не применена';
        process.stdout.write(`${row.version}_${row.name}: ${state}\n`);
      }
      return;
    }

    if (command !== 'up') {
      process.stderr.write(`Неизвестная команда «${command}». Доступны: up, status\n`);
      process.exit(1);
    }

    logger.info('накатываю миграции', { dir: migrationsDir() });
    const applied = await migrateUp(pool, logger);

    if (applied.length === 0) logger.info('новых миграций нет');
    else logger.info('миграции применены', { applied });
  } catch (error) {
    logger.error('миграции не применились', { error });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
