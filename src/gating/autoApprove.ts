// Server-side half of the auto-approve lease. Called right after a pending
// request is written. If an active lease covers the request's connection,
// the server approves it itself and records the decision in the audit log.
import { promises as fs } from "node:fs";
import { recordDecision } from "../audit.js";
import { log } from "../logger.js";
import { decideRequest, readRequest, type PendingRequest } from "./dualStage.js";
import {
  describeScope,
  formatRemaining,
  leaseCovers,
  leaseRemainingMs,
  readLease,
  type AutoLease,
} from "./autoLease.js";

const auditAuto = (decided: PendingRequest, lease: AutoLease): void =>
  recordDecision({
    decidedAt: decided.decidedAt ?? new Date().toISOString(),
    id: decided.id,
    connection: decided.connection,
    sql: decided.sql,
    decision: "approved",
    mode: "auto",
    reason: `lease ${describeScope(lease)} until ${lease.until} (armed by ${lease.armedBy})`,
  });

// Approve every request that is ALREADY pending and covered by `lease`.
// Called by whoever arms a lease, so requests created before arming (or while
// an old server without lease support was running) don't sit there waiting.
// Silent (no stderr) because the dashboard owns the terminal.
export const sweepPendingUnderLease = async (
  dir: string,
  lease: AutoLease,
): Promise<PendingRequest[]> => {
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const approved: PendingRequest[] = [];
  for (const f of files) {
    const m = f.match(/^(REQ-[\w-]+)\.json$/);
    if (!m) continue;
    const req = await readRequest(dir, m[1]!).catch(() => null);
    if (!req || req.status !== "pending" || !leaseCovers(lease, req.connection ?? "")) continue;
    try {
      const decided = await decideRequest(dir, req.id, "approved", `auto-approve lease until ${lease.until}`);
      auditAuto(decided, lease);
      approved.push(decided);
    } catch {
      // decided by someone else between read and write — skip
    }
  }
  return approved;
};

export const tryAutoApprove = async (
  dir: string,
  req: PendingRequest,
): Promise<PendingRequest | null> => {
  let lease;
  try {
    lease = await readLease(dir);
  } catch (err) {
    log.warn("could not read auto-approve lease", { message: (err as Error).message });
    return null;
  }
  if (!lease || !leaseCovers(lease, req.connection)) return null;

  let decided: PendingRequest;
  try {
    decided = await decideRequest(dir, req.id, "approved", `auto-approve lease until ${lease.until}`);
  } catch {
    // Someone else decided it in the meantime — let the caller re-read.
    return null;
  }
  auditAuto(decided, lease);
  const remaining = formatRemaining(leaseRemainingMs(lease));
  log.info("AUTO-APPROVED by lease", {
    id: decided.id,
    connection: decided.connection,
    scope: describeScope(lease),
    remaining,
  });
  process.stderr.write(
    `→ auto-approved ${decided.id} [${decided.connection}] (lease: ${describeScope(lease)}, ${remaining} left)\n`,
  );
  return decided;
};
