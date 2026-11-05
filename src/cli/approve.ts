#!/usr/bin/env node
// One-shot / scriptable approvals. The interactive dashboard is `mcp-sql`.
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideRequest, readRequest } from "../gating/dualStage.js";
import { resolvePendingDir } from "../paths.js";
import { recordDecision } from "../audit.js";
import { sweepPendingUnderLease } from "../gating/autoApprove.js";
import {
  armLease,
  clearLease,
  describeScope,
  formatRemaining,
  leaseRemainingMs,
  MAX_LEASE_MINUTES,
  readLease,
} from "../gating/autoLease.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "..", "..", ".env") });
loadDotenv();

const pendingDir = (): string => resolvePendingDir(import.meta.url, 2);

const usage = (): never => {
  process.stderr.write(
    `Usage:\n` +
      `  mcp-sql-approve <REQ-id> [--reject] [--reason "<text>"]\n` +
      `      Approve (or reject with --reject) a single pending request.\n` +
      `\n` +
      `  mcp-sql-approve auto <minutes> [--connection <tag>[,<tag>]]\n` +
      `      Arm a time-boxed auto-approve lease (max ${MAX_LEASE_MINUTES} min) and exit.\n` +
      `      The MCP server approves matching requests itself while the lease is\n` +
      `      active — nothing needs to stay running.\n` +
      `  mcp-sql-approve auto status\n` +
      `  mcp-sql-approve auto off\n` +
      `\n` +
      `Interactive dashboard (live requests, approve/reject, arm/disarm auto): mcp-sql\n` +
      `Pending requests live in the dir resolved by MCP_PENDING_DIR (defaults\n` +
      `to .mcp-pending under the mcp-mssql install directory).\n`,
  );
  process.exit(2);
};

// Accepts "15", "15m", "1h".
const parseMinutes = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*(m|min|h|hr)?$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return /^h/i.test(m[2] ?? "") ? n * 60 : n;
};

const printStatus = async (dir: string): Promise<void> => {
  const lease = await readLease(dir);
  if (!lease) {
    process.stdout.write(`Auto-approve: OFF (every request needs manual approval)\n`);
    return;
  }
  process.stdout.write(
    `Auto-approve: ON\n` +
      `  scope     : ${describeScope(lease)}\n` +
      `  remaining : ${formatRemaining(leaseRemainingMs(lease))} (until ${new Date(lease.until).toLocaleTimeString()})\n` +
      `  armed by  : ${lease.armedBy} at ${new Date(lease.armedAt).toLocaleTimeString()}\n`,
  );
};

const runAuto = async (args: string[]): Promise<void> => {
  const dir = pendingDir();
  const sub = args[0];
  if (sub === "status") return printStatus(dir);
  if (sub === "off") {
    const removed = await clearLease(dir);
    process.stdout.write(removed ? `Auto-approve lease cleared.\n` : `No active lease.\n`);
    return;
  }
  const minutes = parseMinutes(sub);
  if (minutes === null) {
    process.stderr.write(`auto: expected <minutes>, "status" or "off", got: ${sub ?? "(nothing)"}\n`);
    usage();
  }
  let connections: string[] | null = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--connection" || a === "-c") {
      const v = args[++i];
      if (!v) return usage();
      connections = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      process.stderr.write(`Unknown flag: ${a}\n`);
      usage();
    }
  }
  const lease = await armLease(dir, { minutes: minutes as number, connections });
  const swept = await sweepPendingUnderLease(dir, lease);
  process.stdout.write(
    `🟢 Auto-approve armed for ${lease.durationMinutes} min on ${describeScope(lease)} ` +
      `(until ${new Date(lease.until).toLocaleTimeString()}).\n` +
      (swept.length > 0 ? `   Approved ${swept.length} request(s) that were already pending.\n` : "") +
      `   The MCP server will approve matching requests itself. Disarm early with: mcp-sql-approve auto off\n`,
  );
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();

  // `auto ...` (and the old `--auto <minutes>` spelling)
  if (args[0] === "auto" || args[0] === "--auto") {
    await runAuto(args.slice(1));
    return;
  }

  // One-shot mode: <REQ-id> [--reject] [--reason "..."]
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

  process.stdout.write(
    `Request ${id}\n  Connection: ${existing.connection ?? "default"}\n  SQL: ${existing.sql}\n`,
  );

  const updated = await decideRequest(dir, id, reject ? "rejected" : "approved", reason);
  recordDecision({
    decidedAt: new Date().toISOString(),
    id: updated.id,
    connection: existing.connection,
    sql: existing.sql,
    decision: reject ? "rejected" : "approved",
    mode: "manual",
    reason,
  });
  process.stdout.write(`→ ${updated.status}${reason ? ` (reason: ${reason})` : ""}\n`);
};

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
