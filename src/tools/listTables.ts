import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runQuery } from "../db.js";

export const registerListTables = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List user tables in the connected MSSQL database via INFORMATION_SCHEMA.TABLES. " +
        "Read-only metadata; no human approval required.",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe("Optional schema name filter (e.g. 'dbo'). Returns all schemas if omitted."),
      },
    },
    async ({ schema }) => {
      const where = schema
        ? `WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`
        : `WHERE TABLE_TYPE = 'BASE TABLE'`;
      const sqlText = `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ${where} ORDER BY TABLE_SCHEMA, TABLE_NAME`;
      const result = await runQuery(cfg, sqlText);
      return {
        content: [
          {
            type: "text",
            text: `${result.rowCount} table(s)${result.truncated ? " (truncated)" : ""}.`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
};
