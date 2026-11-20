# RSPdx antenna switcher

Lets listeners pick the RSPdx / RSPdx-R2 antenna port (A, B, C) from the receiver page.

- **Browser side:** the `rsp_antenna` receiver plugin. It shows nothing unless the server says the
  current SDR has switchable antennas.
- **Server side:** `owrx/antenna_switcher.py`, called from `owrx/connection.py` for `getantenna` /
  `setantenna` messages. The choice is a runtime overlay on the SDR's properties: profiles and
  `settings.json` are never written, and the choice is held across profile changes until
  OpenWebRX+ restarts.

The SDRplay connector does not report back, so the page shows what OpenWebRX+ asked for, not a
hardware acknowledgment.

## Enable it on a receiver

Nothing is switchable until `/etc/openwebrx/antenna-switcher.json` exists. Find the OpenWebRX+
device ID (the key under `sdrs`, not the SDRplay serial number):

```bash
sudo python3 -c "import json; print([k for k, v in json.load(open('/var/lib/openwebrx/settings.json'))['sdrs'].items() if v.get('type') == 'sdrplay'])"
```

Copy `antenna-switcher.example.json` to `/etc/openwebrx/antenna-switcher.json`, put that ID in, and
list one to three ports with the labels you want on the buttons. Only SDRplay devices listed there
are switchable. The file is read on each request, so edits apply without a restart.

`"access": "public"` lets any visitor switch; `"key"` requires the receiver's magic key. Changes are
limited to one every two seconds per SDR, and every listener on that SDR sees the new selection.

## Moving a receiver that has the old standalone patch

The earlier `OWRX_RSPdx_Antenna_Switcher/install.py` patched a stock install. Before installing this
fork's package on that machine:

```bash
sudo cp /etc/openwebrx/antenna-switcher.json ~/antenna-switcher.json.keep
sudo python3 ~/OWRX_RSPdx_Antenna_Switcher/install.py --uninstall
```

The uninstall also removes the config file it created, which is why it is copied first. After the
fork's package is installed, put the copy back at `/etc/openwebrx/antenna-switcher.json`.

## Tests

```bash
python3 -m unittest discover -s contrib/antenna/tests -v
```

These use the real OpenWebRX+ property stack with a faked SDR and clients. The browser suite covers
the buttons against a simulated server. Neither switches real hardware.
