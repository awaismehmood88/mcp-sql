#!/usr/bin/env bash
# Reverse of install-mcp.sh: unregister the MCP server from Claude Code and
# remove the global `mcp-sql*` commands. Leaves node_modules, dist and .env alone.
# Usage:  ./scripts/uninstall-mcp.sh   (or: npm run uninstall:mcp)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NAME="mssql"
SCOPE="${MCP_SCOPE:-user}"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

step "Unregistering MCP server '${NAME}' (scope=${SCOPE})"
if command -v claude >/dev/null 2>&1; then
  if claude mcp remove "${NAME}" --scope "${SCOPE}" >/dev/null 2>&1; then
    echo "removed."
  else
    echo "nothing to remove — '${NAME}' was not registered at scope=${SCOPE}."
  fi
else
  echo "'claude' CLI not found on PATH — skipped."
fi

step "Removing global commands"
LOCAL_BIN="${HOME}/.local/bin"
MARKER="# added by mcp-mssql install-mcp.sh"
removed=0
for name in mcp-sql mcp-sql-approve mcp-sql-check mcp-sql-server; do
  f="${LOCAL_BIN}/${name}"
  if [[ -f "${f}" ]] && grep -qF "${MARKER}" "${f}"; then
    rm -f "${f}"; removed=$((removed+1))
  fi
done
[[ ${removed} -gt 0 ]] && echo "removed ${removed} wrapper(s) from ${LOCAL_BIN}"
# Drop the PATH line we added (the marker line + the export that follows it).
for RC in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.profile"; do
  if [[ -f "${RC}" ]] && grep -qF "${MARKER}" "${RC}"; then
    tmp="$(mktemp)"
    awk -v m="${MARKER}" '$0==m {skip=1; next} skip==1 {skip=0; next} {print}' "${RC}" > "${tmp}" && mv "${tmp}" "${RC}"
    echo "removed PATH line from ${RC}"
  fi
done
# npm link variant (only succeeds if the global prefix is writable).
if [[ -L "$(npm prefix -g)/lib/node_modules/mcp-mssql" ]]; then
  npm rm -g mcp-mssql >/dev/null 2>&1 && echo "removed npm global link" || echo "could not remove npm global link — try: sudo npm rm -g mcp-mssql"
fi
if command -v mcp-sql >/dev/null 2>&1; then
  echo "'mcp-sql' is still on PATH at $(command -v mcp-sql) (shell alias or other install?)"
else
  echo "'mcp-sql' no longer on PATH."
fi

echo
echo "Done. Restart any open Claude Code session for it to drop the connection."
