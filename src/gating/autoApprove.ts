// Server-side half of the auto-approve lease. Called right after a pending
// request is written. If an active lease covers the request's connection,
// the server approves it itself and records the decision in the audit log.
import { recordDecision } from "../audit.js";
import { log } from "../logger.js";
import { decideRequest, type PendingRequest } from "./dualStage.js";
import { describeScope, formatRemaining, leaseCovers, leaseRemainingMs, readLease } from "./autoLease.js";

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
  recordDecision({
    decidedAt: decided.decidedAt ?? new Date().toISOString(),
    id: decided.id,
    connection: decided.connection,
    sql: decided.sql,
    decision: "approved",
    mode: "auto",
    reason: `lease ${describeScope(lease)} until ${lease.until} (armed by ${lease.armedBy})`,
  });
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
