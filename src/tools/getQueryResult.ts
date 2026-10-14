import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnection, type Config } from "../config.js";
import { runQuery } from "../db.js";
import { readRequest, writeRequest } from "../gating/dualStage.js";
import { log } from "../logger.js";
import { sourceOf } from "./connectionArg.js";

export const registerGetQueryResult = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "get_query_result",
    {
      title: "Get query result (dual-stage)",
      description:
        "ONLY USE to fetch the result of a request_query call you previously made " +
        "in this same conversation. Do NOT call with arbitrary or guessed request_ids.\n\n" +
        `Returns one of: status='pending' (still awaiting human approval), ` +
        "status='rejected' (operator rejected), status='completed' (rows attached). " +
        "On the first call after approval, the SQL is executed against the connection " +
        "named in the original request_query call and the rows are cached.\n\n" +
        "When relaying completed results to the user, ALWAYS state the source as " +
        '"mssql:<connection tag>" (returned in the `source` field).',
      inputSchema: {
        request_id: z.string().describe("The REQ-... id returned by request_query."),
      },
    },
    async ({ request_id }) => {
      const req = await readRequest(cfg.pendingDir, request_id);
      if (!req) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown request_id: ${request_id}` }],
        };
      }

      // Files written before multi-connection support have no `connection`;
      // getConnection falls back to the sole configured one in that case.
      let source: string;
      let tag: string;
      try {
        tag = getConnection(cfg, req.connection).tag;
        source = sourceOf(tag);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Request ${req.id}: ${message}` }] };
      }

      if (req.status === "pending") {
        return {
          content: [{ type: "text", text: `Request ${req.id} is still pending operator approval.` }],
          structuredContent: { status: "pending", request_id: req.id },
        };
      }

      if (req.status === "rejected") {
        return {
          content: [
            {
              type: "text",
              text: `Request ${req.id} was rejected by the operator.${req.decisionReason ? ` Reason: ${req.decisionReason}` : ""}`,
            },
          ],
          structuredContent: {
            status: "rejected",
            request_id: req.id,
            reason: req.decisionReason,
          },
        };
      }

      if (req.status === "completed") {
        if (req.error) {
          return {
            isError: true,
            content: [{ type: "text", text: `Request ${req.id} failed: ${req.error}` }],
            structuredContent: { status: "completed", request_id: req.id, error: req.error },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Source: ${source}\n` +
                `${req.rowCount ?? 0} row(s)${req.truncated ? " (truncated)" : ""}; columns: ${JSON.stringify(req.columns ?? [])}`,
            },
          ],
          structuredContent: {
            status: "completed",
            source,
            request_id: req.id,
            rows: req.rows ?? [],
            columns: req.columns ?? [],
            rowCount: req.rowCount ?? 0,
            truncated: req.truncated ?? false,
          },
        };
      }

      // status === "approved" → execute now, cache, return.
      try {
        const result = await runQuery(cfg, tag, req.sql);
        req.status = "completed";
        req.rows = result.rows;
        req.columns = result.columns;
        req.rowCount = result.rowCount;
        req.truncated = result.truncated;
        req.completedAt = new Date().toISOString();
        await writeRequest(cfg.pendingDir, req);
        log.info("dual-stage query executed", {
          id: req.id,
          connection: tag,
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Source: ${source}\n` +
                `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}; columns: ${JSON.stringify(result.columns)}`,
            },
          ],
          structuredContent: {
            status: "completed",
            source,
            request_id: req.id,
            rows: result.rows,
            columns: result.columns,
            rowCount: result.rowCount,
            truncated: result.truncated,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.status = "completed";
        req.error = message;
        req.completedAt = new Date().toISOString();
        await writeRequest(cfg.pendingDir, req);
        log.error("dual-stage query failed", { id: req.id, message });
        return {
          isError: true,
          content: [{ type: "text", text: `Request ${req.id} failed: ${message}` }],
          structuredContent: { status: "completed", request_id: req.id, error: message },
        };
      }
    },
  );
};
