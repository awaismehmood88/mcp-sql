// MCP stdio uses stdout for protocol traffic — every log line goes to stderr.
// We also append the same lines to <project>/logs/server.log so they're
// reviewable after the fact regardless of which client launched the server.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/logger.js → ..  →  project root.
const projectRoot = path.resolve(here, "..");
const logsDir = path.join(projectRoot, "logs");
const logFile = path.join(logsDir, "server.log");

let stream: fs.WriteStream | null = null;
const getStream = (): fs.WriteStream | null => {
  if (stream) return stream;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    stream = fs.createWriteStream(logFile, { flags: "a" });
    stream.on("error", (err) => {
      process.stderr.write(`[logger] file stream error: ${err.message}\n`);
      stream = null;
    });
    return stream;
  } catch (err) {
    process.stderr.write(
      `[logger] failed to open ${logFile}: ${(err as Error).message}\n`,
    );
    return null;
  }
};

const ts = () => new Date().toISOString();

const write = (level: "info" | "warn" | "error", msg: string, meta?: unknown) => {
  const line = `[${ts()}] [${level}] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`;
  process.stderr.write(line);
  getStream()?.write(line);
};

export const log = {
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
};

export const logPaths = { dir: logsDir, file: logFile };
