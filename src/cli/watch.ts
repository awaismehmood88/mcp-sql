#!/usr/bin/env node
// Interactive approval terminal.
//   list mode  :  ↑/↓ navigate · Enter decide · a auto-approve · c cancel auto · r refresh · q quit
//   decide mode:  ←/→ or ↑/↓ pick Approve/Reject · Enter confirm · Esc back
//   auto mode  :  ←/→ or ↑/↓ pick 5/10/15/30 min · Enter arm · Esc back

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { decideRequest, readRequest } from "../gating/dualStage.js";
import { resolvePendingDir } from "../paths.js";
import { auditPath, readDecisions, recordDecision, type AuditEntry } from "../audit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "..", "..", ".env") });
loadDotenv();

const dir = resolvePendingDir(import.meta.url, 2);

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  invert: "\x1b[7m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

interface PendingItem {
  id: string;
  sql: string;
  createdAt: string;
}

type Mode = "list" | "decide" | "auto" | "history" | "sessionDetail" | "done";

type ListItem =
  | { kind: "auto"; entry: AutoSessionEntry }
  | { kind: "pending"; entry: PendingItem };

const buildListItems = (): ListItem[] => [
  ...autoSessionLog.map((entry) => ({ kind: "auto" as const, entry })),
  ...pending.map((entry) => ({ kind: "pending" as const, entry })),
];

const AUTO_DURATIONS = [5, 10, 15, 30] as const;
type AutoCursor = 0 | 1 | 2 | 3;

let pending: PendingItem[] = [];
let listCursor = 0; // index into buildListItems()
let decideTarget: PendingItem | null = null;
let sessionDetailTarget: AutoSessionEntry | null = null;
let mode: Mode = "list";
let decideCursor: 0 | 1 = 0;
let autoCursor: AutoCursor = 0;
let autoApprove: { until: number; durationMinutes: number } | null = null;
let autoTickTimer: NodeJS.Timeout | null = null;
let lastMessage: { text: string; color: string } | null = null;
let history: AuditEntry[] = [];
let historyCursor = 0;
const HISTORY_PAGE_SIZE = 20;
let historyOffset = 0;

// Live feed of queries auto-approved during the current auto-approve session.
// Reset when a new session starts; preserved across cancel/expire so the user
// can still scroll the list view after the window ends.
interface AutoSessionEntry {
  time: number;
  id: string;
  sql: string;
}
const AUTO_FEED_LIMIT = 20;
let autoSessionLog: AutoSessionEntry[] = [];
let autoSessionApprovedCount = 0;

const idFromFile = (file: string): string | null => {
  const m = file.match(/^(REQ-[\w-]+)\.json$/);
  return m ? m[1]! : null;
};

const loadPending = async (): Promise<void> => {
  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const ids = files.map(idFromFile).filter((x): x is string => x !== null);
  const fresh: PendingItem[] = [];
  for (const id of ids) {
    const r = await readRequest(dir, id);
    if (r?.status === "pending") {
      fresh.push({ id: r.id, sql: r.sql, createdAt: r.createdAt });
    }
  }
  fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  pending = fresh;
  const total = autoSessionLog.length + pending.length;
  if (listCursor >= total) listCursor = Math.max(0, total - 1);
};

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const autoStatusLine = (): string => {
  if (!autoApprove) return "";
  const remainingMs = autoApprove.until - Date.now();
  return (
    `${ANSI.invert}${ANSI.green}${ANSI.bold} 🟢 AUTO-APPROVE ` +
    `${formatRemaining(remainingMs)} remaining (${autoApprove.durationMinutes} min window) · c to cancel ${ANSI.reset}\n\n`
  );
};

