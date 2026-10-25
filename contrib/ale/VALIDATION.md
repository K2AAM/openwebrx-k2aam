# ALE server scanner update 0.3.0

The C++ decoder remains 0.1.0. This integration update adds a server-owned scan worker and decoder chain, operation without an attached browser, recent-message history, and a backed-up upgrade from 0.1.0/0.2.0. The browser scanner and labeled known-audio replay helper remain available.

Validation:

- 29 local Python decoder/parser/installer/helper/server tests passed. Coverage includes reference decoding, output before EOF, negative audio and protocol inputs, upgrade rollback and original backup restoration, newly patched native-file backup, background worker attachment/cleanup, callback-chain setup and partial-start cleanup, activity/quiet/max holds, stale-generation rejection, source/profile/rate changes, dynamic retune permission revocation, and status retrieval after the initiating browser object is gone.
- 30 local JavaScript scanner/catalog/native-tuning assertions passed. These cover dwell/hold behavior, local tuning, cancellation, permissions, browser lifecycle stops and exact agreement with the 45-entry source catalog.
- 180 local Chromium receiver checks passed using native OWRX 1.2.126 HTML/UI/MessagePanel/DemodulatorPanel code and simulated RF transport. New checks cover default server selection, exclusive scanner ownership, history deduplication, pagehide without a server stop request, observer reconnection and explicit Stop.
- 26 existing RIG installer/update tests passed. No RIG runtime assets were changed.
- Python compilation and JavaScript syntax checks passed. CI additionally runs address/undefined-behavior sanitizers and mobile WebKit startup checks.

Receiver evidence supplied by the operator now includes an off-air ADW sounding at 11226 kHz, followed by reports of PLA and HAW addresses. These are decoded addresses, not independently verified station locations. This evidence applies to the previously installed browser scanner; the new server DSP path still requires receiver deployment and testing. Earlier reference tests, injected panel messages and 16,000-byte/s PCM input checks alone did not establish RF decoding.

The supplied Signal Wiki sample decodes after MP3-to-8 kHz PCM conversion. A continuing-stream check recovers its text with trailing silence before EOF. That user-supplied audio is not redistributed. Two earlier off-air recordings produced no offline decoder events; their signal identity remains unconfirmed.

The development environment lacks a complete RF/pycsdr stack. Backend worker lifecycle and transport tests use simulated sources and chains; the native factory interface is checked with substituted modules. Actual SDR retuning, native resampling, no-browser reception, scanner hold performance and weak-signal behavior require the receiver trial. The provisional 250 ms settle interval is not a hardware acknowledgement. Dwell remains 3–60 seconds: 2–5-channel/second fast scanning is not implemented or measured.

Server scanning continues on tab hide/close until explicit Stop, source failure/shutdown, a profile/sample-rate/unexpected-center change, or a denied hardware retune. Native schedules remain authoritative and may change profiles after listeners leave. No scan automatically resumes after an OWRX restart. The last 250 decoded messages are retained in memory, and decodes are logged to the normal openwebrx journal with normal system retention. The optional browser scanner still stops when its tab is hidden.

No receiver was accessed or restarted during development. The installer checks and backs up native files, including connection.py, without changing profiles, RIG Dock runtime assets or plugin init. An already customized connection.py is rejected rather than overwritten. Deployment requires a service restart and browser reload. 3G ALE and transmit are not implemented.
