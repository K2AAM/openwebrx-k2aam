# Receiver UI roadmap

## Implemented on k2aam-ui

- Compact RIG Dock and status footer, with modes and waterfall controls.
- Shared decoder tray above the RIG controls for all native decoder-panel families, including text, image, secondary FFT and radio metadata panels.
- Adjustable height, collapse while processing continues, preserved native links/handlers, and restoration to stock controls.
- Frequency entry outside the current profile through OWRX's native receiver request.
- Record button compatibility with native recording visibility and server permissions.
- In-place upgrade from dock versions 0.1.0–0.1.3, with backups and uninstall support.

The ale-scanlists branch adds RIG Dock 0.3.0: compact top-row Record/More controls, clickable frequency entry with explicit units, ALE Stop/manual-control handoff and Fit sizing for compact ALE rows. The ALE installer now preserves the recognized antenna connection hook and browser scan preferences survive reload. Persistent station history, service-start resume, fault recovery and AGC presets remain follow-up work.

## Receiver verification

Verify the branch against both the SDRplay remote receiver and the Optiplex Airspy receiver. Exercise decoder switching, phone layout, SSTV/fax image updates, collapsed processing, downloaded recordings, and a frequency outside the current profile. Browser tests simulate receiver transport and do not validate RF decoding quality.

## Next project: ALE decoder

An experimental receive-only 2G ALE prototype is in contrib/ale: a standalone decoder adapted from KiwiSDR/gr-ale, reference-audio tests, native USB mode/DSP integration, a message panel adopted by the shared tray, and a backed-up installer for stock 1.2.126. The 45-channel catalog contains HFN, HFL and optional COTHEN/HFGCS candidates. Experimental bank scanning now includes a server-owned decoder, operation with the tab closed, recent-message history, decoder-activity hold and explicit cross-band tuning opt-in. A live ADW sounding has been reported; server deployment, fast scanning, wider RF qualification and 3G decoding remain pending. See contrib/ale/decoder/README.md for scope and limitations.

## Upstream maintenance

The fork is K2AAM/openwebrx-k2aam, based on luarvique/openwebrx. UI work lives on k2aam-ui; master remains the upstream baseline. The starting commit is 1bea2c93b77493f5c5bc897ab9a603e85b5aad4b (1.2.126). Retain upstream attribution and licenses, keep receiver-specific secrets/configuration out of the repository, and review upstream changes before updating deployed receivers.
