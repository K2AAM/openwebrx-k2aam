const {GLib} = imports.gi;
const rd = f => GLib.file_get_contents(f)[1];
const src = new TextDecoder().decode(rd(ARGV[0]));
const {VoiceNR, Resampler} = new Function('var module={exports:{}};' + src + '; return module.exports;')();
const mod = new WebAssembly.Module(rd(ARGV[1]));
print('imports:', JSON.stringify(WebAssembly.Module.imports(mod).map(i => i.module + '.' + i.name)));
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
// synthetic voiced sound: 130 Hz glottal pulses through 3 formant resonators, syllables 200 ms on / 100 ms off
function voiced(sr, n) {
  const y = new Float32Array(n); const f = [[700, 80], [1200, 90], [2600, 120]];
  const st = f.map(() => [0, 0]);
  for (let i = 0; i < n; i++) {
    const t = i / sr, on = (t % 0.3) < 0.2;
    const pitch = 120 + 20 * Math.sin(2 * Math.PI * 1.5 * t);
    let x = on && (Math.floor(t * pitch) !== Math.floor((t - 1 / sr) * pitch)) ? 1 : 0;
    let out = 0;
    f.forEach(([fc, bw], k) => { const r = Math.exp(-Math.PI * bw / sr), c = 2 * r * Math.cos(2 * Math.PI * fc / sr);
      const v = x + c * st[k][0] - r * r * st[k][1]; st[k][1] = st[k][0]; st[k][0] = v; out += v * 0.02; });
    y[i] = out;
  }
  return y;
}
const rms = (a, s, e) => { let q = 0; for (let i = s; i < e; i++) q += a[i] * a[i]; return Math.sqrt(q / (e - s)); };
function run(sr, input, mix) {
  const v = new VoiceNR(mod, sr); v.mix = mix; const out = new Float32Array(input.length);
  const t0 = Date.now();
  for (let i = 0; i < input.length; i += 128) v.process(input.subarray(i, i + 128), out.subarray(i, i + 128), Math.min(128, input.length - i));
  return {out, ms: Date.now() - t0};
}
const sr = 48000, N = sr * 4;
const speech = voiced(sr, N), noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = 0.05 * rnd();
// 1) noise only
let r = run(sr, noise, 1);
print(`noise only: in ${(20*Math.log10(rms(noise, sr, N))).toFixed(1)} dB, out ${(20*Math.log10(rms(r.out, sr, N)+1e-12)).toFixed(1)} dB; ${r.ms} ms for 4 s of audio`);
// 2) speech + noise: delay by cross-correlation (wet only)
const mixd = new Float32Array(N); for (let i = 0; i < N; i++) mixd[i] = speech[i] + 0.3 * noise[i];
r = run(sr, mixd, 1);
let best = -1, lag = 0;
for (let L = 0; L < 2000; L++) { let c = 0; for (let i = sr; i < N - 2000; i += 2) c += r.out[i + L] * speech[i]; if (c > best) { best = c; lag = L; } }
print('total latency (queue + RNNoise) by cross-correlation:', lag, 'samples');
// SNR-ish: speech-energy correlation before/after
const corr = (a, b, off) => { let ab = 0, aa = 0, bb = 0; for (let i = sr; i < N - 2000; i++) { ab += a[i + off] * b[i]; aa += a[i + off] ** 2; bb += b[i] ** 2; } return ab / Math.sqrt(aa * bb); };
print('correlation with clean speech: noisy input', corr(mixd, speech, 0).toFixed(3), '-> RNNoise output', corr(r.out, speech, lag).toFixed(3));
// 3) blend alignment: with mix 0.5, output should equal 0.5*wet + 0.5*dry delayed; check dry path lag
r = run(sr, mixd, 0);
best = -1; let dlag = 0; for (let L = 0; L < 2000; L++) { let c = 0; for (let i = sr; i < N - 2000; i += 2) c += r.out[i + L] * mixd[i]; if (c > best) { best = c; dlag = L; } }
print('dry path (mix 0) latency:', dlag, 'samples');
// 4) 44.1 kHz path runs and stays bounded
const sr2 = 44100, N2 = sr2 * 3; const sp2 = voiced(sr2, N2);
r = run(sr2, sp2, 1); let finite = r.out.every(Number.isFinite);
print('44.1 kHz: finite', finite, 'out rms', rms(r.out, sr2, N2).toFixed(4), 'in rms', rms(sp2, sr2, N2).toFixed(4));
// 5) alignment: wet (mix 1) vs dry (mix 0) outputs must line up at lag 0
const w = run(sr, mixd, 1).out, d = run(sr, mixd, 0).out;
let bl = 0, bc = -1; for (let L = -1500; L <= 1500; L++) { let c = 0; for (let i = sr; i < N - 2000; i += 2) c += w[i + L] * d[i]; if (c > bc) { bc = c; bl = L; } }
print('wet vs dry alignment lag:', bl, 'samples (0 = aligned)');
