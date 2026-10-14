#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { decideRequest, readRequest } from "../gating/dualStage.js";
import { resolvePendingDir } from "../paths.js";
import { recordDecision } from "../audit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "..", "..", ".env") });
loadDotenv();

const pendingDir = (): string => resolvePendingDir(import.meta.url, 2);

const AUTO_DURATIONS = [5, 10, 15, 30] as const;

const usage = (): never => {
  process.stderr.write(
    `Usage:\n` +
      `  mcp-mssql-approve <REQ-id> [--reject] [--reason "<text>"]\n` +
      `      Approve (or reject with --reject) a single pending request.\n` +
      `\n` +
      `  mcp-mssql-approve --auto <minutes>\n` +
      `      Headless auto-approve: stay alive for N minutes auto-approving any\n` +
      `      pending request that appears. Allowed values: ${AUTO_DURATIONS.join(", ")}.\n` +
      `      Use this with PM2 / systemd / tmux when you don't want the TUI.\n` +
      `\n` +
      `Pending requests are read from the dir resolved by MCP_PENDING_DIR (defaults\n` +
      `to .mcp-pending under the mcp-mssql install directory).\n`,
  );
  process.exit(2);
};

const idFromFile = (file: string): string | null => {
  const m = file.match(/^(REQ-[\w-]+)\.json$/);
  return m ? m[1]! : null;
};

const runAuto = async (minutes: number): Promise<void> => {
  if (!AUTO_DURATIONS.includes(minutes as (typeof AUTO_DURATIONS)[number])) {
    process.stderr.write(
      `--auto <minutes> must be one of ${AUTO_DURATIONS.join(", ")}, got: ${minutes}\n`,
    );
    process.exit(2);
  }

  const dir = pendingDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const until = Date.now() + minutes * 60 * 1000;
  let approvedCount = 0;

  process.stdout.write(
    `🟢 Headless auto-approve armed for ${minutes} min (window ends at ${new Date(until).toLocaleTimeString()})\n` +
      `   Watching ${dir}\n` +
      `   Press Ctrl+C to cancel early.\n\n`,
  );

  const sweep = async (): Promise<void> => {
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      const id = idFromFile(f);
      if (!id) continue;
      const r = await readRequest(dir, id).catch(() => null);
      if (r?.status === "pending") {
        try {
          await decideRequest(dir, id, "approved");
          recordDecision({
            decidedAt: new Date().toISOString(),
            id: r.id,
            connection: r.connection,
            sql: r.sql,
            decision: "approved",
            mode: "auto",
          });
          approvedCount++;
          const sqlOneLine = r.sql.replace(/\s+/g, " ").slice(0, 80);
          process.stdout.write(
            `[${new Date().toLocaleTimeString()}] ✓ approved ${id} [${r.connection ?? "default"}] — ${sqlOneLine}\n`,
          );
        } catch {
          // already decided — ignore
        }
      }
    }
  };

  // Initial sweep clears anything already waiting.
  await sweep();

  // fs.watch + periodic poll, until the window expires.
  const watcher = fs.watch(dir, () => {
    void sweep();
  });
  const poll = setInterval(() => void sweep(), 1500);

  const shutdown = (signal?: string): void => {
    clearInterval(poll);
    watcher.close();
    process.stdout.write(
      `\n${signal ? `Cancelled by ${signal}. ` : "Window expired. "}` +
        `Approved ${approvedCount} request(s).\n`,
    );
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Wait for window to elapse.
  const msLeft = until - Date.now();
  setTimeout(() => shutdown(), msLeft);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();

  // Auto mode: --auto <minutes>
  if (args[0] === "--auto") {
    const mins = Number.parseInt(args[1] ?? "", 10);
    if (Number.isNaN(mins)) {
      process.stderr.write(`--auto requires a number of minutes.\n`);
      usage();
    }
    await runAuto(mins);
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
