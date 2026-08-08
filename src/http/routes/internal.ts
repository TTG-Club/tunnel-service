import type { Router } from 'h3';
import { z } from 'zod';
import type { AppServices } from '../../services.js';
import { apiHandler, readJsonBody, requestLogger, requireNodeSecret } from '../handler.js';

const nodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'допустимы строчные буквы, цифры, дефис и подчёркивание');

/** bigint приходит числом или строкой: JS-числа не хватит на большие счётчики. */
const byteCounter = z
  .union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,19}$/)])
  .transform((value) => BigInt(value));

const accountId = z
  .union([z.string().regex(/^\d{1,19}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => String(value));

const heartbeatSchema = z.object({
  nodeId,
  hostname: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'ожидается имя хоста в нижнем регистре'),
  region: z.string().min(1).max(64).nullish(),
  status: z.enum(['active', 'draining', 'down']).default('active'),
  tunnels: z.number().int().min(0).max(1_000_000).default(0),
  streams: z.number().int().min(0).max(10_000_000).default(0),
});

const usageSchema = z.object({
  nodeId,
  items: z
    .array(
      z.object({
        accountId,
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'период в формате YYYY-MM'),
        /**
         * Накопительный счётчик за период для этой ноды, а не дельта.
         * Именно поэтому повтор батча не удваивает расход.
         */
        bytesIn: byteCounter,
        bytesOut: byteCounter,
      }),
    )
    .max(5000),
});

/**
 * Эндпоинты для нод. Отдельный префикс и отдельная авторизация: общий секрет
 * из окружения, пользовательский JWT здесь не принимается.
 */
export function registerInternalRoutes(router: Router, services: AppServices): void {
  router.post(
    '/api/internal/nodes/heartbeat',
    apiHandler(services, async (event) => {
      requireNodeSecret(services, event);
      const body = await readJsonBody(event, heartbeatSchema);

      const node = await services.nodes.upsertHeartbeat({
        nodeId: body.nodeId,
        hostname: body.hostname,
        region: body.region ?? null,
        status: body.status,
        tunnels: body.tunnels,
        streams: body.streams,
      });

      requestLogger(services, event).debug('heartbeat ноды', {
        node: node.id,
        status: node.status,
        tunnels: node.tunnels,
        streams: node.streams,
      });

      return {
        ok: true,
        node: {
          id: node.id,
          status: node.status,
          lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
        },
        // Ноде полезно знать, как быстро мы посчитаем её мёртвой.
        heartbeatTimeoutSeconds: services.config.nodes.heartbeatTimeoutSeconds,
      };
    }),
  );

  router.post(
    '/api/internal/usage',
    apiHandler(services, async (event) => {
      requireNodeSecret(services, event);
      const body = await readJsonBody(event, usageSchema);
      const logger = requestLogger(services, event);

      const result = await services.usage.applyNodeUsage(body.nodeId, body.items);

      if (result.regressions > 0) {
        logger.warn('счётчики ноды уменьшились — похоже, нода потеряла состояние', {
          node: body.nodeId,
          regressions: result.regressions,
        });
      }

      logger.debug('приняты метрики трафика', {
        node: body.nodeId,
        items: body.items.length,
        applied: result.applied,
        accounts: result.accounts,
      });

      return { ok: true, ...result };
    }),
  );
}
