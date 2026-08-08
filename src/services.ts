import { readFileSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { createPool, type Pool } from './db/pool.js';
import { createNodeRepository, type NodeRepository } from './domain/nodes/repository.js';
import { createSlugRepository, type SlugRepository } from './domain/slug/repository.js';
import { createSlugService, type SlugService } from './domain/slug/service.js';
import { loadStopList } from './domain/slug/stoplist.js';
import { createTicketKeyring, type TicketKeyring } from './domain/ticket/keys.js';
import { createUsageRepository, type UsageRepository } from './domain/usage/repository.js';
import type { Logger } from './logger.js';
import { createUserTokenVerifier, type UserTokenVerifier } from './upstream/auth.js';
import { createSubscriptionService, type SubscriptionService } from './upstream/subscriber.js';
import { fromPackageRoot } from './util/paths.js';

export interface Lifecycle {
  shuttingDown: boolean;
}

export interface AppServices {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly version: string;
  readonly pool: Pool;
  readonly keyring: TicketKeyring;
  readonly slugs: SlugService;
  readonly slugRepository: SlugRepository;
  readonly nodes: NodeRepository;
  readonly usage: UsageRepository;
  readonly subscription: SubscriptionService;
  readonly auth: UserTokenVerifier;
  readonly lifecycle: Lifecycle;
}

function readVersion(): string {
  try {
    const raw = readFileSync(fromPackageRoot('package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? String((parsed as { version: unknown }).version)
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Сборка зависимостей. Всё, что может упасть из-за конфигурации (ключи
 * подписи, стоп-лист), падает здесь — до того, как сервис начнёт слушать порт.
 */
export async function createServices(config: AppConfig, logger: Logger): Promise<AppServices> {
  const pool = createPool(config, logger);
  const keyring = await createTicketKeyring(config);
  const stopList = loadStopList(config.slug.stoplistPath, logger);

  const slugRepository = createSlugRepository(pool);

  logger.info('ключи подписи тикетов загружены', {
    alg: keyring.alg,
    signingKid: keyring.signing.kid,
    kids: keyring.verification.map((key) => key.kid),
  });

  return {
    config,
    logger,
    version: readVersion(),
    pool,
    keyring,
    slugRepository,
    slugs: createSlugService({ repository: slugRepository, stopList, logger }),
    nodes: createNodeRepository(pool),
    usage: createUsageRepository(pool),
    subscription: createSubscriptionService({ config, logger }),
    auth: createUserTokenVerifier(config, logger),
    lifecycle: { shuttingDown: false },
  };
}
