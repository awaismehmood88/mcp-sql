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

export interface MssqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

// One named database connection. `tag` is what the agent passes as the
// `connection` argument; `description` is what it reads to decide which one.
export interface ConnectionConfig {
  tag: string;
  description: string;
  mssql: MssqlConfig;
  ssh: SshConfig | null;
}

export interface Config {
  // Ordered as listed in MSSQL_CONNECTIONS. The first one is the default
  // when a tool is called without an explicit `connection` and only one exists.
  connections: ConnectionConfig[];
  readOnly: boolean;
  hitlMode: HitlMode;
  pendingDir: string;
  queryTimeoutMs: number;
  approvalTimeoutMs: number;
  maxRows: number;
}

type Env = Record<string, string | undefined>;

const TAG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// `psa-edu` → `MSSQL_PSA_EDU_`
export const envPrefixForTag = (tag: string): string =>
  `MSSQL_${tag.toUpperCase().replace(/-/g, "_")}_`;

// Reads MSSQL_<TAG>_<KEY>, then MSSQL_<KEY>, then undefined. Empty strings
// count as unset so a blank line in .env doesn't shadow the fallback.
const makeLookup = (env: Env, prefix: string | null) => {
  const raw = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v;
  };
  return (key: string): string | undefined =>
    (prefix ? raw(`${prefix}${key}`) : undefined) ?? raw(`MSSQL_${key}`);
};
type Lookup = ReturnType<typeof makeLookup>;

const parseBool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v.trim());

