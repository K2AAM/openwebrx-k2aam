#!/usr/bin/env python3
"""Update an installed RIG Dock to the assets in this package, with rollback."""
import argparse
import json
from pathlib import Path
import tempfile
from install import ASSETS, FILES, STATE_DEFAULT, InstallError, atomic, digest, plan_uninstall

OLD_JS = {
    'fadf3975345193b882420542a4c9a98725643dacbf9e61a2beac8a42569b276b',
    '96ab348f1805abc8ce5e20c77d8e71ecbdd352d0250f6541372e2d76bd1c3c31',
    '89a6da28aedf289b2d61953ce8f4ecf0749a336fcae509ff6c10340868ca1f7e',
    'dafc55edb9b76afe30f9ba07dd4f2a997cfe6fec21c222bfc16011f15de814c8',
}


def update(state=STATE_DEFAULT, check=False):
    state = Path(state).expanduser().resolve()
    manifest = state / 'install.json'
    # Validate every installed asset and the managed loader before writing.
    plan_uninstall(state)
    saved = manifest.read_bytes()
    record = json.loads(saved)
    prefix = (ASSETS / 'rig_dock/bootstrap.js').read_bytes() + b'\n'
    if record['prefix'].encode() != prefix:
        raise InstallError('This installation uses a different loader. No files changed.')
    changes = []
    for relative in FILES:
        matches = [item for item in record['files']
                   if Path(item['path']).as_posix().endswith('/' + relative)]
        if len(matches) != 1:
            raise InstallError('Expected one installed asset for ' + relative)
        item = matches[0]
        path = Path(item['path'])
        old, new = path.read_bytes(), (ASSETS / relative).read_bytes()
        if relative.endswith('rig_dock.js') and digest(old) not in OLD_JS | {digest(new)}:
            raise InstallError('The installed dock is not a recognized build. No files changed.')
        item['sha256'] = digest(new)
        if old != new:
            changes.append((path, old, new, path.stat().st_mode & 0o777))
    if not changes:
        print('RIG Dock v0.2.0 is already installed. Reload the receiver page.')
        return
    if check:
        print('Update check passed. No files changed. Run without --check to update to v0.2.0.')
        return
    backup = Path(tempfile.mkdtemp(prefix='update-backup-v0.2.0-', dir=state))
    atomic(backup / 'install.json', saved)
    for path, old, _, _ in changes:
        atomic(backup / path.name, old)
    try:
        for path, _, new, mode in changes:
            atomic(path, new, mode)
        atomic(manifest, (json.dumps(record, indent=2) + '\n').encode())
    except Exception:
        for path, old, _, mode in changes:
            atomic(path, old, mode)
        atomic(manifest, saved)
        raise
    print('RIG Dock updated to v0.2.0. Reload the receiver page; no OWRX restart needed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--state-dir', type=Path, default=STATE_DEFAULT, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        update(args.state_dir, args.check)
    except (InstallError, OSError, ValueError, KeyError) as error:
        parser.exit(1, 'Stopped: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
