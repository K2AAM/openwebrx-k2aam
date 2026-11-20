"""Antenna switcher behaviour against the real OWRX property stack; SDR and clients are faked."""
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from owrx import antenna_switcher as switcher
from owrx.property import PropertyLayer, PropertyStack


class Source:
    def __init__(self, driver='sdrplay'):
        self.profile = PropertyLayer(antenna='Antenna A')
        self.props = PropertyStack()
        self.props.addLayer(0, self.profile)
        self.driver, self.clients = driver, []
        self.monitor = self.controlSocket = object()

    def getId(self): return 'rspdx'
    def getDriver(self): return self.driver
    def getProps(self): return self.props
    def isEnabled(self): return True
    def isFailed(self): return False


class Client:
    def __init__(self, source, magic=''):
        self.sdr, self.stack, self.sent = source, {'magic_key': magic}, []
        source.clients.append(self)

    def send(self, message): self.sent.append(message)
    def last(self): return self.sent[-1]['value']


class SwitcherTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / 'antenna-switcher.json'
        self.original = switcher.CONFIG_PATH
        switcher.CONFIG_PATH = self.path
        self.addCleanup(setattr, switcher, 'CONFIG_PATH', self.original)
        self.source = Source()
        self.client = Client(self.source)

    def configure(self, access='public', ports=('A', 'C'), device='rspdx'):
        self.path.write_text(json.dumps({'access': access, 'devices': {device: {'antennas': [
            {'value': 'Antenna ' + p, 'label': p + ' port'} for p in ports]}}}))

    def set(self, antenna, client=None, **extra):
        client = client or self.client
        params = dict({'sdr_id': 'rspdx', 'antenna': antenna}, **extra)
        switcher.handle_antenna_message(client, {'type': 'setantenna', 'params': params})
        return client.last()

    def get(self):
        switcher.handle_antenna_message(self.client, {'type': 'getantenna'})
        return self.client.last()

    def test_missing_config_is_quietly_unsupported(self):
        with self.assertNoLogs(switcher._log, logging.WARNING):
            state = self.get()
        self.assertEqual(state, {'supported': False, 'sdr_id': 'rspdx'})

    def test_damaged_config_reports_an_error(self):
        self.path.write_text('{not json')
        with self.assertLogs(switcher._log, logging.WARNING):
            state = self.get()
        self.assertFalse(state['supported'])
        self.assertIn('configuration', state['error'])

    def test_unlisted_device_and_other_drivers_are_unsupported(self):
        self.configure(device='another')
        self.assertFalse(self.get()['supported'])
        self.configure()
        self.source.driver = 'sddc'
        self.assertFalse(self.get()['supported'])
        self.assertIn('not enabled', self.set('Antenna C')['error'])

    def test_selection_overrides_profile_without_editing_it(self):
        self.configure()
        state = self.get()
        self.assertEqual((state['selected'], state['held']), ('Antenna A', False))
        other = Client(self.source)
        state = self.set('Antenna C')
        self.assertEqual((state['selected'], state['held']), ('Antenna C', True))
        self.assertEqual(self.source.props['antenna'], 'Antenna C')
        self.assertEqual(self.source.profile['antenna'], 'Antenna A')
        self.assertEqual(other.last()['selected'], 'Antenna C')

    def test_rejects_ports_that_are_not_enabled_and_stale_receivers(self):
        self.configure()
        self.assertIn('not enabled', self.set('Antenna B')['error'])
        self.assertIn('receiver changed', self.set('Antenna C', sdr_id='old')['error'])
        self.assertEqual(self.source.props['antenna'], 'Antenna A')

    def test_cooldown_between_changes(self):
        self.configure()
        self.set('Antenna C')
        self.assertIn('two seconds', self.set('Antenna A')['error'])
        self.assertEqual(self.source.props['antenna'], 'Antenna C')

    def test_key_access_requires_the_magic_key(self):
        self.configure(access='key')
        self.assertIn('Magic Key', self.set('Antenna C')['error'])
        keyed = Client(self.source, magic='secret')
        self.assertIn('Magic Key', self.set('Antenna C', keyed, key='wrong')['error'])
        self.assertEqual(self.set('Antenna C', keyed, key='secret')['selected'], 'Antenna C')

    def test_stopped_sdr_is_not_switched(self):
        self.configure()
        self.source.monitor = None
        self.assertIn('not running', self.set('Antenna C')['error'])


if __name__ == '__main__':
    unittest.main()
