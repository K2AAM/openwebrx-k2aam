import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dock_install', PACKAGE / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

IDS = ['openwebrx-panel-receiver', 'openwebrx-sdr-profiles-listbox',
       'openwebrx-waterfall-color-min', 'openwebrx-waterfall-color-max',
       'openwebrx-wf-themes-listbox', 'openwebrx-tuning-step-listbox']


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.htdocs = self.root / 'htdocs'
        self.receiver = self.htdocs / 'plugins/receiver'
        self.receiver.mkdir(parents=True)
        (self.htdocs / 'index.html').write_text(' '.join(IDS))
        (self.htdocs / 'plugins.js').write_text('fixture')
        self.init = self.receiver / 'init.js'
        self.original = b"// station settings\nPlugins.load('rig_skin');\nPlugins.load('audio_filter');\nPlugins.load('rsp_antenna');\n"
        self.init.write_bytes(self.original)
        self.init.chmod(0o640)
        self.state = self.root / 'state'

    def install(self):
        plans, prefix = installer.plan_install(self.htdocs, self.state)
        installer.install(plans, prefix, self.state)

    def test_check_does_not_mutate(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(['--check', '--htdocs', str(self.htdocs), '--state-dir', str(self.state)]), 0)
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(self.state.exists())

    def test_round_trip_and_mode(self):
        self.install()
        self.assertTrue(self.init.read_bytes().endswith(self.original))
        self.assertEqual(self.init.stat().st_mode & 0o777, 0o640)
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertEqual(self.init.read_bytes(), self.original)
        self.assertFalse(self.state.exists())
        self.assertFalse((self.receiver / installer.FILES[0]).exists())

    def test_keep_later_init_edits(self):
        self.install()
        extra = b"\nPlugins.load('new_station_plugin');\n"
        self.init.write_bytes(self.init.read_bytes() + extra)
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertEqual(self.init.read_bytes(), self.original + extra)

    def test_missing_original_init(self):
        self.init.unlink()
        self.install()
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertFalse(self.init.exists())

    def test_other_plugins_retained(self):
        antenna = self.receiver / 'rsp_antenna/rsp_antenna.js'
        antenna.parent.mkdir()
        antenna.write_bytes(b'working antenna selector')
        self.install()
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertEqual(antenna.read_bytes(), b'working antenna selector')

    def test_reject_asset_collision(self):
        target = self.receiver / installer.FILES[0]
        target.parent.mkdir()
        target.write_bytes(b'user edited')
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)
        self.assertEqual(self.init.read_bytes(), self.original)
        self.assertEqual(target.read_bytes(), b'user edited')

    def test_reject_second_install(self):
        self.install()
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)

    def test_all_hashes_checked_before_uninstall(self):
        self.install()
        asset = self.receiver / installer.FILES[-1]
        asset.write_bytes(asset.read_bytes() + b'// changed')
        before = self.init.read_bytes()
        with self.assertRaises(installer.InstallError):
            installer.plan_uninstall(self.state)
        self.assertEqual(self.init.read_bytes(), before)
        self.assertTrue((self.receiver / installer.FILES[0]).exists())

    def test_reject_managed_block_edit(self):
        self.install()
        self.init.write_bytes(self.init.read_bytes().replace(b'new Set', b'edited Set', 1))
        with self.assertRaises(installer.InstallError):
            installer.plan_uninstall(self.state)

    def test_reject_incompatible_markup(self):
        (self.htdocs / 'index.html').write_text('unknown version')
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)
        self.assertFalse(self.state.exists())

    def test_reject_custom_api_calls(self):
        self.init.write_text("await Plugins.load('rig_skin');\nPlugins.rig_skin.setup({});")
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)

    def test_commented_api_calls_are_ok(self):
        self.init.write_text("// Plugins.rig_skin.setup({});\n/* Plugins.audio_filter.setup({}); */\nPlugins.load('rig_skin');")
        installer.plan_install(self.htdocs, self.state)

    def test_studio_failed_registration_check_is_safe(self):
        original = """(async () => {
            if (Plugins.audio_filter &&
                Plugins.audio_filter._script_loaded === false) {
                delete Plugins.audio_filter;
            }
            await Plugins.load('audio_filter');
            if (window.AudioFilterPlugin?.build === 'studio-2.0.0') console.info('loaded');
            await Plugins.load('https://aganet.github.io/openwebrxplus-rig-skin/receiver/rig_skin/rig_skin.js');
            await Plugins.load('utils');
        })();
        """
        self.init.write_text(original)
        plans, prefix = installer.plan_install(self.htdocs, self.state)
        installer.install(plans, prefix, self.state)
        self.assertTrue(self.init.read_text().endswith(original))
        installer.uninstall(installer.plan_uninstall(self.state), self.state)
        self.assertEqual(self.init.read_text(), original)

    def test_guarded_metadata_does_not_hide_real_custom_calls(self):
        self.init.write_text("if (Plugins.audio_filter && Plugins.audio_filter._script_loaded === false) {}\n"
                             "Plugins.audio_filter.setup({});")
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)

    def test_unguarded_metadata_read_is_still_rejected(self):
        self.init.write_text('console.log(Plugins.audio_filter._script_loaded);')
        with self.assertRaises(installer.InstallError):
            installer.plan_install(self.htdocs, self.state)

    def test_install_write_failure_rolls_back(self):
        plans, prefix = installer.plan_install(self.htdocs, self.state)
        atomic = installer.atomic
        def failing(path, *args, **kwargs):
            if path.name == 'rig_audio.js':
                raise OSError('injected write failure')
            return atomic(path, *args, **kwargs)
        with patch.object(installer, 'atomic', failing):
            with self.assertRaises(OSError):
                installer.install(plans, prefix, self.state)
        self.assertEqual(self.init.read_bytes(), self.original)
        self.assertFalse(self.state.exists())
        self.assertFalse((self.receiver / installer.FILES[0]).exists())


if __name__ == '__main__':
    unittest.main()
