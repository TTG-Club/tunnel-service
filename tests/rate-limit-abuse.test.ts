import { describe, expect, it } from 'vitest';
import { BYTES_IN_GB } from '../src/domain/limits.js';
import { createAbuseWatcher } from '../src/domain/usage/abuse.js';
import { createRateLimiter } from '../src/http/rate-limit.js';

describe('лимит запросов', () => {
  it('пропускает до предела и отсекает дальше', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ limit: 3, windowSeconds: 60, now: () => clock });

    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 0 });

    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('после окна счётчик обнуляется', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ limit: 1, windowSeconds: 60, now: () => clock });

    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);

    clock += 60_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('ключи не мешают друг другу', () => {
    const limiter = createRateLimiter({ limit: 1, windowSeconds: 60 });

    expect(limiter.hit('account-1').allowed).toBe(true);
    expect(limiter.hit('account-2').allowed).toBe(true);
    expect(limiter.hit('account-1').allowed).toBe(false);
  });

  it('не разрастается в памяти', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 10, now: () => clock });

    for (let i = 0; i < 100; i += 1) limiter.hit(`key-${i}`);

    expect(limiter.size).toBeLessThanOrEqual(11);
  });
});

describe('детектор резкого расхода', () => {
  const threshold = 100n * BYTES_IN_GB;

  it('молчит, пока прирост в пределах порога', () => {
    const watcher = createAbuseWatcher({ thresholdBytes: threshold });

    const verdict = watcher.record('account-1', 50n * BYTES_IN_GB);

    expect(verdict.spike).toBe(false);
    expect(verdict.windowBytes).toBe(50n * BYTES_IN_GB);
  });

  it('срабатывает, когда прирост за сутки перешагнул порог', () => {
    let clock = 1_700_000_000_000;
    const watcher = createAbuseWatcher({ thresholdBytes: threshold, now: () => clock });

    watcher.record('account-1', 60n * BYTES_IN_GB);
    clock += 3_600_000;
    const verdict = watcher.record('account-1', 60n * BYTES_IN_GB);

    expect(verdict.spike).toBe(true);
    expect(verdict.windowBytes).toBe(120n * BYTES_IN_GB);
  });

  it('не заливает лог: повторный сигнал не чаще раза в час', () => {
    let clock = 1_700_000_000_000;
    const watcher = createAbuseWatcher({ thresholdBytes: threshold, now: () => clock });

    expect(watcher.record('account-1', 150n * BYTES_IN_GB).spike).toBe(true);
    expect(watcher.record('account-1', 10n * BYTES_IN_GB).spike).toBe(false);

    clock += 3_600_000;
    expect(watcher.record('account-1', 10n * BYTES_IN_GB).spike).toBe(true);
  });

  it('старые часы выпадают из окна', () => {
    let clock = 1_700_000_000_000;
    const watcher = createAbuseWatcher({ thresholdBytes: threshold, windowHours: 24, now: () => clock });

    watcher.record('account-1', 90n * BYTES_IN_GB);
    clock += 25 * 3_600_000;
    const verdict = watcher.record('account-1', 20n * BYTES_IN_GB);

    expect(verdict.windowBytes).toBe(20n * BYTES_IN_GB);
    expect(verdict.spike).toBe(false);
  });

  it('повтор батча (нулевой прирост) ничего не поднимает', () => {
    const watcher = createAbuseWatcher({ thresholdBytes: threshold });

    watcher.record('account-1', 90n * BYTES_IN_GB);
    const verdict = watcher.record('account-1', 0n);

    expect(verdict.spike).toBe(false);
    expect(verdict.windowBytes).toBe(90n * BYTES_IN_GB);
  });

  it('аккаунты считаются раздельно', () => {
    const watcher = createAbuseWatcher({ thresholdBytes: threshold });

    expect(watcher.record('account-1', 90n * BYTES_IN_GB).spike).toBe(false);
    expect(watcher.record('account-2', 90n * BYTES_IN_GB).spike).toBe(false);
    expect(watcher.size).toBe(2);
  });
});
