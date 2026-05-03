# mcp-mssql

An MCP (Model Context Protocol) server that lets an AI agent (Claude Code, Claude Desktop, etc.) query a Microsoft SQL Server database **safely**, with two layers of human guard rails:

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

Copy `.env.example` to `.env` and fill in your MSSQL connection. Strongly recommended: create a dedicated DB login that has only `SELECT` permission on the schemas you want exposed. The server's read-only check is a second layer; the DB grant is the load-bearing one.

```bash
cp .env.example .env
$EDITOR .env
```

Key knobs:

| Var | Default | Notes |
| --- | --- | --- |
| `MCP_READ_ONLY` | `true` | Reject non-SELECT statements |
| `MCP_HITL_MODE` | `interactive` | `interactive` \| `dual_stage` \| `off` |
| `MCP_PENDING_DIR` | `.mcp-pending` | Where dual-stage request files live |
| `MCP_QUERY_TIMEOUT_MS` | `30000` | Per-query timeout |
| `MCP_MAX_ROWS` | `1000` | Result truncation limit |

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
| `list_tables` | always | Lists user tables from `INFORMATION_SCHEMA.TABLES`. No approval. |
| `describe_table` | always | Column metadata. No approval. |
| `query` | `interactive` / `off` | Validates → prompts user → runs → returns rows. |
| `request_query` | `dual_stage` | Validates → writes pending file → returns `request_id`. Does not run. |
| `get_query_result` | `dual_stage` | Polls a `request_id`: returns `pending`, `rejected`, or runs the SQL on first call after approval and returns rows. |

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
   Expect `list_tables`, `describe_table`, plus either `query` (interactive/off) or `request_query`+`get_query_result` (dual_stage).
4. Read-only test: try `UPDATE users SET ...` via `query` — should return `isError: true` with a "Read-only mode" message.
5. Interactive HITL: ask Claude Code to run `SELECT TOP 5 * FROM dbo.Users`. Expect an elicitation prompt; approving runs it; declining returns the reject message.
6. Dual-stage: switch to `MCP_HITL_MODE=dual_stage`, restart, ask the same question, then approve from a second terminal. Watch the agent get rows on its next poll.
