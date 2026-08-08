import type { Logger } from '../../logger.js';
import { randomToken, stableToken } from '../../util/random.js';
import {
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_TOTAL,
  SLUG_MIN_LENGTH,
  isValidSlugShape,
  normalizeSlugCandidate,
  withSuffix,
} from './normalize.js';
import { isReservedSlug } from './reserved.js';
import type { SlugRepository, SlugRow } from './repository.js';
import type { StopList } from './stoplist.js';

export class SlugAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlugAllocationError';
  }
}

const SUFFIX_LENGTH = 6;
const DEFAULT_MAX_ATTEMPTS = 8;

export type CandidateReason = 'name' | 'too-short' | 'reserved' | 'blocked' | 'empty';

export interface AccountCandidate {
  readonly base: string;
  /** Основу нельзя выдавать как есть — только с суффиксом. */
  readonly forceSuffix: boolean;
  readonly reason: CandidateReason;
}

function fallbackBase(accountId: string): string {
  return `u${accountId}`;
}

/**
 * Имя аккаунта -> основа слага.
 *
 * Мат не «дополняем суффиксом», а выбрасываем целиком: `huy-a7k2m9` — всё
 * ещё мат. Резервное и слишком короткое имя основой остаться могут, но только
 * с суффиксом.
 */
export function buildAccountCandidate(
  displayName: string | null,
  accountId: string,
  stopList: StopList,
): AccountCandidate {
  const normalized = normalizeSlugCandidate(displayName ?? '');

  if (normalized === '') {
    return { base: fallbackBase(accountId), forceSuffix: true, reason: 'empty' };
  }
  if (stopList.contains(normalized)) {
    return { base: fallbackBase(accountId), forceSuffix: true, reason: 'blocked' };
  }
  if (normalized.length < SLUG_MIN_LENGTH) {
    return { base: normalized, forceSuffix: true, reason: 'too-short' };
  }
  if (isReservedSlug(normalized)) {
    return { base: normalized, forceSuffix: true, reason: 'reserved' };
  }
  return { base: normalized, forceSuffix: false, reason: 'name' };
}

export interface SlugService {
  /** Слаг аккаунта. Выдаётся один раз и навсегда. */
  ensureAccountSlug(accountId: string, displayName: string | null): Promise<SlugRow>;
  /** Слаг мира: слаг аккаунта + дефис + стабильный короткий id мира. */
  ensureWorldSlug(accountId: string, parentSlug: string, worldId: string): Promise<SlugRow>;
}

export interface SlugServiceDeps {
  readonly repository: SlugRepository;
  readonly stopList: StopList;
  readonly logger: Logger;
  readonly maxAttempts?: number;
}

export function createSlugService(deps: SlugServiceDeps): SlugService {
  const { repository, stopList, logger } = deps;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return {
    async ensureAccountSlug(accountId, displayName) {
      const existing = await repository.findAccountSlug(accountId);
      if (existing) return existing;

      const candidate = buildAccountCandidate(displayName, accountId, stopList);

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const slug =
          attempt === 0 && !candidate.forceSuffix
            ? candidate.base
            : withSuffix(candidate.base, randomToken(SUFFIX_LENGTH), SLUG_MAX_LENGTH);

        // Суффикс случайный: теоретически может сложиться в запрещённое слово.
        if (!isValidSlugShape(slug, SLUG_MIN_LENGTH, SLUG_MAX_LENGTH) || stopList.contains(slug)) {
          continue;
        }

        const outcome = await repository.insertAccountSlug(slug, accountId);

        if (outcome.ok) {
          logger.info('выдан слаг аккаунта', {
            accountId,
            slug,
            attempt,
            reason: candidate.reason,
          });
          return outcome.row;
        }

        if (outcome.reason === 'owner_has_slug') {
          // Параллельный запрос успел раньше — берём то, что он завёл.
          const row = await repository.findAccountSlug(accountId);
          if (row) return row;
          throw new SlugAllocationError(
            `Аккаунт ${accountId}: конфликт уникальности без записи в базе — состояние противоречиво`,
          );
        }

        logger.debug('слаг занят, пробую следующий', { accountId, slug, attempt });
      }

      throw new SlugAllocationError(
        `Не удалось подобрать свободный слаг для аккаунта ${accountId} за ${maxAttempts} попыток`,
      );
    },

    async ensureWorldSlug(accountId, parentSlug, worldId) {
      const existing = await repository.findWorldSlug(accountId, worldId);
      if (existing) return existing;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // Первая попытка — детерминированный id: пересоздание мира с тем же
        // worldId даёт тот же адрес. Дальше — случайные суффиксы.
        const suffix = attempt === 0 ? stableToken(worldId, SUFFIX_LENGTH) : randomToken(SUFFIX_LENGTH);
        const slug = withSuffix(parentSlug, suffix, SLUG_MAX_LENGTH_TOTAL);

        if (!isValidSlugShape(slug) || stopList.contains(slug)) continue;

        const outcome = await repository.insertWorldSlug({ slug, accountId, parentSlug, worldId });

        if (outcome.ok) {
          logger.info('выдан слаг мира', { accountId, slug, worldId, attempt });
          return outcome.row;
        }

        if (outcome.reason === 'owner_has_slug') {
          const row = await repository.findWorldSlug(accountId, worldId);
          if (row) return row;
          throw new SlugAllocationError(
            `Мир ${worldId} аккаунта ${accountId}: конфликт уникальности без записи в базе`,
          );
        }

        logger.debug('слаг мира занят, пробую следующий', { accountId, slug, worldId, attempt });
      }

      throw new SlugAllocationError(
        `Не удалось подобрать свободный слаг для мира ${worldId} за ${maxAttempts} попыток`,
      );
    },
  };
}
