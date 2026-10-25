import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ale_live_test', HERE/'live_test.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
BINARY = (HERE/'decoder/owrx-ale').resolve()


class LiveTestTests(unittest.TestCase):
    def test_reference_replay_reaches_live_pipe_with_labels(self):
        import os
        reader, writer = os.pipe()
        stream = helper.stream_audio
        open_fd = os.open
        def open_pipe(path, flags):
            if str(path) == '/proc/123/fd/1':
                return os.dup(writer)
            return open_fd(path,flags)
        try:
            with patch.object(helper, 'BINARY', BINARY), patch.object(
                helper, 'stream_audio', lambda p, audio: stream(p, audio, realtime=False)
            ), patch.object(helper, 'session', return_value=(7102000,'fixture')), patch.object(os, 'open', side_effect=open_pipe), patch.object(
                sys, 'argv', ['live_test.py', '--pid', '123']
            ):
                helper.main()
            os.close(writer); writer = None
            with os.fdopen(reader, 'rb') as source:
                events = [json.loads(line) for line in source]
            reader = None
            self.assertTrue(all(e['test_audio'] for e in events))
            self.assertTrue(any('[TEST AUDIO]' in e.get('display','') for e in events))
            self.assertTrue(any('THE QUICK BROWN FOX' in e.get('display','') for e in events))
        finally:
            if writer is not None:
                os.close(writer)
            if reader is not None:
                os.close(reader)

    def test_invalid_reference_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'invalid.au'
            path.write_bytes(b'invalid')
            with self.assertRaises(ValueError):
                helper.load_audio(path)


if __name__ == '__main__':
    unittest.main()
