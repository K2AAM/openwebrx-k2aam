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

    def antenna_fixture(self):
        target=self.package/'owrx/connection.py'
        stock=b'import logging\nclass Client:\n    def receive(self,message):\n'+installer.ANTENNA_ANCHOR+b'                    pass\n'
        self.baselines['owrx/connection.py']=installer.blob(stock)
        patched=installer.ANTENNA_IMPORT+stock.replace(installer.ANTENNA_ANCHOR,installer.ANTENNA_HANDLER)
        target.write_bytes(patched)
        return target,patched

    def test_antenna_connection_install_upgrade_and_restore(self):
        target,patched=self.antenna_fixture();original=self.snapshot()
        installer.apply(self.plan(),self.state)
        self.assertIn(installer.ANTENNA_HANDLER,target.read_bytes())
        self.assertIn(b'"ale_scan"',target.read_bytes())
        self.assertEqual(target.read_bytes().count(installer.ANTENNA_IMPORT),1)
        installer.upgrade(self.package,self.web,self.binary,self.state,write=True,baselines=self.baselines)
        self.assertIn(installer.ANTENNA_HANDLER,target.read_bytes())
        installer.undo(self.state)
        self.assertEqual(target.read_bytes(),patched);self.assertEqual(self.snapshot(),original)

    def test_antenna_extra_edits_are_rejected(self):
        target,patched=self.antenna_fixture();target.write_bytes(patched+b'# unrecognized edit\n')
        before=self.snapshot()
        with self.assertRaises(ValueError):self.plan()
        self.assertEqual(self.snapshot(),before)

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

    def test_server_upgrade_adds_verified_native_backup(self):
        self.server_upgrade_roundtrip()

    def test_050_mobile_fix_upgrade_preserves_uninstall(self):
        original=self.snapshot()
        installer.apply(self.plan(),self.state)
        record=json.loads((self.state/'install.json').read_text());record['version']='0.5.0'
        (self.state/'install.json').write_text(json.dumps(record))
        installer.upgrade(self.package,self.web,self.binary,self.state,write=True,baselines=self.baselines)
        self.assertEqual(json.loads((self.state/'install.json').read_text())['version'],'0.5.1')
        installer.undo(self.state);self.assertEqual(self.snapshot(),original)

    def test_040_upgrade_adds_log_module_without_removing_reception_database(self):
        original=self.snapshot()
        installer.apply(self.plan(),self.state)
        record=json.loads((self.state/'install.json').read_text())
        log_path=self.package/'owrx/ale_log.py'
        record['files']=[item for item in record['files'] if item['path']!=str(log_path)]
        log_path.unlink();record['version']='0.4.0'
        (self.state/'install.json').write_text(json.dumps(record))
        database=self.root/'ale-log/receptions.sqlite3'
        database.parent.mkdir();database.write_bytes(b'reception data')
        installer.upgrade(self.package,self.web,self.binary,self.state,write=True,baselines=self.baselines)
        self.assertTrue(log_path.exists())
        installer.undo(self.state)
        self.assertEqual(self.snapshot(),original)
        self.assertEqual(database.read_bytes(),b'reception data')

    def test_antenna_server_upgrade_adds_verified_native_backup(self):
        self.antenna_fixture();self.server_upgrade_roundtrip()

    def server_upgrade_roundtrip(self):
        original = self.snapshot()
        installer.apply(self.plan(), self.state)
        record = json.loads((self.state/'install.json').read_text())
        added = {'owrx/connection.py','owrx/ale_scan.py','owrx/ale_channels.json'}
        retained=[]
        for entry in record['files']:
            relative = str(Path(entry['path']).relative_to(self.package)) if Path(entry['path']).is_relative_to(self.package) else ''
            if relative in added:
                target=Path(entry['path'])
                if entry['backup']:
                    target.write_bytes(Path(entry['backup']).read_bytes())
                else:
                    target.unlink()
            else:
                retained.append(entry)
        record['files']=retained;record['version']='0.2.0'
        (self.state/'install.json').write_text(json.dumps(record))
        before=self.snapshot()
        installer.upgrade(self.package,self.web,self.binary,self.state,baselines=self.baselines)
        self.assertEqual(before,self.snapshot())
        installer.upgrade(self.package,self.web,self.binary,self.state,write=True,baselines=self.baselines)
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
