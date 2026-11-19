#!/bin/bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo "Usage: $0 DOOMER_MAC_BINARY codex|claude|codex,claude OUTPUT.pkg" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build the macOS installer on macOS." >&2
  exit 2
fi

doomer_binary=$1
agents=$2
output=$3
case "$agents" in codex|claude|codex,claude|claude,codex) ;; *) exit 2 ;; esac
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
runtime="$stage/root/usr/local/libexec/doomer-mdm"
mkdir -p "$runtime" "$stage/scripts" "$stage/root/Library/LaunchAgents"
install -m 0755 "$doomer_binary" "$runtime/doomer"
install -m 0644 "$source_dir/mdm/com.doomerlabs.doomer.mdm.enroll.plist" "$stage/root/Library/LaunchAgents/"

if [[ ",$agents," == *,claude,* ]]; then
  claude_dir="$stage/root/Library/Application Support/ClaudeCode/managed-settings.d"
  mkdir -p "$claude_dir"
  "$runtime/doomer" mdm agent-config --agent claude > "$claude_dir/50-doomer.json"
fi
if [[ ",$agents," == *,codex,* ]]; then
  mkdir -p "$stage/root/private/etc/codex/rules"
  install -m 0644 "$source_dir/mdm/doomer-mdm.rules" "$stage/root/private/etc/codex/rules/"
  cat > "$stage/scripts/postinstall" <<'SCRIPT'
#!/bin/bash
set -euo pipefail
/usr/bin/install -d -m 0755 /etc/codex
runtime=/usr/local/libexec/doomer-mdm
"$runtime/doomer" mdm agent-config --agent codex --merge-codex /etc/codex/hooks.json
SCRIPT
  chmod 0755 "$stage/scripts/postinstall"
fi

pkg_args=(--root "$stage/root" --scripts "$stage/scripts" --identifier com.doomerlabs.doomer.mdm
  --version "$("$runtime/doomer" --version | awk '{print $2}' | cut -d- -f1)")
if [[ -n "${DOOMER_PKG_SIGN_IDENTITY:-}" ]]; then
  pkg_args+=(--sign "$DOOMER_PKG_SIGN_IDENTITY")
fi
/usr/bin/pkgbuild "${pkg_args[@]}" --install-location / "$output"
