#!/usr/bin/env bash
# Install this MCP server into Claude Code (user scope).
# Reads MSSQL_* and MCP_* config from .env at runtime — no creds in the MCP config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENTRY="${PROJECT_DIR}/dist/index.js"
NAME="mssql"
SCOPE="${MCP_SCOPE:-user}"   # override with: MCP_SCOPE=project ./install-mcp.sh

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH. Install Claude Code first." >&2
  exit 1
fi

if [[ ! -f "${ENTRY}" ]]; then
  echo "Compiled entry not found at ${ENTRY} — running 'npm run build' first..."
  (cd "${PROJECT_DIR}" && npm run build)
fi

if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
  echo "warning: ${PROJECT_DIR}/.env does not exist — server will fail to start." >&2
  echo "         copy .env.example to .env and fill in MSSQL_* values." >&2
fi

# Remove existing registration if present (idempotent install).
claude mcp remove "${NAME}" --scope "${SCOPE}" >/dev/null 2>&1 || true

claude mcp add "${NAME}" --scope "${SCOPE}" -- node "${ENTRY}"

echo
echo "Installed MCP server '${NAME}' (scope=${SCOPE}) → node ${ENTRY}"
echo "Config source: ${PROJECT_DIR}/.env"
echo "Restart any open Claude Code session, then run /mcp to verify."
