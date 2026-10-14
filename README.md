# mcp-mssql

An MCP (Model Context Protocol) server that lets an AI agent (Claude Code, Claude Desktop, etc.) query one or more Microsoft SQL Server databases **safely**, with two layers of human guard rails:

1. **Read-only by default** — only `SELECT` / `WITH` / `EXPLAIN` are allowed.
2. **Human-in-the-loop gating** — every query needs human approval. Two modes:
   - `interactive` *(default)* — the server pops up a Y/N prompt in the MCP client via the elicitation API.
   - `dual_stage` — the agent calls `request_query` and gets a `REQ-...` id; you approve it from a separate terminal with `mcp-mssql-approve REQ-...`. The agent polls `get_query_result` for the rows.

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in your MSSQL connection(s). Strongly recommended: create a dedicated DB login that has only `SELECT` permission on the schemas you want exposed. The server's read-only check is a second layer; the DB grant is the load-bearing one.

```bash
cp .env.example .env
$EDITOR .env
```

### One database (simple)

```bash
MSSQL_SERVER=localhost
MSSQL_DATABASE=mydb
MSSQL_USER=readonly_user
MSSQL_PASSWORD=...
# MCP_SOURCE_LABEL=shop   # optional tag; defaults to the database name
```

### Several databases (tagged connections)

List the tags in `MSSQL_CONNECTIONS`, then give each one its own `MSSQL_<TAG>_*` block. The tag is uppercased and `-` becomes `_` to form the prefix (`psa-edu` → `MSSQL_PSA_EDU_*`). Every field falls back to the unprefixed `MSSQL_*` value, so shared server / login / SSH settings only need to be written once.

```bash
MSSQL_CONNECTIONS=psa-edu,hrms

# Shared defaults (used by any tag that doesn't override them)
MSSQL_SERVER=10.0.0.5
MSSQL_USER=readonly_user
MSSQL_PASSWORD=...

MSSQL_PSA_EDU_DATABASE=PsaEdu
MSSQL_PSA_EDU_DESCRIPTION=PSA education portal: students, courses, enrollments, fees

MSSQL_HRMS_DATABASE=Hrms
MSSQL_HRMS_DESCRIPTION=HR system: employees, departments, leave, payroll
MSSQL_HRMS_SERVER=hr-db.internal       # override just for this tag
MSSQL_HRMS_USER=hr_readonly
MSSQL_HRMS_PASSWORD=...
```

| Per-tag var | Required | Fallback |
| --- | --- | --- |
| `MSSQL_<TAG>_DATABASE` | yes | none |
| `MSSQL_<TAG>_DESCRIPTION` | no | database name |
| `MSSQL_<TAG>_SERVER` / `_USER` / `_PASSWORD` | one level must set it | `MSSQL_SERVER` / `MSSQL_USER` / `MSSQL_PASSWORD` |
| `MSSQL_<TAG>_PORT` / `_ENCRYPT` / `_TRUST_SERVER_CERT` | no | `MSSQL_PORT` etc., then `1433` / `true` / `false` |
| `MSSQL_<TAG>_SSH_*` | no | `MSSQL_SSH_*` (see below) |

Write the **description** for the agent, not for you: it is what the model reads to decide which connection a question belongs to. Say what the database holds and which app it backs.

Tags must match `[a-z0-9][a-z0-9_-]*` (case-insensitive) and be unique. The agent passes the tag as the `connection` argument of every data tool; it's a required enum when more than one connection is configured and optional when there's exactly one.

Key knobs:

| Var | Default | Notes |
| --- | --- | --- |
| `MCP_READ_ONLY` | `true` | Reject non-SELECT statements |
| `MCP_HITL_MODE` | `interactive` | `interactive` \| `dual_stage` \| `off` |
| `MCP_PENDING_DIR` | `.mcp-pending` | Where dual-stage request files live |
| `MCP_QUERY_TIMEOUT_MS` | `30000` | Per-query timeout |
| `MCP_MAX_ROWS` | `1000` | Result truncation limit |

### Connecting through an SSH bastion

If the MSSQL server isn't directly reachable but you can SSH to a host that *can* reach it, enable the built-in SSH tunnel:

```bash
MSSQL_SSH_ENABLED=true
MSSQL_SSH_HOST=bastion.example.com
MSSQL_SSH_USER=awais
MSSQL_SSH_PRIVATE_KEY_PATH=~/.ssh/id_rsa
# MSSQL_SSH_PASSPHRASE=...   # only if the key is encrypted
# MSSQL_SSH_PORT=22          # default
# MSSQL_SSH_LOCAL_PORT=0     # 0 = pick a free ephemeral port

MSSQL_SERVER=10.0.0.5        # the DB's private hostname as seen FROM the bastion
MSSQL_PORT=1433
```

The server opens the tunnel at startup, picks a free local port, and stitches it into the mssql pool config so `runQuery` transparently goes through. Verify with `npm run test:ssh` and `npm run test:db` (pass a tag to test one connection: `npm run test:db -- hrms`). If the tunnel drops mid-session, the next query will error — restart Claude Code (`/mcp` → Reconnect) to reopen it.

