export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Сколько ждать до следующей попытки, секунды. */
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

export interface RateLimiter {
  hit(key: string): RateLimitVerdict;
  readonly size: number;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly now?: () => number;
  /** Предел числа ключей в памяти, защита от разрастания. */
  readonly maxKeys?: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_KEYS = 50_000;

/**
 * Счётчик запросов в фиксированном окне, в памяти процесса.
 *
 * Задача — не дать через нас нагрузить subscriber.api: single-flight
 * схлопывает параллельные запросы одного аккаунта, но не спасает от многих
 * аккаунтов или от одного клиента, дёргающего тикет в цикле.
 *
 * Состояние не общее на инстансы: при нескольких репликах фактический лимит
 * умножается на их число. Для защиты от перебора этого достаточно; если
 * понадобится точный общий лимит — понадобится Redis.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const windowMs = options.windowSeconds * 1000;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, Bucket>();

  const prune = (current: number): void => {
    for (const [key, bucket] of buckets) {
      if (current - bucket.windowStart >= windowMs) buckets.delete(key);
    }
    // Окна ещё живы, но ключей слишком много — выкидываем самые старые.
    if (buckets.size > maxKeys) {
      const excess = buckets.size - maxKeys;
      let removed = 0;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        if (++removed >= excess) break;
      }
    }
  };

  return {
    get size() {
      return buckets.size;
    },

    hit(key) {
      const current = now();
      const bucket = buckets.get(key);

      if (!bucket || current - bucket.windowStart >= windowMs) {
        if (buckets.size >= maxKeys) prune(current);
        buckets.set(key, { count: 1, windowStart: current });
        return { allowed: true, retryAfterSeconds: 0, remaining: options.limit - 1 };
      }

      bucket.count += 1;
      if (bucket.count > options.limit) {
        const waitMs = windowMs - (current - bucket.windowStart);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
          remaining: 0,
        };
      }

      return { allowed: true, retryAfterSeconds: 0, remaining: options.limit - bucket.count };
    },
  };
}
