#!/usr/bin/env node
// `mcp-sql` — the operator dashboard.
//   list    :  ↑/↓ navigate · Enter decide / view · a auto-approve · c cancel auto · h history · r refresh · q quit
//   decide  :  ←/→ or ↑/↓ Approve/Reject · Enter confirm · Esc back
//   auto    :  pick duration (then scope when several connections) · Enter arm · Esc back
//   history :  ↑/↓ scroll · PgUp/PgDn page · Esc back
//
// Auto-approve is a lease FILE honoured by the MCP server itself, so arming
// it here and closing this dashboard still keeps approving until it expires.

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { decideRequest, readRequest } from "../gating/dualStage.js";
import { resolvePendingDir } from "../paths.js";
import { auditPath, readDecisions, recordDecision, type AuditEntry } from "../audit.js";
import {
  armLease,
  AUTO_DURATIONS,
  clearLease,
  describeScope,
  formatRemaining,
  leaseRemainingMs,
  readLease,
  type AutoLease,
} from "../gating/autoLease.js";
import { loadConfig, type ConnectionConfig } from "../config.js";
import { sweepPendingUnderLease } from "../gating/autoApprove.js";

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

// ---------------------------------------------------------------- state ---

interface PendingItem {
  id: string;
  connection: string | undefined;
  sql: string;
  createdAt: string;
}

type Mode = "list" | "decide" | "autoDuration" | "autoScope" | "history" | "feedDetail" | "done";

type ListItem =
  | { kind: "auto"; entry: AuditEntry }
  | { kind: "pending"; entry: PendingItem };

// Connections are informational here; the dashboard must still work if the
// .env is incomplete, so a config error is shown instead of crashing.
let connections: ConnectionConfig[] = [];
let configError: string | null = null;
try {
  connections = loadConfig().connections;
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
}

let pending: PendingItem[] = [];
let lease: AutoLease | null = null;
// Remembered after a lease ends so the feed of what it approved stays visible.
let lastLeaseArmedAt: string | null = null;
let autoFeed: AuditEntry[] = [];
const AUTO_FEED_LIMIT = 20;

let mode: Mode = "list";
let listCursor = 0;
let decideTarget: PendingItem | null = null;
let decideCursor: 0 | 1 = 0;
let feedDetailTarget: AuditEntry | null = null;
let autoDurationCursor = 0;
let autoScopeCursor = 0;
let chosenMinutes = 0;
let lastMessage: { text: string; color: string } | null = null;
let history: AuditEntry[] = [];
let historyCursor = 0;
let historyOffset = 0;
const HISTORY_PAGE_SIZE = 20;

const connTag = (c: string | undefined): string => `[${c ?? "default"}]`;
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (sql: string, n: number): string => truncate(sql.replace(/\s+/g, " ").trim(), n);

const buildListItems = (): ListItem[] => [
  ...autoFeed.map((entry) => ({ kind: "auto" as const, entry })),
  ...pending.map((entry) => ({ kind: "pending" as const, entry })),
];

// Scope options for the auto picker: "all" first, then each tag.
const scopeOptions = (): { label: string; connections: string[] | null }[] => [
  { label: "all connections", connections: null },
  ...connections.map((c) => ({ label: c.tag, connections: [c.tag] })),
];

// --------------------------------------------------------------- loaders ---

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
  const fresh: PendingItem[] = [];
  for (const id of files.map(idFromFile).filter((x): x is string => x !== null)) {
    const r = await readRequest(dir, id).catch(() => null);
    if (r?.status === "pending") {
      fresh.push({ id: r.id, connection: r.connection, sql: r.sql, createdAt: r.createdAt });
    }
  }
  fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  pending = fresh;
};

const loadLease = async (): Promise<void> => {
  const l = await readLease(dir).catch(() => null);
  if (l) lastLeaseArmedAt = l.armedAt;
  lease = l;
};

// Everything the current (or most recent) lease auto-approved, newest first.
const loadAutoFeed = async (): Promise<void> => {
  const since = lease?.armedAt ?? lastLeaseArmedAt;
  if (!since) {
    autoFeed = [];
    return;
  }
  const all = await readDecisions(500).catch(() => [] as AuditEntry[]);
  autoFeed = all.filter((h) => h.mode === "auto" && h.decidedAt >= since).slice(0, AUTO_FEED_LIMIT);
};

