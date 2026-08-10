import { createServer, type Server } from 'node:http';
import { toNodeListener } from 'h3';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { migrationStatus } from './db/migrator.js';
import { createHttpApp } from './http/app.js';
import { createLogger, type Logger } from './logger.js';
import { createServices, type AppServices } from './services.js';
import { loadDotEnv } from './util/dotenv.js';

const DRAIN_POLL_MS = 100;

/**
 * Сообщает в лог о неприменённых миграциях.
 *
 * Миграции по-прежнему накатывает не приложение, а отдельный шаг выката — это
 * осознанное решение, и оно не меняется. Меняется то, что расхождение схемы
 * перестаёт быть НЕВИДИМЫМ.
 *
 * Стоило шагу миграций отсутствовать в конвейере, и сервис поднимался бодрым,
 * отвечал на /health, а падал только там, где код трогал недостающую таблицу.
 * Снаружи это выглядело как «у всех перестал работать туннель» — искать причину
 * приходилось по цепочке из трёх репозиториев. Одна строка в логе старта
 * закрывает этот класс расследований целиком.
 *
 * Старт при этом НЕ отменяется: часть сервиса, не зависящая от новой таблицы,
 * работает, и уронить всё ради одной ручки было бы хуже болезни.
 *
 * @param services - собранные сервисы (нужен пул подключений)
 * @param logger - логгер приложения
 */
async function reportPendingMigrations(services: AppServices, logger: Logger): Promise<void> {
  try {
    const pending = (await migrationStatus(services.pool)).filter((row) => !row.applied);

    if (pending.length > 0) {
      logger.error('СХЕМА УСТАРЕЛА: есть неприменённые миграции — накатите их', {
        pending: pending.map((row) => `${row.version}_${row.name}`),
      });
    }
  } catch (error) {
    logger.error('не удалось проверить состояние миграций', { error: (error as Error).message });
  }
}

function trackInFlight(server: Server): { count: () => number } {
  let inFlight = 0;
  server.on('request', (_request, response) => {
    inFlight += 1;
    response.on('close', () => {
      inFlight -= 1;
    });
  });
  return { count: () => inFlight };
}

async function waitForDrain(count: () => number, timeoutMs: number, logger: Logger): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (count() > 0) {
    if (Date.now() >= deadline) {
      logger.warn('не дождались завершения запросов, обрываю', { inFlight: count() });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS).unref());
  }
}

function installShutdown(server: Server, services: AppServices, inFlight: () => number): void {
  const { logger, config } = services;
  let started = false;

  const shutdown = (signal: string): void => {
    if (started) return;
    started = true;
    services.lifecycle.shuttingDown = true;

    logger.info('получен сигнал остановки, завершаю работу', { signal, inFlight: inFlight() });

    // Новые соединения больше не принимаем, простаивающие keep-alive рвём
    // сразу — иначе server.close() будет ждать их вечно.
    server.close();
    server.closeIdleConnections();

    void (async () => {
      try {
        await waitForDrain(inFlight, config.shutdownTimeoutMs, logger);
        server.closeAllConnections();
        await services.pool.end();
        logger.info('остановлен штатно');
        process.exit(0);
      } catch (error) {
        logger.error('ошибка при остановке', { error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  loadDotEnv();

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    // Логгера ещё нет, и это единственное место, где мы пишем в stderr сырым текстом.
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'tunnel-service', env: config.env },
  });

  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { error: reason }));
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException, завершаю процесс', { error });
    process.exit(1);
  });

  const services = await createServices(config, logger);

  await reportPendingMigrations(services, logger);

  const server = createServer(toNodeListener(createHttpApp(services)));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const inFlight = trackInFlight(server);
  installShutdown(server, services, inFlight.count);

  server.listen(config.http.port, config.http.host, () => {
    logger.info('сервис запущен', {
      host: config.http.host,
      port: config.http.port,
      version: services.version,
      authMode: services.auth.mode,
      publicDomain: config.publicDomain,
      // Не `ticketAlg`: редактор секретов режет всё, где в имени поля есть
      // «ticket», и в логе вместо алгоритма оказывалось бы [redacted].
      signingAlg: config.ticket.alg,
    });
  });
}

await main();
