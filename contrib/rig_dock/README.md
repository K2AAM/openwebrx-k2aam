# K2AAM receiver UI — RIG Dock 0.2.0

This fork adds a compact receiver dock and a shared decoder tray to OpenWebRX+ 1.2.126. The receiver page loads the dock before station plugins. Map pages retain their existing loader.

## Decoder tray

All native message panels, digital voice/radio metadata panels, and the secondary decoder waterfall/text panel move into a full-width tray directly above the RIG controls. The main RF waterfall reserves space for the tray.

- Native mode selection determines which panels are active. There is no FT8-only mode list in the tray; newly added panels with the native decoder classes are also adopted.
- Height adjusts from the tray header. The default is about 28% of the space available above the dock, with room retained for the RF waterfall.
- Collapse hides the output area while decoding and image updates continue. Height and collapse preferences are saved in this browser.
- IF waterfall toggles the small decoder waterfall. Phones default to full-width results where text/results are available; users can enable the IF view, and that choice is saved. Decoded messages retain their native scrolling, callsign/map links, and Clear handlers.
- Text, WSJT-family, JS8, packet, paging, aeronautical, image, skimmer, mesh, and digital-radio metadata outputs share the tray.
- Native expand/collapse flags are settled explicitly because the tray does not use the floating panels' 3-D transitions.
- More controls → Use stock controls restores native nodes, positions, and controls in the current tab.

## Receiver controls

The dock retains native frequency/digit tuning, profiles, supported mode selection and underlying modes, volume/mute, squelch, NR, step, bandpass, recording, and scanner. The legacy rig_skin DX/satellite/watch/dual-VFO extras are not ported. Waterfall controls include palette, levels, auto range, spectrum, and zoom. The status footer replaces the floating status panel, and chat/log stays hidden while the dock is active.

Tune accepts Hz, kHz, or MHz; a value without units is MHz. Outside the current capture window it sends the native `setfrequency` request with the current magic key, waits for the server's new center frequency and delayed demodulator restart, then restores the selected mode and listening frequency. The server must permit center-frequency changes. Moving the shared SDR affects everyone using it. A profile change or Stop waiting cancels the pending client update, but cannot recall a receiver request already sent.

Record uses OWRX's native recording control marker and mirrors its visibility. This fixes the native visibility gate rejecting the former dock button and retains the server's recording permission. Stop downloads the native MP3 recording.

The optional browser audio filter is bypassed on every page load and loaded only on explicit enable/settings. Its MIT-licensed upstream attribution is retained in the source. It does not replace `AudioNode.prototype.connect`. OWRX's native recording path is retained.

The optional `rsp_antenna` frontend is included for installations with the existing antenna-switcher backend. The dock reuses its shared selection and labels. This UI change does not install the antenna backend or alter profiles, SDR drivers, or antenna permissions.

## Apply the UI to an existing OWRX installation

Clone this branch on the receiver:

```bash
git clone --branch k2aam-ui https://github.com/K2AAM/openwebrx-k2aam.git
cd openwebrx-k2aam
```

For an already installed RIG Dock 0.1.0–0.1.3:

```bash
sudo /usr/bin/python3 contrib/rig_dock/update.py --check
sudo /usr/bin/python3 contrib/rig_dock/update.py
```

For a fresh installation on a stock OWRX+ receiver:

```bash
sudo /usr/bin/python3 contrib/rig_dock/install.py --check
sudo /usr/bin/python3 contrib/rig_dock/install.py --install
```

If needed, select the web directory with `--htdocs /usr/lib/python3/dist-packages/htdocs`. The installer and updater validate files, save backups, retain file permissions, update uninstall records, and roll back failed writes. Edited installed assets stop an update before writes. Safe Studio failed-registration checks and standard legacy `Plugins.load()` calls are supported; direct custom calls to replaced plugin APIs need adapting.

Reload the receiver afterward. No OWRX service restart is needed for these browser assets. Backups and the install record are in `/var/lib/openwebrx/rig-dock/`.

To undo an asset installation on stock OWRX:

```bash
sudo /usr/bin/python3 contrib/rig_dock/install.py --uninstall
```

When running the fork itself, its bundled plugin loader starts the dock automatically; use More → Use stock controls for a per-tab fallback. The standalone installer is for a separate, existing OWRX installation, not this checkout's own `htdocs` directory.

## Validation

See [VALIDATION.md](VALIDATION.md). RF/DSP transport is simulated in browser tests; physical receiver behavior still needs confirmation on SDRplay and Airspy receivers.
