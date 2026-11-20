#!/usr/bin/env python3
"""Fetch the upstream KiwiSDR reference sample, checking its fixed SHA-256."""
from pathlib import Path
from urllib.request import urlopen
import hashlib
import time

URL = 'https://distro.kiwisdr.com/samples/ALE.test.8k.au'
SHA256 = '90d1a75ef48c7802fcd49c1b8273bd36dfcb97d4b35e1f1ededa45e00842815e'


def main():
    target = Path(__file__).with_name('test-data') / 'ALE.test.8k.au'
    if target.exists():
        data = target.read_bytes()
    else:
        for attempt in range(4):
            try:
                with urlopen(URL, timeout=30) as response:
                    data = response.read(474267)
                break
            except OSError as error:
                # The sample host is occasionally slow from CI runners.
                if attempt == 3:
                    raise SystemExit(f'Cannot download reference sample: {error}')
                time.sleep(10 * (attempt + 1))
    if len(data) != 474266 or hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit('Reference sample changed or is incomplete; no file written.')
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(data)
    print(f'Verified upstream reference sample: {target}')


if __name__ == '__main__':
    main()
