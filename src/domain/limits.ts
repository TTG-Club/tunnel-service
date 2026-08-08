import type { Logger } from '../logger.js';

export interface TierLimits {
  readonly maxStreams: number;
  readonly maxWorlds: number;
  /** Техническая квота трафика на календарный месяц, гигабайты. */
  readonly quotaGb: number;
}

/**
 * Тарифы. Это не биллинг: деньги считает subscriber.api, здесь только
 * технические лимиты, которые уезжают в тикет и которые проверяет нода.
 */
export const TIERS: Readonly<Record<string, TierLimits>> = {
  free: { maxStreams: 50, maxWorlds: 1, quotaGb: 5 },
  pro: { maxStreams: 200, maxWorlds: 5, quotaGb: 50 },
};

export interface ResolvedTier {
  readonly name: string;
  readonly limits: TierLimits;
}

/**
 * `tier` в ответе subscriber.api пока нет — читаем с фолбэком на значение по
 * умолчанию. Незнакомый тариф тоже сводим к дефолтному, но с warning: лучше
 * пустить играть по базовым лимитам, чем отказать из-за нового названия.
 */
export function resolveTier(raw: string | null | undefined, defaultTier: string, logger: Logger): ResolvedTier {
  const fallbackLimits = TIERS[defaultTier];
  if (!fallbackLimits) {
    throw new Error(`SUBSCRIPTION_DEFAULT_TIER=${defaultTier}: такого тарифа нет в TIERS`);
  }

  if (!raw) return { name: defaultTier, limits: fallbackLimits };

  const known = TIERS[raw];
  if (known) return { name: raw, limits: known };

  logger.warn('неизвестный тариф от subscriber.api, применяю тариф по умолчанию', {
    tier: raw,
    defaultTier,
  });
  return { name: defaultTier, limits: fallbackLimits };
}

export const BYTES_IN_GB = 1_000_000_000n;

/**
 * Сколько гигабайт квоты осталось.
 *
 * Округление вверх, и это принципиально: ноль должен означать ровно
 * «квота исчерпана». С округлением вниз последние 999 МБ показывались бы как
 * 0 ГБ, и выдача тикета отказывала бы человеку, у которого квота ещё есть.
 */
export function quotaLeftGb(limits: TierLimits, usedBytes: bigint): number {
  const quotaBytes = BigInt(limits.quotaGb) * BYTES_IN_GB;
  const left = quotaBytes - usedBytes;
  if (left <= 0n) return 0;
  return Math.ceil(Number(left) / Number(BYTES_IN_GB));
}
