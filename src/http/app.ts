import { randomUUID } from 'node:crypto';
import {
  createApp,
  createRouter,
  eventHandler,
  getRequestHeader,
  getResponseStatus,
  setResponseHeader,
  setResponseStatus,
  type App,
  type H3Event,
} from 'h3';
import type { AppServices } from '../services.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTunnelRoutes } from './routes/tunnel.js';

const QUIET_PATHS = new Set(['/health', '/ready']);

/** Путь без query: в query может оказаться что угодно, включая токен. */
function safePath(event: H3Event): string {
  const path = event.path;
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

export function createHttpApp(services: AppServices): App {
  const app = createApp({
    onRequest(event) {
      const incoming = getRequestHeader(event, 'x-request-id');
      const requestId = incoming ? incoming.slice(0, 64) : randomUUID();
      event.context['requestId'] = requestId;
      event.context['startedAt'] = performance.now();
      setResponseHeader(event, 'x-request-id', requestId);
    },

    onAfterResponse(event) {
      const startedAt = event.context['startedAt'];
      const path = safePath(event);
      const fields = {
        requestId: event.context['requestId'],
        method: event.method,
        path,
        status: getResponseStatus(event),
        durationMs:
          typeof startedAt === 'number' ? Math.round((performance.now() - startedAt) * 10) / 10 : null,
        accountId: event.context['accountId'] ?? null,
      };

      // Health-чеки ходят каждые несколько секунд — не засоряем лог.
      if (QUIET_PATHS.has(path)) services.logger.debug('запрос', fields);
      else services.logger.info('запрос', fields);
    },

    onError(error, event) {
      // Сюда попадает только то, что не поймал apiHandler.
      services.logger.error('необработанная ошибка h3', {
        requestId: event.context['requestId'],
        method: event.method,
        path: safePath(event),
        error,
      });
    },
  });

  const router = createRouter();
  registerSystemRoutes(router, services);
  registerTunnelRoutes(router, services);
  registerInternalRoutes(router, services);

  app.use(router);

  // Роутер без preemptive просто пропускает несовпавшие пути дальше — здесь
  // отдаём 404 в том же формате, что и остальные ошибки.
  app.use(
    eventHandler((event) => {
      setResponseStatus(event, 404);
      return {
        error: {
          code: 'not_found' as const,
          message: `Маршрут ${event.method} ${safePath(event)} не найден`,
        },
      };
    }),
  );

  return app;
}
