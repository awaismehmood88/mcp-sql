import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the pending-requests directory to an absolute path that's stable
// regardless of cwd. When the MCP server is launched by Claude Code from some
// other project, cwd is that project's folder — without this pinning, each
// project would get its own .mcp-pending/ and the watcher would never see them.
//
// Resolution rules:
//   - if MCP_PENDING_DIR is set and absolute, use it verbatim
//   - if MCP_PENDING_DIR is set and relative, resolve it against the MCP
//     server's install dir (the parent of dist/), NOT the current cwd
//   - if MCP_PENDING_DIR is unset, default to <projectRoot>/.mcp-pending
//
// `levelsUp` = how many `..` to climb from the compiled caller's file to
// reach the project root: 1 for files in dist/, 2 for files in dist/cli/.
export const resolvePendingDir = (importMetaUrl: string, levelsUp: number): string => {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  const projectRoot = path.resolve(here, ...Array<string>(levelsUp).fill(".."));
  const raw = process.env.MCP_PENDING_DIR?.trim() || ".mcp-pending";
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
};
