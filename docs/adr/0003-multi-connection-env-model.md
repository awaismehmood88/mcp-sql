# 0003. Multiple tagged connections configured via prefixed env vars

Date: 2026-10-13 · Status: Accepted

## Context

The server originally held one connection. Operators run several apps
(education portal, HR system, …) each with its own database, and want one MCP
server where the agent can pick the right database for a question.

## Decision

- `MSSQL_CONNECTIONS=psa-edu,hrms` lists tags. Each tag gets an
  `MSSQL_<TAG>_*` block (tag uppercased, `-` → `_`). **Every field falls back
  to the unprefixed `MSSQL_*` var**, so shared server / login / SSH settings
  are written once. Only `DATABASE` is required per tag.
- `MSSQL_<TAG>_DESCRIPTION` is **agent-facing**: it is embedded in every data
  tool's description so the model can pick a database without a round-trip.
- Every data tool takes `connection` as a `z.enum` of the tags — required with
  several connections, optional with one. A `list_connections` tool exists for
  discovery and touches no database.
- **Backward compatibility:** without `MSSQL_CONNECTIONS`, the legacy
  unprefixed vars define a single connection whose tag is `MCP_SOURCE_LABEL`
  or the database name.
- One pool and one SSH tunnel per tag (`src/db.ts`).
- Pending request files carry `connection`; `get_query_result` reads it from
  the file rather than as input so an approved request cannot be redirected.
- HITL mode and read-only mode stay **global**, not per connection.

Rejected alternatives: a JSON blob env var (hard to edit in `.env`, no
fallback story); one server process per database (loses cross-app discovery
and multiplies Claude Code config).

## Consequences

- Adding a database is a `.env` change plus a server restart.
- The enum in the tool schema is the discovery mechanism; descriptions must
  be written for the model, not the human.
- Results and audit entries always carry `mssql:<tag>` so the human knows
  which database they are approving against.
