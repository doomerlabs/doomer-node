#!/usr/bin/env python3
"""Bundle current source, including local edits, without Git metadata or secrets."""
import argparse
import io
import pathlib
import subprocess
import tarfile


def bundle(root, destination):
    with tarfile.open(destination, 'x:gz') as archive:
        for component in ('doomer', 'doomer-node', 'skills'):
            checkout = root / component
            names = subprocess.check_output(
                ['git', '-C', str(checkout), 'ls-files', '-z', '--cached', '--others', '--exclude-standard']
            ).split(b'\0')
            for raw in sorted(set(names)):
                if not raw:
                    continue
                name = raw.decode()
                relative = pathlib.PurePosixPath(name)
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError(f'Unsafe source path: {name}')
                # Never bundle working-tree secrets, symlinks or Git internals.
                if any(part in ('.git', '.env', '.env.local', '.envrc', 'node_modules') or part.startswith('.env.') for part in relative.parts):
                    continue
                source = checkout / name
                if not source.exists():
                    continue  # Locally deleted tracked file.
                if source.is_symlink() or not source.is_file():
                    raise ValueError(f'Unsupported source file: {component}/{name}')
                data = source.read_bytes()
                entry = tarfile.TarInfo(f'doomer-local/{component}/{name}')
                entry.size = len(data)
                entry.mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
                archive.addfile(entry, io.BytesIO(data))
        data = b'Run: bash doomer-node/scripts/install-local.sh API_URL [claude|codex|claude,codex]\nRequires Node.js 22+, npm, Git, make and Go matching doomer/go.mod.\n'
        entry = tarfile.TarInfo('doomer-local/INSTALL.txt')
        entry.size = len(data)
        entry.mode = 0o644
        archive.addfile(entry, io.BytesIO(data))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=pathlib.Path)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    bundle(args.root.resolve(), args.destination.resolve())
    print(args.destination.resolve())
