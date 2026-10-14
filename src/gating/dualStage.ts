import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../logger.js";

export type RequestStatus = "pending" | "approved" | "rejected" | "completed";

export interface PendingRequest {
  id: string;
  createdAt: string;
  // Connection tag the SQL targets. Absent on files written before
  // multi-connection support; readers should fall back to the default.
  connection: string;
  sql: string;
  status: RequestStatus;
  rows: Record<string, unknown>[] | null;
  columns: string[] | null;
  rowCount: number | null;
  truncated: boolean | null;
  error: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  decisionReason: string | null;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

const filePath = (dir: string, id: string): string => path.join(dir, `${id}.json`);

const newId = (): string => {
  const ts = Math.floor(Date.now() / 1000);
  const rnd = crypto.randomBytes(3).toString("hex");
  return `REQ-${ts}-${rnd}`;
};

export const createRequest = async (
  dir: string,
  sqlText: string,
  connection: string,
): Promise<PendingRequest> => {
  await ensureDir(dir);
  const req: PendingRequest = {
    id: newId(),
    createdAt: new Date().toISOString(),
    connection,
    sql: sqlText,
    status: "pending",
    rows: null,
    columns: null,
    rowCount: null,
    truncated: null,
    error: null,
    decidedAt: null,
    completedAt: null,
    decisionReason: null,
  };
  await fs.writeFile(filePath(dir, req.id), JSON.stringify(req, null, 2), "utf8");
  return req;
};

export const readRequest = async (dir: string, id: string): Promise<PendingRequest | null> => {
  try {
    const raw = await fs.readFile(filePath(dir, id), "utf8");
    return JSON.parse(raw) as PendingRequest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export const writeRequest = async (dir: string, req: PendingRequest): Promise<void> => {
  await ensureDir(dir);
  await fs.writeFile(filePath(dir, req.id), JSON.stringify(req, null, 2), "utf8");
};

export const decideRequest = async (
  dir: string,
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<PendingRequest> => {
  const req = await readRequest(dir, id);
  if (!req) throw new Error(`Request not found: ${id}`);
  if (req.status !== "pending") {
    throw new Error(`Request ${id} is not pending (status: ${req.status}).`);
  }
  req.status = decision;
  req.decidedAt = new Date().toISOString();
  req.decisionReason = reason ?? null;
  await writeRequest(dir, req);
  return req;
};

export interface AwaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export const awaitDecision = async (
  dir: string,
  id: string,
  opts: AwaitOptions = {},
): Promise<PendingRequest> => {
  const pollMs = opts.pollIntervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const req = await readRequest(dir, id);
    if (!req) throw new Error(`Request ${id} disappeared from disk.`);
    if (req.status === "approved" || req.status === "rejected") return req;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Approval timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${id}. ` +
      `The pending file is still on disk — approve it and call the tool again, or raise MCP_APPROVAL_TIMEOUT_MS.`,
  );
};

export const pruneOldRequests = async (dir: string): Promise<void> => {
  try {
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - MAX_AGE_MS;
    await Promise.all(
      files
        .filter((f) => f.startsWith("REQ-") && f.endsWith(".json"))
        .map(async (f) => {
          const fp = path.join(dir, f);
          const stat = await fs.stat(fp);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(fp);
            log.info("pruned old pending request", { file: f });
          }
        }),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    log.warn("prune failed", { message: (err as Error).message });
  }
};
