# 0001. stdio MCP server with read-only parser and human-in-the-loop gating

Date: 2026-10-13 · Status: Accepted (records the original design)

## Context

An AI agent (Claude Code) needs to read from production-adjacent Microsoft SQL
Server databases. Handing it a connection string directly gives it an
unbounded blast radius and no audit trail. We want a human to be able to see,
and veto, every query before it runs.

## Decision

- Expose the database through a **stdio MCP server** written in TypeScript.
  stdout carries JSON-RPC only; all logging goes to stderr.
- Two independent guard rails:
  1. **Read-only parser** (`src/readonly.ts`): rejects anything that isn't a
     single `SELECT` / `WITH` / `EXPLAIN` statement and blocks known-dangerous
     tokens. It is a heuristic, deliberately not a full T-SQL parser.
  2. **HITL gating** (`MCP_HITL_MODE`): `interactive` blocks the tool call
     until an operator approves; `dual_stage` returns a request id and runs
     only after approval on a later poll; `off` is for trusted local dev.
- The **DB login's `SELECT`-only grant is the load-bearing control**. The
  parser is a second layer; the HITL is the audit and veto layer.

## Consequences

- Any new tool that touches data must run the read-only check and route
  through the same gate.
- The parser can be bypassed by sufficiently creative SQL; that is accepted
  because the DB grant is the real boundary.
- `MCP_HITL_MODE=off` must never be the default in a shipped config.