const render = (): void => {
  if (mode === "done") return;
  let out = ANSI.clear;
  out += `${ANSI.bold}${ANSI.cyan}mcp-mssql approval watcher${ANSI.reset}\n`;
  out += `${ANSI.dim}${dir}${ANSI.reset}\n\n`;

  out += autoStatusLine();

  if (lastMessage) {
    out += `${lastMessage.color}${lastMessage.text}${ANSI.reset}\n\n`;
  }

  if (mode === "list") {
    const items = buildListItems();
    const total = items.length;
    if (listCursor >= total) listCursor = Math.max(0, total - 1);

    out += `${ANSI.dim}↑/↓ navigate · Enter: ${
      total > 0
        ? items[listCursor]?.kind === "pending"
          ? "decide"
          : "view full SQL"
        : "—"
    } · a: auto-approve · ${autoApprove ? "c: cancel auto · " : ""}h: history · r: refresh · q: quit${ANSI.reset}\n\n`;

    // Auto-approved feed (with cursor support if cursor is in this section).
    if (autoApprove || autoSessionLog.length > 0) {
      const label = autoApprove
        ? `${ANSI.green}Auto-approved this session${ANSI.reset}`
        : `${ANSI.dim}Auto-approved (last session)${ANSI.reset}`;
      out += `${label}  ${ANSI.bold}${autoSessionApprovedCount} total${ANSI.reset}`;
      if (autoSessionLog.length < autoSessionApprovedCount) {
        out += `  ${ANSI.dim}(showing newest ${autoSessionLog.length})${ANSI.reset}`;
      }
      out += `\n`;
      if (autoSessionLog.length === 0) {
        out += `  ${ANSI.dim}(none yet — waiting for incoming queries…)${ANSI.reset}\n`;
      } else {
        autoSessionLog.forEach((entry, i) => {
          const when = new Date(entry.time).toLocaleTimeString();
          const sqlOneLine = truncate(entry.sql.replace(/\s+/g, " ").trim(), 70);
          const idCell = entry.id.padEnd(28, " ");
          if (i === listCursor) {
            out += `${ANSI.invert}${ANSI.bold} ▶ ${ANSI.dim}${when}${ANSI.reset}${ANSI.invert}${ANSI.bold}  ${ANSI.green}✓${ANSI.reset}${ANSI.invert}${ANSI.bold} ${idCell}${ANSI.reset}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
          } else {
            out += `   ${ANSI.dim}${when}${ANSI.reset}  ${ANSI.green}✓${ANSI.reset} ${idCell}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
          }
        });
      }
      out += `\n`;
    }

    if (pending.length === 0) {
      out += `${ANSI.dim}(no pending requests — waiting for new ones…)${ANSI.reset}\n`;
    } else {
      out += `${ANSI.bold}${pending.length} pending${ANSI.reset}\n\n`;
      pending.forEach((p, i) => {
        const sqlOneLine = truncate(p.sql.replace(/\s+/g, " ").trim(), 70);
        const idCell = p.id.padEnd(28, " ");
        const combinedIndex = autoSessionLog.length + i;
        if (combinedIndex === listCursor) {
          out += `${ANSI.invert}${ANSI.bold} ▶ ${idCell}${ANSI.reset}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
        } else {
          out += `   ${idCell}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
        }
      });
    }
  } else if (mode === "sessionDetail") {
    const sel = sessionDetailTarget;
    if (!sel) {
      mode = "list";
      return render();
    }
    out += `${ANSI.dim}Esc: back · q: quit${ANSI.reset}\n\n`;
    out += `${ANSI.bold}${sel.id}${ANSI.reset}  ${ANSI.invert}${ANSI.green} AUTO-APPROVED ${ANSI.reset}\n`;
    out += `${ANSI.dim}approved at:${ANSI.reset} ${new Date(sel.time).toLocaleString()}\n`;
    out += `${ANSI.dim}sql:${ANSI.reset}\n`;
    for (const line of sel.sql.split("\n")) {
      out += `  ${line}\n`;
    }
    out += `\n`;
  } else if (mode === "decide") {
    const sel = decideTarget;
    if (!sel) {
      mode = "list";
      return render();
    }
    out += `${ANSI.dim}←/→ or ↑/↓ choose · Enter: confirm · Esc: back · q: quit${ANSI.reset}\n\n`;
    out += `${ANSI.bold}${sel.id}${ANSI.reset}\n`;
    out += `${ANSI.dim}created:${ANSI.reset} ${sel.createdAt}\n`;
    out += `${ANSI.dim}sql:${ANSI.reset}\n`;
    for (const line of sel.sql.split("\n")) {
      out += `  ${line}\n`;
    }
    out += `\n`;
    const opts: { label: string; color: string }[] = [
      { label: " ✓ Approve ", color: ANSI.green },
      { label: " ✗ Reject  ", color: ANSI.red },
    ];
    opts.forEach((o, i) => {
      if (i === decideCursor) {
        out += `  ${ANSI.invert}${o.color}${ANSI.bold}${o.label}${ANSI.reset}  `;
      } else {
        out += `  ${ANSI.dim}${o.label}${ANSI.reset}  `;
      }
    });
    out += `\n`;
  } else if (mode === "history") {
    const stats = {
      autoApproved: history.filter((h) => h.mode === "auto" && h.decision === "approved").length,
      manualApproved: history.filter((h) => h.mode === "manual" && h.decision === "approved").length,
      rejected: history.filter((h) => h.decision === "rejected").length,
    };
    out += `${ANSI.dim}↑/↓ scroll · PgUp/PgDn page · Esc: back · q: quit${ANSI.reset}\n\n`;
    out += `${ANSI.bold}Approval history${ANSI.reset}  `;
    out += `${ANSI.dim}(showing last ${history.length}, newest first)${ANSI.reset}\n`;
    out += `${ANSI.green}${stats.autoApproved} auto-approved${ANSI.reset}  ·  `;
    out += `${ANSI.cyan}${stats.manualApproved} manual approved${ANSI.reset}  ·  `;
    out += `${ANSI.red}${stats.rejected} rejected${ANSI.reset}\n`;
    out += `${ANSI.dim}log: ${auditPath()}${ANSI.reset}\n\n`;

    if (history.length === 0) {
      out += `${ANSI.dim}(no decisions logged yet)${ANSI.reset}\n`;
    } else {
      const end = Math.min(historyOffset + HISTORY_PAGE_SIZE, history.length);
      for (let i = historyOffset; i < end; i++) {
        const h = history[i]!;
        const when = h.decidedAt.replace("T", " ").slice(0, 19);
        const badge =
          h.mode === "auto"
            ? `${ANSI.invert}${ANSI.green} AUTO ${ANSI.reset}`
            : `${ANSI.dim}MANUAL${ANSI.reset}`;
        const mark =
          h.decision === "approved" ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;
        const sql = truncate(h.sql.replace(/\s+/g, " ").trim(), 70);
        const selected = i === historyCursor;
        const prefix = selected ? `${ANSI.invert} ▶ ` : "   ";
        const idCell = h.id.padEnd(28, " ");
        out += `${prefix}${ANSI.dim}${when}${ANSI.reset}  ${badge} ${mark}  ${idCell}${ANSI.reset}  ${ANSI.dim}${sql}${ANSI.reset}\n`;
      }
      if (history.length > HISTORY_PAGE_SIZE) {
        out += `\n${ANSI.dim}showing ${historyOffset + 1}–${end} of ${history.length}${ANSI.reset}\n`;
      }
    }
  } else {
    // mode === "auto"
    out += `${ANSI.dim}←/→ or ↑/↓ choose duration · Enter: arm · Esc: back · q: quit${ANSI.reset}\n\n`;
    out += `${ANSI.bold}Auto-approve every new request for…${ANSI.reset}\n\n`;
    AUTO_DURATIONS.forEach((mins, i) => {
      const label = ` ${String(mins).padStart(2, " ")} min `;
      if (i === autoCursor) {
        out += `  ${ANSI.invert}${ANSI.green}${ANSI.bold}${label}${ANSI.reset}  `;
      } else {
        out += `  ${ANSI.dim}${label}${ANSI.reset}  `;
      }
    });
    out += `\n\n`;
    out += `${ANSI.yellow}⚠  All pending and incoming queries will run without further prompts.${ANSI.reset}\n`;
    out += `${ANSI.yellow}    You can cancel early by pressing c in the list view.${ANSI.reset}\n`;
  }
  process.stdout.write(out);
};