With several connections, the unprefixed `MSSQL_SSH_*` block is the shared default and each tag may override any of it with `MSSQL_<TAG>_SSH_*`. A tag that is reachable directly can opt out with `MSSQL_<TAG>_SSH_ENABLED=false`. Each SSH-enabled connection opens its own tunnel.

## Wire it up to Claude Code

Add to `~/.claude.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/absolute/path/to/sql/dist/index.js"],
      "env": {
        "MSSQL_SERVER": "localhost",
        "MSSQL_DATABASE": "mydb",
        "MSSQL_USER": "readonly_user",
        "MSSQL_PASSWORD": "...",
        "MCP_HITL_MODE": "interactive"
      }
    }
  }
}
```

For interactive mode you need an MCP client that supports elicitation — Claude Code 2.1.76+ does.

## Tool surface

| Tool | When | What |
| --- | --- | --- |
| `list_connections` | always | Lists configured connections with tag, description, database, server. Touches no DB. No approval. |
| `list_tables` | always | Lists user tables from `INFORMATION_SCHEMA.TABLES` on one `connection`. No approval. |
| `describe_table` | always | Column metadata on one `connection`. No approval. |
| `query` | `interactive` / `off` | Validates → prompts user → runs on `connection` → returns rows. |
| `request_query` | `dual_stage` | Validates → writes pending file (with the `connection`) → returns `request_id`. Does not run. |
| `get_query_result` | `dual_stage` | Polls a `request_id`: returns `pending`, `rejected`, or runs the SQL on the request's connection on first call after approval and returns rows. |

`connection` is the tag from `MSSQL_CONNECTIONS`. The tag list and each description are embedded in every tool description, so the agent can usually pick the right database without calling `list_connections` first. Every result carries `source: "mssql:<tag>"` and the pending-request file, the watcher TUI, the approve CLI, and the audit log all show the tag so you know which database you're approving a query against.

## Approving a dual-stage query

When `MCP_HITL_MODE=dual_stage`, the agent sees a workflow like:

```
agent → request_query(sql)        → { request_id: "REQ-1714742400-7c3a" }
agent → get_query_result(REQ-...) → { status: "pending" }   (loop)
```

In a separate terminal — the same working directory the MCP server was launched from (so `MCP_PENDING_DIR` resolves to the same place) — you run:

```bash
# inspect (the file is plain JSON):
cat .mcp-pending/REQ-1714742400-7c3a.json

# approve:
node dist/cli/approve.js REQ-1714742400-7c3a

# or reject:
node dist/cli/approve.js REQ-1714742400-7c3a --reject --reason "looks like a join bomb"
```

The next `get_query_result` call from the agent then runs the SQL and returns the rows.

When `request_query` is called the SQL is also dumped to the server's stderr, so if you have the MCP server's terminal in view you'll see something like:

```
=== Pending query REQ-1714742400-7c3a ===
SELECT TOP 5 * FROM dbo.Users
→ Approve:  npx mcp-mssql-approve REQ-1714742400-7c3a
→ Reject :  npx mcp-mssql-approve REQ-1714742400-7c3a --reject
===============================
```

## Security model

- **DB login:** create a dedicated SQL login with only `SELECT` permission on the schemas the agent should see. This is the primary protection.
- **Read-only parser:** rejects multi-statement batches, non-SELECT leading keywords, and known-dangerous tokens (`xp_cmdshell`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `BULK INSERT`, `SELECT … INTO`). It is a heuristic, not a real T-SQL parser. Don't rely on it as the only line of defence.
- **HITL:** every `query` / `request_query` call goes past a human. `MCP_HITL_MODE=off` exists for trusted local-dev only — don't ship it.
- **stdout discipline:** MCP stdio uses stdout for protocol traffic, so the codebase logs only to stderr. Never `console.log` anywhere.

## Manual verification

1. Spin up SQL Server in Docker, create a DB and a read-only user.
2. `npm install && npm run build`.
3. Smoke-test tools/list:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
   ```
   Expect `list_connections`, `list_tables`, `describe_table`, plus either `query` (interactive/off) or `request_query`+`get_query_result` (dual_stage). With `MSSQL_CONNECTIONS` set, `connection` should appear as a required enum of your tags on the data tools.
   Config parsing has unit tests: `npm test`.
4. Read-only test: try `UPDATE users SET ...` via `query` — should return `isError: true` with a "Read-only mode" message.
5. Interactive HITL: ask Claude Code to run `SELECT TOP 5 * FROM dbo.Users`. Expect an elicitation prompt; approving runs it; declining returns the reject message.
6. Dual-stage: switch to `MCP_HITL_MODE=dual_stage`, restart, ask the same question, then approve from a second terminal. Watch the agent get rows on its next poll.
7. Multi-connection: configure two tags, ask Claude Code something that only makes sense for one of them ("how many employees are on leave?"), and confirm it picks that tag and that the watcher shows the tag next to the pending request.
