#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
for repo in doomer doomer-node skills; do
  test "$(git -C "$root/$repo" branch --show-current)" = polish-part-2 || { printf 'Expected polish-part-2 in %s\n' "$repo" >&2; exit 1; }
done
stage=$(mktemp -d "${TMPDIR:-/tmp}/doomer-publish.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
python3 "$root/doomer-node/scripts/bundle-local.py" "$stage/source.tar.gz" --root "$root"
target="$root/doomerlabs/public/local-builds/polish-part-2"
mkdir -p "$target"
cp "$stage/source.tar.gz" "$target/.source.tar.gz.new"
mv "$target/.source.tar.gz.new" "$target/source.tar.gz"
cp "$root/doomer-node/scripts/sync-local.sh" "$target/update-doomer.sh"
printf 'Published local bundle: %s\n' "$target/source.tar.gz"
