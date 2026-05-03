#!/usr/bin/env bash
# Remove this MCP server from Claude Code.

set -euo pipefail

NAME="mssql"
SCOPE="${MCP_SCOPE:-user}"   # override with: MCP_SCOPE=project ./uninstall-mcp.sh

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH." >&2
  exit 1
fi

if claude mcp remove "${NAME}" --scope "${SCOPE}" 2>&1; then
  echo "Removed MCP server '${NAME}' (scope=${SCOPE})."
  echo "Restart any open Claude Code session for it to drop the connection."
else
  echo "Nothing to remove — '${NAME}' was not registered at scope=${SCOPE}." >&2
fi
