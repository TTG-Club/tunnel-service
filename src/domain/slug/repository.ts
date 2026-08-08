import type { Pool } from 'pg';
import { PG_UNIQUE_VIOLATION, pgConstraint, pgErrorCode } from '../../db/pool.js';

export type SlugKind = 'account' | 'world';

export interface SlugRow {
  readonly slug: string;
  readonly accountId: string;
  readonly kind: SlugKind;
  readonly parentSlug: string | null;
  readonly worldId: string | null;
  readonly createdAt: Date;
}

/**
 * Результат вставки. Конфликт уникальности — штатная ситуация, а не
 * исключение: `slug_taken` — адрес занят кем-то другим, надо пробовать
 * следующий; `owner_has_slug` — параллельный запрос уже завёл слаг этому
 * аккаунту или миру, надо перечитать.
 */
export type InsertOutcome =
  | { readonly ok: true; readonly row: SlugRow }
  | { readonly ok: false; readonly reason: 'slug_taken' | 'owner_has_slug' };

export interface SlugRepository {
  findAccountSlug(accountId: string): Promise<SlugRow | null>;
  findWorldSlug(accountId: string, worldId: string): Promise<SlugRow | null>;
  listWorldSlugs(accountId: string): Promise<SlugRow[]>;
  insertAccountSlug(slug: string, accountId: string): Promise<InsertOutcome>;
  insertWorldSlug(input: {
    slug: string;
    accountId: string;
    parentSlug: string;
    worldId: string;
  }): Promise<InsertOutcome>;
}

interface DbSlugRow {
  slug: string;
  account_id: string;
  kind: string;
  parent_slug: string | null;
  world_id: string | null;
  created_at: Date;
}

const COLUMNS = 'slug, account_id, kind, parent_slug, world_id, created_at';

function mapRow(row: DbSlugRow): SlugRow {
  return {
    slug: row.slug,
    accountId: row.account_id,
    kind: row.kind as SlugKind,
    parentSlug: row.parent_slug,
    worldId: row.world_id,
    createdAt: row.created_at,
  };
}

function classifyUniqueViolation(error: unknown): InsertOutcome | null {
  if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) return null;

  const constraint = pgConstraint(error);
  // slugs_pkey — адрес занят другим аккаунтом.
  // slugs_one_per_account / slugs_one_per_world — владелец уже получил слаг
  // в параллельном запросе.
  return constraint === 'slugs_pkey' || constraint === null
    ? { ok: false, reason: 'slug_taken' }
    : { ok: false, reason: 'owner_has_slug' };
}

export function createSlugRepository(pool: Pool): SlugRepository {
  return {
    async findAccountSlug(accountId) {
      const { rows } = await pool.query<DbSlugRow>(
        `select ${COLUMNS} from slugs where account_id = $1 and kind = 'account'`,
        [accountId],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async findWorldSlug(accountId, worldId) {
      const { rows } = await pool.query<DbSlugRow>(
        `select ${COLUMNS} from slugs where account_id = $1 and kind = 'world' and world_id = $2`,
        [accountId, worldId],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async listWorldSlugs(accountId) {
      const { rows } = await pool.query<DbSlugRow>(
        `select ${COLUMNS} from slugs where account_id = $1 and kind = 'world' order by created_at`,
        [accountId],
      );
      return rows.map(mapRow);
    },

    async insertAccountSlug(slug, accountId) {
      try {
        const { rows } = await pool.query<DbSlugRow>(
          `insert into slugs (slug, account_id, kind) values ($1, $2, 'account') returning ${COLUMNS}`,
          [slug, accountId],
        );
        return { ok: true, row: mapRow(rows[0] as DbSlugRow) };
      } catch (error) {
        const outcome = classifyUniqueViolation(error);
        if (outcome) return outcome;
        throw error;
      }
    },

    async insertWorldSlug({ slug, accountId, parentSlug, worldId }) {
      try {
        const { rows } = await pool.query<DbSlugRow>(
          `insert into slugs (slug, account_id, kind, parent_slug, world_id)
           values ($1, $2, 'world', $3, $4)
           returning ${COLUMNS}`,
          [slug, accountId, parentSlug, worldId],
        );
        return { ok: true, row: mapRow(rows[0] as DbSlugRow) };
      } catch (error) {
        const outcome = classifyUniqueViolation(error);
        if (outcome) return outcome;
        throw error;
      }
    },
  };
}