const flash = (text: string, color: string): void => {
  lastMessage = { text, color };
  setTimeout(() => {
    lastMessage = null;
    render();
  }, 2500);
};

const autoApproveNewPendings = async (): Promise<number> => {
  if (!autoApprove || Date.now() >= autoApprove.until) return 0;
  let count = 0;
  let files: string[] = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0;
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
          sql: r.sql,
          decision: "approved",
          mode: "auto",
        });
        autoSessionLog.unshift({ time: Date.now(), id: r.id, sql: r.sql });
        if (autoSessionLog.length > AUTO_FEED_LIMIT) {
          autoSessionLog = autoSessionLog.slice(0, AUTO_FEED_LIMIT);
        }
        autoSessionApprovedCount++;
        count++;
      } catch {
        // already decided by something else — skip
      }
    }
  }
  return count;
};

const startAutoApprove = async (minutes: number): Promise<void> => {
  autoApprove = { until: Date.now() + minutes * 60 * 1000, durationMinutes: minutes };
  autoSessionLog = [];
  autoSessionApprovedCount = 0;
  if (autoTickTimer) clearInterval(autoTickTimer);
  autoTickTimer = setInterval(() => {
    if (!autoApprove) {
      if (autoTickTimer) {
        clearInterval(autoTickTimer);
        autoTickTimer = null;
      }
      return;
    }
    if (Date.now() >= autoApprove.until) {
      const elapsed = autoApprove.durationMinutes;
      autoApprove = null;
      if (autoTickTimer) {
        clearInterval(autoTickTimer);
        autoTickTimer = null;
      }
      flash(`⏱  Auto-approve window expired (${elapsed} min). Manual approval required again.`, ANSI.yellow);
      void loadPending().then(render);
      return;
    }
    if (mode === "list") render();
  }, 1000);

  const cleared = await autoApproveNewPendings();
  await loadPending();
  flash(
    `🟢 Auto-approve armed for ${minutes} min` + (cleared > 0 ? ` (cleared ${cleared} existing)` : ""),
    ANSI.green,
  );
  render();
};

