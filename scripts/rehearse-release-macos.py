#!/usr/bin/env python3
"""Verify and smoke-test prebuilt release candidates in a disposable Mac home."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path, help='Depot build-only Go bundle ZIP')
    parser.add_argument('--bundle-sha256', required=True, help='expected SHA256 of the private Go ZIP')
    parser.add_argument('--package', required=True, type=Path, help='reviewed npm tarball')
    parser.add_argument('--package-sha256', required=True, help='expected SHA256 from the release rehearsal')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('native macOS is required; an OS label or cross-build is not a native test')
    if not re.fullmatch('[a-f0-9]{64}', args.bundle_sha256) or sha256(args.bundle) != args.bundle_sha256:
        parser.error('Go bundle checksum mismatch')
    if not re.fullmatch('[a-f0-9]{64}', args.package_sha256) or sha256(args.package) != args.package_sha256:
        parser.error('npm candidate checksum mismatch')
    archive = args.package.resolve()
    arch = {'arm64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine())
    if not arch:
        parser.error('unsupported macOS architecture')
    with tempfile.TemporaryDirectory(prefix='doomer-release-rehearsal-') as directory:
        root = Path(directory)
        bundle = root / 'bundle'
        bundle.mkdir()
        with zipfile.ZipFile(args.bundle) as zipped:
            for member in zipped.infolist():
                if member.is_dir():
                    continue
                name = PurePosixPath(member.filename)
                if name.is_absolute() or '..' in name.parts or (bundle / name.name).exists():
                    parser.error('unsafe or duplicate bundle member')
                (bundle / name.name).write_bytes(zipped.read(member))
        for line in (bundle / 'checksums.txt').read_text().splitlines():
            digest, name = line.split(maxsplit=1)
            name = name.lstrip('*')
            if PurePosixPath(name).name != name or sha256(bundle / name) != digest:
                parser.error('Go bundle checksum mismatch')
        manifest = json.loads((bundle / 'release-manifest.json').read_text())
        version = manifest['version']
        native = root / 'doomer'
        with tarfile.open(bundle / f'doomer_{version}_darwin_{arch}.tar.gz') as tar:
            members = [m for m in tar if m.name.removeprefix('./') == 'doomer']
            if len(members) != 1 or not members[0].isfile():
                parser.error('native archive must contain one regular executable')
            native.write_bytes(tar.extractfile(members[0]).read())
        native.chmod(0o700)
        with tarfile.open(archive) as tar:
            for member in tar:
                name = PurePosixPath(member.name)
                if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'package':
                    parser.error('unsafe npm member')
                path = root.joinpath(*name.parts)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(tar.extractfile(member).read())
                else:
                    parser.error('npm archive contains a non-regular member')
        home = root / 'home'
        home.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith(('DOOMER_', 'CODEX_', 'CLAUDE_', 'XDG_', 'NPM_CONFIG_'))}
        env.update(HOME=str(home), CODEX_HOME=str(home / '.codex'), CLAUDE_CONFIG_DIR=str(home / '.claude'),
                   DOOMER_NATIVE_BINARY=str(native), XDG_DATA_HOME=str(home / '.local/share'),
                   XDG_CONFIG_HOME=str(home / '.config'), NPM_CONFIG_CACHE=str(root / 'npm-cache'),
                   NPM_CONFIG_USERCONFIG=str(root / 'npmrc'), GIT_CONFIG_GLOBAL='/dev/null')
        entry = root / 'package/bin/doomer.js'
        subprocess.run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
                       cwd=entry.parent.parent, env=env, check=True)
        def manager(*arguments):
            result = subprocess.run(['node', str(entry), *arguments, '--json'], cwd=root, env=env,
                                    check=True, stdout=subprocess.PIPE, text=True)
            return json.loads(result.stdout)
        standalone = manager('install', '--from', str(archive), '--no-hooks')
        assert standalone['ready'] and standalone['agents'] == [] and not standalone['uploadApproved']
        hooked = manager('onboard', '--agent', 'codex,claude')
        assert hooked['ready'] and not hooked['uploadApproved']
        assert {h['agent'] for h in hooked['hooks'] if h['configured']} == {'codex', 'claude'}
        assert sha256(Path(hooked['executable'])) == sha256(native)
        print(json.dumps({'passed': True, 'platform': platform.platform(), 'version': version,
                          'standalone': True, 'hook_configuration': True, 'uploads_declined': True,
                          'native_hook_activation': 'not tested; requires a real agent session'}, indent=2))


if __name__ == '__main__':
    main()
