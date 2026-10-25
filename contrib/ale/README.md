# Experimental ALE 2G receiver and channel banks

This directory now contains an experimental receive-only 2G ALE decoder and native OWRX integration, plus a 45-entry channel catalog in four banks. The decoder operates on one selected channel. Automatic scan-bank control is still future work. Receiver profiles and RIG Dock assets are not changed by the ALE installer.

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

After restarting, select **ALE 2G (experimental)** from Modes and tune a USB dial frequency below. The message panel uses the existing shared decoder tray. Start with one channel and confirm recognizable output before attempting any scanning. Recordings are useful for repeatable comparisons.

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

## Scanner behavior to implement

Start with a selected bank and user Start/Stop controls. Default to channels whose entire USB passband fits within the current SDR capture. Tune the listener's demodulator in this mode, and show entries outside the capture instead of moving the shared hardware automatically.

An optional full-list scanner needs explicit control of a dedicated SDR source, or owner-controlled shared-source tuning. Crossing HF bands can move the hardware capture for other listeners. Loading this catalog must not enable that behavior.

Hold a channel on decoder synchronization/activity through a complete ALE exchange, then resume after a configurable idle period. A signal-strength threshold alone can stop on unrelated signals or noise. Determine dwell, acquisition delay and maximum hold from recorded-signal and receiver tests; this catalog contains no validated timing settings.

Log UTC, dial frequency, bank, source/destination addresses, event, message and quality indicators where available. Support heard-station history, channel enable/skip, custom entries and export. Retuning must reset acquisition so samples and partial words from different channels cannot mix.

OWRX 1.2.126's stock Scanner uses current-waterfall FFT levels and scannable bookmarks. It does not supply full-HF tuning or ALE-specific activity/hold logic. Decoder and scanner integration remain separate implementation work.

## Maintenance

Maintain channel data independently of decoder code. Preserve sources and dates, keep published channel plans separate from monitoring candidates, and store actual reception observations separately. Duplicate frequencies within a bank are rejected; the same frequency in different networks can remain separate.

After live checks, enable the useful subset for each location and antenna. A published channel does not guarantee reception at a particular time.
