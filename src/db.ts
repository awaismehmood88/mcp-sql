import sql from "mssql";
import type { Config } from "./config.js";
import { log } from "./logger.js";

let pool: sql.ConnectionPool | null = null;

export const getPool = async (cfg: Config): Promise<sql.ConnectionPool> => {
  if (pool && pool.connected) return pool;
  const p = new sql.ConnectionPool({
    server: cfg.mssql.server,
    port: cfg.mssql.port,
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
  log.info("connected to mssql", { server: cfg.mssql.server, database: cfg.mssql.database });
  return pool;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.close();
    pool = null;
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
