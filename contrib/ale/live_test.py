#!/usr/bin/env python3
"""Decode test audio and forward labeled results to one active OWRX ALE panel.

This exercises a separate installed decoder plus the live parser/WebSocket/UI.
It deliberately bypasses RF and the native float-to-PCM input chain.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import threading
import time

REFERENCE_SHA256 = '90d1a75ef48c7802fcd49c1b8273bd36dfcb97d4b35e1f1ededa45e00842815e'
BINARY = Path('/usr/local/bin/owrx-ale')


def load_audio(path):
    if path.suffix.lower() == '.au':
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != REFERENCE_SHA256:
            raise ValueError('AU input must be the verified reference sample.')
        magic, offset, size, encoding, rate, channels = struct.unpack('>6I', data[:24])
        if (magic, encoding, rate, channels) != (0x2e736e64, 3, 8000, 1):
            raise ValueError('Unexpected AU format.')
        raw = data[offset:offset+size]
        return b''.join(raw[i:i+2][::-1] for i in range(0, len(raw), 2))
    # ffmpeg reads the file only; no sound card, microphone or virtual cable.
    return subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-t', '180',
                           '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
                          capture_output=True, check=True, timeout=30).stdout


def session(pid):
    proc = Path('/proc') / str(pid)
    if proc.joinpath('exe').resolve() != BINARY.resolve():
        raise ValueError('PID is not the installed owrx-ale executable.')
    args = proc.joinpath('cmdline').read_bytes().decode().split('\0')
    frequency = int(args[args.index('--frequency-hz')+1])
    if frequency <= 0:
        raise ValueError('Select a valid listening frequency first.')
    # starttime protects against PID reuse; comm may contain spaces/parentheses.
    started = proc.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
    return frequency, started


def stream_audio(process, pcm, realtime=True):
    try:
        started = time.monotonic()
        # Include trailing quiet audio to test live output before EOF.
        pcm += bytes(16000 * 5)
        for offset in range(0, len(pcm), 640):
            process.stdin.write(pcm[offset:offset+640])
            process.stdin.flush()
            if realtime:
                delay = started + (offset+640)/16000 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
    except (BrokenPipeError, OSError, ValueError):
        pass  # main thread checks the child's return code
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True, help='One active live ALE decoder PID')
    parser.add_argument('--audio', type=Path, default=Path(__file__).parent/'decoder/test-data/ALE.test.8k.au')
    args = parser.parse_args()
    child = None
    fd = None
    try:
        frequency, started = identity = session(args.pid)
        pcm = load_audio(args.audio.expanduser())
        if not pcm or len(pcm) % 2:
            raise ValueError('Empty or invalid PCM audio.')
        fd = os.open(f'/proc/{args.pid}/fd/1', os.O_WRONLY | os.O_NONBLOCK)
        if not stat.S_ISFIFO(os.fstat(fd).st_mode):
            raise ValueError('Live decoder stdout is not a pipe; no test messages sent.')
        os.write(fd, (json.dumps({'kind':'activity', 'active':False, 'frequency_hz':frequency, 'test_audio':True})+'\n').encode())
        print(f'TEST AUDIO: {len(pcm)/16000:.2f}s + 5s silence, labeled at {frequency/1000:.1f} kHz.', flush=True)
        print('Stop ALE scanning first. Do not tune or change modes during this test.', flush=True)
        child = subprocess.Popen([str(BINARY), '--sample-rate', '8000', '--frequency-hz', str(frequency)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        worker = threading.Thread(target=stream_audio, args=(child, pcm), daemon=True)
        worker.start()
        count = 0
        for line in child.stdout:
            if session(args.pid) != identity:
                raise ValueError('Live decoder changed/restarted; test stopped.')
            event = json.loads(line)
            event['test_audio'] = True
            if event.get('kind') == 'decode':
                event['display'] = '[TEST AUDIO] ' + event['display']
                count += 1
            payload = (json.dumps(event)+'\n').encode()
            if len(payload) > 4096:
                raise ValueError('Oversized decoder event.')
            if os.write(fd, payload) != len(payload):
                raise OSError('Incomplete event write.')
            print(json.dumps(event), flush=True)
        worker.join(timeout=2)
        if child.wait(timeout=5):
            raise ValueError('Test decoder exited with an error.')
        print(f'Finished: {count} labeled decoded messages. RF/audio capture was not modified.')
    except (OSError, ValueError, IndexError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        parser.exit(1, f'Stopped: {error}\n')
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if child is not None:
            child.stdout.close()
        if fd is not None:
            os.close(fd)


if __name__ == '__main__':
    main()