const refresh = async (): Promise<void> => {
  await loadLease();
  // Fallback sweep: the server approves its own requests under a lease, but a
  // server started before lease support existed (or several stale ones from
  // old Claude Code sessions sharing this dir) never will. While the
  // dashboard is open it covers for them.
  if (lease) await sweepPendingUnderLease(dir, lease).catch(() => []);
  await Promise.all([loadPending(), loadAutoFeed()]);
  const total = autoFeed.length + pending.length;
  if (listCursor >= total) listCursor = Math.max(0, total - 1);
};

// ---------------------------------------------------------------- render ---

const header = (): string => {
  let out = `${ANSI.bold}${ANSI.cyan}mcp-sql dashboard${ANSI.reset}  ${ANSI.dim}${dir}${ANSI.reset}\n`;
  if (configError) {
    out += `${ANSI.yellow}config: ${truncate(configError, 100)}${ANSI.reset}\n`;
  } else {
    out += connections
      .map(
        (c) =>
          `  ${ANSI.cyan}${c.tag.padEnd(12, " ")}${ANSI.reset} ${ANSI.dim}${truncate(c.description, 60)}${ANSI.reset}`,
      )
      .join("\n");
    out += "\n";
  }
  return out + "\n";
};

const autoBanner = (): string => {
  if (!lease) return "";
  return (
    `${ANSI.invert}${ANSI.green}${ANSI.bold} 🟢 AUTO-APPROVE ${formatRemaining(leaseRemainingMs(lease))} remaining ` +
    `· ${describeScope(lease)} · ${lease.durationMinutes} min window · armed by ${lease.armedBy} · c to cancel ${ANSI.reset}\n\n`
  );
};

const renderList = (): string => {
  const items = buildListItems();
  if (listCursor >= items.length) listCursor = Math.max(0, items.length - 1);
  const enterLabel =
    items.length === 0 ? "—" : items[listCursor]?.kind === "pending" ? "decide" : "view";
  let out =
    `${ANSI.dim}↑/↓ navigate · Enter: ${enterLabel} · a: auto-approve · ` +
    `${lease ? "c: cancel auto · " : ""}h: history · r: refresh · q: quit${ANSI.reset}\n\n`;

  if (lease || autoFeed.length > 0) {
    const label = lease
      ? `${ANSI.green}Auto-approved this session${ANSI.reset}`
      : `${ANSI.dim}Auto-approved (last session)${ANSI.reset}`;
    out += `${label}  ${ANSI.bold}${autoFeed.length}${ANSI.reset}${autoFeed.length >= AUTO_FEED_LIMIT ? ` ${ANSI.dim}(newest ${AUTO_FEED_LIMIT})${ANSI.reset}` : ""}\n`;
    if (autoFeed.length === 0) {
      out += `  ${ANSI.dim}(none yet — waiting for incoming queries…)${ANSI.reset}\n`;
    } else {
      autoFeed.forEach((h, i) => {
        const when = new Date(h.decidedAt).toLocaleTimeString();
        const row = `${when}  ${ANSI.green}✓${ANSI.reset} ${h.id.padEnd(28, " ")}  ${ANSI.cyan}${connTag(h.connection).padEnd(12, " ")}${ANSI.reset} ${ANSI.dim}${oneLine(h.sql, 60)}${ANSI.reset}`;
        out += i === listCursor ? `${ANSI.invert} ▶ ${row}${ANSI.reset}\n` : `   ${row}\n`;
      });
    }
    out += "\n";
  }

  if (pending.length === 0) {
    out += `${ANSI.dim}(no pending requests — waiting for new ones…)${ANSI.reset}\n`;
  } else {
    out += `${ANSI.bold}${pending.length} pending${ANSI.reset}  ${ANSI.dim}(needs your approval)${ANSI.reset}\n\n`;
    pending.forEach((p, i) => {
      const row = `${p.id.padEnd(28, " ")}  ${ANSI.cyan}${connTag(p.connection).padEnd(12, " ")}${ANSI.reset} ${ANSI.dim}${oneLine(p.sql, 60)}${ANSI.reset}`;
      out += autoFeed.length + i === listCursor ? `${ANSI.invert}${ANSI.bold} ▶ ${row}${ANSI.reset}\n` : `   ${row}\n`;
    });
  }
  return out;
};

const renderSql = (sql: string): string => sql.split("\n").map((l) => `  ${l}`).join("\n") + "\n";

