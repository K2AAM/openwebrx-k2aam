# Validation — RIG Dock 0.4.0

## Studio and ALE log update

- 29 installer/repair/update tests pass, including recognized 0.3.1 assets, adding the model/license files to a pre-Studio manifest, read-only checks, collisions, rollback of newly added files and original uninstall behavior.
- Seven Studio/model regression scripts pass: GUI/DSP defaults across six modes and 25 controls, presets and saved-profile isolation, speech/body/SSB comparisons, RNNoise frame buffering/mix/fallback, sticky failure/retry, and 100 actual frames through the pinned WASM binary.
- A focused Chromium run passes 13 checks. The locally served RNNoise model becomes active on nonzero receiver audio in a real 48 kHz AudioWorklet, CW falls back to classical processing, and the AudioNode prototype stays unchanged. The same run checks stations heard, malicious text escaping, real multi-page CSV download/formula escaping, Clear without log deletion, mobile width and log errors independent of scanner state.
- Existing browser routing checks additionally confirmed that opening settings leaves audio untouched and enable/bypass restores an OfflineAudioContext signal with zero measured sample difference. This routing comparison substitutes the processor stage and does not measure NR quality.
- A just-changed native mode is synchronized when enabling, so its own saved profile/preset is used. Explicit detach restores the native direct connection, disconnects source branches and tells the worklet to dispose of neural state.
- CI runs the full receiver suite and mobile WebKit startup alongside these checks. Consult the published commit's workflow result for the current full-suite count. The local serverless Chromium runtime had intermittent navigation/download failures before its matching NSS libraries were supplied; the focused run uses those libraries. These runtime failures are not counted as passing tests.

The full physical Airspy/SDRplay listening comparison remains unperformed. RNNoise requires a 48 kHz browser context, secure AudioWorklet and spoken AM/SSB; it can remove weak speech or non-speech content. Unsupported rates/modes and model failure retain classical NR. Processing defaults to bypass; native decoder input and recording remain separate. Browser/model tests prove execution and routing, not better intelligibility on received HF speech.

## Earlier 0.3.1 regression evidence

The 0.3.0 build reproduces the reported Screenshot-plugin clipping with the unmodified upstream Screenshot source: it wraps both native and dock Record controls into 2rem boxes, creates duplicate PIC ids, and binds only the first PIC node. Version 0.3.1 adopts that original node/handler, removes the unbound dock duplicate, unwraps the dock Record control and restores stock PIC metadata/location during teardown.

Regression coverage loads the actual upstream plugin before and after dock mount, verifies one PNG download per pointer/keyboard activation, original-node preservation and stock fallback, active Record label width and audio-recording permission. Layout checks cover a receiver with no antenna controls at 1918×900, 1024×768, 390×844 and 375×667. The html2canvas renderer is substituted with a deterministic canvas; its rendering quality and RF reception are outside this test. See test/browser/fixtures/README.md for provenance.


The ale-scanlists update adds compact sounding rows/raw details, matching header/data columns, responsive two-line phone rows and Fit sizing. Record/More move to the main row. Frequency entry has an explicit unit selector and a readout click handler that intercepts the native inline editor while leaving wheel handling intact. ALE-aware RIG actions wait for Stop before taking control; scan preferences restore without starting a scan. These behaviors are included in the current browser suite. The click regression uses representative native digit markup and a competing click listener; physical receiver/browser checks remain required.

- **209 Chromium browser checks passed for 0.3.1.** The fixture uses this fork's native 1.2.126 HTML, UI, Modes, DemodulatorPanel, MessagePanel, JS8 threader, MetaPanel, Waterfall, plugin loader, panel visibility/animation functions, and delayed demodulator restart. The upstream starting commit is `1bea2c93b77493f5c5bc897ab9a603e85b5aad4b`.
- **26 installer/repair/update tests passed for 0.3.1.** These cover read-only checks, supported installation layouts, file modes, guarded Studio metadata reads, rejecting actual custom API calls, asset collisions and edits, install/uninstall round trips, later init additions, rollback, and upgrades from 0.1.0/0.1.1/0.1.2/0.1.3/0.2.0/0.2.1/0.3.0. Updates verify both JavaScript and CSS against the packaged assets and preserve uninstall support.
- The new mobile cold-load case reproduces the 0.2.0 readiness bug: the waterfall canvas exists while modes/features and profile data are still missing. The old implementation fails this regression. Checks now delay the stylesheet and deliver config, modes/features, and profiles independently in two orders; the first visible dock frames contain the selected frequency/profile. They also cover a separately positioned full-width decoder tray, isolation from native receiver transforms, teardown, and stock-control recovery after a stylesheet failure.
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
npx playwright install --with-deps chromium webkit
npm run test:receiver
npm run test:startup:webkit
```

The optional `CHROMIUM_EXECUTABLE_PATH` and JSON `PLAYWRIGHT_CHROMIUM_ARGS` environment variables support environments with an existing Chromium binary. The default uses Playwright's installed Chromium. `.github/workflows/receiver-ui.yml` provides the same syntax, Python and Chromium checks, plus the mobile startup cases under Playwright WebKit. Linux WebKit automation is not a physical iPhone Safari test.

## Receiver verification remaining

Earlier receiver tests exposed the first-load 0 Hz/empty-profile state and shifted tray. Adam subsequently reported the 0.3.1 Record/Screenshot layout fix working. The new 0.4.0 Studio integration still needs an operator listening trial. Complete live reception, decoder switching, collapsed output, image updates, recording playback and tuning outside the current profile on both receivers. No remote receiver was accessed or modified during development.

The UI reuses an existing shared antenna backend when present. Its selected-property indication is not a separate hardware acknowledgment. This change does not write receiver profiles, SDR drivers, antenna settings or server FFT configuration.
