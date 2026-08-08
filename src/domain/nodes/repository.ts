import type { Pool } from 'pg';

export type NodeStatus = 'active' | 'draining' | 'down';

export interface NodeRow {
  readonly id: string;
  readonly hostname: string;
  readonly region: string | null;
  readonly status: NodeStatus;
  readonly lastSeenAt: Date | null;
  readonly tunnels: number;
  readonly streams: number;
}

export interface HeartbeatInput {
  readonly nodeId: string;
  readonly hostname: string;
  readonly region: string | null;
  readonly status: NodeStatus;
  readonly tunnels: number;
  readonly streams: number;
}

export interface NodeRepository {
  /** Ноды, готовые принимать туннели: active и с недавним heartbeat. */
  listHealthy(heartbeatTimeoutSeconds: number): Promise<NodeRow[]>;
  get(nodeId: string): Promise<NodeRow | null>;
  upsertHeartbeat(input: HeartbeatInput): Promise<NodeRow>;
}

interface DbNodeRow {
  id: string;
  hostname: string;
  region: string | null;
  status: string;
  last_seen_at: Date | null;
  tunnels: number;
  streams: number;
}

const COLUMNS = 'id, hostname, region, status, last_seen_at, tunnels, streams';

function mapRow(row: DbNodeRow): NodeRow {
  return {
    id: row.id,
    hostname: row.hostname,
    region: row.region,
    status: row.status as NodeStatus,
    lastSeenAt: row.last_seen_at,
    tunnels: row.tunnels,
    streams: row.streams,
  };
}

export function createNodeRepository(pool: Pool): NodeRepository {
  return {
    async listHealthy(heartbeatTimeoutSeconds) {
      const { rows } = await pool.query<DbNodeRow>(
        `select ${COLUMNS}
         from nodes
         where status = 'active'
           and last_seen_at is not null
           and last_seen_at > now() - ($1::int * interval '1 second')
         order by id`,
        [heartbeatTimeoutSeconds],
      );
      return rows.map(mapRow);
    },

    async get(nodeId) {
      const { rows } = await pool.query<DbNodeRow>(`select ${COLUMNS} from nodes where id = $1`, [nodeId]);
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async upsertHeartbeat(input) {
      const { rows } = await pool.query<DbNodeRow>(
        `insert into nodes (id, hostname, region, status, last_seen_at, tunnels, streams)
         values ($1, $2, $3, $4, now(), $5, $6)
         on conflict (id) do update
           set hostname = excluded.hostname,
               region = coalesce(excluded.region, nodes.region),
               status = excluded.status,
               last_seen_at = now(),
               tunnels = excluded.tunnels,
               streams = excluded.streams
         returning ${COLUMNS}`,
        [input.nodeId, input.hostname, input.region, input.status, input.tunnels, input.streams],
      );
      return mapRow(rows[0] as DbNodeRow);
    },
  };
}
