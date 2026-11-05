# 0004. Auto-approve is a time-boxed lease file honoured by the server

Date: 2026-11-05 · Status: Accepted

## Context

Approving every query by hand is right for sensitive work but tedious during
an exploratory session. The first auto-approve implementation was a sweep loop
inside the watcher TUI / `--auto` CLI: it only worked while that process stayed
open, and the TUI and headless modes had separate code paths and separate
audit behaviour.

## Decision

- Auto-approve state is a single file, `<pendingDir>/auto-approve.json`
  (`src/gating/autoLease.ts`): `until`, `armedAt`, optional `connections`
  scope, and who armed it.
- **The MCP server does the approving.** Immediately after writing a pending
  request, `tryAutoApprove` reads the lease; if it is unexpired and covers
  the request's connection, the server marks the request approved, audits it
  with `mode: "auto"` and the lease in `reason`, and echoes one line to
  stderr. The interactive `query` tool then skips the wait.
- The dashboard's `a` key and `mcp-sql-approve auto <min>` only **write** the
  file; `c` and `auto off` **delete** it. Nothing has to stay running.
- The lease is re-read on every request and never cached, so disarming is
  instant. Expired or malformed files are deleted on read.
- Durations offered: 5, 10, 15, 30, 60, 100, 300 minutes; hard cap
  `MAX_LEASE_MINUTES = 300`.
- Auto-approve **never bypasses the read-only check**; it only replaces the
  human click.

## Consequences

- One mechanism, one audit path; TUI open or closed makes no difference.
- A forgotten lease is bounded by the cap and visible in `auto status` and
  the dashboard banner.
- Because the server approves its own requests, the pending file still
  exists for the full history and the stderr echo still shows the SQL.
