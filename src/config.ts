import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolvePendingDir } from "./paths.js";

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

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  // Exactly one of (privateKeyPath, password, useAgent) is required.
  // Priority if multiple set: privateKeyPath > password > useAgent.
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  // If true, authenticate via ssh-agent using $SSH_AUTH_SOCK (or override).
  useAgent: boolean;
  agentSocket?: string;
  // Local port to bind the tunnel to. If 0/undefined, an ephemeral port is
  // picked at runtime and stitched into the mssql pool config.
  localPort: number;
}

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
  ssh: SshConfig | null;
  readOnly: boolean;
  hitlMode: HitlMode;
  pendingDir: string;
  queryTimeoutMs: number;
  approvalTimeoutMs: number;
  maxRows: number;
  sourceLabel: string;
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

const loadSshConfig = (): SshConfig | null => {
  if (!boolEnv("MSSQL_SSH_ENABLED", false)) return null;
  const privateKeyPath = process.env.MSSQL_SSH_PRIVATE_KEY_PATH?.trim() || undefined;
  const password = process.env.MSSQL_SSH_PASSWORD ?? undefined;
  const useAgent = boolEnv("MSSQL_SSH_USE_AGENT", false);
  const agentSocket = process.env.MSSQL_SSH_AGENT_SOCK?.trim() || process.env.SSH_AUTH_SOCK;
  if (!privateKeyPath && !password && !useAgent) {
    throw new Error(
      "MSSQL_SSH_ENABLED=true requires one of: MSSQL_SSH_PRIVATE_KEY_PATH, " +
        "MSSQL_SSH_PASSWORD, or MSSQL_SSH_USE_AGENT=true.",
    );
  }
  if (useAgent && !agentSocket) {
    throw new Error(
      "MSSQL_SSH_USE_AGENT=true but neither MSSQL_SSH_AGENT_SOCK nor SSH_AUTH_SOCK is set. " +
        "Is ssh-agent running? Try: eval \"$(ssh-agent -s)\" && ssh-add",
    );
  }
  return {
    host: required("MSSQL_SSH_HOST"),
    port: intEnv("MSSQL_SSH_PORT", 22),
    username: required("MSSQL_SSH_USER"),
    privateKeyPath,
    passphrase: process.env.MSSQL_SSH_PASSPHRASE ?? undefined,
    password,
    useAgent,
    agentSocket: useAgent ? agentSocket : undefined,
    localPort: intEnv("MSSQL_SSH_LOCAL_PORT", 0), // 0 = pick a free port
  };
};

export const loadConfig = (): Config => {
  const database = required("MSSQL_DATABASE");
  return {
    mssql: {
      server: required("MSSQL_SERVER"),
      port: intEnv("MSSQL_PORT", 1433),
      database,
      user: required("MSSQL_USER"),
      password: required("MSSQL_PASSWORD"),
      encrypt: boolEnv("MSSQL_ENCRYPT", true),
      trustServerCertificate: boolEnv("MSSQL_TRUST_SERVER_CERT", false),
    },
    ssh: loadSshConfig(),
    readOnly: boolEnv("MCP_READ_ONLY", true),
    hitlMode: hitlModeEnv("interactive"),
    pendingDir: resolvePendingDir(import.meta.url, 1),
    queryTimeoutMs: intEnv("MCP_QUERY_TIMEOUT_MS", 30000),
    approvalTimeoutMs: intEnv("MCP_APPROVAL_TIMEOUT_MS", 5 * 60 * 1000),
    maxRows: intEnv("MCP_MAX_ROWS", 1000),
    sourceLabel: process.env.MCP_SOURCE_LABEL?.trim() || database,
  };
};
