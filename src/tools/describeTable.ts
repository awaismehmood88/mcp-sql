import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { runQuery } from "../db.js";

const ident = (v: string): string => v.replace(/'/g, "''");

export const registerDescribeTable = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "ONLY USE WHEN THE USER EXPLICITLY ASKS about the MSSQL database schema " +
        "(phrases like 'describe the X table', 'columns of', 'schema of', 'what's " +
        "in table Y'). Do NOT call this proactively or to answer unrelated questions.\n\n" +
        "Returns column metadata for a table from INFORMATION_SCHEMA.COLUMNS. " +
        "Read-only metadata; no human approval required.",
      inputSchema: {
        table: z.string().describe("Table name, e.g. 'Users'."),
        schema: z.string().default("dbo").describe("Schema name. Defaults to 'dbo'."),
      },
    },
    async ({ table, schema }) => {
      const sqlText =
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT ` +
        `FROM INFORMATION_SCHEMA.COLUMNS ` +
        `WHERE TABLE_SCHEMA = '${ident(schema)}' AND TABLE_NAME = '${ident(table)}' ` +
        `ORDER BY ORDINAL_POSITION`;
      const result = await runQuery(cfg, sqlText);
      return {
        content: [
          {
            type: "text",
            text:
              result.rowCount === 0
                ? `No columns found for ${schema}.${table}. Table may not exist.`
                : `${schema}.${table}: ${result.rowCount} column(s).`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
};
