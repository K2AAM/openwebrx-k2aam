# Decoder provenance and changes

The receive decoder in `vendor/decode_ff_impl.cpp`, `decode_ff_impl.h` and `decode_ff.h` is adapted from KiwiSDR's ALE_2G extension:

https://github.com/jks-prv/KiwiSDR/tree/master/extensions/ALE_2G

Original upstream blob IDs:

- decode_ff_impl.cpp: `754fd31160ce53d8fc8a16ee00692d478a1aeafc`
- decode_ff_impl.h: `6ad4bbf28c4e1e4174a4d097ab939f0b1a4063f2`
- decode_ff.h: `eda5ad0ee571a2604b5efde69d047388ac7d80da`
- ansi.h (KiwiSDR root): `bfc971fc63c7d1f6632cb191e8c3609885976466`

The original notices identify Milen Rangelov (2015), and earlier LinuxALE work by Charles Brain and Ilkka Toivanen (2000–2001). KiwiSDR maintainers adapted and extended that work. Original source notices are retained. The decoder is GPL-3.0-or-later; the license text is in LICENSE. OWRX integration remains covered by the repository's AGPL license.

Local changes remove the Kiwi runtime, unused FFTW allocation, Dream resampling and fixed sample-file harness. The existing sliding Fourier/Golay decoder is retained. The executable accepts already-resampled 8 kHz mono signed 16-bit little-endian PCM and emits JSON Lines. All decoder state starts initialized. Command/address accumulation and message formatting have bounds checks; EOF flushes partial output. The adapter emits activity events and decodes with a channel-frequency tag, allowing the server to reject stale events after retuning. It does not transmit.

`main.cpp`, `compat.h`, WAV helper and tests are local adapter work. A GPLv3 license is used for the decoder adapter. No code from Alex-Pennington/PC-ALE is incorporated.

The optional test audio is downloaded separately from KiwiSDR's public distribution and verified against SHA-256 `90d1a75ef48c7802fcd49c1b8273bd36dfcb97d4b35e1f1ededa45e00842815e`. It is a reference/self-test sample, not evidence of on-air reception by this project. The audio is not redistributed in the repository.
