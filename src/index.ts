#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { closePool, getPool } from "./db.js";
import { pruneOldRequests } from "./gating/dualStage.js";
import { registerListConnections } from "./tools/listConnections.js";
import { registerListTables } from "./tools/listTables.js";
import { registerDescribeTable } from "./tools/describeTable.js";
import { registerQuery } from "./tools/query.js";
import { registerRequestQuery } from "./tools/requestQuery.js";
import { registerGetQueryResult } from "./tools/getQueryResult.js";
import { log } from "./logger.js";

const main = async () => {
  const cfg = loadConfig();
  log.info("starting mcp-mssql", {
    version: "0.2.0",
    autoApproveLease: true,
    readOnly: cfg.readOnly,
    hitlMode: cfg.hitlMode,
    connections: cfg.connections.map((c) => ({
      tag: c.tag,
      server: c.mssql.server,
      database: c.mssql.database,
      ssh: c.ssh !== null,
    })),
  });

  // Try to establish every pool at startup so connection errors surface fast —
  // but DO NOT crash the server if one fails. A transient SSH/network blip
  // shouldn't take down the whole MCP session; the next tool call will retry.
  // Set MCP_EAGER_CONNECT=false to skip the eager attempt entirely.
  const eagerConnect = !/^(0|false|no|off)$/i.test(process.env.MCP_EAGER_CONNECT ?? "");
  if (eagerConnect) {
    await Promise.all(
      cfg.connections.map(async (c) => {
        try {
          await getPool(cfg, c.tag);
        } catch (err) {
          log.warn("eager pool connect failed at startup — will retry on first tool call", {
            connection: c.tag,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  if (cfg.hitlMode === "dual_stage") {
    await pruneOldRequests(cfg.pendingDir);
  }

  const server = new McpServer({
    name: "mcp-mssql",
    version: "0.2.0",
  });

  registerListConnections(server, cfg);
  registerListTables(server, cfg);
  registerDescribeTable(server, cfg);

  if (cfg.hitlMode === "interactive" || cfg.hitlMode === "off") {
    registerQuery(server, cfg);
  } else {
    registerRequestQuery(server, cfg);
    registerGetQueryResult(server, cfg);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp-mssql ready (stdio)");

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((err) => {
  log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
