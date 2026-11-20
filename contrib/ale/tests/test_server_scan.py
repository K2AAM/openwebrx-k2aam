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
    def getProfileId(self): return self.props['profile_id']
    def activateProfile(self,profile):
        if profile in ('hf','night'): self.props.change('profile_id',profile)


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
        journal=Mock(recent=Mock(return_value=[]),append=Mock(return_value=1))
        scan=module.AleBackgroundScan(source,factory,clock=lambda:now[0],settle=0,retune_allowed=lambda:True,journal=journal)
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

    def test_control_is_locked_without_a_key_unless_public(self):
        source,chains,now,scan=self.fixture()
        for stack in ({'magic_key':''},{}):
            with self.assertRaisesRegex(ValueError,'locked'):module.check_control(SimpleNamespace(stack=stack),{'key':''})
        keyed=SimpleNamespace(stack={'magic_key':'secret','ale_scan_public':False})
        for key in (None,'','secre','secret ',5):
            with self.assertRaisesRegex(ValueError,'magic key'):module.check_control(keyed,{'key':key})
        module.check_control(keyed,{'key':'secret'})
        module.check_control(SimpleNamespace(stack={'magic_key':'','ale_scan_public':True}),{})
        # Only a literal True opens control; a damaged setting keeps it locked.
        with self.assertRaises(ValueError):module.check_control(SimpleNamespace(stack={'magic_key':'','ale_scan_public':'yes'}),{})
        client=SimpleNamespace(sdr=source,stack={'magic_key':'','allow_center_freq_changes':True})
        with patch.dict(module._registry,{'airspy':scan},clear=True):
            with self.assertRaisesRegex(ValueError,'locked'):module.request(client,dict(OPTIONS,action='start'))
            self.assertFalse(module.request(client,{'action':'status'})['running'])
    def state_fixture(self):
        import tempfile
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'ale-log'/'scan-state.json'
        source=Source();chains=[]
        def factory(source, frequency, callback):
            chain=SimpleNamespace(stop=lambda:None);chains.append(chain);return chain
        journal=Mock(recent=Mock(return_value=[]),append=Mock(return_value=1))
        scan=module.AleBackgroundScan(source,factory,settle=0,retune_allowed=lambda:True,journal=journal,state=path)
        def finish():
            scan.stop()
            if scan.thread: scan.thread.join(timeout=2)
        self.addCleanup(finish)
        return path,source,chains,scan
    def test_running_scan_is_saved_and_forgotten_when_stopped(self):
        path,source,chains,scan=self.state_fixture()
        scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
        saved=json.loads(path.read_text())
        self.assertEqual(saved,{'airspy':{'options':OPTIONS,'profile':'hf'}})
        scan.stop();scan.thread.join(timeout=2)
        self.assertEqual(json.loads(path.read_text()),{})
    def test_scan_stays_saved_across_service_shutdown(self):
        path,source,chains,scan=self.state_fixture()
        scan.start(OPTIONS.copy());wait_for(lambda:len(chains)==1)
        with patch.object(module,'_shutting_down',True):
            scan.onShutdown();scan.thread.join(timeout=2)
        self.assertFalse(scan.running)
        self.assertIn('airspy',json.loads(path.read_text()))
    def test_resume_restarts_saved_scans_and_drops_bad_entries(self):
        path,source,chains,scan=self.state_fixture()
        source.props['profile_id']='night'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'airspy':{'options':OPTIONS,'profile':'hf'},
            'gone':{'options':OPTIONS,'profile':'hf'},'bad':{'options':dict(OPTIONS,bank='nope')},'worse':7}))
        lookup={'airspy':source,'bad':Source(),'worse':Source()}.get
        created=[]
        def build(source,**kwargs):
            created.append(kwargs);return scan
        with patch.dict(module._registry,{},clear=True),patch.object(module,'AleBackgroundScan',build),\
                patch.object(module,'native_retune_allowed',lambda:True),self.assertLogs(module.logger,level='INFO') as logs:
            resumed=module.resume_saved(path=path,sources=lookup,features=lambda:True,catalog=CATALOG,start=False)
        self.assertEqual(resumed,['airspy'])
        self.assertEqual(source.props['profile_id'],'hf')
        self.assertEqual(created[0]['startup'],45)
        wait_for(lambda:len(chains)==1)
        self.assertTrue(scan.running)
        self.assertEqual(list(json.loads(path.read_text())),['airspy'])
        self.assertEqual(sum('not resumed' in line for line in logs.output),3)
    def test_resume_does_nothing_without_decoder_or_state_and_never_raises(self):
        path,source,chains,scan=self.state_fixture()
        self.assertEqual(module.resume_saved(path=path,sources={}.get,features=lambda:True,catalog=CATALOG,start=False),[])
        path.parent.mkdir(parents=True);path.write_text(json.dumps({'airspy':{'options':OPTIONS,'profile':'hf'}}))
        with self.assertLogs(module.logger,level='WARNING'):
            self.assertEqual(module.resume_saved(path=path,sources={'airspy':source}.get,features=lambda:False,catalog=CATALOG,start=False),[])
        self.assertIn('airspy',json.loads(path.read_text()))
        path.write_text('{broken')
        with self.assertLogs(module.logger,level='ERROR'):
            self.assertEqual(module.resume_saved(path=path,sources={}.get,features=lambda:True,catalog=CATALOG,start=False),[])
        with patch.object(module,'native_retune_allowed',lambda:False),self.assertLogs(module.logger,level='WARNING'):
            path.write_text(json.dumps({'airspy':{'options':OPTIONS,'profile':'hf'}}))
            self.assertEqual(module.resume_saved(path=path,sources={'airspy':source}.get,features=lambda:True,catalog=CATALOG,start=False),[])


if __name__=='__main__': unittest.main()
