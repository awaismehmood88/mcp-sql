import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runQuery } from "../db.js";
import { assertReadOnly, ReadOnlyViolationError } from "../readonly.js";
import {
  awaitDecision,
  createRequest,
  writeRequest,
} from "../gating/dualStage.js";
import { log } from "../logger.js";

export const registerQuery = (server: McpServer, cfg: Config): void => {
  const gatedNote =
    cfg.hitlMode === "interactive"
      ? " Each call writes a pending request that the operator approves via " +
        "the watcher terminal (`npm run approve:watch`). The tool blocks until " +
        "approved/rejected, then runs the SQL and returns rows."
      : cfg.hitlMode === "off"
        ? " HITL gating is disabled (MCP_HITL_MODE=off)."
        : "";

  server.registerTool(
    "query",
    {
      title: "Run a SQL query",
      description:
        "ONLY USE WHEN THE USER EXPLICITLY ASKS to run a SQL query, fetch records, " +
        "or read data from the MSSQL database (phrases like 'query the db', 'fetch " +
        "rows from', 'select from', 'show me records'). Do NOT call this " +
        "proactively. Every call requires explicit human approval — do not invoke " +
        "speculatively.\n\n" +
        `Executes a SQL query against the connected MSSQL database and returns the rows.` +
        (cfg.readOnly ? " Read-only mode: only SELECT/WITH/EXPLAIN statements are allowed." : "") +
        gatedNote,
      inputSchema: {
        sql: z.string().min(1).describe("The SQL statement to execute."),
      },
    },
    async ({ sql }) => {
      if (cfg.readOnly) {
        try {
          assertReadOnly(sql);
        } catch (err) {
          if (err instanceof ReadOnlyViolationError) {
            return { isError: true, content: [{ type: "text", text: err.message }] };
          }
          throw err;
        }
      }

      if (cfg.hitlMode === "interactive") {
        const req = await createRequest(cfg.pendingDir, sql);
        log.info("PENDING REQUEST — review and approve:", { id: req.id, sql });
        process.stderr.write(
          `\n=== Pending query ${req.id} ===\n${sql}\n` +
            `→ Approve via watcher (npm run approve:watch), or:\n` +
            `→ npx mcp-mssql-approve ${req.id}\n` +
            `→ npx mcp-mssql-approve ${req.id} --reject\n` +
            `===============================\n\n`,
        );

        let decided;
        try {
          decided = await awaitDecision(cfg.pendingDir, req.id, {
            timeoutMs: cfg.approvalTimeoutMs,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: "text", text: message }] };
        }

        if (decided.status === "rejected") {
          // Mark completed so the watcher won't keep showing it.
          decided.status = "completed";
          decided.completedAt = new Date().toISOString();
          await writeRequest(cfg.pendingDir, decided);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Query rejected by operator.${decided.decisionReason ? ` Reason: ${decided.decisionReason}` : ""}`,
              },
            ],
          };
        }
        // Fall through to execute (approved).
        try {
          const result = await runQuery(cfg, sql);
          decided.status = "completed";
          decided.rows = result.rows;
          decided.columns = result.columns;
          decided.rowCount = result.rowCount;
          decided.truncated = result.truncated;
          decided.completedAt = new Date().toISOString();
          await writeRequest(cfg.pendingDir, decided);
          log.info("query executed", {
            id: decided.id,
            rowCount: result.rowCount,
            truncated: result.truncated,
          });
          return {
            content: [
              {
                type: "text",
                text: `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}; columns: ${JSON.stringify(result.columns)}`,
              },
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          decided.status = "completed";
          decided.error = message;
          decided.completedAt = new Date().toISOString();
          await writeRequest(cfg.pendingDir, decided);
          log.error("query failed", { id: decided.id, message });
          return { isError: true, content: [{ type: "text", text: `Query failed: ${message}` }] };
        }
      }

      if (cfg.hitlMode === "dual_stage") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Server is in dual_stage mode — use request_query and get_query_result instead.",
            },
          ],
        };
      }

      // hitlMode === "off"
      try {
        const result = await runQuery(cfg, sql);
        log.info("query executed (off)", { rowCount: result.rowCount, truncated: result.truncated });
        return {
          content: [
            {
              type: "text",
              text: `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}; columns: ${JSON.stringify(result.columns)}`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("query failed", { message });
        return { isError: true, content: [{ type: "text", text: `Query failed: ${message}` }] };
      }
    },
  );
};
