import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool.js';

export interface AccountUsage {
  readonly bytesIn: bigint;
  readonly bytesOut: bigint;
  readonly total: bigint;
}

export interface UsageReportItem {
  readonly accountId: string;
  readonly period: string;
  readonly bytesIn: bigint;
  readonly bytesOut: bigint;
}

/** Насколько вырос расход аккаунта этим батчем. */
export interface UsageDelta {
  readonly accountId: string;
  readonly period: string;
  readonly deltaBytes: bigint;
  readonly totalBytes: bigint;
}

export interface ApplyUsageResult {
  /** Сколько строк (node_id, account_id, period) затронуто. */
  readonly applied: number;
  /** Сколько агрегатов (account_id, period) пересчитано. */
  readonly accounts: number;
  /**
   * Сколько строк пришло со счётчиком меньше сохранённого. Признак того, что
   * нода потеряла состояние: такие значения игнорируются.
   */
  readonly regressions: number;
  /**
   * Прирост по каждому аккаунту. Считается как разница агрегата до и после,
   * поэтому повтор батча даёт ноль — на этом строится детектор всплесков.
   */
  readonly deltas: readonly UsageDelta[];
}

export interface UsageRepository {
  getAccountUsage(accountId: string, period: string): Promise<AccountUsage>;
  applyNodeUsage(nodeId: string, items: readonly UsageReportItem[]): Promise<ApplyUsageResult>;
  /** Запоминает, что этой ноде выдавался тикет для этого аккаунта. */
  rememberTicketGrant(accountId: string, nodeId: string): Promise<void>;
  /**
   * Отбирает из списка те аккаунты, которым эта нода действительно выдавалась.
   *
   * Отчёт о трафике приходит с общим секретом нод, поэтому одна
   * скомпрометированная нода могла записать расход ЛЮБОМУ аккаунту и
   * исчерпать ему квоту. Сервис сам выбирает ноду при выдаче тикета — здесь
   * он этой памятью и пользуется.
   */
  filterGrantedAccounts(nodeId: string, accountIds: readonly string[]): Promise<Set<string>>;
}

/** Период учёта — календарный месяц по UTC: '2026-08'. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Внутри одного батча ключ может встретиться дважды — берём максимум.
 * Без этого `insert ... on conflict` упал бы с «cannot affect row a second time».
 */
function dedupe(items: readonly UsageReportItem[]): UsageReportItem[] {
  const byKey = new Map<string, UsageReportItem>();
  for (const item of items) {
    const key = `${item.accountId} ${item.period}`;
    const previous = byKey.get(key);
    byKey.set(
      key,
      previous
        ? {
            accountId: item.accountId,
            period: item.period,
            bytesIn: previous.bytesIn > item.bytesIn ? previous.bytesIn : item.bytesIn,
            bytesOut: previous.bytesOut > item.bytesOut ? previous.bytesOut : item.bytesOut,
          }
        : item,
    );
  }
  return [...byKey.values()];
}

