import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnection, type Config } from "../config.js";
import { runQuery } from "../db.js";
import { connectionInput, connectionsBlurb, sourceNote, sourceOf } from "./connectionArg.js";

export const registerListTables = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "ONLY USE WHEN THE USER EXPLICITLY ASKS to inspect, query, or work with " +
        "an MSSQL database (phrases like 'list the tables', 'check the database', " +
        "'what's in the db', 'query mssql', etc.). Do NOT call this proactively to " +
        "answer unrelated questions.\n\n" +
        "Lists user tables in the chosen MSSQL connection via INFORMATION_SCHEMA.TABLES. " +
        "Read-only metadata; no human approval required." +
        connectionsBlurb(cfg) +
        sourceNote(),
      inputSchema: {
        connection: connectionInput(cfg),
        schema: z
          .string()
          .optional()
          .describe("Optional schema name filter (e.g. 'dbo'). Returns all schemas if omitted."),
      },
    },
    async ({ connection, schema }) => {
      const conn = getConnection(cfg, connection);
      const source = sourceOf(conn.tag);
      const where = schema
        ? `WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`
        : `WHERE TABLE_TYPE = 'BASE TABLE'`;
      const sqlText = `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ${where} ORDER BY TABLE_SCHEMA, TABLE_NAME`;
      const result = await runQuery(cfg, conn.tag, sqlText);
      return {
        content: [
          {
            type: "text",
            text:
              `Source: ${source}\n` +
              `${result.rowCount} table(s)${result.truncated ? " (truncated)" : ""}.`,
          },
        ],
        structuredContent: { ...result, source } as unknown as Record<string, unknown>,
      };
    },
  );
};
