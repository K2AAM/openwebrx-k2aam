import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import threading
import time
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('server_ale_scan',ROOT/'owrx/ale_scan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CATALOG = json.loads((ROOT/'contrib/ale/channels.json').read_text())
OPTIONS = {'bank':'hfgcs_candidates','channels':[9025000,11226000],'dwell':3,'across':True}


class Props(dict):
    def __init__(self):
        super().__init__(profile_id='hf',samp_rate=768000,center_freq=9025000)
        self.listeners=[]
    def wire(self, callback):
        self.listeners.append(callback)
        return SimpleNamespace(cancel=lambda:self.listeners.remove(callback))
    def change(self, key, value):
        self[key]=value
        for callback in self.listeners.copy():
            callback({key:value})


class Source:
    def __init__(self):
        self.props=Props();self.clients=[];self.retunes=[]
    def getProps(self): return self.props
    def getId(self): return 'airspy'
    def getState(self): return SimpleNamespace(name='RUNNING')
    def addClient(self,c): self.clients.append(c)
    def removeClient(self,c): self.clients.remove(c)
    def setCenterFreq(self,f):
        self.retunes.append(f);self.props.change('center_freq',f)


def wait_for(condition):
    deadline=time.monotonic()+2
    while not condition():
        if time.monotonic()>deadline: raise AssertionError('Timed out')
        time.sleep(.005)


class ServerScanTests(unittest.TestCase):
    def fixture(self):
        source=Source();chains=[];now=[0]
        def factory(source, frequency, callback):
            chain=SimpleNamespace(frequency=frequency,callback=callback,stopped=False)
            chain.stop=lambda:setattr(chain,'stopped',True)
            chains.append(chain)
            return chain
        scan=module.AleBackgroundScan(source,factory,clock=lambda:now[0],settle=0,retune_allowed=lambda:True)
        self.addCleanup(lambda:self.cleanup(scan))
        return source,chains,now,scan
    def cleanup(self,scan):
        scan.stop()
        if scan.thread: scan.thread.join(timeout=2)
        self.assertFalse(scan.thread and scan.thread.is_alive())
    def test_native_chain_attaches_source_reader_and_cleans_partial_start(self):
        source=Source();reader=object();source.getBuffer=lambda:SimpleNamespace(getReader=lambda:reader)
        secondary=Mock();chain=Mock();chain.getOutputFormat.return_value='events'
        chain_factory=Mock(return_value=chain);secondary_factory=Mock(return_value=secondary)
        modules={
            'csdr.chain.analog':SimpleNamespace(Ssb=Mock()),
            'csdr.chain.ale':SimpleNamespace(AleDemodulator=secondary_factory),
            'owrx.service.chain':SimpleNamespace(ServiceDemodulatorChain=chain_factory),
            'pycsdr.modules':SimpleNamespace(Buffer=Mock(return_value='output')),
        }
        callback=Mock()
        with patch.dict(sys.modules,modules):
            self.assertIs(module.native_chain(source,9025000,callback),chain)
            secondary_factory.assert_called_once_with(callback=callback)
            secondary.setDialFrequency.assert_called_once_with(9025000)
            chain.setBandPass.assert_called_once_with(600,2650)
            chain.setReader.assert_called_once_with(reader)
            self.assertEqual(chain_factory.call_args.args[2:],(768000,0))
            chain.setReader.side_effect=ValueError('reader unavailable')
            with self.assertRaisesRegex(ValueError,'reader unavailable'):
                module.native_chain(source,9025000,callback)
            chain.stop.assert_called_once()

    def test_bank_validation_and_catalog(self):
        self.assertEqual(json.loads((ROOT/'owrx/ale_channels.json').read_text()),CATALOG)
        self.assertEqual(module.validate_options(OPTIONS,CATALOG)['channels'],OPTIONS['channels'])
        for change in [{'bank':'unknown'},{'channels':[]},{'channels':[True]},{'channels':[123]},
                       {'dwell':float('nan')},{'dwell':.5},{'dwell':True},{'across':'true'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                module.validate_options(dict(OPTIONS,**change),CATALOG)
    def test_background_lifetime_hold_release_and_history(self):
        source,chains,now,scan=self.fixture();scan.start(OPTIONS.copy())
        wait_for(lambda:len(chains)==1)
        self.assertIn(scan,source.clients)
        # No browser/client is retained or needed by the running worker.
        now[0]=4;chains[0].callback({'freq':9025000,'event':'activity','active':True})
        time.sleep(.1);self.assertEqual(len(chains),1)
        now[0]=5;chains[0].callback({'freq':9025000,'event':'sounding_this_was','source':'ADW','message':'TEST'})
        self.assertEqual(scan.snapshot()['events'][0]['source'],'ADW')
        self.assertTrue(scan.snapshot()['events'][0]['server_scan'])
        self.assertEqual(scan.snapshot(after=1)['events'],[])
        now[0]=6;chains[0].callback({'freq':9025000,'event':'activity','active':False})
        now[0]=8.9;time.sleep(.1);self.assertEqual(len(chains),1)
        now[0]=9;wait_for(lambda:len(chains)==2)
        self.assertTrue(chains[0].stopped);self.assertEqual(source.retunes,[11226000])
        # A callback from an old acquisition cannot label the current channel.
        chains[0].callback({'freq':9025000,'event':'sounding_this_was','source':'OLD'})
        self.assertEqual(len(scan.snapshot()['events']),1)
        scan.stop();scan.thread.join(timeout=2)
        self.assertFalse(scan.running);self.assertEqual(source.clients,[]);self.assertTrue(chains[1].stopped)
    def test_manual_center_profile_and_rate_changes_stop(self):
        for key,value in [('center_freq',9999000),('profile_id','other'),('samp_rate',192000)]:
            source,chains,now,scan=self.fixture();scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
            source.props.change(key,value);scan.thread.join(timeout=2)
            self.assertFalse(scan.running);self.assertEqual(source.clients,[])
    def test_local_capture_filter_and_duplicate_start(self):
        source,chains,now,scan=self.fixture();scan.start(dict(OPTIONS,across=False));wait_for(lambda:len(chains)==1)
        self.assertEqual(scan.options['channels'],[9025000]);self.assertEqual(source.retunes,[])
        with self.assertRaises(ValueError):scan.start(OPTIONS.copy())
    def test_stuck_activity_maximum_hold(self):
        source,chains,now,scan=self.fixture();scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
        chains[0].callback({'freq':9025000,'event':'activity','active':True})
        now[0]=120;wait_for(lambda:len(chains)==2)
    def test_failures_and_test_events(self):
        source,chains,now,scan=self.fixture();scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
        chains[0].callback({'freq':9025000,'event':'amd','test_audio':True})
        self.assertEqual(scan.snapshot()['events'],[])
        scan.onFail();scan.thread.join(timeout=2);self.assertFalse(scan.running)
        self.assertIn('failed',scan.status)
    def test_retune_permission_revocation_stops_before_next_hop(self):
        source,chains,now,scan=self.fixture();scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
        scan.retune_allowed=lambda:False
        with self.assertLogs(module.logger,level='ERROR'):
            now[0]=4;scan.thread.join(timeout=2)
        self.assertFalse(scan.running);self.assertEqual(source.retunes,[])
        self.assertIn('no longer allows',scan.status)
    def test_factory_failure_cleans_background_client(self):
        source,chains,now,scan=self.fixture()
        scan.factory=lambda *args: (_ for _ in ()).throw(ValueError('DSP unavailable'))
        with self.assertLogs(module.logger,level='ERROR'):
            scan.start(OPTIONS.copy());scan.thread.join(timeout=2)
        self.assertFalse(scan.running);self.assertEqual(source.clients,[])
        self.assertIn('DSP unavailable',scan.status)
    def test_control_permission_and_status_after_browser_gone(self):
        source,chains,now,scan=self.fixture()
        client=SimpleNamespace(sdr=source,stack={'magic_key':'secret','allow_center_freq_changes':True})
        with patch.dict(module._registry,{'airspy':scan},clear=True):
            with self.assertRaises(ValueError):module.request(client,dict(OPTIONS,action='start',key='wrong'))
            with self.assertRaises(ValueError):module.request(client,{'action':'stop','key':'wrong'})
            self.assertFalse(module.request(client,{'action':'status'})['running'])
            client.stack['allow_center_freq_changes']=False
            with self.assertRaises(ValueError):module.request(client,dict(OPTIONS,action='start',key='secret'))
            client.stack['allow_center_freq_changes']=True
            # Use a temporary catalog path through the module's existing sibling file.
            module.request(client,dict(OPTIONS,action='start',key='secret'))
            wait_for(lambda:len(chains)==1)
            del client
            reader=SimpleNamespace(sdr=source,stack={'magic_key':'secret','allow_center_freq_changes':True})
            self.assertTrue(module.request(reader,{'action':'status'})['running'])
            module.request(reader,{'action':'stop','key':'secret'})
            scan.thread.join(timeout=2);self.assertFalse(scan.running)


if __name__=='__main__': unittest.main()