const renderDecide = (): string => {
  const sel = decideTarget!;
  let out = `${ANSI.dim}←/→ or ↑/↓ choose · Enter: confirm · Esc: back · q: quit${ANSI.reset}\n\n`;
  out += `${ANSI.bold}${sel.id}${ANSI.reset}\n`;
  out += `${ANSI.dim}created:${ANSI.reset} ${sel.createdAt}\n`;
  out += `${ANSI.dim}connection:${ANSI.reset} ${ANSI.cyan}${ANSI.bold}${sel.connection ?? "default"}${ANSI.reset}\n`;
  out += `${ANSI.dim}sql:${ANSI.reset}\n${renderSql(sel.sql)}\n`;
  const opts = [
    { label: " ✓ Approve ", color: ANSI.green },
    { label: " ✗ Reject  ", color: ANSI.red },
  ];
  out += opts
    .map((o, i) =>
      i === decideCursor
        ? `  ${ANSI.invert}${o.color}${ANSI.bold}${o.label}${ANSI.reset}  `
        : `  ${ANSI.dim}${o.label}${ANSI.reset}  `,
    )
    .join("");
  return out + "\n";
};

const renderFeedDetail = (): string => {
  const h = feedDetailTarget!;
  let out = `${ANSI.dim}Esc: back · q: quit${ANSI.reset}\n\n`;
  out += `${ANSI.bold}${h.id}${ANSI.reset}  ${ANSI.invert}${ANSI.green} AUTO-APPROVED ${ANSI.reset}\n`;
  out += `${ANSI.dim}approved at:${ANSI.reset} ${new Date(h.decidedAt).toLocaleString()}\n`;
  out += `${ANSI.dim}connection:${ANSI.reset} ${ANSI.cyan}${h.connection ?? "default"}${ANSI.reset}\n`;
  if (h.reason) out += `${ANSI.dim}lease:${ANSI.reset} ${h.reason}\n`;
  out += `${ANSI.dim}sql:${ANSI.reset}\n${renderSql(h.sql)}`;
  return out;
};

const renderAutoDuration = (): string => {
  let out = `${ANSI.dim}←/→ or ↑/↓ choose duration · Enter: ${connections.length > 1 ? "next" : "arm"} · Esc: back · q: quit${ANSI.reset}\n\n`;
  out += `${ANSI.bold}Auto-approve every new request for…${ANSI.reset}\n\n`;
  out += AUTO_DURATIONS.map((mins, i) => {
    const label = ` ${String(mins).padStart(2, " ")} min `;
    return i === autoDurationCursor
      ? `  ${ANSI.invert}${ANSI.green}${ANSI.bold}${label}${ANSI.reset}  `
      : `  ${ANSI.dim}${label}${ANSI.reset}  `;
  }).join("");
  out += `\n\n${ANSI.yellow}⚠  Matching queries will run without further prompts, even if you close this dashboard.${ANSI.reset}\n`;
  out += `${ANSI.yellow}    The MCP server honours the lease itself. Cancel any time with c here or 'mcp-sql-approve auto off'.${ANSI.reset}\n`;
  return out;
};

const renderAutoScope = (): string => {
  let out = `${ANSI.dim}↑/↓ choose scope · Enter: arm for ${chosenMinutes} min · Esc: back · q: quit${ANSI.reset}\n\n`;
  out += `${ANSI.bold}Which connections should auto-approve?${ANSI.reset}\n\n`;
  scopeOptions().forEach((o, i) => {
    const desc = o.connections ? connections.find((c) => c.tag === o.connections![0])?.description ?? "" : "";
    out +=
      i === autoScopeCursor
        ? `  ${ANSI.invert}${ANSI.green}${ANSI.bold} ${o.label.padEnd(16, " ")} ${ANSI.reset} ${ANSI.dim}${truncate(desc, 60)}${ANSI.reset}\n`
        : `   ${o.label.padEnd(16, " ")}  ${ANSI.dim}${truncate(desc, 60)}${ANSI.reset}\n`;
  });
  return out;
};

