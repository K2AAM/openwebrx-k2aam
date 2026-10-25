#!/usr/bin/env python3
"""Install the browser-only RIG Dock. Check is read-only; no OWRX restart needed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ASSETS = HERE if (HERE / 'rig_dock/rig_dock.js').is_file() else HERE.parent.parent / 'htdocs/plugins/receiver'
STATE_DEFAULT = Path('/var/lib/openwebrx/rig-dock')
MARKER = b'/* BEGIN OWRX RIG DOCK'
FILES = ('rig_dock/rig_dock.js', 'rig_dock/rig_dock.css', 'rig_audio/rig_audio.js')


class InstallError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.rig-dock-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def discover_htdocs(selected=None):
    if selected:
        candidates = [Path(selected).expanduser().resolve()]
    else:
        candidates = [Path(p) for p in (
            '/usr/lib/python3/dist-packages/htdocs', '/opt/openwebrx/htdocs',
            '/usr/share/openwebrx/htdocs', '/usr/local/share/openwebrx/htdocs')]
    valid = [p for p in candidates if (p / 'index.html').is_file() and (p / 'plugins.js').is_file()]
    if len(valid) != 1:
        raise InstallError('Select the OWRX htdocs directory with --htdocs /path/to/htdocs.')
    return valid[0]


def plan_install(htdocs, state):
    if (state / 'install.json').exists():
        raise InstallError('RIG Dock is already installed. Uninstall it before replacing this build.')
    html = (htdocs / 'index.html').read_text()
    required = ['openwebrx-panel-receiver', 'openwebrx-sdr-profiles-listbox',
                'openwebrx-waterfall-color-min', 'openwebrx-waterfall-color-max',
                'openwebrx-wf-themes-listbox', 'openwebrx-tuning-step-listbox']
    missing = [name for name in required if name not in html]
    if missing:
        raise InstallError('Unsupported receiver markup: missing ' + ', '.join(missing))
    receiver = htdocs / 'plugins/receiver'
    init = receiver / 'init.js'
    old = init.read_bytes() if init.exists() else b''
    if MARKER in old:
        raise InstallError('A RIG Dock loading block already exists. No files changed.')
    text = old.decode('utf-8-sig')
    # The loader guard replaces standard Plugins.load calls only. Avoid silently
    # breaking scripts which call the replaced plugins' custom APIs directly.
    uncommented = re.sub(r'/\*.*?\*/|(?m:^\s*//[^\n]*)', '', text, flags=re.S)
    # K2AAM's Studio loader safely inspects a failed registration before
    # retrying Plugins.load(). This guarded metadata read is not an API call.
    uncommented = re.sub(
        r'Plugins\.(rig_skin|audio_filter|mode_selector)\s*&&\s*'
        r'Plugins\.\1\s*\._script_loaded\s*===\s*false\b',
        'false', uncommented)
    if re.search(r'Plugins\.(rig_skin|audio_filter|mode_selector)\s*\.|(?:window\.)?AudioFilterPlugin\s*\.', uncommented):
        raise InstallError('init.js calls an API on rig_skin, audio_filter, or mode_selector. '
                           'Comment out those custom API calls first; standard Plugins.load calls are supported.')
    if re.search(r'(?:_load_script|getScript)\([^\n]*(?:rig_skin|audio_filter|mode_selector)', uncommented):
        raise InstallError('Use standard Plugins.load calls for the replaced plugins before installing.')
    prefix = (ASSETS / 'rig_dock/bootstrap.js').read_bytes() + b'\n'
    plans = []
    for relative in FILES:
        target = receiver / relative
        if target.exists():
            raise InstallError('Refusing to overwrite existing file: ' + str(target))
        plans.append((target, (ASSETS / relative).read_bytes(), None))
    plans.append((init, prefix + old, old if init.exists() else None))
    return plans, prefix


def install(plans, prefix, state):
    state.mkdir(parents=True, exist_ok=False)
    manifest = {'version': 1, 'prefix': prefix.decode(), 'files': []}
    written = []
    try:
        for index, (target, data, old) in enumerate(plans):
            mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
            backup = None
            if old is not None:
                backup = str(index) + '.bak'
                atomic(state / backup, old)
            manifest['files'].append({'path': str(target), 'sha256': digest(data),
                                      'backup': backup, 'mode': mode,
                                      'init': target.name == 'init.js'})
            atomic(target, data, mode)
            written.append((target, old, mode))
        atomic(state / 'install.json', (json.dumps(manifest, indent=2) + '\n').encode())
    except Exception:
        for target, old, mode in reversed(written):
            if old is None:
                target.unlink(missing_ok=True)
            else:
                atomic(target, old, mode)
        shutil.rmtree(state)
        raise


def plan_uninstall(state):
    manifest_path = state / 'install.json'
    if not manifest_path.exists():
        raise InstallError('No RIG Dock installation record at ' + str(manifest_path))
    manifest = json.loads(manifest_path.read_text())
    prefix = manifest['prefix'].encode()
    plans = []
    for item in manifest['files']:
        target = Path(item['path'])
        if not target.exists():
            raise InstallError('Installed file is missing; no files changed: ' + str(target))
        current = target.read_bytes()
        if item['init']:
            # Remove only our exact prefix, keeping later plugin edits intact.
            if not current.startswith(prefix):
                raise InstallError('The managed init.js loading block was changed. No files changed.')
            replacement = current[len(prefix):]
            if item['backup'] is None and not replacement:
                replacement = None
        else:
            if digest(current) != item['sha256']:
                raise InstallError('Installed file was edited. No files changed: ' + str(target))
            replacement = (state / item['backup']).read_bytes() if item['backup'] else None
        plans.append((target, replacement, item['mode']))
    return plans


def uninstall(plans, state):
    # Validate every path and hash before the first mutation. Retain originals
    # for rollback if a write or delete fails part-way through.
    old = [(path, path.read_bytes(), path.stat().st_mode & 0o777) for path, _, _ in plans]
    try:
        for path, replacement, mode in plans:
            if replacement is None:
                path.unlink()
            else:
                atomic(path, replacement, mode)
    except Exception:
        for path, data, mode in old:
            atomic(path, data, mode)
        raise
    shutil.rmtree(state)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--check', action='store_true', help='Read-only compatibility check (default)')
    action.add_argument('--install', action='store_true')
    action.add_argument('--uninstall', action='store_true')
    parser.add_argument('--htdocs', help='OWRX htdocs directory')
    parser.add_argument('--state-dir', type=Path, default=STATE_DEFAULT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    state = args.state_dir.expanduser().resolve()
    try:
        if args.uninstall:
            plans = plan_uninstall(state)
            uninstall(plans, state)
            print('RIG Dock removed. Original plugin loading restored. Hard-refresh the receiver page.')
            return 0
        htdocs = discover_htdocs(args.htdocs)
        plans, prefix = plan_install(htdocs, state)
        print('OWRX htdocs: ' + str(htdocs))
        print('Receiver markup: compatible with the 1.2.126 layout')
        print('Original rig_skin, mode_selector and audio_filter loads: skipped while RIG Dock is installed')
        print('Antenna switcher: retained; shared controls moved into dock')
        print('Audio filter: optional, master bypass ON at page load')
        if not args.install:
            print('Check passed. No files changed. Use --install to apply.')
            return 0
        install(plans, prefix, state)
        print('RIG Dock installed. Hard-refresh the receiver page. No OWRX restart required.')
        return 0
    except (InstallError, OSError, ValueError, KeyError) as error:
        print('Stopped: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
