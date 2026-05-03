import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from a fixed location next to the installed server, so creds work
// regardless of the cwd Claude Code (or anything else) spawns us from.
// dist/config.js → ../  → project root, where .env lives.
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "..", ".env");
loadDotenv({ path: envPath });
// Fall back to default cwd-based load too, so `npm run dev` from the project
// root keeps working unchanged.
loadDotenv();

export type HitlMode = "interactive" | "dual_stage" | "off";

export interface Config {
  mssql: {
    server: string;
    port: number;
    database: string;
    user: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  readOnly: boolean;
  hitlMode: HitlMode;
  pendingDir: string;
  queryTimeoutMs: number;
  maxRows: number;
}

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

const boolEnv = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const intEnv = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer, got: ${v}`);
  return n;
};

const hitlModeEnv = (fallback: HitlMode): HitlMode => {
  const v = process.env.MCP_HITL_MODE?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "interactive" || v === "dual_stage" || v === "off") return v;
  throw new Error(`MCP_HITL_MODE must be one of interactive|dual_stage|off, got: ${v}`);
};

export const loadConfig = (): Config => ({
  mssql: {
    server: required("MSSQL_SERVER"),
    port: intEnv("MSSQL_PORT", 1433),
    database: required("MSSQL_DATABASE"),
    user: required("MSSQL_USER"),
    password: required("MSSQL_PASSWORD"),
    encrypt: boolEnv("MSSQL_ENCRYPT", true),
    trustServerCertificate: boolEnv("MSSQL_TRUST_SERVER_CERT", false),
  },
  readOnly: boolEnv("MCP_READ_ONLY", true),
  hitlMode: hitlModeEnv("interactive"),
  pendingDir: process.env.MCP_PENDING_DIR?.trim() || ".mcp-pending",
  queryTimeoutMs: intEnv("MCP_QUERY_TIMEOUT_MS", 30000),
  maxRows: intEnv("MCP_MAX_ROWS", 1000),
});
