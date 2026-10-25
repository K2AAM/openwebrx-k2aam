# ALE receive channel banks

This is a prepared channel catalog for the proposed OWRX ALE scanner: 45 entries in four banks, provided as JSON and CSV. It does not install a decoder, start scanning, change receiver profiles, or modify the RIG UI.

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
