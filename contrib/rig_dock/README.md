# K2AAM receiver UI — RIG Dock 0.4.0

This fork adds a compact receiver dock and a shared decoder tray to OpenWebRX+ 1.2.126. The receiver page loads the dock before station plugins. Map pages retain their existing loader.

On first load, a compact connecting bar stays visible until the stylesheet, waterfall scale, supported modes/features, active demodulator, and selected profile are ready. The dock is then revealed with its configured frequency and profile. A failed stylesheet load or a 20-second startup timeout restores stock controls.

## Decoder tray

All native message panels, digital voice/radio metadata panels, and the secondary decoder waterfall/text panel move into a full-width tray directly above the RIG controls. The main RF waterfall reserves space for the tray.

- Native mode selection determines which panels are active. There is no FT8-only mode list in the tray; newly added panels with the native decoder classes are also adopted.
- ALE output uses aligned UTC/frequency/from/to/event/message columns, with compact sounding descriptions and expandable raw decoder text. **Fit** sizes the ALE tray to the latest six rows plus the log toolbar and the current Stations heard panel; the Height slider selects a fixed pane size. Phone rows use two lines without hiding addresses.
- Height adjusts from the tray header. The default is about 28% of the space available above the dock, with room retained for the RF waterfall.
- Collapse hides the output area while decoding and image updates continue. Height and collapse preferences are saved in this browser.
- IF waterfall toggles the small decoder waterfall. Phones default to full-width results where text/results are available; users can enable the IF view, and that choice is saved. Decoded messages retain their native scrolling, callsign/map links, and Clear handlers.
- Text, WSJT-family, JS8, packet, paging, aeronautical, image, skimmer, mesh, and digital-radio metadata outputs share the tray.
- Native expand/collapse flags are settled explicitly because the tray does not use the floating panels' 3-D transitions.
- The tray sits beside the native panel stacks so a receiver panel transform cannot shift or clip it. Dock menus remain above the tray.
- More controls → Use stock controls restores native nodes, positions, and controls in the current tab.

## Receiver controls

The dock retains native frequency/digit tuning, profiles, supported mode selection and underlying modes, volume/mute, squelch, NR, step, bandpass, recording, and scanner. The legacy rig_skin DX/satellite/watch/dual-VFO extras are not ported. Waterfall controls include palette, levels, auto range, spectrum, and zoom. The status footer replaces the floating status panel, and chat/log stays hidden while the dock is active.

Click the frequency readout or **Tune** to enter a frequency. Choose Hz, kHz, or MHz in the units selector (default MHz); an explicitly typed suffix overrides it. Without a typed suffix the selected scale is used. Native mouse-wheel digit tuning is retained. Outside the current capture window it sends the native `setfrequency` request with the current magic key, waits for the server's new center frequency and delayed demodulator restart, then restores the selected mode and listening frequency. The server must permit center-frequency changes. Moving the shared SDR affects everyone using it. A profile change or Stop waiting cancels the pending client update, but cannot recall a receiver request already sent.

Record, the optional Screenshot control, and More controls sit together in the first row, keeping the toolbar compact. The dock adopts the Screenshot plugin's original PIC node and handler, removes its unbound duplicate inside the dock, and unwraps the narrow Record container. Labels retain their full width; stock-control fallback restores PIC to its original position. Screenshot is available independently of the server's audio-recording permission. Record uses OWRX's native recording control marker and mirrors its visibility. This fixes the native visibility gate rejecting the former dock button and retains the server's recording permission. Stop downloads the native MP3 recording.

The optional filter now uses **Audio Filter Studio 2.3 beta.2**, adapted from K2AAM's separate Studio repository. Earlier RIG builds bundled an adapted older DL1HQH filter. Studio adds the existing classical spectral NR, speech/body controls, listening presets, NB, notch, EQ and compressor, plus an optional **RNNoise WASM** engine. Existing per-mode Studio settings keys are retained. Processing starts bypassed on every page load; opening settings does not touch the audio route. Enable explicitly in Audio or the Studio window. Native receiver attachment replaces global connection/factory interception, and bypass restores the original direct route. Native recording and server decoder input are retained.

For RNNoise, start receiver audio, choose USB/LSB or spoken AM, enable the filter, open **Audio → Filter settings → ⋯ → NR engine**, and select **RNNoise WASM**. Alternatively choose **Weak SSB / DX · Neural**. The pinned 1.9 MiB model is bundled locally and fetched by the browser only when requested. No external CDN, microphone permission or receiver-side neural processing is required. HTTPS/localhost, AudioWorklet and a 48 kHz browser audio context are required. Other sample rates and non-speech modes use classical NR with a visible explanation. Missing/failed models retain classical NR and expose Retry. Classical NR remains the default and is not stacked with active RNNoise. RNNoise strength controls an aligned dry/wet mix; this speech model may remove weak speech, music or non-speech sounds, so compare it with the classical engine on actual radio audio.

The newer Studio assets and RNNoise/Studio license files are included in fresh installation and verified updates, with uninstall tracking and rollback. See [audio provenance](../../htdocs/plugins/receiver/rig_audio/PROVENANCE.md).

The optional `rsp_antenna` frontend is included for installations with the existing antenna-switcher backend. The dock reuses its shared selection and labels. This UI change does not install the antenna backend or alter profiles, SDR drivers, or antenna permissions.

With the updated ALE integration installed, choosing a RIG mode, typed frequency, step button or stock Scan waits for the server ALE scanner to stop before changing reception. A footer control shows current ALE scan status and provides Stop even when output is collapsed. Direct native controls outside those RIG actions remain separate. A refused or timed-out scanner Stop cancels the manual RIG action.

## Apply the UI to an existing OWRX installation

Clone this branch on the receiver:

```bash
git clone --branch ale-scanlists https://github.com/K2AAM/openwebrx-k2aam.git
cd openwebrx-k2aam
```

For an already installed RIG Dock 0.1.0–0.3.1 (run `git pull --ff-only` first when updating an existing clone):

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