const cancelAutoApprove = (): void => {
  if (!autoApprove) return;
  autoApprove = null;
  if (autoTickTimer) {
    clearInterval(autoTickTimer);
    autoTickTimer = null;
  }
  flash("Auto-approve cancelled.", ANSI.yellow);
  render();
};

const commitDecision = async (): Promise<void> => {
  const sel = decideTarget;
  if (!sel) return;
  const approve = decideCursor === 0;
  try {
    const updated = await decideRequest(dir, sel.id, approve ? "approved" : "rejected");
    recordDecision({
      decidedAt: new Date().toISOString(),
      id: updated.id,
      sql: sel.sql,
      decision: approve ? "approved" : "rejected",
      mode: "manual",
    });
    flash(
      `${approve ? "✓ approved" : "✗ rejected"} ${updated.id}`,
      approve ? ANSI.green : ANSI.red,
    );
  } catch (err) {
    flash(`! ${(err as Error).message}`, ANSI.yellow);
  }
  mode = "list";
  await loadPending();
  render();
};

const onKey = async (
  _str: string,
  key: { name?: string; ctrl?: boolean; sequence?: string },
): Promise<void> => {
  if (key.ctrl && key.name === "c") return cleanup(0);
  if (key.name === "q" && mode === "list") return cleanup(0);

  if (mode === "list") {
    const items = buildListItems();
    if (key.name === "up" && listCursor > 0) {
      listCursor--;
      render();
    } else if (key.name === "down" && listCursor < items.length - 1) {
      listCursor++;
      render();
    } else if (key.name === "return" && items.length > 0) {
      const item = items[listCursor];
      if (item?.kind === "pending") {
        decideTarget = item.entry;
        mode = "decide";
        decideCursor = 0;
        render();
      } else if (item?.kind === "auto") {
        sessionDetailTarget = item.entry;
        mode = "sessionDetail";
        render();
      }
    } else if (key.name === "r") {
      await loadPending();
      render();
    } else if (key.name === "a") {
      mode = "auto";
      autoCursor = 0;
      render();
    } else if (key.name === "c" && autoApprove) {
      cancelAutoApprove();
    } else if (key.name === "h") {
      history = await readDecisions(200);
      historyCursor = 0;
      historyOffset = 0;
      mode = "history";
      render();
    }
    return;
  }

  if (mode === "history") {
    if (key.name === "escape" || key.name === "h") {
      mode = "list";
      render();
    } else if (key.name === "up" && historyCursor > 0) {
      historyCursor--;
      if (historyCursor < historyOffset) historyOffset = historyCursor;
      render();
    } else if (key.name === "down" && historyCursor < history.length - 1) {
      historyCursor++;
      if (historyCursor >= historyOffset + HISTORY_PAGE_SIZE) {
        historyOffset = historyCursor - HISTORY_PAGE_SIZE + 1;
      }
      render();
    } else if (key.name === "pageup") {
      historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE);
      historyCursor = historyOffset;
      render();
    } else if (key.name === "pagedown") {
      historyOffset = Math.min(
        Math.max(0, history.length - HISTORY_PAGE_SIZE),
        historyOffset + HISTORY_PAGE_SIZE,
      );
      historyCursor = historyOffset;
      render();
    } else if (key.name === "q") {
      return cleanup(0);
    }
    return;
  }

  if (mode === "decide") {
    if (key.name === "left" || key.name === "up") {
      decideCursor = 0;
      render();
    } else if (key.name === "right" || key.name === "down") {
      decideCursor = 1;
      render();
    } else if (key.name === "return") {
      await commitDecision();
    } else if (key.name === "escape") {
      decideTarget = null;
      mode = "list";
      render();
    } else if (key.name === "q") {
      return cleanup(0);
    }
    return;
  }

  if (mode === "sessionDetail") {
    if (key.name === "escape" || key.name === "return") {
      sessionDetailTarget = null;
      mode = "list";
      render();
    } else if (key.name === "q") {
      return cleanup(0);
    }
    return;
  }

  // mode === "auto"
  if (key.name === "left" || key.name === "up") {
    autoCursor = (autoCursor > 0 ? autoCursor - 1 : 0) as AutoCursor;
    render();
  } else if (key.name === "right" || key.name === "down") {
    autoCursor = (autoCursor < AUTO_DURATIONS.length - 1 ? autoCursor + 1 : autoCursor) as AutoCursor;
    render();
  } else if (key.name === "return") {
    const mins = AUTO_DURATIONS[autoCursor]!;
    mode = "list";
    await startAutoApprove(mins);
  } else if (key.name === "escape") {
    mode = "list";
    render();
  } else if (key.name === "q") {
    return cleanup(0);
  }
};

