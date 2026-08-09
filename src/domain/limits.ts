export interface TierLimits {
  readonly maxStreams: number;
  readonly maxWorlds: number;
  /** Техническая квота трафика на календарный месяц, гигабайты. */
  readonly quotaGb: number;
}

/**
 * Тарифы.
 *
 * Тариф ровно один, и это не временное упрощение: у subscriber тарифов нет ни
 * как поля, ни как понятия. `GIFT`/`BUY` в его ответе — способ появления
 * подписки, а уровни промо-кодов (RewardTier) при погашении растворяются и в
 * подписку не переносятся. Правило простое: есть подписка — есть туннель с
 * фиксированными лимитами.
 *
 * Таблица оставлена таблицей, а не схлопнута в константу, чтобы появление
 * тарифов стало строчкой здесь: поле `tier` в тикете уже есть, брать его будет
 * откуда.
 */
export const TIERS: Readonly<Record<string, TierLimits>> = {
  pro: { maxStreams: 1000, maxWorlds: 5, quotaGb: 10_240 },
};

export interface ResolvedTier {
  readonly name: string;
  readonly limits: TierLimits;
}

export function isKnownTier(name: string): boolean {
  return Object.hasOwn(TIERS, name);
}

/**
 * Тариф тикета — константа из конфига (`TICKET_TIER`). Сводить к умолчанию
 * нечего: сообщать нам тариф некому.
 *
 * Имя проверяется при старте (createServices), поэтому на запросе исключения
 * быть не может.
 */
export function ticketTier(name: string): ResolvedTier {
  const limits = TIERS[name];
  if (!limits) throw new Error(`TICKET_TIER=${name}: такого тарифа нет в TIERS`);
  return { name, limits };
}

export const BYTES_IN_GB = 1_000_000_000n;

export function quotaBytes(limits: TierLimits): bigint {
  return BigInt(limits.quotaGb) * BYTES_IN_GB;
}

/**
 * Сколько гигабайт квоты осталось.
 *
 * Округление вверх, и это принципиально: ноль должен означать ровно
 * «квота исчерпана». С округлением вниз последние 999 МБ показывались бы как
 * 0 ГБ, и выдача тикета отказывала бы человеку, у которого квота ещё есть.
 */
export function quotaLeftGb(limits: TierLimits, usedBytes: bigint): number {
  const left = quotaBytes(limits) - usedBytes;
  if (left <= 0n) return 0;
  return Math.ceil(Number(left) / Number(BYTES_IN_GB));
}

/** Доля израсходованной квоты в процентах, для порога предупреждения. */
export function usedPercent(limits: TierLimits, usedBytes: bigint): number {
  const quota = quotaBytes(limits);
  if (quota <= 0n) return 100;
  return Number((usedBytes * 100n) / quota);
}
