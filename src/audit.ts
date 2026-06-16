// Append-only audit log of every approval/rejection decision.
//
// Lives at <project>/logs/approvals.jsonl  (one JSON object per line).
// Survives the 24-hour prune of .mcp-pending/, so it is the authoritative
// long-term record of what queries ran (especially under auto-approve).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/audit.js → ..  →  project root
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const auditDir = path.join(projectRoot, "logs");
const auditFile = path.join(auditDir, "approvals.jsonl");

let stream: fs.WriteStream | null = null;
const getStream = (): fs.WriteStream | null => {
  if (stream) return stream;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    stream = fs.createWriteStream(auditFile, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
    return stream;
  } catch {
    return null;
  }
};

export interface AuditEntry {
  decidedAt: string;
  id: string;
  sql: string;
  decision: "approved" | "rejected";
  mode: "auto" | "manual";
  reason?: string;
}

export const recordDecision = (entry: AuditEntry): void => {
  const s = getStream();
  if (!s) return;
  s.write(JSON.stringify(entry) + "\n");
};

export const readDecisions = async (limit = 200): Promise<AuditEntry[]> => {
  try {
    const raw = await fs.promises.readFile(auditFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const all: AuditEntry[] = [];
    for (const line of lines) {
      try {
        all.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip malformed line
      }
    }
    return all.slice(-limit).reverse(); // newest first
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

export const auditPath = (): string => auditFile;
