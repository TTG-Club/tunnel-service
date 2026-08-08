export interface SpikeVerdict {
  /** Прирост за окно перешагнул порог, и об этом ещё не сообщали. */
  readonly spike: boolean;
  readonly windowBytes: bigint;
}

export interface AbuseWatcher {
  /** Учесть прирост расхода аккаунта. */
  record(accountId: string, deltaBytes: bigint): SpikeVerdict;
  readonly size: number;
}

export interface AbuseWatcherOptions {
  readonly thresholdBytes: bigint;
  readonly windowHours?: number;
  readonly now?: () => number;
  readonly maxAccounts?: number;
}

interface AccountWindow {
  /** Прирост по часам: [номер часа, байты]. */
  buckets: [number, bigint][];
  lastAlertHour: number | null;
}

const HOUR_MS = 3_600_000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_ACCOUNTS = 20_000;

/**
 * Детектор резкого расхода трафика.
 *
 * Ничего не блокирует — только даёт сигнал для ручного разбора. Квота в 10 ТБ
 * обычной игрой недостижима, поэтому «много за сутки» — более ранний признак
 * злоупотребления, чем исчерпание квоты.
 *
 * Окно живёт в памяти и обнуляется при перезапуске: для сигнала этого
 * достаточно, а тащить ради него ещё одну таблицу не хочется. Повторный
 * сигнал по тому же аккаунту — не чаще раза в час, чтобы не залить лог.
 */
export function createAbuseWatcher(options: AbuseWatcherOptions): AbuseWatcher {
  const now = options.now ?? Date.now;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const maxAccounts = options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS;
  const windows = new Map<string, AccountWindow>();

  return {
    get size() {
      return windows.size;
    },

    record(accountId, deltaBytes) {
      const hour = Math.floor(now() / HOUR_MS);

      if (deltaBytes <= 0n) {
        const existing = windows.get(accountId);
        const total = existing
          ? existing.buckets
              .filter(([bucketHour]) => hour - bucketHour < windowHours)
              .reduce((sum, [, bytes]) => sum + bytes, 0n)
          : 0n;
        return { spike: false, windowBytes: total };
      }

      let window = windows.get(accountId);
      if (!window) {
        if (windows.size >= maxAccounts) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
        }
        window = { buckets: [], lastAlertHour: null };
        windows.set(accountId, window);
      }

      window.buckets = window.buckets.filter(([bucketHour]) => hour - bucketHour < windowHours);
      const last = window.buckets.at(-1);
      if (last && last[0] === hour) last[1] += deltaBytes;
      else window.buckets.push([hour, deltaBytes]);

      const windowBytes = window.buckets.reduce((sum, [, bytes]) => sum + bytes, 0n);
      const crossed = windowBytes >= options.thresholdBytes;
      const alreadyAlerted = window.lastAlertHour !== null && hour - window.lastAlertHour < 1;

      if (crossed && !alreadyAlerted) {
        window.lastAlertHour = hour;
        return { spike: true, windowBytes };
      }

      return { spike: false, windowBytes };
    },
  };
}
