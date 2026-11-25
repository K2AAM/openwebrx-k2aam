#!/bin/sh
# Build rnnoise.wasm (RNNoise 0.2 + k2aam_rnnoise.c) with Debian's clang/lld/wasi-libc.
set -e
SRC=${RNNOISE_SRC:?set RNNOISE_SRC to the extracted rnnoise-0.2 directory}
OUT=${1:-rnnoise.wasm}
cd "$(dirname "$0")"
FILES="denoise.c rnn.c pitch.c kiss_fft.c celt_lpc.c nnet.c nnet_default.c parse_lpcnet_weights.c rnnoise_data.c rnnoise_tables.c"
set --
for f in $FILES; do set -- "$@" "$SRC/src/$f"; done
clang --target=wasm32-wasi --sysroot=/usr -O3 -msimd128 \
  -DRNNOISE_BUILD -I. -I"$SRC/include" -I"$SRC/src" \
  -mexec-model=reactor -Wl,--strip-all -Wl,-z,stack-size=262144 \
  -o "$OUT" k2aam_rnnoise.c "$@"
ls -l "$OUT"
