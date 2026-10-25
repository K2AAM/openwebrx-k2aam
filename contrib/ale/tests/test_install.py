import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ale_installer', HERE/'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root/'python'
        self.web = self.package/'htdocs'
        self.state = self.root/'state'
        self.binary = self.root/'bin/owrx-ale'
        self.baselines = json.loads((HERE/'install-baselines.json').read_text())
        for relative, expected in self.baselines.items():
            if expected is not None:
                target = self.package/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'stock source\n')
                target.chmod(0o640)
                self.baselines[relative] = installer.blob(target.read_bytes())

    def snapshot(self):
        return {str(p):p.read_bytes() for tree in [self.package, self.root/'bin']
                if tree.exists() for p in tree.rglob('*') if p.is_file()}

    def plan(self):
        return installer.plan(self.package, self.web, self.binary, self.baselines)

    def test_check_roundtrip_and_permissions(self):
        original = self.snapshot()
        changes = self.plan()
        self.assertEqual(self.snapshot(), original)
        self.assertFalse(self.state.exists())
        installer.apply(changes, self.state)
        self.assertEqual(self.binary.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.package/'owrx/modes.py').stat().st_mode & 0o777, 0o640)
        installer.undo(self.state)
        self.assertEqual(self.snapshot(), original)

    def test_upgrade_preserves_original_restore(self):
        original = self.snapshot()
        installer.apply(self.plan(), self.state)
        record = json.loads((self.state/'install.json').read_text())
        extra = self.web/'lib/AleScanner.js'
        record['files'] = [e for e in record['files'] if e['path'] != str(extra)]
        record['version'] = '0.1.0'
        extra.unlink()
        (self.state/'install.json').write_text(json.dumps(record))
        before = self.snapshot()
        installer.upgrade(self.package,self.web,self.binary,self.state)
        self.assertEqual(self.snapshot(),before)
        installer.upgrade(self.package,self.web,self.binary,self.state,write=True)
        self.assertTrue(extra.exists())
        installer.undo(self.state)
        self.assertEqual(self.snapshot(),original)

    def test_upgrade_rejects_changed_files_and_rolls_back_failure(self):
        installer.apply(self.plan(), self.state)
        before = self.snapshot()
        manifest = (self.state/'install.json').read_bytes()
        write = installer.atomic
        def fail(path, *args):
            if path.name == 'install.json':
                raise OSError('manifest failure')
            return write(path, *args)
        with patch.object(installer, 'atomic', fail):
            with self.assertRaises(OSError):
                installer.upgrade(self.package,self.web,self.binary,self.state,write=True)
        self.assertEqual(self.snapshot(),before)
        self.assertEqual((self.state/'install.json').read_bytes(),manifest)
        target = self.package/'owrx/ale.py'
        target.write_bytes(b'changed')
        before = self.snapshot()
        with self.assertRaises(ValueError):
            installer.upgrade(self.package,self.web,self.binary,self.state,write=True)
        self.assertEqual(self.snapshot(),before)

    def test_edited_file_rejected_before_writes(self):
        (self.package/'owrx/modes.py').write_bytes(b'custom source')
        before = self.snapshot()
        with self.assertRaises(ValueError):
            self.plan()
        self.assertEqual(self.snapshot(), before)

    def test_failed_install_rolls_back(self):
        before = self.snapshot()
        write = installer.atomic
        def fail(path, *args):
            if path.name == 'install.json':
                raise OSError('injected failure')
            return write(path, *args)
        with patch.object(installer, 'atomic', fail):
            with self.assertRaises(OSError):
                installer.apply(self.plan(), self.state)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.state/'install.json').exists())

    def test_uninstall_refuses_later_edits(self):
        installer.apply(self.plan(), self.state)
        target = self.package/'owrx/ale.py'
        target.write_bytes(target.read_bytes()+b'# custom\n')
        before = self.snapshot()
        with self.assertRaises(ValueError):
            installer.undo(self.state)
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
