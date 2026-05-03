// MCP stdio uses stdout for protocol traffic — every log line MUST go to stderr.

const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string, meta?: unknown) => {
    process.stderr.write(`[${ts()}] [info] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
  },
  warn: (msg: string, meta?: unknown) => {
    process.stderr.write(`[${ts()}] [warn] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
  },
  error: (msg: string, meta?: unknown) => {
    process.stderr.write(`[${ts()}] [error] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
  },
};
