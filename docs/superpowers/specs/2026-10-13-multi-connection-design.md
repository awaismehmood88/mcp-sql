# Multi-connection support for mcp-mssql

**Date:** 2026-10-13
**Status:** approved by implementer under autonomous run; owner to review

## Goal

One running `mcp-mssql` server can expose several MSSQL databases. Each
connection has a short **tag** (e.g. `psa-edu`, `hrms`) and a human-written
**description**. The AI agent discovers the available connections from the
tool schema itself and picks the right one per call.

## Non-goals

- Cross-database joins or federated queries.
- Per-connection HITL mode / read-only mode. These stay global.
- Sharing one SSH tunnel across connections. Each connection opens its own.

## Env format

A connection list plus a prefixed block per tag. The tag is uppercased and
`-` becomes `_` to form the env prefix.

```bash
MSSQL_CONNECTIONS=psa-edu,hrms

MSSQL_PSA_EDU_DATABASE=PsaEdu
MSSQL_PSA_EDU_DESCRIPTION=PSA education portal: students, courses, enrollments
MSSQL_PSA_EDU_SERVER=10.0.0.5          # optional, falls back to MSSQL_SERVER
MSSQL_PSA_EDU_USER=ro_edu              # optional, falls back to MSSQL_USER
MSSQL_PSA_EDU_PASSWORD=...             # optional, falls back to MSSQL_PASSWORD

MSSQL_HRMS_DATABASE=Hrms
MSSQL_HRMS_DESCRIPTION=HR system: employees, leave, payroll
MSSQL_HRMS_SSH_ENABLED=true            # per-tag SSH, falls back to MSSQL_SSH_*
MSSQL_HRMS_SSH_HOST=bastion2

# Shared defaults for every tag that doesn't override them
MSSQL_SERVER=10.0.0.5
MSSQL_USER=readonly
MSSQL_PASSWORD=...
```

Resolution for every field: `MSSQL_<TAG>_X` → `MSSQL_X` → built-in default.
`DATABASE` is required per tag. `SERVER`, `USER`, `PASSWORD` must resolve
from one of the two levels. `DESCRIPTION` defaults to the database name.

**Backward compatibility:** when `MSSQL_CONNECTIONS` is unset, the existing
unprefixed vars define a single connection. Its tag is `MCP_SOURCE_LABEL`
if set, otherwise the database name. Existing `.env` files keep working.

Tag rules: `^[a-z0-9][a-z0-9_-]*$` (case-insensitive), unique after
normalisation. Config loading fails fast on bad or duplicate tags.

## Config shape

```ts
interface ConnectionConfig {
  tag: string;
  description: string;
  mssql: { server, port, database, user, password, encrypt, trustServerCertificate };
  ssh: SshConfig | null;
}
interface Config {
  connections: ConnectionConfig[];   // ordered as listed; first is default
  readOnly; hitlMode; pendingDir; queryTimeoutMs; approvalTimeoutMs; maxRows;
}
```

`getConnection(cfg, tag?)` returns the matching connection, or the sole
connection when `tag` is omitted and exactly one exists, or throws.

## db layer

`db.ts` keeps a `Map<tag, { pool, tunnel }>`. `getPool(cfg, tag)` and
`runQuery(cfg, tag, sql)` take the tag. `closePool()` closes every entry.
Eager connect at startup tries every connection in parallel and logs
failures without exiting (existing behaviour, now per connection).

## Tool surface

| Tool | Change |
| --- | --- |
| `list_connections` (new) | Always registered. Returns tag, description, database, server for each connection. No approval. |
| `list_tables`, `describe_table`, `query`, `request_query` | Gain a `connection` input: `z.enum(tags)`. Required when >1 connection; optional when exactly 1. Tool descriptions embed the connection list so the agent can pick without calling `list_connections`. |
| `get_query_result` | No new input. Reads `connection` from the pending request file. |

Source attribution becomes `mssql:<tag>` everywhere.

## Pending requests and audit

`PendingRequest` gains `connection: string`. `createRequest(dir, sql, connection)`.
The watcher TUI, the one-shot approve CLI, and the audit entry all show the
tag so the human knows which database a query targets before approving.
Old pending files without `connection` resolve to the default connection.

## CLI checks

`npm run test:db [tag]` and `npm run test:ssh [tag]` test one connection,
or every connection in order when no tag is given.

## Testing

Add `node --test` via `tsx` for config parsing (legacy single, multi with
fallbacks, bad tag, duplicate tag, missing database). Everything else is
verified by `npm run typecheck`, `npm run build`, and the stdio
`tools/list` smoke test.
