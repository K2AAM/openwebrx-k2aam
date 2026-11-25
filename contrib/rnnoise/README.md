# rnnoise.wasm for K2AAM NR (Voice)

`htdocs/plugins/receiver/k2aam_nr/rnnoise.wasm` is RNNoise 0.2 (xiph.org, BSD 3-clause, see
`k2aam_nr/RNNOISE-LICENSE.txt`) with its built-in default model, plus the small interface in
`k2aam_rnnoise.c`, compiled to WebAssembly. Jitsi's published builds (up to 0.2.1) still carry the
2019 model, so this one is built from the release instead.

- Source: https://github.com/xiph/rnnoise/releases/download/v0.2/rnnoise-0.2.tar.gz
  sha256 `90fce4b00b9ff24c08dbfe31b82ffd43bae383d85c5535676d28b0a2b11c0d37`
- Output: rnnoise.wasm, sha256 `b8d69759f801fa25b7324c69f0d12b7584147b2870eddae31a440223f60797ca`, no imports
- `os_support.h` stands in for a libopus header that RNNoise 0.2's portable code path includes but
  the release does not ship (only OPUS_CLEAR / OPUS_COPY / OPUS_MOVE are needed).
- Built without -ffast-math (RNNoise refuses it without FLOAT_APPROX).

## Rebuild (Debian 13)

    sudo apt install clang lld wasi-libc libclang-rt-dev-wasm32
    tar xzf rnnoise-0.2.tar.gz
    RNNOISE_SRC=$PWD/rnnoise-0.2 contrib/rnnoise/build.sh
    cp contrib/rnnoise/rnnoise.wasm htdocs/plugins/receiver/k2aam_nr/

## Test

    gjs test/k2aam_nr/rnnoise_test.js htdocs/plugins/receiver/k2aam_nr/k2aam_nr_worklet.js \
        htdocs/plugins/receiver/k2aam_nr/rnnoise.wasm

Checks noise suppression, CPU time, that the dry copy used by the strength blend lines up with
RNNoise's output (VoiceNR.DELAY, 960 samples at 48 kHz), and the 44.1 kHz resampling path.
