import sql from "mssql";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import { openSshTunnel, type ActiveTunnel } from "./ssh.js";

let pool: sql.ConnectionPool | null = null;
let tunnel: ActiveTunnel | null = null;

const ensureTunnel = async (cfg: Config): Promise<void> => {
  if (!cfg.ssh) return;
  if (tunnel) return;
  tunnel = await openSshTunnel(cfg.ssh, cfg.mssql.server, cfg.mssql.port);
};

export const getPool = async (cfg: Config): Promise<sql.ConnectionPool> => {
  if (pool && pool.connected) return pool;
  await ensureTunnel(cfg);
  const server = tunnel ? tunnel.localHost : cfg.mssql.server;
  const port = tunnel ? tunnel.localPort : cfg.mssql.port;
  const p = new sql.ConnectionPool({
    server,
    port,
    database: cfg.mssql.database,
    user: cfg.mssql.user,
    password: cfg.mssql.password,
    options: {
      encrypt: cfg.mssql.encrypt,
      trustServerCertificate: cfg.mssql.trustServerCertificate,
    },
    requestTimeout: cfg.queryTimeoutMs,
    pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
  });
  p.on("error", (err) => log.error("mssql pool error", { message: err.message }));
  await p.connect();
  pool = p;
  log.info("connected to mssql", {
    server: cfg.mssql.server,
    database: cfg.mssql.database,
    viaTunnel: tunnel
      ? { localHost: tunnel.localHost, localPort: tunnel.localPort }
      : false,
  });
  return pool;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    try {
      await pool.close();
    } catch (err) {
      log.warn("error closing mssql pool", { message: (err as Error).message });
    }
    pool = null;
  }
  if (tunnel) {
    try {
      await tunnel.close();
    } catch (err) {
      log.warn("error closing SSH tunnel", { message: (err as Error).message });
    }
    tunnel = null;
  }
};

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  truncated: boolean;
}

export const runQuery = async (cfg: Config, text: string): Promise<QueryResult> => {
  const p = await getPool(cfg);
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
