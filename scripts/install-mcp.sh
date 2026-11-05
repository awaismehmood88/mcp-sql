#!/usr/bin/env bash
# One-shot setup:
#   1. npm install            (dependencies)
#   2. npm run build          (compile to dist/)
#   3. register the server with Claude Code   (claude mcp add mssql …)
#   4. npm link               (global `mcp-sql` dashboard + helper bins)
#
# Reads MSSQL_* and MCP_* config from .env at runtime — no creds in the MCP config.
# Usage:  ./scripts/install-mcp.sh          (or: npm run install:mcp)
#         MCP_SCOPE=project ./scripts/install-mcp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENTRY="${PROJECT_DIR}/dist/index.js"
NAME="mssql"
SCOPE="${MCP_SCOPE:-user}"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "error: node and npm are required (Node 20+)." >&2
  exit 1
fi

step "Installing dependencies"
(cd "${PROJECT_DIR}" && npm install --no-fund --no-audit)

step "Building"
(cd "${PROJECT_DIR}" && npm run build)

if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
  if [[ -f "${PROJECT_DIR}/.env.example" ]]; then
    cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
    warn "created ${PROJECT_DIR}/.env from .env.example — edit it with your MSSQL connection(s) before use."
  else
    warn "${PROJECT_DIR}/.env does not exist — the server will fail to start until you create it."
  fi
fi

step "Registering MCP server '${NAME}' with Claude Code (scope=${SCOPE})"
if command -v claude >/dev/null 2>&1; then
  # Remove existing registration if present (idempotent install).
  claude mcp remove "${NAME}" --scope "${SCOPE}" >/dev/null 2>&1 || true
  claude mcp add "${NAME}" --scope "${SCOPE}" -- node "${ENTRY}"
  echo "registered → node ${ENTRY}"
else
  warn "'claude' CLI not found on PATH — skipped MCP registration. Install Claude Code and re-run, or add manually:"
  echo "    claude mcp add ${NAME} --scope ${SCOPE} -- node ${ENTRY}"
fi

step "Linking global commands (mcp-sql dashboard)"
# Try npm link first; it only works when npm's global prefix is writable
# (nvm/fnm users). Otherwise drop wrapper scripts into ~/.local/bin and make
# sure that dir is on PATH — no sudo needed.
LOCAL_BIN="${HOME}/.local/bin"
MARKER="# added by mcp-mssql install-mcp.sh"
BINS=(mcp-sql:dist/cli/dashboard.js mcp-sql-approve:dist/cli/approve.js mcp-sql-check:dist/cli/check.js mcp-sql-server:dist/index.js)

if (cd "${PROJECT_DIR}" && npm link --no-fund --no-audit >/dev/null 2>&1) && command -v mcp-sql >/dev/null 2>&1; then
  echo "npm link → $(command -v mcp-sql)"
else
  mkdir -p "${LOCAL_BIN}"
  for pair in "${BINS[@]}"; do
    name="${pair%%:*}"; rel="${pair#*:}"
    cat > "${LOCAL_BIN}/${name}" <<WRAP
#!/bin/sh
${MARKER}
exec node "${PROJECT_DIR}/${rel}" "\$@"
WRAP
    chmod +x "${LOCAL_BIN}/${name}"
  done
  echo "wrappers → ${LOCAL_BIN}/{mcp-sql,mcp-sql-approve,mcp-sql-check,mcp-sql-server}"

  case ":${PATH}:" in
    *":${LOCAL_BIN}:"*) ;;
    *)
      case "$(basename "${SHELL:-zsh}")" in
        zsh)  RC="${HOME}/.zshrc" ;;
        bash) RC="${HOME}/.bashrc" ;;
        *)    RC="${HOME}/.profile" ;;
      esac
      if ! grep -qF "${MARKER}" "${RC}" 2>/dev/null; then
        printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n' "${MARKER}" >> "${RC}"
        echo "added ~/.local/bin to PATH in ${RC} — open a new terminal (or: source ${RC})"
      fi
      ;;
  esac
fi

cat <<DONE

Done.
  dashboard      : mcp-sql              (live requests, approve/reject, auto-approve lease)
  scripted       : mcp-sql-approve    (one-shot approve / reject / auto <min>)
  connectivity   : mcp-sql-check [tag]
  config source  : ${PROJECT_DIR}/.env

Restart any open Claude Code session, then run /mcp to verify the '${NAME}' server.
DONE
