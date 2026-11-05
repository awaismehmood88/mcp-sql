# 0005. `mcp-sql` dashboard command and one-shot installer

Date: 2026-11-05 · Status: Accepted

## Context

Operators had to remember several bins and flags (`mcp-mssql-watch`,
`mcp-mssql-approve --auto 15`, `npm run approve:watch`) and could only run
them from inside the project directory unless they linked them by hand.

## Decision

- One operator command, **`mcp-sql`**, opens the dashboard
  (`src/cli/dashboard.ts`): connections panel, live pending requests with
  their tag, approve/reject, arm/cancel the auto-approve lease, audit
  history. `mcp-sql-approve` remains for scripts; `mcp-sql-check` tests
  connectivity; the server bin is `mcp-sql-server` (Claude Code launches it
  by absolute path, so its name is cosmetic).
- `scripts/install-mcp.sh` does everything: `npm install`, build, create
  `.env` from the example if missing, `claude mcp add`, and put the commands
  on PATH. It tries `npm link`; when the global prefix is not writable it
  writes wrapper scripts to `~/.local/bin` and appends a **marked** PATH line
  to the shell rc. `uninstall-mcp.sh` reverses every step using the marker.
- The dashboard tolerates an incomplete `.env` (shows a warning line) so it
  can still be used to approve requests.

## Consequences

- From any directory: `mcp-sql` to supervise, `mcp-sql-approve auto 30m` to
  script.
- The installer edits the user's shell rc; it does so idempotently and only
  with a marker so uninstall can remove exactly its own line.
- Renaming the command again means touching the stderr hints and tool
  descriptions the agent reads, not just `package.json`.
