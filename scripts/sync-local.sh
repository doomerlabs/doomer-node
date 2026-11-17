#!/usr/bin/env bash
# Save on your test machine; rerun to install the latest published local bundle.
set -euo pipefail
origin=${DOOMER_TEST_ORIGIN:-https://dev-5e07a07af5ee.exe.xyz}
agents=${DOOMER_TEST_AGENTS:-claude}
for command in curl node npm git make go tar; do
  command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ required"); process.exit(1) }'
case "$origin" in https://*) ;; *) printf 'HTTPS origin required\n' >&2; exit 2 ;; esac
workdir=$(mktemp -d "${TMPDIR:-/tmp}/doomer-polish.XXXXXXXX")
trap 'rm -rf -- "$workdir"' EXIT
printf 'Downloading current polish-part-2 source bundle…\n'
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --retry 3 \
  "$origin/local-builds/polish-part-2/source.tar.gz" -o "$workdir/source.tar.gz"
tar -xzf "$workdir/source.tar.gz" -C "$workdir"
bash "$workdir/doomer-local/doomer-node/scripts/install-local.sh" "$origin/api" "$agents"
printf '\nUpdate installed. Start a fresh agent session.\n'
