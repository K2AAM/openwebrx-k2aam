# ALE 2G prototype 0.1.0 validation

Completed locally:

- 12 decoder, protocol and installer tests passed. The external SHA-256-pinned Kiwi reference waveform yields the expected AMD text and BAS sounding address. The same cases pass with AddressSanitizer and UndefinedBehaviorSanitizer. Leak detection was disabled because the development process environment cannot support LeakSanitizer.
- Thirty seconds each of silence, deterministic noise and a single 1 kHz tone produce no decoded messages in these tests. This is a small negative set, not a measured false-positive rate or weak-signal qualification.
- EOF, partial blocks, odd PCM byte count, incorrect sample rate, invalid JSON, oversized events and old-channel results are exercised. The WAV helper rejects the wrong format before decoding.
- Installer checks are read-only; installation/restoration preserve bytes and file modes in temporary fixtures. Edited-file rejection, failed-write rollback, and refusing later-edited files on uninstall are covered.
- 168 Chromium receiver checks passed. The native ALE mode/panel joins the shared decoder tray, preserves the decoded source and exact dial frequency, escapes radio-supplied text, and uses the tray's Clear action. Existing receiver controls and 32 other mode variants remain covered.
- Modified Python and JavaScript files passed syntax checks.

The standalone prototype genuinely demodulates the reference audio. Receiver DSP input and transport in browser tests are simulated. The development environment does not have a complete SDR/pycsdr stack. Native process creation/restart, PCM routing, service permissions, and live RF performance must be confirmed on the receiver before describing the integration as production-ready.

No receiver was accessed or restarted during development. The ALE installer touches no profiles, antenna backend, receiver plugin init or RIG Dock assets. It does change native receiver/Python files and requires a service restart after installation or restoration.

Automatic scan-bank selection/hold/resume and 3G ALE are not implemented. The provided channels are receive candidates; their presence in a catalog does not prove current activity or reception.
