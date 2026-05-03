import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runQuery } from "../db.js";
import { assertReadOnly, ReadOnlyViolationError } from "../readonly.js";
import { elicitApproval } from "../gating/interactive.js";
import { log } from "../logger.js";

export const registerQuery = (server: McpServer, cfg: Config): void => {
  const gatedNote =
    cfg.hitlMode === "interactive"
      ? " Each call prompts the user for Y/N approval before running."
      : cfg.hitlMode === "off"
        ? " HITL gating is disabled (MCP_HITL_MODE=off)."
        : "";

  server.registerTool(
    "query",
    {
      title: "Run a SQL query",
      description:
        `Execute a SQL query against the connected MSSQL database and return the rows.` +
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
            return {
              isError: true,
              content: [{ type: "text", text: err.message }],
            };
          }
          throw err;
        }
      }

      if (cfg.hitlMode === "interactive") {
        const decision = await elicitApproval(server, sql);
        if (!decision.approved) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Query rejected by user.${decision.reason ? ` Reason: ${decision.reason}` : ""}`,
              },
            ],
          };
        }
      } else if (cfg.hitlMode === "dual_stage") {
        // Should not happen — `query` is only registered in interactive/off modes.
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

      try {
        const result = await runQuery(cfg, sql);
        log.info("query executed", { rowCount: result.rowCount, truncated: result.truncated });
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
        return {
          isError: true,
          content: [{ type: "text", text: `Query failed: ${message}` }],
        };
      }
    },
  );
};