const renderHistory = (): string => {
  const stats = {
    auto: history.filter((h) => h.mode === "auto" && h.decision === "approved").length,
    manual: history.filter((h) => h.mode === "manual" && h.decision === "approved").length,
    rejected: history.filter((h) => h.decision === "rejected").length,
  };
  let out = `${ANSI.dim}↑/↓ scroll · PgUp/PgDn page · Esc: back · q: quit${ANSI.reset}\n\n`;
  out += `${ANSI.bold}Approval history${ANSI.reset}  ${ANSI.dim}(last ${history.length}, newest first)${ANSI.reset}\n`;
  out += `${ANSI.green}${stats.auto} auto-approved${ANSI.reset}  ·  ${ANSI.cyan}${stats.manual} manual approved${ANSI.reset}  ·  ${ANSI.red}${stats.rejected} rejected${ANSI.reset}\n`;
  out += `${ANSI.dim}log: ${auditPath()}${ANSI.reset}\n\n`;
  if (history.length === 0) return out + `${ANSI.dim}(no decisions logged yet)${ANSI.reset}\n`;
  const end = Math.min(historyOffset + HISTORY_PAGE_SIZE, history.length);
  for (let i = historyOffset; i < end; i++) {
    const h = history[i]!;
    const when = h.decidedAt.replace("T", " ").slice(0, 19);
    const badge = h.mode === "auto" ? `${ANSI.invert}${ANSI.green} AUTO ${ANSI.reset}` : `${ANSI.dim}MANUAL${ANSI.reset}`;
    const mark = h.decision === "approved" ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;
    const prefix = i === historyCursor ? `${ANSI.invert} ▶ ` : "   ";
    out += `${prefix}${ANSI.dim}${when}${ANSI.reset}  ${badge} ${mark}  ${h.id.padEnd(28, " ")}${ANSI.reset}  ${ANSI.cyan}${connTag(h.connection).padEnd(12, " ")}${ANSI.reset} ${ANSI.dim}${oneLine(h.sql, 60)}${ANSI.reset}\n`;
  }
  if (history.length > HISTORY_PAGE_SIZE) {
    out += `\n${ANSI.dim}showing ${historyOffset + 1}–${end} of ${history.length}${ANSI.reset}\n`;
  }
  return out;
};

const render = (): void => {
  if (mode === "done") return;
  let out = ANSI.clear + header() + autoBanner();
  if (lastMessage) out += `${lastMessage.color}${lastMessage.text}${ANSI.reset}\n\n`;
  switch (mode) {
    case "list":
      out += renderList();
      break;
    case "decide":
      out += decideTarget ? renderDecide() : renderList();
      break;
    case "feedDetail":
      out += feedDetailTarget ? renderFeedDetail() : renderList();
      break;
    case "autoDuration":
      out += renderAutoDuration();
      break;
    case "autoScope":
      out += renderAutoScope();
      break;
    case "history":
      out += renderHistory();
      break;
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

// --------------------------------------------------------------- actions ---

const arm = async (minutes: number, scope: string[] | null): Promise<void> => {
  try {
    const l = await armLease(dir, { minutes, connections: scope });
    const swept = await sweepPendingUnderLease(dir, l);
    await refresh();
    flash(
      `🟢 Auto-approve armed for ${minutes} min on ${describeScope(l)}` +
        (swept.length > 0 ? ` — approved ${swept.length} already-pending` : ""),
      ANSI.green,
    );
  } catch (err) {
    flash(`! ${(err as Error).message}`, ANSI.yellow);
  }
  mode = "list";
  render();
};

const disarm = async (): Promise<void> => {
  await clearLease(dir).catch(() => false);
  await refresh();
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
      connection: sel.connection,
      sql: sel.sql,
      decision: approve ? "approved" : "rejected",
      mode: "manual",
    });
    flash(`${approve ? "✓ approved" : "✗ rejected"} ${updated.id}`, approve ? ANSI.green : ANSI.red);
  } catch (err) {
    flash(`! ${(err as Error).message}`, ANSI.yellow);
  }
  mode = "list";
  await refresh();
  render();
};

// ------------------------------------------------------------------ keys ---

type Key = { name?: string; ctrl?: boolean };

