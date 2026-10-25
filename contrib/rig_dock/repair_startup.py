#!/usr/bin/env python3
"""Repair an installed RIG Dock 0.1.0 without reinstalling or restarting OWRX."""
import hashlib
import json
from pathlib import Path
import sys
from install import atomic

OLD_SHA = 'fadf3975345193b882420542a4c9a98725643dacbf9e61a2beac8a42569b276b'
NEW_SHA = '96ab348f1805abc8ce5e20c77d8e71ecbdd352d0250f6541372e2d76bd1c3c31'


def repair(state=Path('/var/lib/openwebrx/rig-dock/install.json')):
    original_state = state.read_bytes()
    record = json.loads(original_state)
    entry = next(item for item in record['files'] if Path(item['path']).name == 'rig_dock.js')
    target = Path(entry['path'])
    original = target.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest == NEW_SHA and entry['sha256'] == NEW_SHA:
        print('Startup repair is already applied. Reload the receiver page.')
        return
    if digest != OLD_SHA or entry['sha256'] != OLD_SHA:
        raise SystemExit('Stopped: installed dock differs from v0.1.0. No files changed.')
    text = original.decode()
    ready = "typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done && typeof scale_canvas !== 'undefined' && scale_canvas && typeof scale_ctx !== 'undefined' && scale_ctx"
    before = "        if (typeof openwebrx_resize === 'function') openwebrx_resize();"
    after = "        if (" + ready + " && typeof openwebrx_resize === 'function') openwebrx_resize();"
    wait = """            // Plugins run at DOM ready, before the first receiver config creates the scale.
            const deadline = Date.now() + 20000;
            while (!(typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done &&
                    typeof scale_canvas !== 'undefined' && scale_canvas &&
                    typeof scale_ctx !== 'undefined' && scale_ctx)) {
                if (Date.now() > deadline) throw new Error('RIG Dock: waiting for the receiver to initialize; stock controls retained. Reload after the receiver connects.');
                await new Promise(resolve => window.setTimeout(resolve, 100));
            }
"""
    text = text.replace("plugin._version = '0.1.0';", "plugin._version = '0.1.1';")
    text = text.replace(before, after).replace('            mount(); return true;', wait + '            mount(); return true;')
    updated = text.encode()
    if hashlib.sha256(updated).hexdigest() != NEW_SHA:
        raise SystemExit('Stopped: repair validation failed. No files changed.')
    backup = state.parent / 'startup-backup-v0.1.0'
    backup.mkdir(exist_ok=True)
    atomic(backup / 'rig_dock.js', original)
    atomic(backup / 'install.json', original_state)
    entry['sha256'] = NEW_SHA
    try:
        atomic(target, updated, target.stat().st_mode & 0o777)
        atomic(state, (json.dumps(record, indent=2) + '\n').encode(), state.stat().st_mode & 0o777)
    except Exception:
        atomic(target, original)
        atomic(state, original_state)
        raise
    local = Path.cwd() / 'rig_dock/rig_dock.js'
    if local.is_file() and hashlib.sha256(local.read_bytes()).hexdigest() == OLD_SHA:
        atomic(local, updated, local.stat().st_mode & 0o777)
    print('RIG Dock startup repaired to v0.1.1. Reload the receiver page; no restart needed.')


if __name__ == '__main__':
    repair(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/var/lib/openwebrx/rig-dock/install.json'))
