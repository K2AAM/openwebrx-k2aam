# Experimental ALE 2G receiver and channel banks

This directory now contains an experimental receive-only 2G ALE decoder and native OWRX integration, plus a 45-entry channel catalog in four banks. The decoder operates on one channel at a time. The experimental browser scanner steps through enabled bank entries and holds on decoder activity. Receiver profiles and RIG Dock assets are not changed by the ALE installer.

## Receiver trial on stock OWRX+ 1.2.126

Build on the receiver so the binary matches its CPU architecture. In this fork's `ale-scanlists` branch:

```bash
make -C contrib/ale/decoder
sudo /usr/bin/python3 contrib/ale/install.py --check
sudo /usr/bin/python3 contrib/ale/install.py --install
sudo systemctl restart openwebrx
```

The check is read-only and requires unmodified versions of the seven native files it patches. The installer refuses edited/unsupported files and existing decoder assets, saves backups, preserves file modes and rolls back failed writes. It does not restart the service. This backend change requires the explicit restart shown above. A versioned receiver bundle URL makes the updated native UI available after reloading the page.

If necessary, supply `--owrx-root /usr/lib/python3/dist-packages/owrx` and `--htdocs /usr/lib/python3/dist-packages/htdocs`. The Python root must have sibling `owrx` and `csdr` packages. Backups/state are in `/var/lib/openwebrx/ale2g` and the executable installs to `/usr/local/bin/owrx-ale`.

## Upgrade an existing 0.1.0 ALE installation

```bash
git switch ale-scanlists
git pull --ff-only
make -C contrib/ale/decoder
sudo /usr/bin/python3 contrib/ale/install.py --check
sudo /usr/bin/python3 contrib/ale/install.py --upgrade
sudo systemctl restart openwebrx
```

The upgrade checks every installed hash and original backup before writing. It preserves the original stock-file backups so uninstall still restores the pre-ALE installation. Edited files stop the upgrade. Refresh the receiver after restart. The native receiver bundle and new scanner script use `ale=0.2.0` cache keys; the decoder executable remains version 0.1.0 because its demodulation code is unchanged.

## Reference audio in the actual OWRX message panel

Stop scanning, select **ALE 2G (experimental)**, keep the browser page open, and do not tune during the test. First fetch the pinned reference sample:

```bash
/usr/bin/python3 contrib/ale/decoder/fetch_test_audio.py
sudo /usr/bin/python3 contrib/ale/live_test.py --pid "$(pgrep -x owrx-ale)"
```

This helper requires exactly one PID (or pass the desired PID explicitly if there are multiple ALE listeners). It starts a separate installed decoder, streams the reference PCM at real-time speed with five seconds of trailing silence, and forwards clearly labeled `[TEST AUDIO]` results into that listener's native parser/WebSocket/panel. Expect `THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG` and source `BAS`. The real receiver audio is not replaced, mixed with the test, or transmitted. No service restart is needed for the test itself.

To use the Signal Wiki MP3 or another recording already on the receiver instead:

```bash
sudo /usr/bin/python3 contrib/ale/live_test.py --pid "$(pgrep -x owrx-ale)" --audio /home/k2aam/2G_ALEaudio.mp3
```

MP3/WAV file conversion uses the receiver's `ffmpeg`; the pinned AU reference needs only Python. Files are limited to three minutes. Root is needed to inspect and open the service process's output pipe. The helper verifies the executable and session identity, stops if the live decoder restarts/tunes, and labels all test events. The updated scanner stops when test events arrive. This is a decoder/output-path test: it does **not** validate the SDR RF input, native resampling, or float-to-PCM conversion. Browser rows may also contain concurrent real receptions, which do not have the test label. Clear the test rows before monitoring.

## Using the ALE scanner

After restarting, select **ALE 2G (experimental)** from Modes. The scanner controls are inside its native message panel/shared decoder tray, separate from the stock RIG **Scan** button.

1. Expand **ALE scanner**, then select HFN, HFL, COTHEN candidates, or HFGCS candidates. On a small phone, increase the decoder tray Height to make room for the controls.
2. Expand **Channels / skip** to uncheck unwanted entries.
3. Leave shared retuning unchecked to scan only entries whose entire USB passband fits inside the current SDR capture. A narrow capture may contain only one bank entry, or none.
4. For a dedicated receiver or an owner-authorized shared receiver, explicitly check **Retune shared SDR across bands — affects EVERY listener**. This uses the same native `setfrequency` request and magic-key/server permissions as manual out-of-capture tuning. It does not bypass permissions or alter profiles.
5. Start with a **10-second dwell** and click **Start ALE scan**. Dwell is adjustable from 3–60 seconds and is experimental, not a validated optimum.

