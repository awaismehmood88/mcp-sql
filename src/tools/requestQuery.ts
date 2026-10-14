import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnection, type Config } from "../config.js";
import { assertReadOnly, ReadOnlyViolationError } from "../readonly.js";
import { createRequest } from "../gating/dualStage.js";
import { log } from "../logger.js";
import { connectionInput, connectionsBlurb, sourceNote } from "./connectionArg.js";

export const registerRequestQuery = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "request_query",
    {
      title: "Request a SQL query (dual-stage)",
      description:
        "ONLY USE WHEN THE USER EXPLICITLY ASKS to run a SQL query against an " +
        "MSSQL database. Do NOT call this proactively or speculatively.\n\n" +
        "Submits a SQL query for human approval against the chosen MSSQL connection " +
        "and returns a request_id immediately. The query does NOT run until the operator " +
        "approves it in a separate terminal (`npm run approve:watch` or `mcp-mssql-approve <id>`). " +
        "Poll get_query_result with the returned request_id to fetch the rows once approved." +
        (cfg.readOnly ? " Read-only mode: only SELECT/WITH/EXPLAIN statements are allowed." : "") +
        connectionsBlurb(cfg) +
        sourceNote(),
      inputSchema: {
        connection: connectionInput(cfg),
        sql: z.string().min(1).describe("The SQL statement to request execution of."),
      },
    },
    async ({ connection, sql }) => {
      const conn = getConnection(cfg, connection);

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

      const req = await createRequest(cfg.pendingDir, sql, conn.tag);
      // Surface the request to the human via stderr so it's visible in the
      // terminal where the MCP server is running.
      log.info("PENDING REQUEST — review and approve:", { id: req.id, connection: conn.tag, sql });
      process.stderr.write(
        `\n=== Pending query ${req.id} [${conn.tag}] ===\n${sql}\n` +
          `→ Approve:  npx mcp-mssql-approve ${req.id}\n` +
          `→ Reject :  npx mcp-mssql-approve ${req.id} --reject\n` +
          `===============================\n\n`,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Query queued as ${req.id} on connection "${conn.tag}". Waiting for operator approval. ` +
              `Call get_query_result with request_id="${req.id}" to poll for the result.`,
          },
        ],
        structuredContent: { request_id: req.id, connection: conn.tag, status: req.status },
      };
    },
  );
};
