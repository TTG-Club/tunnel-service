import type { Router } from 'h3';
import { z } from 'zod';
import {
  BYTES_IN_GB,
  quotaLeftGb,
  resolveTier,
  usedPercent,
  type TierLimits,
} from '../../domain/limits.js';
import { selectNode } from '../../domain/nodes/select.js';
import { issueTicket } from '../../domain/ticket/issue.js';
import { currentPeriod } from '../../domain/usage/repository.js';
import type { AppServices } from '../../services.js';
import type { SubscriptionResult } from '../../upstream/subscriber.js';
import { ApiError } from '../errors.js';
import {
  apiHandler,
  clientIp,
  enforceRateLimit,
  readJsonBody,
  requestLogger,
  requireUser,
} from '../handler.js';

const ticketRequestSchema = z.object({
  worlds: z
    .array(
      z.object({
        worldId: z.string().min(1).max(128),
        // Порт мастеру нужен, чтобы нода знала, куда стучаться; control plane
        // его только валидирует и возвращает обратно в раскладке хостов.
        port: z.number().int().min(1).max(65_535),
      }),
    )
    .max(64)
    .default([]),
});

type TicketRequest = z.infer<typeof ticketRequestSchema>;

function host(slug: string, domain: string): string {
  return `${slug}.${domain}`;
}

function limitsView(limits: TierLimits, leftGb: number): Record<string, number> {
  return {
    maxStreams: limits.maxStreams,
    maxWorlds: limits.maxWorlds,
    quotaGb: limits.quotaGb,
    quotaLeftGb: leftGb,
  };
}

function subscriptionView(result: SubscriptionResult): Record<string, unknown> {
  return {
    active: result.status.active,
    registered: result.status.registered,
    expiresAt: result.status.expiresAt,
    // Полезно для диагностики: fresh / cache / stale.
    source: result.source,
  };
}

/** Один и тот же worldId в запросе дважды — не ошибка, просто схлопываем. */
function dedupeWorlds(worlds: TicketRequest['worlds']): TicketRequest['worlds'] {
  const seen = new Set<string>();
  return worlds.filter((world) => {
    if (seen.has(world.worldId)) return false;
    seen.add(world.worldId);
    return true;
  });
}