const cleanup = (code: number): void => {
  mode = "done";
  if (autoTickTimer) {
    clearInterval(autoTickTimer);
    autoTickTimer = null;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ANSI.showCursor);
  process.stdout.write("\n");
  process.exit(code);
};

const main = async (): Promise<void> => {
  await fs.promises.mkdir(dir, { recursive: true });
  await loadPending();

  if (!process.stdin.isTTY) {
    process.stderr.write(
      "watch needs a TTY (interactive terminal). Run it directly, not piped.\n",
    );
    process.exit(2);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (str, key) => {
    void onKey(str, key);
  });

  process.stdout.write(ANSI.hideCursor);
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.on("exit", () => {
    process.stdout.write(ANSI.showCursor);
  });

  // Debounced filesystem watcher.
  let pendingRefresh: NodeJS.Timeout | null = null;
  const scheduleRefresh = (): void => {
    if (pendingRefresh) return;
    pendingRefresh = setTimeout(async () => {
      pendingRefresh = null;
      // If auto-approve is armed, clear any new pendings immediately.
      if (autoApprove && Date.now() < autoApprove.until) {
        await autoApproveNewPendings();
      }
      if (mode === "list") {
        await loadPending();
        render();
      } else {
        await loadPending();
      }
    }, 150);
  };
  fs.watch(dir, () => scheduleRefresh());

  // Belt-and-braces poll in case fs.watch misses an event (macOS sometimes does).
  setInterval(() => scheduleRefresh(), 2000);

  render();
};

main().catch((err) => {
  process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  cleanup(1);
});
