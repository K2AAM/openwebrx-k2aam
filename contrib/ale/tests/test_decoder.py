import array
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import select
import time
import struct
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[3]
DECODER = ROOT / 'contrib/ale/decoder'
BINARY = Path(os.environ.get('ALE_BINARY', DECODER / 'owrx-ale'))
AUDIO = Path(os.environ.get('ALE_TEST_AUDIO', DECODER / 'test-data/ALE.test.8k.au'))
spec = importlib.util.spec_from_file_location('ale_protocol', ROOT / 'owrx/ale_protocol.py')
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


def run_pcm(pcm, *args):
    return subprocess.run([str(BINARY), '--frequency-hz', '7102000', *args],
                          input=pcm, capture_output=True, check=False)


def pcm_bytes(values):
    samples = array.array('h', values)
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples.tobytes()


class DecoderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = AUDIO.read_bytes()
        magic, offset, size, encoding, rate, channels = struct.unpack('>6I', data[:24])
        assert (magic, encoding, rate, channels) == (0x2e736e64, 3, 8000, 1)
        raw = data[offset:offset + size]
        cls.pcm = b''.join(raw[i:i+2][::-1] for i in range(0, len(raw), 2))

    def test_reference_message_and_address(self):
        result = run_pcm(self.pcm)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(any(e.get('event') == 'amd' and 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG' in e['display'] for e in events))
        self.assertTrue(any(e.get('event') == 'sounding_this_was' and e['source'] == 'BAS' for e in events))
        self.assertEqual([e['active'] for e in events if e['kind'] == 'activity'], [True, False])
        self.assertTrue(all(e['frequency_hz'] == 7102000 for e in events))
        parsed = [protocol.decode_event(line, 7102000, 123456) for line in result.stdout.splitlines()]
        self.assertEqual(len([e for e in parsed if e and e['event'] != 'activity']), 2)
        self.assertTrue(any(e.get('source') == 'BAS' for e in parsed))

    def test_reference_decodes_on_stream_without_eof(self):
        process = subprocess.Popen([str(BINARY), '--frequency-hz', '7102000'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            process.stdin.write(self.pcm + bytes(16000*5))
            process.stdin.flush()
            output = b''
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                ready, _, _ = select.select([process.stdout], [], [], 0.1)
                if ready:
                    output += os.read(process.stdout.fileno(), 8192)
                if b'THE QUICK BROWN FOX' in output:
                    break
            self.assertIsNone(process.poll(), 'decoder must still be streaming')
            self.assertIn(b'THE QUICK BROWN FOX', output)
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()

    def test_no_decodes_from_silence_noise_or_single_tone(self):
        rng = random.Random(7102)
        samples = 8000 * 30
        for label, pcm in [('silence', bytes(samples * 2)),
                           ('noise', pcm_bytes(rng.randint(-12000,12000) for _ in range(samples))),
                           ('tone', pcm_bytes(int(8000*math.sin(2*math.pi*1000*n/8000)) for n in range(samples)))]:
            with self.subTest(label=label):
                result = run_pcm(pcm)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertFalse(any(json.loads(line).get('kind') == 'decode' for line in result.stdout.splitlines()))

    def test_truncated_sample_and_wrong_rate_fail(self):
        self.assertEqual(run_pcm(b'\x00').returncode, 2)
        self.assertEqual(run_pcm(b'', '--sample-rate', '12000').returncode, 2)

    def test_partial_block_eof(self):
        self.assertEqual(run_pcm(bytes(30)).returncode, 0)

    def test_wav_reader_and_rate_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'sample.wav'
            for rate in (8000, 12000):
                with wave.open(str(file), 'wb') as audio:
                    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
                    audio.writeframes(self.pcm)
                result = subprocess.run([sys.executable, str(DECODER/'decode_file.py'), str(file), '--binary', str(BINARY), '--frequency-hz', '7102000'], capture_output=True)
                if rate == 8000:
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertIn(b'"source":"BAS"', result.stdout)
                else:
                    self.assertNotEqual(result.returncode, 0)


class ProtocolTests(unittest.TestCase):
    def valid(self):
        return {'kind':'decode','event':'amd','source':'BAS','destination':'',
                'display':'[00:00:22] [MSG] [AMD: "TEST"] [His BER: 3]', 'frequency_hz':7102000}

    def test_event_metadata_and_plain_text(self):
        event = self.valid(); event['display'] = '<img src=x onerror=alert(1)>'
        value = protocol.decode_event(json.dumps(event).encode(), 7102000, 42)
        self.assertEqual((value['mode'], value['freq'], value['timestamp']), ('ALE2G',7102000,42))
        self.assertEqual(value['message'], event['display'])

    def test_previous_channel_output_is_rejected(self):
        self.assertFalse(protocol.decode_event(json.dumps(self.valid()).encode(),14109000,42))

    def test_activity_validation_and_test_audio(self):
        event = {'kind':'activity', 'active':True, 'frequency_hz':7102000}
        value = protocol.decode_event(json.dumps(event).encode(),7102000,42)
        self.assertEqual(value['event'], 'activity')
        self.assertTrue(value['active'])
        event['active'] = 'true'
        self.assertFalse(protocol.decode_event(json.dumps(event).encode(),7102000,42))
        event = self.valid(); event['test_audio'] = True
        self.assertTrue(protocol.decode_event(json.dumps(event).encode(),7102000,42)['test_audio'])

    def test_bad_and_oversized_events_are_ignored(self):
        for value in (b'bad json', b'[]', b'null', b'x'*4097, b'{"kind":"activity"}'):
            self.assertFalse(protocol.decode_event(value,7102000,42))
        for key, value in [('event','unknown'),('event',[]),('source',[]),('display','x'*513),('frequency_hz',True)]:
            event=self.valid();event[key]=value
            self.assertFalse(protocol.decode_event(json.dumps(event).encode(),7102000,42))


if __name__ == '__main__':
    unittest.main()