export function registerTunnelRoutes(router: Router, services: AppServices): void {
  const { config } = services;

  router.post(
    '/api/tunnel/ticket',
    apiHandler(services, async (event) => {
      const logger = requestLogger(services, event);

      // 0. Лимит по IP — до разбора токена: это самая дешёвая проверка, и она
      //    закрывает поток запросов от одного клиента с чужими токенами.
      enforceRateLimit(event, services.rateLimit.byIp, clientIp(event, config.http.trustProxy));

      const { user, accessToken } = await requireUser(services, event);

      // Лимит по аккаунту — до похода в subscriber.api, иначе через нас можно
      // нагрузить сервис подписок.
      enforceRateLimit(event, services.rateLimit.byAccount, user.accountId);

      const body = await readJsonBody(event, ticketRequestSchema);
      const worlds = dedupeWorlds(body.worlds);

      // 1. Подписка. Всё остальное делается только после неё: ни слаг, ни
      //    тикет не должны появляться у аккаунта без активной подписки.
      const subscription = await services.subscription.get(user.accountId, accessToken);
      if (!subscription.status.active) {
        throw ApiError.subscriptionInactive({
          registered: subscription.status.registered,
          expiresAt: subscription.status.expiresAt,
        });
      }

      // 2. Тариф и лимиты.
      const tier = resolveTier(subscription.status.tier, config.subscriber.defaultTier, logger);
      if (worlds.length > tier.limits.maxWorlds) {
        throw ApiError.worldsLimitExceeded(worlds.length, tier.limits.maxWorlds);
      }

      // 3. Квота трафика за текущий месяц.
      const period = currentPeriod();
      const usage = await services.usage.getAccountUsage(user.accountId, period);
      const leftGb = quotaLeftGb(tier.limits, usage.total);
      if (leftGb <= 0) {
        throw ApiError.quotaExceeded({
          period,
          usedGb: Number(usage.total / BYTES_IN_GB),
          quotaGb: tier.limits.quotaGb,
        });
      }

      // Квота в 10 ТБ обычной игрой недостижима, поэтому приближение к ней —
      // повод посмотреть на аккаунт руками, а не молча ждать отказа.
      const percent = usedPercent(tier.limits, usage.total);
      if (percent >= config.quota.warnPercent) {
        logger.warn('расход приблизился к квоте', {
          accountId: user.accountId,
          period,
          usedGb: Number(usage.total / BYTES_IN_GB),
          quotaGb: tier.limits.quotaGb,
          usedPercent: percent,
          suspicious: true,
        });
      }

      // 4. Нода. Ищем до выдачи слагов: если нод нет, тикет всё равно
      //    бесполезен.
      const healthyNodes = await services.nodes.listHealthy(config.nodes.heartbeatTimeoutSeconds);
      const node = selectNode(healthyNodes, user.accountId);
      if (!node) {
        logger.error('нет живых нод для выдачи тикета', { accountId: user.accountId });
        throw ApiError.noNodesAvailable();
      }

      // 5. Слаги: аккаунта — навсегда, миров — по стабильному id мира.
      const accountSlug = await services.slugs.ensureAccountSlug(user.accountId, user.displayName);
      const worldSlugs = await Promise.all(
        worlds.map(async (world) => ({
          world,
          row: await services.slugs.ensureWorldSlug(user.accountId, accountSlug.slug, world.worldId),
        })),
      );

      // 6. Тикет.
      const hosts = [accountSlug.slug, ...worldSlugs.map((entry) => entry.row.slug)];
      const ticket = await issueTicket(
        services.keyring,
        {
          issuer: config.ticket.issuer,
          audience: config.ticket.audience,
          ttlSeconds: config.ticket.ttlSeconds,
        },
        {
          accountId: user.accountId,
          slug: accountSlug.slug,
          nodeId: node.id,
          hosts,
          limits: {
            max_streams: tier.limits.maxStreams,
            max_worlds: tier.limits.maxWorlds,
            quota_left_gb: leftGb,
          },
          tier: tier.name,
        },
      );

      logger.info('выдан тикет', {
        accountId: user.accountId,
        slug: accountSlug.slug,
        node: node.id,
        worlds: worlds.length,
        tier: tier.name,
        jti: ticket.jti,
        subscriptionSource: subscription.source,
      });

      return {
        ticket: ticket.token,
        issuedAt: ticket.issuedAt.toISOString(),
        expiresAt: ticket.expiresAt.toISOString(),
        ttlSeconds: config.ticket.ttlSeconds,
        node: { id: node.id, hostname: node.hostname, region: node.region },
        account: {
          slug: accountSlug.slug,
          host: host(accountSlug.slug, config.publicDomain),
        },
        hosts: [
          {
            kind: 'account' as const,
            slug: accountSlug.slug,
            host: host(accountSlug.slug, config.publicDomain),
          },
          ...worldSlugs.map((entry) => ({
            kind: 'world' as const,
            slug: entry.row.slug,
            host: host(entry.row.slug, config.publicDomain),
            worldId: entry.world.worldId,
            port: entry.world.port,
          })),
        ],
        tier: tier.name,
        limits: limitsView(tier.limits, leftGb),
        subscription: subscriptionView(subscription),
      };
    }),
  );

  router.get(
    '/api/tunnel/status',
    apiHandler(services, async (event) => {
      const logger = requestLogger(services, event);
      const { user, accessToken } = await requireUser(services, event);

      const subscription = await services.subscription.get(user.accountId, accessToken);
      const tier = resolveTier(subscription.status.tier, config.subscriber.defaultTier, logger);

      const period = currentPeriod();
      const usage = await services.usage.getAccountUsage(user.accountId, period);
      const leftGb = quotaLeftGb(tier.limits, usage.total);

      // Слаг на GET не выдаём: побочных эффектов у чтения быть не должно.
      // До первого тикета slug === null, приложению этого достаточно.
      const accountSlug = await services.slugRepository.findAccountSlug(user.accountId);
      const worlds = accountSlug ? await services.slugRepository.listWorldSlugs(user.accountId) : [];

      return {
        accountId: user.accountId,
        slug: accountSlug?.slug ?? null,
        host: accountSlug ? host(accountSlug.slug, config.publicDomain) : null,
        tier: tier.name,
        limits: limitsView(tier.limits, leftGb),
        quota: {
          period,
          bytesIn: usage.bytesIn.toString(),
          bytesOut: usage.bytesOut.toString(),
          usedGb: Number(usage.total / BYTES_IN_GB),
          quotaGb: tier.limits.quotaGb,
          leftGb,
        },
        worlds: worlds.map((row) => ({
          worldId: row.worldId,
          slug: row.slug,
          host: host(row.slug, config.publicDomain),
        })),
        subscription: subscriptionView(subscription),
      };
    }),
  );
}
