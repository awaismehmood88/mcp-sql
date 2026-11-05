# Architecture Decision Records

One file per decision, numbered, never edited after acceptance except to mark
them superseded. Add a new ADR when a change alters an interface, a security
boundary, or a "why" that future readers (human or agent) would otherwise have
to reverse-engineer from the code.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-stdio-mcp-with-read-only-and-hitl.md) | stdio MCP server with read-only parser and human-in-the-loop gating | Accepted |
| [0002](0002-file-backed-pending-requests.md) | Pending requests are JSON files in a pinned directory | Accepted |
| [0003](0003-multi-connection-env-model.md) | Multiple tagged connections configured via prefixed env vars | Accepted |
| [0004](0004-server-side-auto-approve-lease.md) | Auto-approve is a time-boxed lease file honoured by the server | Accepted |
| [0005](0005-mcp-sql-dashboard-and-installer.md) | `mcp-sql` dashboard command and one-shot installer | Accepted |

Template:

```
# NNNN. Title
Date · Status (Proposed / Accepted / Superseded by NNNN)
## Context
## Decision
## Consequences
```
