"""Exercise native source occupancy and scheduler methods without an SDR."""
import ast
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
import sys
import time
import unittest
from unittest.mock import Mock, patch

from owrx.ale_scan import AleBackgroundScan

ROOT = Path(__file__).resolve().parents[3]


def native_classes():
    # Execute the repository's real occupancy/scheduling methods, not copies
    # of those algorithms. Imports and hardware process startup are excluded.
    source = ast.parse((ROOT/'owrx/source/__init__.py').read_text())
    names = {'SdrSourceState', 'SdrBusyState', 'SdrClientClass', 'SdrSourceEventClient'}
    body = [item for item in source.body if isinstance(item, ast.ClassDef) and item.name in names]
    original = next(item for item in source.body if isinstance(item, ast.ClassDef) and item.name == 'SdrSource')
    methods = {'getClients', 'hasClients', 'addClient', 'removeClient', 'checkStatus', 'setBusyState'}
    body.append(ast.ClassDef(name='NativeSource', bases=[], keywords=[], decorator_list=[],
                             body=[item for item in original.body if isinstance(item, ast.FunctionDef) and item.name in methods]))
    schedule = ast.parse((ROOT/'owrx/service/schedule.py').read_text())
    original = next(item for item in schedule.body if isinstance(item, ast.ClassDef) and item.name == 'ServiceScheduler')
    methods = {'selectProfile', '_setCurrentEntry', 'getClientClass', 'onBusyStateChange', 'onStateChange'}
    body.append(ast.ClassDef(name='NativeScheduler', bases=[], keywords=[], decorator_list=[],
                             body=[item for item in original.body if isinstance(item, ast.FunctionDef) and item.name in methods]))
    namespace = {'Enum':Enum, 'logger':Mock()}
    exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), '<native occupancy>', 'exec'), namespace)
    return SimpleNamespace(**namespace)


NATIVE = native_classes()
OPTIONS = {'bank':'hfgcs_candidates', 'channels':[9025000,11226000], 'dwell':3, 'across':True}


class Props(dict):
    def __init__(self):
        super().__init__(profile_id='hf', samp_rate=768000, center_freq=9025000)
        self.listeners=[]
    def wire(self, callback):
        self.listeners.append(callback)
        return SimpleNamespace(cancel=lambda:self.listeners.remove(callback))
    def change(self, key, value):
        self[key]=value
        for callback in self.listeners.copy(): callback({key:value})


class Source(NATIVE.NativeSource):
    def __init__(self):
        self.clients=[];self.props=Props();self.busyState=NATIVE.SdrBusyState.IDLE
        self.activated=[];self.started=0;self.stopped=0
    def getId(self): return 'mobile-radio'
    def getProps(self): return self.props
    def getState(self): return NATIVE.SdrSourceState.RUNNING
    def isAlwaysOn(self): return False
    def start(self): self.started+=1
    def stop(self): self.stopped+=1
    def setCenterFreq(self, frequency): self.props.change('center_freq',frequency)
    def activateProfile(self, profile):
        self.activated.append(profile);self.props.change('profile_id',profile)


class Scheduler(NATIVE.NativeScheduler):
    def __init__(self, source):
        self.source=source;self.currentEntry=None;self.scheduled=[]
        entry=SimpleNamespace(getProfile=lambda:'default-AM',getScheduledEnd=lambda:None)
        self.schedule=SimpleNamespace(getCurrentEntry=lambda:entry,getNextEntry=lambda:None)
    def scheduleSelection(self, when=None): self.scheduled.append(when)


class MobileScanTests(unittest.TestCase):
    def fixture(self):
        source=Source();scheduler=Scheduler(source)
        source.addClient(scheduler)
        chains=[]
        def factory(source, frequency, callback):
            chain=SimpleNamespace(stop=lambda:None, callback=callback)
            chains.append(chain);return chain
        scan=AleBackgroundScan(source,factory,settle=0,retune_allowed=lambda:True,
                               journal=Mock(recent=Mock(return_value=[]),append=Mock(return_value=1)))
        self.addCleanup(lambda:self.cleanup(scan))
        return source,scheduler,chains,scan

    def cleanup(self, scan):
        scan.stop()
        if scan.thread: scan.thread.join(timeout=2)
        self.assertFalse(scan.thread and scan.thread.is_alive())

    def wait(self, condition):
        deadline=time.monotonic()+2
        while not condition():
            if time.monotonic()>deadline: self.fail('Scanner did not start')
            time.sleep(.005)

    def test_last_browser_disconnect_does_not_allow_idle_profile_takeover(self):
        source,scheduler,chains,scan=self.fixture()
        browser=NATIVE.SdrSourceEventClient()
        browser.getClientClass=lambda:NATIVE.SdrClientClass.USER
        source.addClient(browser)
        with patch.dict(sys.modules, {'owrx.source':NATIVE}):
            scan.start(OPTIONS.copy());self.wait(lambda:len(chains)==1)
            source.removeClient(browser)
            self.assertEqual(source.busyState,NATIVE.SdrBusyState.BUSY)
            scheduler.selectProfile()
            self.assertTrue(scan.running);self.assertEqual(source.activated,[])
            chains[0].callback({'freq':9025000,'event':'amd','source':'ADW','message':'TEST'})
            self.assertEqual(scan.snapshot()['events'][0]['source'],'ADW')
            scan.stop();scan.thread.join(timeout=2)
            self.assertNotIn(scan,source.clients)
            self.assertEqual(source.busyState,NATIVE.SdrBusyState.IDLE)
            scheduler.selectProfile()
            self.assertEqual(source.activated,['default-AM'])

    def test_explicit_profile_change_still_stops_and_releases_scan(self):
        source,scheduler,chains,scan=self.fixture()
        with patch.dict(sys.modules, {'owrx.source':NATIVE}):
            scan.start(OPTIONS.copy());self.wait(lambda:len(chains)==1)
            source.activateProfile('operator-selected')
            scan.thread.join(timeout=2)
            self.assertFalse(scan.running);self.assertNotIn(scan,source.clients)
            self.assertIn('profile changed',scan.status)

    def test_failure_releases_reservation_without_a_browser(self):
        source,scheduler,chains,scan=self.fixture()
        with patch.dict(sys.modules, {'owrx.source':NATIVE}):
            scan.start(OPTIONS.copy());self.wait(lambda:len(chains)==1)
            scheduler.selectProfile();self.assertEqual(source.activated,[])
            scan.onFail();scan.thread.join(timeout=2)
            self.assertFalse(scan.running);self.assertEqual(source.busyState,NATIVE.SdrBusyState.IDLE)
            scheduler.selectProfile();self.assertEqual(source.activated,['default-AM'])
