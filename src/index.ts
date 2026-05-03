#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { closePool, getPool } from "./db.js";
import { pruneOldRequests } from "./gating/dualStage.js";
import { registerListTables } from "./tools/listTables.js";
import { registerDescribeTable } from "./tools/describeTable.js";
import { registerQuery } from "./tools/query.js";
import { registerRequestQuery } from "./tools/requestQuery.js";
import { registerGetQueryResult } from "./tools/getQueryResult.js";
import { log } from "./logger.js";

const main = async () => {
  const cfg = loadConfig();
  log.info("starting mcp-mssql", {
    readOnly: cfg.readOnly,
    hitlMode: cfg.hitlMode,
    server: cfg.mssql.server,
    database: cfg.mssql.database,
  });

  // Eagerly establish the pool so connection errors surface at startup.
  await getPool(cfg);

  if (cfg.hitlMode === "dual_stage") {
    await pruneOldRequests(cfg.pendingDir);
  }

  const server = new McpServer({
    name: "mcp-mssql",
    version: "0.1.0",
  });

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
