import sql from "mssql";
import { getConnection, type Config, type ConnectionConfig } from "./config.js";
import { log } from "./logger.js";
import { openSshTunnel, type ActiveTunnel } from "./ssh.js";

interface Live {
  pool: sql.ConnectionPool | null;
  tunnel: ActiveTunnel | null;
}

// One pool (and, if configured, one SSH tunnel) per connection tag.
const live = new Map<string, Live>();

const slot = (tag: string): Live => {
  let s = live.get(tag);
  if (!s) {
    s = { pool: null, tunnel: null };
    live.set(tag, s);
  }
  return s;
};

const ensureTunnel = async (conn: ConnectionConfig, s: Live): Promise<void> => {
  if (!conn.ssh) return;
  if (s.tunnel) return;
  s.tunnel = await openSshTunnel(conn.ssh, conn.mssql.server, conn.mssql.port);
};

export const getPool = async (cfg: Config, tag?: string | null): Promise<sql.ConnectionPool> => {
  const conn = getConnection(cfg, tag);
  const s = slot(conn.tag);
  if (s.pool && s.pool.connected) return s.pool;
  await ensureTunnel(conn, s);
  const server = s.tunnel ? s.tunnel.localHost : conn.mssql.server;
  const port = s.tunnel ? s.tunnel.localPort : conn.mssql.port;
  const p = new sql.ConnectionPool({
    server,
    port,
    database: conn.mssql.database,
    user: conn.mssql.user,
    password: conn.mssql.password,
    options: {
      encrypt: conn.mssql.encrypt,
      trustServerCertificate: conn.mssql.trustServerCertificate,
    },
    requestTimeout: cfg.queryTimeoutMs,
    pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
  });
  p.on("error", (err) => log.error("mssql pool error", { connection: conn.tag, message: err.message }));
  await p.connect();
  s.pool = p;
  log.info("connected to mssql", {
    connection: conn.tag,
    server: conn.mssql.server,
    database: conn.mssql.database,
    viaTunnel: s.tunnel ? { localHost: s.tunnel.localHost, localPort: s.tunnel.localPort } : false,
  });
  return p;
};

const closeOne = async (tag: string, s: Live): Promise<void> => {
  if (s.pool) {
    try {
      await s.pool.close();
    } catch (err) {
      log.warn("error closing mssql pool", { connection: tag, message: (err as Error).message });
    }
    s.pool = null;
  }
  if (s.tunnel) {
    try {
      await s.tunnel.close();
    } catch (err) {
      log.warn("error closing SSH tunnel", { connection: tag, message: (err as Error).message });
    }
    s.tunnel = null;
  }
};

// Closes every open pool and tunnel.
export const closePool = async (): Promise<void> => {
  await Promise.all([...live.entries()].map(([tag, s]) => closeOne(tag, s)));
  live.clear();
};

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  truncated: boolean;
}

export const runQuery = async (
  cfg: Config,
  tag: string | null | undefined,
  text: string,
): Promise<QueryResult> => {
  const p = await getPool(cfg, tag);
  const req = p.request();
  const result = await req.query(text);
  const recordset = result.recordset ?? [];
  const truncated = recordset.length > cfg.maxRows;
  const rows = truncated ? recordset.slice(0, cfg.maxRows) : recordset;
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  return {
    rows: rows as Record<string, unknown>[],
    columns,
    rowCount: rows.length,
    truncated,
  };
};
