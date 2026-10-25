#!/usr/bin/env python3
"""Decode a mono 8 kHz, 16-bit PCM WAV through the receive-only ALE prototype."""
import argparse
from pathlib import Path
import subprocess
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--frequency-hz', type=int, default=0)
    parser.add_argument('--binary', type=Path, default=Path(__file__).with_name('owrx-ale'))
    args = parser.parse_args()
    if args.frequency_hz < 0 or args.frequency_hz > 9999999999:
        parser.error('Frequency must be a nonnegative integer in Hz.')
    try:
        with wave.open(str(args.file), 'rb') as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 8000, 'NONE'):
                parser.error('Convert the input to mono 8000 Hz, signed 16-bit PCM WAV first.')
            with subprocess.Popen([str(args.binary.resolve()), '--frequency-hz', str(args.frequency_hz)], stdin=subprocess.PIPE) as process:
                try:
                    while data := audio.readframes(4096):
                        process.stdin.write(data)
                    process.stdin.close()
                except (BrokenPipeError, OSError):
                    process.terminate()
                    raise
                return process.wait()
    except (OSError, EOFError, wave.Error) as error:
        parser.exit(1, f'Stopped: {error}\n')


if __name__ == '__main__':
    raise SystemExit(main())
