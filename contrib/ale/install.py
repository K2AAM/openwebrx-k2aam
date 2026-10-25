#!/usr/bin/env python3
"""Check/install experimental ALE 2G on stock OWRX+ 1.2.126, with backups."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent
STATE = Path('/var/lib/openwebrx/ale2g')
VERSION = '0.3.0'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.owrx-ale-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def plan(package, htdocs, binary_target, baselines=None):
    baselines = json.loads((HERE/'install-baselines.json').read_text()) if baselines is None else baselines
    changes = []
    for relative, expected in baselines.items():
        part, tail = relative.split('/', 1)
        target = htdocs/tail if part == 'htdocs' else package/relative
        source = SOURCE/relative
        if target.is_symlink():
            raise ValueError(f'Refusing to replace a symlink: {target}')
        old = target.read_bytes() if target.exists() else None
        if expected is None and old is not None:
            raise ValueError(f'An ALE file already exists: {target}')
        if expected is not None and (old is None or blob(old) != expected):
            raise ValueError(f'Unsupported or edited OWRX file: {target}. No files changed.')
        changes.append((target, source.read_bytes(), old, target.stat().st_mode & 0o777 if old is not None else 0o644))
    binary = HERE/'decoder/owrx-ale'
    version = subprocess.run([str(binary), '--version'], check=True, capture_output=True, timeout=5).stdout
    if version.strip() != b'owrx-ale 0.1.0':
        raise ValueError('Build this package\'s decoder before installing.')
    if binary_target.exists():
        raise ValueError(f'Refusing to replace an existing decoder: {binary_target}')
    changes.append((binary_target, binary.read_bytes(), None, 0o755))
    return changes


def apply(changes, state):
    if (state/'install.json').exists():
        raise ValueError('ALE is already installed; uninstall before replacing this prototype.')
    state.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='backup-', dir=state))
    record = {'version':VERSION, 'files':[]}
    for index, (target, new, old, mode) in enumerate(changes):
        saved = backup/f'{index}.bak' if old is not None else None
        if saved is not None:
            atomic(saved, old)
        record['files'].append({'path':str(target), 'backup':str(saved) if saved else None,
                                'original_sha256':digest(old) if old is not None else None,
                                'sha256':digest(new), 'mode':mode})
    written = []
    try:
        for target, new, old, mode in changes:
            atomic(target, new, mode)
            written.append((target, old, mode))
        atomic(state/'install.json', (json.dumps(record, indent=2)+'\n').encode())
    except Exception:
        for target, old, mode in reversed(written):
            target.unlink(missing_ok=True) if old is None else atomic(target, old, mode)
        raise


def upgrade(package, htdocs, binary_target, state, write=False, baselines=None):
    """Preserve original uninstall backups while upgrading a verified installation."""
    manifest = state/'install.json'
    original_manifest = manifest.read_bytes()
    record = json.loads(original_manifest)
    if record.get('version') not in ('0.1.0', '0.2.0', VERSION):
        raise ValueError('Unsupported installed ALE version.')
    baselines = json.loads((HERE/'install-baselines.json').read_text()) if baselines is None else baselines
    wanted = {}
    for relative in baselines:
        part, tail = relative.split('/', 1)
        wanted[htdocs/tail if part == 'htdocs' else package/relative] = SOURCE/relative
    wanted[binary_target] = HERE/'decoder/owrx-ale'
    version = subprocess.run([str(wanted[binary_target]), '--version'], check=True,
                             capture_output=True, timeout=5).stdout
    if version.strip() != b'owrx-ale 0.1.0':
        raise ValueError('Build this package decoder before upgrading.')
    changes = []
    seen = set()
    for entry in record['files']:
        target = Path(entry['path'])
        if target in seen or target not in wanted or target.is_symlink():
            raise ValueError(f'Unexpected installed target: {target}')
        seen.add(target)
        current = target.read_bytes()
        if digest(current) != entry['sha256']:
            raise ValueError(f'Installed file changed: {target}. No files changed.')
        if entry['backup'] and digest(Path(entry['backup']).read_bytes()) != entry['original_sha256']:
            raise ValueError(f'Backup changed: {target}. No files changed.')
        new = wanted[target].read_bytes()
        changes.append((target, new, current, target.stat().st_mode & 0o777))
        entry['sha256'] = digest(new)
    new_backups = []
    for target in wanted.keys() - seen:
        relative = next((r for r in baselines if wanted[target] == SOURCE/r), None)
        if relative is None or target.is_symlink():
            raise ValueError(f'Unexpected new ALE target: {target}')
        expected = baselines[relative]
        old = target.read_bytes() if target.exists() else None
        if expected is None and old is not None:
            raise ValueError(f'New ALE asset already exists: {target}')
        if expected is not None and (old is None or blob(old) != expected):
            raise ValueError(f'Unsupported or edited new native target: {target}. No files changed.')
        mode = target.stat().st_mode & 0o777 if old is not None else 0o644
        new = wanted[target].read_bytes()
        changes.append((target, new, old, mode))
        entry = {'path':str(target), 'backup':None, 'original_sha256':digest(old) if old is not None else None,
                 'sha256':digest(new), 'mode':mode}
        record['files'].append(entry)
        if old is not None:
            new_backups.append((entry, old))
    if not write:
        return len(changes)
    written = []
    record['version'] = VERSION
    if new_backups:
        backup = Path(tempfile.mkdtemp(prefix='upgrade-backup-', dir=state))
        for index, (entry, old) in enumerate(new_backups):
            saved = backup/f'{index}.bak'
            atomic(saved, old)
            entry['backup'] = str(saved)
    try:
        for target, new, old, mode in changes:
            atomic(target, new, mode)
            written.append((target, old, mode))
        atomic(manifest, (json.dumps(record, indent=2)+'\n').encode())
    except Exception:
        for target, old, mode in reversed(written):
            target.unlink(missing_ok=True) if old is None else atomic(target, old, mode)
        # atomic() leaves the previous manifest intact on failure.
        raise
    return len(changes)


def undo(state):
    manifest = state/'install.json'
    record = json.loads(manifest.read_text())
    restores = []
    for entry in record['files']:
        target = Path(entry['path'])
        current = target.read_bytes()
        if digest(current) != entry['sha256']:
            raise ValueError(f'Installed file changed: {target}. No files restored.')
        old = Path(entry['backup']).read_bytes() if entry['backup'] else None
        if old is not None and digest(old) != entry['original_sha256']:
            raise ValueError(f'Backup changed: {target}. No files restored.')
        restores.append((target, old, current, entry['mode']))
    written = []
    try:
        for target, old, current, mode in restores:
            target.unlink() if old is None else atomic(target, old, mode)
            written.append((target, current, mode))
    except Exception:
        for target, current, mode in reversed(written):
            atomic(target, current, mode)
        raise
    manifest.rename(manifest.with_name('uninstalled.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--install', action='store_true')
    action.add_argument('--check', action='store_true')
    action.add_argument('--upgrade', action='store_true')
    action.add_argument('--uninstall', action='store_true')
    parser.add_argument('--owrx-root', type=Path, default=Path('/usr/lib/python3/dist-packages/owrx'))
    parser.add_argument('--htdocs', type=Path)
    parser.add_argument('--state-dir', type=Path, default=STATE)
    parser.add_argument('--binary-target', type=Path, default=Path('/usr/local/bin/owrx-ale'))
    args = parser.parse_args()
    try:
        if args.uninstall:
            undo(args.state_dir)
            print('ALE files restored. Restart openwebrx and reload the receiver page.')
            return
        package = args.owrx_root.expanduser().resolve().parent
        htdocs = args.htdocs.expanduser().resolve() if args.htdocs else package/'htdocs'
        if (args.state_dir/'install.json').exists():
            if args.install:
                raise ValueError('ALE is already installed. Use --check then --upgrade.')
            count = upgrade(package, htdocs, args.binary_target, args.state_dir, write=args.upgrade)
            print(f'ALE {VERSION} upgrade ' + (f'applied ({count} files). Restart openwebrx and reload.' if args.upgrade else f'check passed ({count} files). No files changed. Use --upgrade to apply.'))
            return
        if args.upgrade:
            raise ValueError('No installed ALE manifest. Use --check then --install.')
        changes = plan(package, htdocs, args.binary_target)
        if not args.install:
            print(f'ALE compatibility check passed ({len(changes)} files). No files changed.')
            return
        apply(changes, args.state_dir)
        print('Experimental ALE 2G installed. Restart openwebrx and reload the receiver page.')
        print(f'Backups: {args.state_dir}')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Stopped: {error}\n')


if __name__ == '__main__':
    main()