The scanner shows tuning/scanning/activity/decoded/stop status. It holds on decoder synchronization/activity, not waterfall signal strength, then resumes three seconds after activity ends. A decoded message also extends the idle hold. A 120-second maximum hold prevents a stuck activity flag from holding forever; a longer exchange can be cut off at that limit. Acquisition resets through the existing native decoder restart on each frequency change. Channels are integer USB dial frequencies, with no audio-frequency offset.

Scanning stops on Stop, manual frequency/mode/profile/source-center change, disconnect, hidden browser tab, failed tuning or a ten-second retune timeout. Keep the receiver tab visible; this is a browser scanner, not an unattended server-side scanner. An already-sent hardware retune cannot be recalled by Stop. No scanning state is automatically restored on reload. The stock signal-level scanner is stopped when ALE scanning starts; do not run both simultaneously.

The optional utility frequencies are historical monitoring candidates, not verified current assignments or guaranteed activity. User observations are still needed to choose a productive subset and dwell. First confirm a recognizable off-air decode before relying on hold/resume performance. **3G ALE is not implemented.**

To restore stock native files, run `sudo /usr/bin/python3 contrib/ale/install.py --uninstall`, then restart openwebrx and reload the page. Later edits stop restoration before any writes. When running the fork itself, its native source already has the integration: build/install the executable and restart the fork; do not run this patch installer against its own checkout.

See [decoder/README.md](decoder/README.md) for file decoding, tests, provenance and limitations.

The JSON is a project catalog, not an OWRX bookmark-import file. The CSV is a portable reference. JSON frequencies are integer hertz; CSV also includes kilohertz. Every entry uses a USB dial/carrier frequency, with no extra audio-frequency offset.

## Banks

| Bank | Entries | Intended use | Starting selection |
| --- | ---: | --- | --- |
| Amateur HFN — US HF | 9 | Soundings and text | Default |
| Amateur HFL — US HF | 11 | Calling | Optional |
| COTHEN | 15 | Monitoring candidates | Optional |
| HFGCS ALE | 10 | Monitoring candidates | Optional |

The amateur entries are HF ALE rows in the USA column of the [HFLINK matrix](https://hflink.com/channels/), whose stated effective date is July 15, 2019. HFN is the starting bank for periodic soundings; HFL is the calling bank and is configured without automatic sounding. HFN priority flags reflect the source's NET+ marks. SEL/Selcall rows and LF/VHF/UHF entries are excluded.

The optional utility banks come from the [KiwiSDR ALE net list](https://github.com/jks-prv/KiwiSDR/blob/master/web/extensions/ALE_2G/ALE_nets.cjson). Its frequencies are aggregated and may be incorrect, incomplete, or obsolete. They are listening candidates, not verified current assignments. The JSON records the source blob SHA and review date. None of these channels has been live-verified for this catalog.

## Initial HFN bank

| Band | USB dial, kHz |
| --- | ---: |
| 160m | 1843.0 |
| 80m | 3596.0 |
| 40m | 7102.0 |
| 30m | 10145.5 |
| 20m | 14109.0 |
| 17m | 18106.0 |
| 15m | 21096.0 |
| 12m | 24926.0 |
| 10m | 28146.0 |

The source's 15-second calling/preamble duration is not a scanner dwell setting. Timing needs to be measured with the receiver and decoder, particularly when hardware retuning is required.

## Remaining scanner work

The first scanner runs in a visible browser tab, with explicit opt-in shared retuning. Server-side unattended operation, heard-station history, custom-channel editing, export, and validated weak-signal/dwell behavior remain future work. Stock OWRX bookmark Scanner remains separate and does not automatically load this catalog.

## Maintenance

Maintain channel data independently of decoder code. Preserve sources and dates, keep published channel plans separate from monitoring candidates, and store actual reception observations separately. Duplicate frequencies within a bank are rejected; the same frequency in different networks can remain separate.

After live checks, enable the useful subset for each location and antenna. A published channel does not guarantee reception at a particular time.
