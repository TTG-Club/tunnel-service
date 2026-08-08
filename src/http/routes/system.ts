import { setResponseHeader, setResponseStatus, type Router } from 'h3';
import type { AppServices } from '../../services.js';
import { apiHandler } from '../handler.js';

const READY_QUERY_TIMEOUT_MS = 2000;

async function pingDatabase(services: AppServices): Promise<void> {
  await Promise.race([
    services.pool.query('select 1'),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('таймаут запроса к базе')), READY_QUERY_TIMEOUT_MS).unref(),
    ),
  ]);
}

export function registerSystemRoutes(router: Router, services: AppServices): void {
  // Жив ли процесс. В базу не ходит специально: иначе перезапуск базы
  // спровоцирует перезапуск контейнеров.
  router.get(
    '/health',
    apiHandler(services, async () => ({
      status: 'ok',
      version: services.version,
      uptimeSeconds: Math.round(process.uptime()),
    })),
  );

  // Готов ли принимать трафик: нужна база, и мы не должны быть в процессе
  // остановки.
  router.get(
    '/ready',
    apiHandler(services, async (event) => {
      if (services.lifecycle.shuttingDown) {
        setResponseStatus(event, 503);
        return { status: 'shutting-down' };
      }

      try {
        await pingDatabase(services);
      } catch (error) {
        services.logger.error('проверка готовности не прошла', { error });
        setResponseStatus(event, 503);
        return { status: 'unavailable', reason: 'database' };
      }

      return { status: 'ready', authMode: services.auth.mode };
    }),
  );

  // Публичные ключи ЭТОГО сервиса: по ним ноды проверяют тикеты, не обращаясь
  // к нам. Отдаются оба активных ключа, чтобы ротация не рвала живые туннели.
  router.get(
    '/.well-known/jwks.json',
    apiHandler(services, async (event) => {
      setResponseHeader(event, 'cache-control', 'public, max-age=300, stale-while-revalidate=600');
      setResponseHeader(event, 'content-type', 'application/jwk-set+json; charset=utf-8');
      return services.keyring.jwks();
    }),
  );
}
