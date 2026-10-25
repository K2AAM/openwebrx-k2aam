# ALE scanner/output-test update 0.2.0

The C++ decoder remains 0.1.0. This update adds activity transport, a browser scanner, an optional known-audio replay helper, and a backed-up upgrade path.

Validation:

- 18 local decoder/parser/installer/helper tests passed. They cover reference decoding, output before EOF on a continuing stream with trailing silence, silence/noise/single-tone negatives, bad PCM/JSON, stale frequency rejection, activity/test flags, failed upgrade rollback, original backup restoration after upgrade, and labeled test-audio forwarding into a controlled output pipe.
- 30 local scanner/catalog/native-tuning assertions passed. Scanner tests use an injected clock/tuning API to cover dwell, activity and message holds, quiet release, maximum hold, stale events, manual tuning/mode/profile/center changes, disconnect, hidden tab, cancelled in-flight tuning, retune rejection, and exact agreement with the 45-entry source catalog.
- Browser tests use native OWRX 1.2.126 HTML/UI/MessagePanel/DemodulatorPanel code with simulated RF transport. They cover scanner controls, safe default scope, native in-capture tuning, activity routing without empty rows, Stop, and cross-band config acknowledgement/ALE restoration, along with existing receiver/decoder controls.

Receiver evidence supplied during development: the installed binary passes the known reference test; the existing native parser/WebSocket/browser path displays injected decoded reference messages; process input counters show 16,000 bytes/s; a captured noise segment contains nonzero, non-full-scale PCM. Two supplied off-air recordings produce no decoder events offline. Their signal identity remains unconfirmed. None of this establishes successful off-air ALE reception or scanner performance.

The supplied Signal Wiki sample decodes independently after MP3-to-8 kHz PCM conversion. A continuing-stream check recovers its text with trailing silence before EOF, so EOF is not required for this sample. That input audio is user supplied, not redistributed in the repository.

The development environment lacks a complete RF/pycsdr stack. The replay helper's process-pipe forwarding is exercised with a controlled pipe in tests; root access to the actual service process and end-to-end native deployment still require the receiver trial. Scanner radio transport and server permission handling are simulated in browser tests. Live acquisition, channel dwell and false holds require on-air evaluation.

No receiver was accessed or restarted during development. This update does not modify receiver profiles, antenna-switcher files, RIG Dock assets, or the original plugin init. It modifies native Python/frontend files and requires a service restart and browser reload. The scanner stops when the tab is hidden; it is not an unattended backend service. 3G ALE and transmit are not implemented.
