# Validation — RIG Dock 0.2.0

## Completed locally

- **145 Chromium browser checks passed.** The fixture uses this fork's native 1.2.126 HTML, UI, Modes, DemodulatorPanel, MessagePanel, JS8 threader, MetaPanel, Waterfall, plugin loader, panel visibility/animation functions, and delayed demodulator restart. The upstream starting commit is `1bea2c93b77493f5c5bc897ab9a603e85b5aad4b`.
- **26 installer/repair/update tests passed.** These cover read-only checks, supported installation layouts, file modes, guarded Studio metadata reads, rejecting actual custom API calls, asset collisions and edits, install/uninstall round trips, later init additions, rollback, and upgrades from 0.1.0/0.1.1/0.1.2/0.1.3. Updates verify both JavaScript and CSS against the packaged assets and preserve uninstall support.
- The browser suite checks native decoder visibility through **32 mode variants** across WSJT, JS8, packet/AIS, paging, aeronautical data, ADS-B, ISM, DSC, image, skimmer, mesh, text and radio-metadata panel families. The tray implementation uses native panel classes rather than this fixture's test mode list.
- Native decoded callsign links, scrolling, Clear handlers, JS8 threads, escaped text output and cursor retention are exercised. Native SSTV and fax scanline updates render into retained canvases; output continues while collapsed. Switching to an analog mode settles native collapse flags. New decoder panels are adopted dynamically, and teardown restores existing nodes without recreating a panel removed by its owner.
- Recording uses native `UI.toggleRecording`, `AudioEngine.startRecording/stopRecording`, `AudioRecorder`, the bundled LAME encoder, and the browser download event. A synthetic two-second tone produces an MP3 with native filename and MPEG frame bytes. The test also verifies the server's recording-disable flag still prevents recording.
- Frequency checks cover Hz/kHz/MHz and unitless MHz, Enter submission, local tuning without changing the shared SDR, one native request with the current magic key, waiting for the native demodulator restart, retaining decoder/underlying mode, disabled tuning, a real-time timeout, cancellation, late acknowledgments, invalid input and disconnects.
- The receiver loader starts the dock before station init. An Optiplex-style async Studio loader remains safe, other plugins load, and map initialization does not load the receiver dock.
- Layout checks cover **1440×900, 1024×768, 390×844, 375×667, and 844×390**. They check overflow, menu bounds, reserved waterfall space, decoder/dock boundaries and the phone's default full-width results. Desktop and phone screenshots were visually inspected.
- Existing audio bypass/routing regressions are retained. Processor stages are stubbed only in the OfflineAudioContext routing comparison; that check does not validate DSP quality.

Receiver DSP, RF samples and websocket transport are simulated. Browser tests use native decoder renderers, but do not prove decoding quality or hardware tuning on a physical SDR. Native recorder encoding/download is exercised independently of live received audio.

## Reproduce

From the repository root:

```bash
python3 -m unittest discover -s contrib/rig_dock/tests -v
npm ci --ignore-scripts
npx playwright install chromium
npm run test:receiver
```

The optional `CHROMIUM_EXECUTABLE_PATH` and JSON `PLAYWRIGHT_CHROMIUM_ARGS` environment variables support environments with an existing Chromium binary. The default uses Playwright's installed Chromium. `.github/workflows/receiver-ui.yml` provides the same syntax, Python and browser checks on GitHub Actions.

## Receiver verification remaining

Apply the UI assets to both the SDRplay and Airspy installations, reload their pages, and confirm live reception, decoder switching, collapsed output, image updates, recording playback and a supported frequency outside the current profile. Check Safari on a phone as well as desktop. These changes have not been deployed to either receiver during development.

The UI reuses an existing shared antenna backend when present. Its selected-property indication is not a separate hardware acknowledgment. This change does not write receiver profiles, SDR drivers, antenna settings or server FFT configuration.
