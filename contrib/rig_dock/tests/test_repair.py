import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import install as installer
import repair_startup as repair


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.htdocs = self.root / 'htdocs'
        self.htdocs.mkdir()
        ids = ['openwebrx-panel-receiver', 'openwebrx-sdr-profiles-listbox',
               'openwebrx-waterfall-color-min', 'openwebrx-waterfall-color-max',
               'openwebrx-wf-themes-listbox', 'openwebrx-tuning-step-listbox']
        (self.htdocs / 'index.html').write_text(' '.join(ids))
        (self.htdocs / 'plugins.js').write_text('fixture')
        self.state = self.root / 'state'
        plans, prefix = installer.plan_install(self.htdocs, self.state)
        installer.install(plans, prefix, self.state)
        self.manifest = self.state / 'install.json'
        record = json.loads(self.manifest.read_bytes())
        self.entry = next(x for x in record['files'] if Path(x['path']).name == 'rig_dock.js')
        self.target = Path(self.entry['path'])
        original = (PACKAGE / 'tests/fixtures/rig_dock_v0.1.0.js').read_bytes()
        self.target.write_bytes(original)
        self.entry['sha256'] = repair.OLD_SHA
        self.manifest.write_text(json.dumps(record, indent=2) + '\n')

    def test_repair_matches_fixed_build_and_preserves_uninstall(self):
        repair.repair(self.manifest)
        self.assertEqual(self.target.read_bytes(), (PACKAGE / 'tests/fixtures/rig_dock_v0.1.1.js').read_bytes())
        updated = json.loads(self.manifest.read_bytes())
        entry = next(x for x in updated['files'] if Path(x['path']).name == 'rig_dock.js')
        self.assertEqual(entry['sha256'], repair.NEW_SHA)
        self.assertTrue((self.state / 'startup-backup-v0.1.0/rig_dock.js').is_file())
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertFalse(self.target.exists())

    def test_second_run_is_read_only(self):
        repair.repair(self.manifest)
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        repair.repair(self.manifest)
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_edited_asset_stops_before_writes(self):
        self.target.write_bytes(self.target.read_bytes() + b'// user edit')
        before = self.manifest.read_bytes()
        with self.assertRaises(SystemExit):
            repair.repair(self.manifest)
        self.assertEqual(before, self.manifest.read_bytes())
        self.assertFalse((self.state / 'startup-backup-v0.1.0').exists())

    def test_edited_record_stops_before_writes(self):
        record = json.loads(self.manifest.read_bytes())
        entry = next(x for x in record['files'] if Path(x['path']).name == 'rig_dock.js')
        entry['sha256'] = 'edited'
        self.manifest.write_text(json.dumps(record))
        with self.assertRaises(SystemExit):
            repair.repair(self.manifest)
        self.assertFalse((self.state / 'startup-backup-v0.1.0').exists())

    def test_manifest_write_failure_restores_source_and_record(self):
        before = self.target.read_bytes(), self.manifest.read_bytes()
        atomic = repair.atomic
        def fail_once(path, *args, **kwargs):
            if path == self.manifest and not getattr(fail_once, 'failed', False):
                fail_once.failed = True
                raise OSError('injected state write failure')
            return atomic(path, *args, **kwargs)
        with patch.object(repair, 'atomic', fail_once):
            with self.assertRaises(OSError):
                repair.repair(self.manifest)
        self.assertEqual(before, (self.target.read_bytes(), self.manifest.read_bytes()))
        installer.plan_uninstall(self.state)


if __name__ == '__main__':
    unittest.main()
