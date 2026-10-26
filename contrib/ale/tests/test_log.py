import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from owrx.ale_log import AleLog
from owrx.ale_scan import AleBackgroundScan, request


def event(address='ADW', frequency=11226000, **changes):
    return dict(mode='ALE2G', timestamp=1792962000000, freq=frequency,
                event='sounding_this_was', source=address, destination='',
                message='[Sounding THIS WAS] [From: '+address+']', **changes)


class LogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'ale-log'/'receptions.sqlite3'
        self.log = AleLog(self.path)

    def test_reopen_keeps_repetitions_and_exact_text(self):
        message = event('<ADW>')
        message['message'] = '=SUM(1,2)\n"radio text"'
        first = self.log.append('sdrplay','hfgcs_candidates',message)
        second = self.log.append('sdrplay','hfgcs_candidates',message)
        restored = AleLog(self.path)
        self.assertEqual([r['log_id'] for r in restored.recent('sdrplay')], [first,second])
        self.assertEqual(restored.recent('sdrplay')[0]['message'],message['message'])
        self.assertEqual(restored.summary('sdrplay')['stations'][0]['count'],2)

    def test_aggregate_sources_only_and_isolate_receivers(self):
        self.log.append('one','hfgcs',event())
        self.log.append('one','hfgcs',event(frequency=15043000))
        destination = event(''); destination['destination'] = 'UNHEARD'
        self.log.append('one','hfgcs',destination)
        self.log.append('two','hfgcs',event('OTHER'))
        summary = self.log.summary('one')
        self.assertEqual(summary['total'],3)
        self.assertEqual([s['address'] for s in summary['stations']],['ADW'])
        self.assertEqual(summary['stations'][0]['frequencies'],[11226000,15043000])
        self.assertEqual(self.log.page('two')['events'][0]['source'],'OTHER')
        self.assertEqual(self.log.recent('missing'),[])

    def test_activity_test_audio_and_bad_events_are_not_logged(self):
        self.assertIsNone(self.log.append('one','bank',dict(event(),event='activity')))
        self.assertIsNone(self.log.append('one','bank',dict(event(),test_audio=True)))
        for changes in ({'freq':True},{'timestamp':0},{'source':'x'*256},{'message':12}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.log.append('one','bank',dict(event(),**changes))
        self.assertEqual(self.log.summary('one')['total'],0)

    def test_retention_is_bounded_across_receivers(self):
        log = AleLog(self.path,limit=3)
        for i in range(8): log.append('one' if i%2 else 'two','bank',event(str(i)))
        rows = sorted(log.recent('one')+log.recent('two'),key=lambda x:x['log_id'])
        self.assertEqual([r['source'] for r in rows],['5','6','7'])

    def test_paginated_export_has_stable_end_cursor(self):
        for _ in range(205): self.log.append('one','bank',event())
        first = self.log.page('one')
        self.assertEqual(len(first['events']),200); self.assertTrue(first['more'])
        self.log.append('one','bank',event('LATER'))
        last = self.log.page('one',first['after'],first['through'])
        self.assertFalse(last['more']); self.assertEqual(len(last['events']),5)
        self.assertEqual(last['total'],205)
        self.assertNotIn('LATER',[r['source'] for r in last['events']])
        for cursor in (True,-1,'0',2**54):
            with self.assertRaises(ValueError): self.log.page('one',cursor)

    def test_concurrent_sources_commit_without_losing_events(self):
        errors=[]
        def write(receiver):
            try:
                for _ in range(12): self.log.append(receiver,'bank',event())
            except Exception as error: errors.append(error)
        threads=[threading.Thread(target=write,args=(name,)) for name in ['one','two']]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors,[])
        self.assertEqual([self.log.summary(s)['total'] for s in ['one','two']],[12,12])

    def test_scanner_restores_without_starting_or_retuning(self):
        self.log.append('one','bank',event())
        source=SimpleNamespace(getId=lambda:'one')
        scan=AleBackgroundScan(source,journal=self.log)
        state=scan.snapshot()
        self.assertFalse(state['running']); self.assertIsNone(scan.thread)
        self.assertTrue(state['events'][0]['restored'])
        self.assertEqual(state['events'][0]['source'],'ADW')
        self.assertEqual(scan.snapshot(after=1)['events'],[])

    def test_disk_failure_preserves_live_decodes(self):
        source=SimpleNamespace(getId=lambda:'one')
        scan=AleBackgroundScan(source,journal=self.log)
        scan.running=True;scan.frequency=11226000;scan.options={'bank':'bank'}
        with patch.object(self.log,'append',side_effect=OSError('disk full')):
            with self.assertLogs('owrx.ale_scan',level='ERROR'): scan.event(0,event())
        self.assertEqual(len(scan.snapshot()['events']),1)
        self.assertIn('unavailable',scan.snapshot()['log_error'])
        scan.event(0,event('RECOVERED'))
        self.assertIsNone(scan.snapshot()['log_error'])
        self.assertEqual(self.log.summary('one')['total'],1)

    def test_read_requests_are_scoped_and_do_not_control_rf(self):
        self.log.append('one','bank',event())
        client=SimpleNamespace(sdr=SimpleNamespace(getId=lambda:'one'))
        with patch('owrx.ale_scan.get_log',return_value=self.log):
            response=request(client,{'action':'log','request_id':'1'})
            self.assertEqual(response['total'],1);self.assertEqual(response['kind'],'log')
            response=request(client,{'action':'export','request_id':'2','log_after':-1})
            self.assertIn('error',response)
            with self.assertRaises(ValueError): request(client,{'action':'log','request_id':'x'*50})
