#!/usr/bin/env bash
set -euo pipefail

# A source bundle has doomer/, doomer-node/, and skills/ side by side.
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'Usage: %s API_URL [claude|codex|claude,codex]\n' "$0" >&2
  exit 2
fi
api_url=$1
agents=${2:-claude}
case "$agents" in claude|codex|claude,codex|codex,claude) ;; *) printf 'Invalid agent selection\n' >&2; exit 2 ;; esac
node --input-type=module - "$api_url" "$source_root/doomer-node" <<'JS'
const { endpoint } = await import(`${process.argv[3]}/src/api.js`);
endpoint(process.argv[2]);
JS
# Clear inherited production tokens and conflicting install modes. The selected
# endpoint is persisted by onboarding; launch the agent with this URL as well.
unset DOOMER_TOKEN DOOMER_DEV_INSTALL DOOMER_DEV_HOME DOOMER_NATIVE_BINARY
export DOOMER_API_URL="$api_url"
export DOOMER_CONFIG_DIR="${DOOMER_LOCAL_CONFIG_DIR:-$HOME/.config/doomer-local-testing}"
export DOOMER_HOME="${DOOMER_LOCAL_HOME:-$HOME/.local/share/doomer-node}"
export DOOMER_BIN_DIR="${DOOMER_LOCAL_BIN_DIR:-$HOME/.local/bin}"

make -C "$source_root/doomer" build
npm --prefix "$source_root/doomer-node" ci --ignore-scripts --no-audit --no-fund
export DOOMER_NATIVE_BINARY="$source_root/doomer/bin/doomer"
node "$source_root/doomer-node/bin/doomer.js" install --agent "$agents" --api-url "$api_url" --skill-source "$source_root/skills"
node "$source_root/doomer-node/bin/doomer.js" doctor --json
printf '\nLaunch your agent with DOOMER_API_URL=%q and DOOMER_CONFIG_DIR=%q; unset DOOMER_TOKEN.\n' "$DOOMER_API_URL" "$DOOMER_CONFIG_DIR"
printf 'Review /hooks and start a new agent session after installing.\n'
