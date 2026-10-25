import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import install as installer
import update as updater


class UpdateTests(unittest.TestCase):
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
        self.use_old('0.1.1')

    def use_old(self, version):
        record = json.loads(self.manifest.read_bytes())
        entry = next(item for item in record['files'] if Path(item['path']).name == 'rig_dock.js')
        self.target = Path(entry['path'])
        old = (PACKAGE / ('tests/fixtures/rig_dock_v' + version + '.js')).read_bytes()
        self.target.write_bytes(old)
        entry['sha256'] = installer.digest(old)
        css = next(item for item in record['files'] if Path(item['path']).name == 'rig_dock.css')
        css_version = version if version in ('0.2.0', '0.2.1') else '0.1.3'
        css_bytes = (PACKAGE / f'tests/fixtures/rig_dock_v{css_version}.css').read_bytes()
        Path(css['path']).write_bytes(css_bytes)
        css['sha256'] = installer.digest(css_bytes)
        self.manifest.write_text(json.dumps(record, indent=2) + '\n')

    def files(self):
        return {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def test_supported_versions_update_and_uninstall(self):
        for version in ('0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.2.0', '0.2.1'):
            with self.subTest(version=version):
                self.use_old(version)
                updater.update(self.state)
                self.assertEqual(self.target.read_bytes(), (installer.ASSETS / 'rig_dock/rig_dock.js').read_bytes())
                css = self.target.with_name('rig_dock.css')
                self.assertEqual(css.read_bytes(), (installer.ASSETS / 'rig_dock/rig_dock.css').read_bytes())
                installer.plan_uninstall(self.state)
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertFalse(self.target.exists())

    def test_check_and_repeat_are_read_only(self):
        before = self.files()
        updater.update(self.state, check=True)
        self.assertEqual(before, self.files())
        updater.update(self.state)
        before = self.files()
        updater.update(self.state)
        self.assertEqual(before, self.files())

    def test_edited_asset_is_not_overwritten(self):
        self.target.write_bytes(self.target.read_bytes() + b'// custom')
        before = self.files()
        with self.assertRaises(installer.InstallError):
            updater.update(self.state)
        self.assertEqual(before, self.files())

    def test_manifest_failure_rolls_back_assets(self):
        css = self.target.with_name('rig_dock.css')
        before = self.target.read_bytes(), css.read_bytes(), self.manifest.read_bytes()
        atomic = updater.atomic
        def fail_once(path, *args, **kwargs):
            if path == self.manifest and not getattr(fail_once, 'failed', False):
                fail_once.failed = True
                raise OSError('injected state write failure')
            return atomic(path, *args, **kwargs)
        with patch.object(updater, 'atomic', fail_once):
            with self.assertRaises(OSError):
                updater.update(self.state)
        self.assertEqual(before, (self.target.read_bytes(), css.read_bytes(), self.manifest.read_bytes()))
        installer.plan_uninstall(self.state)

    def test_update_keeps_later_plugin_additions(self):
        init = self.htdocs / 'plugins/receiver/init.js'
        added = b"\nPlugins.load('station_plugin');\n"
        init.write_bytes(init.read_bytes() + added)
        updater.update(self.state)
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertEqual(init.read_bytes(), added)


if __name__ == '__main__':
    unittest.main()
