#!/usr/bin/env python3
"""Keep chat hidden in RIG Dock 0.1.1/0.1.2 and retain uninstall support."""
import hashlib
import json
from pathlib import Path
from install import atomic

RULE = """
/* RIG Dock: hide chat */
body.rig-dock-active #openwebrx-panel-log,
body.rig-dock-active [data-toggle-panel='openwebrx-panel-log'] {
    display: none !important;
}
"""


def remove_chat(state=Path('/var/lib/openwebrx/rig-dock/install.json')):
    saved = state.read_bytes()
    record = json.loads(saved)
    plan = []
    for name in ('rig_dock.js', 'rig_dock.css'):
        entry = next(x for x in record['files'] if Path(x['path']).name == name)
        path = Path(entry['path'])
        old = path.read_bytes()
        if hashlib.sha256(old).hexdigest() != entry['sha256']:
            raise SystemExit('Stopped: installed file was edited: ' + str(path))
        text = old.decode()
        if name.endswith('.js'):
            if not any("plugin._version = '" + version + "';" in text
                       for version in ('0.1.1', '0.1.2', '0.1.3')):
                raise SystemExit('Stopped: apply the startup repair first. No files changed.')
            text = text.replace("plugin._version = '0.1.1';", "plugin._version = '0.1.2';")
            text = text.replace("button('Chat / log', () => { toggle_panel('openwebrx-panel-log'); closePopup(false); }),\n            ", '')
        elif '/* RIG Dock: hide chat */' not in text:
            text += RULE
        new = text.encode()
        entry['sha256'] = hashlib.sha256(new).hexdigest()
        plan.append((path, old, new, path.stat().st_mode & 0o777))
    if all(old == new for _, old, new, _ in plan):
        print('Chat removal is already applied. Reload the receiver page.')
        return
    backup = state.parent / 'chat-backup'
    backup.mkdir(exist_ok=True)
    atomic(backup / 'install.json', saved)
    for path, old, _, _ in plan:
        atomic(backup / path.name, old)
    try:
        for path, _, new, mode in plan:
            atomic(path, new, mode)
        atomic(state, (json.dumps(record, indent=2) + '\n').encode())
    except Exception:
        for path, old, _, mode in plan:
            atomic(path, old, mode)
        atomic(state, saved)
        raise
    for path, old, new, mode in plan:
        local = Path.cwd() / 'rig_dock' / path.name
        if local.is_file() and local.read_bytes() == old:
            atomic(local, new, mode)
    print('Chat panel and buttons removed from RIG Dock v0.1.2. Reload the receiver page.')


if __name__ == '__main__':
    remove_chat()