const parseInt10 = (v: string | undefined, fallback: number, label: string): number => {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${label} must be an integer, got: ${v}`);
  return n;
};

const requireKey = (get: Lookup, key: string, prefix: string | null): string => {
  const v = get(key);
  if (v !== undefined) return v;
  const names = prefix ? `${prefix}${key} (or fallback MSSQL_${key})` : `MSSQL_${key}`;
  throw new Error(`Missing required env var: ${names}`);
};

const boolEnv = (env: Env, name: string, fallback: boolean): boolean =>
  parseBool(env[name], fallback);

const intEnv = (env: Env, name: string, fallback: number): number => {
  const v = env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return parseInt10(v, fallback, name);
};

const hitlModeEnv = (env: Env, fallback: HitlMode): HitlMode => {
  const v = env.MCP_HITL_MODE?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "interactive" || v === "dual_stage" || v === "off") return v;
  throw new Error(`MCP_HITL_MODE must be one of interactive|dual_stage|off, got: ${v}`);
};

const loadSshConfig = (get: Lookup, env: Env, prefix: string | null): SshConfig | null => {
  if (!parseBool(get("SSH_ENABLED"), false)) return null;
  const label = (key: string): string => (prefix ? `${prefix}${key}` : `MSSQL_${key}`);
  const privateKeyPath = get("SSH_PRIVATE_KEY_PATH")?.trim() || undefined;
  const password = get("SSH_PASSWORD");
  const useAgent = parseBool(get("SSH_USE_AGENT"), false);
  const agentSocket = get("SSH_AGENT_SOCK")?.trim() || env.SSH_AUTH_SOCK;
  if (!privateKeyPath && !password && !useAgent) {
    throw new Error(
      `${label("SSH_ENABLED")}=true requires one of: ${label("SSH_PRIVATE_KEY_PATH")}, ` +
        `${label("SSH_PASSWORD")}, or ${label("SSH_USE_AGENT")}=true.`,
    );
  }
  if (useAgent && !agentSocket) {
    throw new Error(
      `${label("SSH_USE_AGENT")}=true but neither ${label("SSH_AGENT_SOCK")} nor SSH_AUTH_SOCK is set. ` +
        "Is ssh-agent running? Try: eval \"$(ssh-agent -s)\" && ssh-add",
    );
  }
  return {
    host: requireKey(get, "SSH_HOST", prefix),
    port: parseInt10(get("SSH_PORT"), 22, label("SSH_PORT")),
    username: requireKey(get, "SSH_USER", prefix),
    privateKeyPath,
    passphrase: get("SSH_PASSPHRASE"),
    password,
    useAgent,
    agentSocket: useAgent ? agentSocket : undefined,
    localPort: parseInt10(get("SSH_LOCAL_PORT"), 0, label("SSH_LOCAL_PORT")), // 0 = pick a free port
  };
};

const loadConnection = (env: Env, tag: string, prefix: string | null): ConnectionConfig => {
  const get = makeLookup(env, prefix);
  const database = requireKey(get, "DATABASE", prefix);
  const label = (key: string): string => (prefix ? `${prefix}${key}` : `MSSQL_${key}`);
  return {
    tag,
    description: get("DESCRIPTION")?.trim() || database,
    mssql: {
      server: requireKey(get, "SERVER", prefix),
      port: parseInt10(get("PORT"), 1433, label("PORT")),
      database,
      user: requireKey(get, "USER", prefix),
      password: requireKey(get, "PASSWORD", prefix),
      encrypt: parseBool(get("ENCRYPT"), true),
      trustServerCertificate: parseBool(get("TRUST_SERVER_CERT"), false),
    },
    ssh: loadSshConfig(get, env, prefix),
  };
};

export const loadConnections = (env: Env = process.env): ConnectionConfig[] => {
  const listRaw = env.MSSQL_CONNECTIONS?.trim();
  if (!listRaw) {
    // Legacy single-connection layout: unprefixed MSSQL_* vars.
    const legacy = makeLookup(env, null);
    const database = requireKey(legacy, "DATABASE", null);
    const tag = env.MCP_SOURCE_LABEL?.trim() || database;
    if (!TAG_RE.test(tag)) {
      throw new Error(
        `Connection tag "${tag}" (from MCP_SOURCE_LABEL or MSSQL_DATABASE) must match ${TAG_RE}. ` +
          `Set MCP_SOURCE_LABEL to a simple name, or use MSSQL_CONNECTIONS.`,
      );
    }
    return [loadConnection(env, tag, null)];
  }

  const tags = listRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tags.length === 0) throw new Error("MSSQL_CONNECTIONS is set but contains no tags.");

  const seen = new Set<string>();
  return tags.map((tag) => {
    if (!TAG_RE.test(tag)) {
      throw new Error(`Connection tag "${tag}" in MSSQL_CONNECTIONS must match ${TAG_RE}.`);
    }
    const prefix = envPrefixForTag(tag);
    if (seen.has(prefix)) {
      throw new Error(`Duplicate connection tag "${tag}" in MSSQL_CONNECTIONS (prefix ${prefix}).`);
    }
    seen.add(prefix);
    return loadConnection(env, tag, prefix);
  });
};

export const loadConfig = (env: Env = process.env): Config => ({
  connections: loadConnections(env),
  readOnly: boolEnv(env, "MCP_READ_ONLY", true),
  hitlMode: hitlModeEnv(env, "interactive"),
  pendingDir: resolvePendingDir(import.meta.url, 1),
  queryTimeoutMs: intEnv(env, "MCP_QUERY_TIMEOUT_MS", 30000),
  approvalTimeoutMs: intEnv(env, "MCP_APPROVAL_TIMEOUT_MS", 5 * 60 * 1000),
  maxRows: intEnv(env, "MCP_MAX_ROWS", 1000),
});

export const connectionTags = (cfg: Config): string[] => cfg.connections.map((c) => c.tag);

// Resolve a connection by tag. With exactly one connection the tag may be
// omitted. Tag matching is case-insensitive so the agent can't trip on it.
export const getConnection = (cfg: Config, tag?: string | null): ConnectionConfig => {
  if (!tag) {
    if (cfg.connections.length === 1) return cfg.connections[0]!;
    throw new Error(
      `A \`connection\` is required because several are configured: ${connectionTags(cfg).join(", ")}.`,
    );
  }
  const wanted = tag.toLowerCase();
  const found = cfg.connections.find((c) => c.tag.toLowerCase() === wanted);
  if (!found) {
    throw new Error(`Unknown connection "${tag}". Available: ${connectionTags(cfg).join(", ")}.`);
  }
  return found;
};

// One-line summary the agent sees in tool descriptions.
export const describeConnections = (cfg: Config): string =>
  cfg.connections
    .map((c) => `- "${c.tag}": ${c.description} (database ${c.mssql.database} on ${c.mssql.server})`)
    .join("\n");
