#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideRequest, readRequest } from "../gating/dualStage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "..", "..", ".env") });
loadDotenv();

const pendingDir = (): string => process.env.MCP_PENDING_DIR?.trim() || ".mcp-pending";

const usage = (): never => {
  process.stderr.write(
    `Usage: mcp-mssql-approve <REQ-id> [--reject] [--reason "<text>"]\n` +
      `\n` +
      `  Approve (or reject with --reject) a pending dual-stage SQL request.\n` +
      `  The pending request directory is read from MCP_PENDING_DIR (or .mcp-pending).\n`,
  );
  process.exit(2);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();

  const id = args[0]!;
  let reject = false;
  let reason: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--reject") reject = true;
    else if (a === "--reason") {
      reason = args[++i];
    } else {
      process.stderr.write(`Unknown flag: ${a}\n`);
      usage();
    }
  }

  const dir = pendingDir();
  const existing = await readRequest(dir, id);
  if (!existing) {
    process.stderr.write(`No such request: ${id} (looked in ${dir})\n`);
    process.exit(1);
  }

  if (existing.status !== "pending") {
    process.stderr.write(
      `Request ${id} is not pending (current status: ${existing.status}). No change.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Request ${id}\n  SQL: ${existing.sql}\n`);

  const updated = await decideRequest(dir, id, reject ? "rejected" : "approved", reason);
  process.stdout.write(`→ ${updated.status}${reason ? ` (reason: ${reason})` : ""}\n`);
};

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
