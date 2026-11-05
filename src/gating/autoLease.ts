// Time-boxed auto-approve lease.
//
// A single JSON file in the pending dir says "approve everything (or
// everything on these connections) until <time>". The SERVER reads it on
// every new request and approves immediately; nothing has to stay running.
// The dashboard and the approve CLI only arm / disarm / inspect it.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LEASE_FILE = "auto-approve.json";
export const AUTO_DURATIONS = [5, 10, 15, 30, 60, 100, 300] as const;
export const MAX_LEASE_MINUTES = 300;

export interface AutoLease {
  armedAt: string; // ISO
  until: string; // ISO
  durationMinutes: number;
  // null = every connection
  connections: string[] | null;
  armedBy: string;
}

const leasePath = (dir: string): string => path.join(dir, LEASE_FILE);

const isLease = (v: unknown): v is AutoLease => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.armedAt === "string" &&
    typeof o.until === "string" &&
    typeof o.durationMinutes === "number" &&
    (o.connections === null ||
      (Array.isArray(o.connections) && o.connections.every((c) => typeof c === "string"))) &&
    typeof o.armedBy === "string"
  );
};

export const isLeaseActive = (lease: AutoLease, now: number = Date.now()): boolean =>
  Date.parse(lease.until) > now;

export const leaseRemainingMs = (lease: AutoLease, now: number = Date.now()): number =>
  Math.max(0, Date.parse(lease.until) - now);

// Does this lease cover a request on `tag`? Tag match is case-insensitive.
export const leaseCovers = (lease: AutoLease, tag: string, now: number = Date.now()): boolean => {
  if (!isLeaseActive(lease, now)) return false;
  if (lease.connections === null) return true;
  const wanted = tag.toLowerCase();
  return lease.connections.some((c) => c.toLowerCase() === wanted);
};

// Returns the lease only if it is well-formed AND unexpired. Expired or
// garbage files are deleted so they can't confuse anyone later.
export const readLease = async (dir: string, now: number = Date.now()): Promise<AutoLease | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(leasePath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await clearLease(dir);
    return null;
  }
  if (!isLease(parsed) || !isLeaseActive(parsed, now)) {
    await clearLease(dir);
    return null;
  }
  return parsed;
};

export interface ArmOptions {
  minutes: number;
  connections?: string[] | null;
  armedBy?: string;
  now?: number;
}

export const buildLease = (opts: ArmOptions): AutoLease => {
  const minutes = opts.minutes;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Lease duration must be a positive whole number of minutes, got: ${minutes}`);
  }
  if (minutes > MAX_LEASE_MINUTES) {
    throw new Error(`Lease duration is capped at ${MAX_LEASE_MINUTES} minutes, got: ${minutes}`);
  }
  const now = opts.now ?? Date.now();
  const connections =
    opts.connections && opts.connections.length > 0 ? opts.connections.map((c) => c.trim()) : null;
  return {
    armedAt: new Date(now).toISOString(),
    until: new Date(now + minutes * 60_000).toISOString(),
    durationMinutes: minutes,
    connections,
    armedBy: opts.armedBy ?? os.userInfo().username,
  };
};

export const armLease = async (dir: string, opts: ArmOptions): Promise<AutoLease> => {
  const lease = buildLease(opts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(leasePath(dir), JSON.stringify(lease, null, 2), "utf8");
  return lease;
};

export const clearLease = async (dir: string): Promise<boolean> => {
  try {
    await fs.unlink(leasePath(dir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};

// "12m 05s" style, for banners and status output.
export const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

export const describeScope = (lease: AutoLease): string =>
  lease.connections === null ? "all connections" : lease.connections.join(", ");
