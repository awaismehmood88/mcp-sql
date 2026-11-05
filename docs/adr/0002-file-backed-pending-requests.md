# 0002. Pending requests are JSON files in a pinned directory

Date: 2026-10-13 · Status: Accepted (records the original design)

## Context

The operator approves queries from a different process (a terminal) than the
one the agent talks to (the MCP server spawned by Claude Code). They need a
shared, inspectable channel with no extra daemon or database.

## Decision

- Each request is a file `REQ-<ts>-<rand>.json` in the pending directory with
  `status: pending | approved | rejected | completed`, the SQL, and later the
  result rows.
- The directory is resolved relative to the **install location**, not the
  current working directory (`src/paths.ts`), because Claude Code spawns the
  server from whatever project the user is in.
- Every approve/reject is appended to `logs/approvals.jsonl` (`src/audit.ts`),
  which outlives the 24-hour prune of the pending directory.

## Consequences

- Plain files mean `cat` is a valid inspection tool and no extra service runs.
- Completed files contain result sets; the pending directory is sensitive.
- Cross-process decisions are polled, so there is up to ~0.5 s latency.
