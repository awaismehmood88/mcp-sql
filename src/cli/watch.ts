#!/usr/bin/env node
// Interactive approval terminal.
//   list mode  :  ↑/↓ navigate pending requests · Enter to open · q to quit
//   decide mode:  ←/→ or ↑/↓ to pick Approve/Reject · Enter confirm · Esc back

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { decideRequest, readRequest } from "../gating/dualStage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "..", "..", ".env") });
loadDotenv();

const dir = path.resolve(process.env.MCP_PENDING_DIR?.trim() || ".mcp-pending");

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

type Mode = "list" | "decide" | "done";

let pending: PendingItem[] = [];
let listCursor = 0;
let mode: Mode = "list";
let decideCursor: 0 | 1 = 0; // 0 = Approve, 1 = Reject
let lastMessage: { text: string; color: string } | null = null;

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
  if (listCursor >= pending.length) listCursor = Math.max(0, pending.length - 1);
};

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const render = (): void => {
  if (mode === "done") return;
  let out = ANSI.clear;
  out += `${ANSI.bold}${ANSI.cyan}mcp-mssql approval watcher${ANSI.reset}\n`;
  out += `${ANSI.dim}${dir}${ANSI.reset}\n\n`;

  if (lastMessage) {
    out += `${lastMessage.color}${lastMessage.text}${ANSI.reset}\n\n`;
  }

  if (mode === "list") {
    out += `${ANSI.dim}↑/↓ navigate · Enter: decide · r: refresh · q: quit${ANSI.reset}\n\n`;
    if (pending.length === 0) {
      out += `${ANSI.dim}(no pending requests — waiting for new ones…)${ANSI.reset}\n`;
    } else {
      out += `${ANSI.bold}${pending.length} pending${ANSI.reset}\n\n`;
      pending.forEach((p, i) => {
        const sqlOneLine = truncate(p.sql.replace(/\s+/g, " ").trim(), 70);
        const idCell = p.id.padEnd(28, " ");
        if (i === listCursor) {
          out += `${ANSI.invert}${ANSI.bold} ▶ ${idCell}${ANSI.reset}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
        } else {
          out += `   ${idCell}  ${ANSI.dim}${sqlOneLine}${ANSI.reset}\n`;
        }
      });
    }
  } else {
    const sel = pending[listCursor];
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

const commitDecision = async (): Promise<void> => {
  const sel = pending[listCursor];
  if (!sel) return;
  const approve = decideCursor === 0;
  try {
    const updated = await decideRequest(dir, sel.id, approve ? "approved" : "rejected");
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
  if (key.name === "q" && mode !== "decide") return cleanup(0);

  if (mode === "list") {
    if (key.name === "up" && listCursor > 0) {
      listCursor--;
      render();
    } else if (key.name === "down" && listCursor < pending.length - 1) {
      listCursor++;
      render();
    } else if (key.name === "return" && pending.length > 0) {
      mode = "decide";
      decideCursor = 0;
      render();
    } else if (key.name === "r") {
      await loadPending();
      render();
    }
    return;
  }

  // mode === "decide"
  if (key.name === "left" || key.name === "up") {
    decideCursor = 0;
    render();
  } else if (key.name === "right" || key.name === "down") {
    decideCursor = 1;
    render();
  } else if (key.name === "return") {
    await commitDecision();
  } else if (key.name === "escape") {
    mode = "list";
    render();
  } else if (key.name === "q") {
    return cleanup(0);
  }
};

const cleanup = (code: number): void => {
  mode = "done";
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

  // Debounced filesystem watcher — refreshes the list when files appear/change.
  let pendingRefresh: NodeJS.Timeout | null = null;
  const scheduleRefresh = (): void => {
    if (pendingRefresh) return;
    pendingRefresh = setTimeout(async () => {
      pendingRefresh = null;
      if (mode === "list") {
        await loadPending();
        render();
      } else {
        // In decide mode, just refresh the underlying list silently —
        // re-render on return to list mode.
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
