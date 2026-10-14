import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { describeConnections } from "../config.js";

export const registerListConnections = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    "list_connections",
    {
      title: "List database connections",
      description:
        "Lists the MSSQL database connections this server exposes, with a tag and a " +
        "description of what each database holds. Use the tag as the `connection` " +
        "argument of list_tables, describe_table, query and request_query. " +
        "Read-only metadata; touches no database; no human approval required.\n\n" +
        describeConnections(cfg),
      inputSchema: {},
    },
    async () => {
      const connections = cfg.connections.map((c) => ({
        tag: c.tag,
        description: c.description,
        database: c.mssql.database,
        server: c.mssql.server,
        viaSsh: c.ssh !== null,
      }));
      return {
        content: [
          {
            type: "text",
            text: `${connections.length} connection(s):\n${describeConnections(cfg)}`,
          },
        ],
        structuredContent: { connections } as unknown as Record<string, unknown>,
      };
    },
  );
};