export function createUsageRepository(pool: Pool): UsageRepository {
  return {
    async rememberTicketGrant(accountId, nodeId) {
      await pool.query(
        `insert into ticket_grants (account_id, node_id)
         values ($1, $2)
         on conflict (account_id, node_id) do update set issued_at = now()`,
        [accountId, nodeId],
      );
    },

    async filterGrantedAccounts(nodeId, accountIds) {
      if (accountIds.length === 0) return new Set<string>();

      const { rows } = await pool.query<{ account_id: string }>(
        `select account_id from ticket_grants
          where node_id = $1 and account_id = any($2::uuid[])`,
        [nodeId, [...new Set(accountIds)]],
      );

      return new Set(rows.map((row) => row.account_id));
    },

    async getAccountUsage(accountId, period) {
      const { rows } = await pool.query<{ bytes_in: string; bytes_out: string }>(
        'select bytes_in, bytes_out from usage where account_id = $1 and period = $2',
        [accountId, period],
      );
      const row = rows[0];
      const bytesIn = row ? BigInt(row.bytes_in) : 0n;
      const bytesOut = row ? BigInt(row.bytes_out) : 0n;
      return { bytesIn, bytesOut, total: bytesIn + bytesOut };
    },

    /**
     * Нода присылает накопительный счётчик за период, а не дельту. Поэтому
     * повтор того же батча даёт те же числа и агрегат не удваивается —
     * идемпотентность по (node_id, account_id, period).
     *
     * `greatest` защищает от отката счётчика: если нода потеряла состояние и
     * начала считать заново, мы не уменьшаем уже учтённый расход (лучше
     * недосчитать чужой трафик, чем ошибочно заблокировать оплаченный).
     */
    async applyNodeUsage(nodeId, rawItems) {
      const items = dedupe(rawItems);
      if (items.length === 0) return { applied: 0, accounts: 0, regressions: 0, deltas: [] };

      const nodeIds = items.map(() => nodeId);
      const accountIds = items.map((item) => item.accountId);
      const periods = items.map((item) => item.period);
      const bytesIn = items.map((item) => item.bytesIn.toString());
      const bytesOut = items.map((item) => item.bytesOut.toString());

      return withTransaction(pool, async (client) => {
        // Агрегат до применения батча — из него считаем прирост.
        const before = await client.query<{ account_id: string; period: string; total: string }>(
          `select u.account_id, u.period, (u.bytes_in + u.bytes_out)::text as total
           from usage u
           join (select distinct account_id, period
                 from unnest($1::uuid[], $2::text[]) as k(account_id, period)) k
             on k.account_id = u.account_id and k.period = u.period`,
          [accountIds, periods],
        );
        const totalsBefore = new Map(
          before.rows.map((row) => [`${row.account_id} ${row.period}`, BigInt(row.total)]),
        );

        const upserted = await client.query<{
          account_id: string;
          period: string;
          bytes_in: string;
          bytes_out: string;
        }>(
          `insert into node_usage (node_id, account_id, period, bytes_in, bytes_out, updated_at)
           select node_id, account_id, period, bytes_in, bytes_out, now()
           from unnest($1::text[], $2::uuid[], $3::text[], $4::bigint[], $5::bigint[])
             as t(node_id, account_id, period, bytes_in, bytes_out)
           on conflict (node_id, account_id, period) do update
             set bytes_in = greatest(node_usage.bytes_in, excluded.bytes_in),
                 bytes_out = greatest(node_usage.bytes_out, excluded.bytes_out),
                 updated_at = now()
           returning account_id, period, bytes_in, bytes_out`,
          [nodeIds, accountIds, periods, bytesIn, bytesOut],
        );

        // Сохранённое больше присланного — счётчик ноды откатился назад.
        // Сопоставляем по ключу: порядок строк returning не гарантирован.
        const sent = new Map(items.map((item) => [`${item.accountId} ${item.period}`, item]));
        let regressions = 0;
        for (const row of upserted.rows) {
          const item = sent.get(`${row.account_id} ${row.period}`);
          if (!item) continue;
          if (BigInt(row.bytes_in) > item.bytesIn || BigInt(row.bytes_out) > item.bytesOut) {
            regressions += 1;
          }
        }

        // Агрегат пересчитываем из node_usage целиком: он всегда равен сумме
        // вкладов всех нод, сколько бы раз батч ни повторился.
        const aggregated = await client.query<{ account_id: string; period: string; total: string }>(
          `insert into usage (account_id, period, bytes_in, bytes_out, updated_at)
           select nu.account_id, nu.period, sum(nu.bytes_in), sum(nu.bytes_out), now()
           from node_usage nu
           join (select distinct account_id, period
                 from unnest($1::uuid[], $2::text[]) as k(account_id, period)) k
             on k.account_id = nu.account_id and k.period = nu.period
           group by nu.account_id, nu.period
           on conflict (account_id, period) do update
             set bytes_in = excluded.bytes_in,
                 bytes_out = excluded.bytes_out,
                 updated_at = now()
           returning account_id, period, (bytes_in + bytes_out)::text as total`,
          [accountIds, periods],
        );

        const deltas = aggregated.rows.map((row) => {
          const total = BigInt(row.total);
          const previous = totalsBefore.get(`${row.account_id} ${row.period}`) ?? 0n;
          return {
            accountId: row.account_id,
            period: row.period,
            deltaBytes: total - previous,
            totalBytes: total,
          };
        });

        return {
          applied: upserted.rowCount ?? 0,
          accounts: aggregated.rowCount ?? 0,
          regressions,
          deltas,
        };
      });
    },
  };
}
