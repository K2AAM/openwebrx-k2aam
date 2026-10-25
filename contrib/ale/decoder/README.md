# Experimental receive-only 2G ALE decoder 0.1.0

This C++17 executable adapts the KiwiSDR/gr-ale decoder core to a standalone streaming process. No GNU Radio, FFTW or Kiwi installation is required. It accepts 8 kHz mono signed 16-bit little-endian PCM on stdin and produces JSON Lines on stdout. It has no transmit or radio-control function. See NOTICE.md and LICENSE for provenance.

## Build and decode a file

```bash
make -C contrib/ale/decoder
python3 contrib/ale/decoder/decode_file.py recording-8k.wav --frequency-hz 7102000
```

The WAV helper validates mono, 8 kHz, 16-bit PCM before sending any samples. If conversion is needed, ffmpeg can create that format:

```bash
ffmpeg -i recording.wav -ac 1 -ar 8000 -c:a pcm_s16le recording-8k.wav
```

The frequency argument labels the recorded signal; it does not tune hardware. The native OWRX integration supplies this label from its listening frequency. A native channel change restarts the decoder, resets acquisition and partial words, and rejects buffered events tagged with the previous channel.

## Reference test

```bash
python3 contrib/ale/decoder/fetch_test_audio.py
python3 -m unittest discover -s contrib/ale/tests -v
```

The upstream reference audio produces an AMD message containing `THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG` and a THIS WAS sounding with source `BAS`. These are independent expected values from a reference waveform, rather than a transmitter/receiver loopback built from the same constants. The test audio is downloaded only when requested and its SHA-256 must match.

Tests also exercise 30 seconds each of silence, deterministic white noise and a single tone, wrong sample rate, partial-block EOF, truncated samples, WAV validation, event parsing, rejection of stale channel output, and installer rollback/restoration. This small set does not establish weak-signal performance or a general false-positive rate.

The JSON `kind` distinguishes `activity` from `decode`. Decodes include event, source, destination, display text, channel frequency in Hz and time into the input stream. An address can be empty when it was not recovered; no identity is inferred from a later packet. The native parser adds receipt time in UTC. Legacy decoder vote metrics in display text are not presented as measured SNR or a calibrated bit-error rate.

## Status

Implemented: decoder executable, file helper, OWRX feature detection, USB mode, 8 kHz secondary DSP chain, channel-reset handling and a bounded native message panel that is adopted by RIG Dock's shared tray. The mode is hidden unless `owrx-ale --version` succeeds.

The native browser scanner uses activity events for hold/resume; see ../README.md. Not implemented: 3G ALE, unattended backend scanning, transmit/link establishment, station-directory lookups or weak-signal qualification. The 45-channel JSON/CSV catalog is in the parent directory.

Native pycsdr process handling and RF decoding must still be checked on a receiver. Local reference-audio, parser and browser tests do not replace that check.
