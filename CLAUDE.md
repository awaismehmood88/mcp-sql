# Claude conventions for mcp-mssql

This is an MCP server (TypeScript, ESM, Node 20+) that exposes a Microsoft SQL Server database to an AI agent with read-only and human-in-the-loop guard rails. Read [README.md](README.md) for the user-facing overview before making changes.

## Hard rules

- **stdout is reserved for MCP protocol traffic.** All logging goes to stderr via [src/logger.ts](src/logger.ts). Do NOT use `console.log` anywhere — use `log.info / warn / error`. A stray stdout write will corrupt the JSON-RPC stream and break the client.
- **Never weaken the read-only check** in [src/readonly.ts](src/readonly.ts) without raising it explicitly. The DB-side `SELECT`-only grant is the load-bearing protection, but the parser is the second layer and downgrading it without a corresponding stronger DB grant story would silently expand the agent's blast radius.
- **HITL is the point.** The whole server exists so a human can sit between the agent and the database. New tools that mutate or read sensitive data must respect `MCP_HITL_MODE` and gate themselves like `query` / `request_query` do.

## Layout

```
src/
├── index.ts                # entry: build pool, register tools, connect stdio
├── config.ts               # env parsing → typed Config (one or many tagged connections)
├── db.ts                   # one mssql ConnectionPool (+ SSH tunnel) per connection tag
├── readonly.ts             # assertReadOnly(sql)
├── logger.ts               # stderr-only logger
├── gating/
│   ├── interactive.ts      # elicitation-based Y/N
│   └── dualStage.ts        # file-backed request store
├── tools/                  # one file per MCP tool
│   ├── connectionArg.ts    # shared `connection` zod input + description blurb
│   ├── listConnections.ts  # discovery: tags + descriptions, touches no DB
│   ├── listTables.ts
│   ├── describeTable.ts
│   ├── query.ts            # interactive / off
│   ├── requestQuery.ts     # dual-stage stage 1
│   └── getQueryResult.ts   # dual-stage stage 2
└── cli/
    └── approve.ts          # `mcp-mssql-approve` bin
```

`package.json` has two `bin` entries: `mcp-mssql` (the server) and `mcp-mssql-approve` (the CLI). The CLI deliberately does NOT load the full `Config` (which would force MSSQL_* env vars) — it only reads `MCP_PENDING_DIR`.

## Adding a new tool

1. Create `src/tools/myTool.ts` exporting `registerMyTool(server: McpServer, cfg: Config): void`.
2. If it touches data, take a `connection` input from `connectionInput(cfg)` in [src/tools/connectionArg.ts](src/tools/connectionArg.ts), resolve it with `getConnection(cfg, connection)`, and pass `conn.tag` to `runQuery`. Run `assertReadOnly(sql)` (when `cfg.readOnly`) and route through gating exactly like [src/tools/query.ts](src/tools/query.ts) — including the `dual_stage` early-return. Report `source: "mssql:<tag>"` in the result.
3. Wire it in `src/index.ts` under the appropriate `cfg.hitlMode` branch.
4. Update the **Tool surface** table in [README.md](README.md).
5. Smoke-test with `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js`.

## Adding a new gating mode

Modes are an enum in [src/config.ts](src/config.ts): `interactive | dual_stage | off`. To add one, extend `HitlMode`, update `hitlModeEnv`, and branch on it in `src/index.ts` (which tools to register) and inside each tool's gate. Don't sprinkle mode strings as magic literals.

## Build / run

- `npm run build` — `tsc` to `dist/`.
- `npm run dev` — `tsx src/index.ts` for iteration.
- `npm run typecheck` — type-check without emit.
- `npm test` — `node --test` via `tsx` for pure logic (currently config parsing in `test/`).

Anything that needs a database is verified manually against a real MSSQL instance per the steps in README.md § Manual verification.

## Multi-connection model

- `MSSQL_CONNECTIONS=tag1,tag2` + `MSSQL_<TAG>_*` blocks; every field falls back to the unprefixed `MSSQL_*` var. No `MSSQL_CONNECTIONS` → one legacy connection whose tag is `MCP_SOURCE_LABEL` or the database name. Keep that fallback working.
- `MSSQL_<TAG>_DESCRIPTION` is agent-facing: it's what the model reads to pick a database. It is embedded in every data tool's description via `connectionsBlurb`.
- Pending request files carry `connection`. `get_query_result` reads it from the file rather than taking it as input, so a request can't be redirected to another database after approval.
- HITL mode and read-only mode are global, not per connection. Don't add per-connection relaxations without raising it.

## Things to be careful about

- The `mssql` package returns `Date` objects for datetime columns. JSON-stringifying them works but loses the type. If the agent needs ISO strings, transform in `runQuery` rather than per-tool.
- `sql.ConnectionPool` errors after connect (network blips) emit on `pool.on("error")` — we log them but don't auto-reconnect. The next `runQuery` call should reconnect because `getPool` checks `pool.connected`.
- `request_query` writes the SQL to stderr in addition to the pending file. That's intentional — it's the "logged in your terminal so you can review it" UX from the dual-stage protocol. Don't quietly remove it.
- Pending files include the full result set after completion. Treat `MCP_PENDING_DIR` like a cache of query output — sensitive. The 24 h prune in `pruneOldRequests` only runs at startup; longer-lived servers should add a periodic prune if this becomes a concern.