const onKey = async (_str: string, key: Key): Promise<void> => {
  if (key.ctrl && key.name === "c") return cleanup(0);
  if (key.name === "q") return cleanup(0);

  switch (mode) {
    case "list": {
      const items = buildListItems();
      if (key.name === "up" && listCursor > 0) listCursor--;
      else if (key.name === "down" && listCursor < items.length - 1) listCursor++;
      else if (key.name === "return" && items.length > 0) {
        const item = items[listCursor]!;
        if (item.kind === "pending") {
          decideTarget = item.entry;
          decideCursor = 0;
          mode = "decide";
        } else {
          feedDetailTarget = item.entry;
          mode = "feedDetail";
        }
      } else if (key.name === "r") await refresh();
      else if (key.name === "a") {
        autoDurationCursor = 0;
        mode = "autoDuration";
      } else if (key.name === "c" && lease) return disarm();
      else if (key.name === "h") {
        history = await readDecisions(200);
        historyCursor = 0;
        historyOffset = 0;
        mode = "history";
      }
      return render();
    }
    case "decide":
      if (key.name === "left" || key.name === "up") decideCursor = 0;
      else if (key.name === "right" || key.name === "down") decideCursor = 1;
      else if (key.name === "return") return commitDecision();
      else if (key.name === "escape") {
        decideTarget = null;
        mode = "list";
      }
      return render();
    case "feedDetail":
      if (key.name === "escape" || key.name === "return") {
        feedDetailTarget = null;
        mode = "list";
      }
      return render();
    case "autoDuration":
      if (key.name === "left" || key.name === "up") autoDurationCursor = Math.max(0, autoDurationCursor - 1);
      else if (key.name === "right" || key.name === "down")
        autoDurationCursor = Math.min(AUTO_DURATIONS.length - 1, autoDurationCursor + 1);
      else if (key.name === "return") {
        chosenMinutes = AUTO_DURATIONS[autoDurationCursor]!;
        if (connections.length > 1) {
          autoScopeCursor = 0;
          mode = "autoScope";
        } else {
          return arm(chosenMinutes, null);
        }
      } else if (key.name === "escape") mode = "list";
      return render();
    case "autoScope": {
      const opts = scopeOptions();
      if (key.name === "up" || key.name === "left") autoScopeCursor = Math.max(0, autoScopeCursor - 1);
      else if (key.name === "down" || key.name === "right")
        autoScopeCursor = Math.min(opts.length - 1, autoScopeCursor + 1);
      else if (key.name === "return") return arm(chosenMinutes, opts[autoScopeCursor]!.connections);
      else if (key.name === "escape") mode = "autoDuration";
      return render();
    }
    case "history":
      if (key.name === "escape" || key.name === "h") mode = "list";
      else if (key.name === "up" && historyCursor > 0) {
        historyCursor--;
        if (historyCursor < historyOffset) historyOffset = historyCursor;
      } else if (key.name === "down" && historyCursor < history.length - 1) {
        historyCursor++;
        if (historyCursor >= historyOffset + HISTORY_PAGE_SIZE) historyOffset = historyCursor - HISTORY_PAGE_SIZE + 1;
      } else if (key.name === "pageup") {
        historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE);
        historyCursor = historyOffset;
      } else if (key.name === "pagedown") {
        historyOffset = Math.min(Math.max(0, history.length - HISTORY_PAGE_SIZE), historyOffset + HISTORY_PAGE_SIZE);
        historyCursor = historyOffset;
      }
      return render();
    case "done":
      return;
  }
};

// -------------------------------------------------------------- lifecycle ---

const cleanup = (code: number): void => {
  mode = "done";
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ANSI.showCursor + "\n");
  process.exit(code);
};

const main = async (): Promise<void> => {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "mcp-sql needs a TTY (interactive terminal). For scripts use mcp-sql-approve.\n",
    );
    process.exit(2);
  }
  await fs.promises.mkdir(dir, { recursive: true });
  await refresh();

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (str, key) => void onKey(str, key));

  process.stdout.write(ANSI.hideCursor);
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.on("exit", () => process.stdout.write(ANSI.showCursor));

  // Debounced filesystem watcher + belt-and-braces poll (macOS fs.watch can miss events).
  let pendingRefresh: NodeJS.Timeout | null = null;
  const scheduleRefresh = (): void => {
    if (pendingRefresh) return;
    pendingRefresh = setTimeout(async () => {
      pendingRefresh = null;
      await refresh();
      if (mode === "list") render();
    }, 150);
  };
  fs.watch(dir, () => scheduleRefresh());
  setInterval(() => scheduleRefresh(), 2000);

  // 1 s tick keeps the countdown banner live and notices lease expiry.
  setInterval(async () => {
    const had = lease !== null;
    await loadLease();
    if (had && !lease) {
      flash("⏱  Auto-approve window expired. Manual approval required again.", ANSI.yellow);
    }
    if (mode === "list") render();
  }, 1000);

  render();
};

main().catch((err) => {
  process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  cleanup(1);
});
