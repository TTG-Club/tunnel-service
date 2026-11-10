import { isIP } from 'node:net';
import type { Router } from 'h3';
import { z } from 'zod';
import { BYTES_IN_GB } from '../../domain/limits.js';
import type { AppServices } from '../../services.js';
import { ACCOUNT_ID_RE } from '../../upstream/auth.js';
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

/** account_id — UUID из claim `sub` токена пользователя. */
const accountId = z
  .string()
  .regex(ACCOUNT_ID_RE, 'ожидается идентификатор аккаунта в формате UUID')
  .transform((value) => value.toLowerCase());

const heartbeatSchema = z.object({
  nodeId,
  hostname: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'ожидается имя хоста в нижнем регистре'),
  region: z.string().min(1).max(64).nullish(),
  /**
   * Публичные IP ноды. По ним приложение мастера подключается в обход DNS
   * пользователя. Нет поля (старая нода) — пустой список, клиент идёт по имени.
   */
  addresses: z
    .array(z.string().max(45).refine((value) => isIP(value) !== 0, 'ожидается IPv4 или IPv6 адрес'))
    .max(8)
    .default([])
    .transform((list) => [...new Set(list.map((value) => value.toLowerCase()))]),
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
        addresses: body.addresses,
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

      // ⚠️ Отчёт принимается ТОЛЬКО по тем аккаунтам, которым эта нода
      // действительно выдавалась. Раньше принимался любой account_id: общий
      // секрет нод превращал одну скомпрометированную ноду в способ выключить
      // доступ любому подписчику — записал ему исчерпанную квоту, и до конца
      // месяца тикетов не будет.
      const granted = await services.usage.filterGrantedAccounts(
        body.nodeId,
        body.items.map((item) => item.accountId),
      );

      const acceptedItems = body.items.filter((item) => granted.has(item.accountId));
      const rejectedCount = body.items.length - acceptedItems.length;

      if (rejectedCount > 0) {
        logger.warn('нода прислала расход по аккаунтам, которых ей не поручали', {
          node: body.nodeId,
          rejected: rejectedCount,
          suspicious: true,
        });
      }

      const result = await services.usage.applyNodeUsage(body.nodeId, acceptedItems);

      // Потолок прироста за ОДИН отчёт. Счётчики накопительные и приходят
      // каждые несколько минут, поэтому честный прирост измеряется гигабайтами.
      // Скачок в сотни — либо сбой счётчика ноды, либо попытка разом выжечь
      // человеку месячную квоту. Ничего не откатываем (данные уже применены), но
      // говорим об этом громко: тихо принять такое значение хуже всего.
      const growthLimitBytes =
        BigInt(services.config.quota.maxReportGrowthGb) * BYTES_IN_GB;

      for (const delta of result.deltas) {
        if (delta.deltaBytes > growthLimitBytes) {
          logger.error('прирост расхода за один отчёт выше потолка', {
            accountId: delta.accountId,
            period: delta.period,
            node: body.nodeId,
            deltaGb: Number(delta.deltaBytes / BYTES_IN_GB),
            limitGb: services.config.quota.maxReportGrowthGb,
            suspicious: true,
          });
        }
      }

      if (result.regressions > 0) {
        logger.warn('счётчики ноды уменьшились — похоже, нода потеряла состояние', {
          node: body.nodeId,
          regressions: result.regressions,
        });
      }

      // Резкий прирост — сигнал для ручного разбора. Ничего не блокируем:
      // ложное срабатывание не должно выключать человеку игру.
      for (const delta of result.deltas) {
        const verdict = services.abuse.record(delta.accountId, delta.deltaBytes);
        if (!verdict.spike) continue;

        logger.warn('подозрительно резкий расход трафика', {
          accountId: delta.accountId,
          period: delta.period,
          node: body.nodeId,
          windowGb: Number(verdict.windowBytes / BYTES_IN_GB),
          thresholdGbPerDay: services.config.quota.spikeGbPerDay,
          totalGb: Number(delta.totalBytes / BYTES_IN_GB),
          suspicious: true,
        });
      }

      logger.debug('приняты метрики трафика', {
        node: body.nodeId,
        items: body.items.length,
        applied: result.applied,
        accounts: result.accounts,
      });

      // Поля перечислены явно: в deltas лежат bigint, и JSON.stringify на них
      // падает.
      return {
        ok: true,
        applied: result.applied,
        accounts: result.accounts,
        regressions: result.regressions,
      };
    }),
  );
}
