// Offline tests for the K2AAM NR worklet DSP.
// Usage: node test/k2aam_nr/test.js htdocs/plugins/receiver/k2aam_nr/k2aam_nr_worklet.js [calibrate]
'use strict';
const path = require('path');
const { SpectralNR, FFT } = require(path.resolve(process.argv[2]));
const FS = 48000;

// deterministic gaussian noise
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; }
function gauss() { return Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()); }

// band-limit noise to roughly an SSB passband (300-3000 Hz) with a brick-wall FFT filter
function bandNoise(n, lo, hi, rms) {
    const size = 1 << Math.ceil(Math.log2(n));
    const fft = new FFT(size), re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = gauss();
    fft.transform(re, im, false);
    for (let k = 0; k < size; k++) {
        const f = (k <= size / 2 ? k : size - k) * FS / size;
        if (f < lo || f > hi) { re[k] = 0; im[k] = 0; }
    }
    fft.transform(re, im, true);
    const out = new Float64Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) { out[i] = re[i] / size; p += out[i] * out[i]; }
    const g = rms / Math.sqrt(p / n);
    for (let i = 0; i < n; i++) out[i] *= g;
    return out;
}

function run(nr, input, inputR) {
    const n = input.length, out = new Float64Array(n), outR = inputR ? new Float64Array(n) : null;
    for (let i = 0; i + 128 <= n; i += 128) {
        nr.process(input.subarray(i, i + 128), inputR ? inputR.subarray(i, i + 128) : null,
                   out.subarray(i, i + 128), outR ? outR.subarray(i, i + 128) : null, 128);
    }
    return outR ? [out, outR] : out;
}

const db = (x) => 10 * Math.log10(x);
function power(x, from, to) { let p = 0; for (let i = from; i < to; i++) p += x[i] * x[i]; return p / (to - from); }
// power of the component of x at frequency f between from..to (coherent projection)
function tonePower(x, f, from, to) {
    let c = 0, s = 0;
    for (let i = from; i < to; i++) { c += x[i] * Math.cos(2 * Math.PI * f * i / FS); s += x[i] * Math.sin(2 * Math.PI * f * i / FS); }
    const n = to - from;
    return 2 * (c * c + s * s) / (n * n);
}

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
    if (!ok) failures++;
}

if (process.argv[3] === 'calibrate') {
    // Measure how far below the true mean the noise tracker settles on noise.
    for (const profile of ['normal', 'beacon']) {
        seed = 12345;
        const nr = new SpectralNR(FS, profile);
        nr.bias = 1;
        const n = FS * 30, x = bandNoise(n, 300, 3000, 0.1);
        const hz = FS / nr.size, k0 = Math.round(600 / hz), k1 = Math.round(2700 / hz);
        let sumNoise = 0, sumPower = 0;
        const out = new Float64Array(128);
        for (let i = 0; i + 128 <= n; i += 128) {
            nr.process(x.subarray(i, i + 128), null, out, null, 128);
            if (i > FS * 5 && (i + 128) % nr.hop === 0) {
                for (let k = k0; k < k1; k++) { sumNoise += nr.noise[k]; sumPower += nr.power[k]; }
            }
        }
        console.log(profile + ' bias = ' + (sumPower / sumNoise).toFixed(2));
    }
    process.exit(0);
}

// Speech-like test signal: a harmonic source with gliding pitch and formant
// weighting, in syllables with pauses, including one long steady vowel in ten.
function speechLike(n, rms) {
    const y = new Float64Array(n);
    const formant = (f) => 1 / (1 + ((f - 600) / 250) ** 2) + 0.7 / (1 + ((f - 1400) / 300) ** 2) + 0.4 / (1 + ((f - 2500) / 350) ** 2);
    let ph = 0, t0 = 0, f0 = 120, f1 = 140, dur = 0.2, gap = 0.1, count = 0;
    for (let i = 0; i < n; i++) {
        if (i / FS - t0 > dur + gap) {
            t0 = i / FS; count++;
            const steady = count % 10 === 0;
            f0 = 100 + 60 * rnd(); f1 = steady ? f0 : f0 * (0.85 + 0.3 * rnd());
            dur = steady ? 0.7 : 0.12 + 0.2 * rnd(); gap = 0.04 + 0.15 * rnd();
        }
        const t = i / FS - t0;
        if (t < dur) {
            const f = f0 + (f1 - f0) * t / dur + 1.5 * Math.sin(2 * Math.PI * 5 * t);
            ph += 2 * Math.PI * f / FS;
            let v = 0;
            for (let h = 1; h * f < 3000; h++) v += formant(h * f) * Math.sin(h * ph);
            y[i] = v * Math.min(1, t / 0.01, (dur - t) / 0.02);
        }
    }
    let p = 0;
    for (let i = 0; i < n; i++) p += y[i] * y[i];
    const g = rms / Math.sqrt(p / n);
    for (let i = 0; i < n; i++) y[i] *= g;
    return y;
}
// gain (dB) of the known clean signal within the output, allowing for the delay
function keptDb(y, clean, latency, from, to) {
    let num = 0, den = 0;
    for (let i = from; i < to; i++) { const c = clean[i - latency]; num += y[i] * c; den += c * c; }
    return 20 * Math.log10(num / den);
}

const SEC = FS;
const settle = 4 * SEC;      // ignore the first seconds while the tracker settles

// 1. Reconstruction: with the gain forced to 1 the output must equal the delayed input.
{
    const nr = new SpectralNR(FS);
    nr.updateGain = function () { this.gain.fill(1); };
    const n = 2 * SEC, x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = gauss() * 0.1;
    const y = run(nr, x);
    let err = 0, ref = 0;
    for (let i = nr.latency + 4096; i < n - 256; i++) { const d = y[i] - x[i - nr.latency]; err += d * d; ref += x[i - nr.latency] ** 2; }
    check('reconstruction', db(err / ref) < -100, 'error ' + db(err / ref).toFixed(0) + ' dB, latency ' + (nr.latency / FS * 1000).toFixed(0) + ' ms');
}

for (const strength of [0.25, 0.5, 1.0]) {
    console.log('\n--- strength ' + strength + ' ---');
    const n = 12 * SEC;

    // 2. Noise only
    {
        const nr = new SpectralNR(FS); nr.setStrength(strength);
        const x = bandNoise(n, 300, 3000, 0.1), y = run(nr, x);
        const red = db(power(x, settle, n) / power(y, settle, n));
        const max = 6 + 18 * strength;
        check('noise-only reduction', red > max - 2 && red < max + 0.5, red.toFixed(1) + ' dB (floor allows ' + max.toFixed(0) + ' dB)');
    }

    // 3. Weak steady carrier (beacon) 15 dB below the noise in a 2.7 kHz passband
    {
        const nr = new SpectralNR(FS); nr.setStrength(strength);
        const x = bandNoise(n, 300, 3000, 0.1), f = 1020;
        const amp = Math.sqrt(2 * 0.01 * Math.pow(10, -15 / 10));
        const noiseOnly = Float64Array.from(x);
        for (let i = 0; i < n; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / FS);
        const y = run(nr, x);
        const tIn = tonePower(x, f, settle, n), tOut = tonePower(y, f, settle, n);
        const nIn = power(noiseOnly, settle, n), nOut = power(y, settle, n) - tOut;
        const gainSnr = db(tOut / nOut) - db(tIn / nIn);
        const need = strength < 0.4 ? 2 : strength < 0.8 ? 5 : 9; // scaled to the floor at each strength
        check('weak carrier: SNR improved ' + need + ' dB+', gainSnr > need, 'carrier ' + db(tOut / tIn).toFixed(1) + ' dB, SNR ' + db(tIn / nIn).toFixed(1) + ' -> ' + db(tOut / nOut).toFixed(1) + ' dB (' + (gainSnr >= 0 ? '+' : '') + gainSnr.toFixed(1) + ')');
        // must still be there late in the run (not learned as noise)
        const late = db(tonePower(y, f, n - 2 * SEC, n) / tonePower(x, f, n - 2 * SEC, n));
        check('carrier not learned as noise', late > -12, 'last 2 s: ' + late.toFixed(1) + ' dB');
    }

    // 4. Strong carrier 10 dB above the noise must pass essentially untouched
    {
        const nr = new SpectralNR(FS); nr.setStrength(strength);
        const x = bandNoise(n, 300, 3000, 0.1), f = 800;
        const amp = Math.sqrt(2 * 0.01 * 10);
        for (let i = 0; i < n; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / FS);
        const y = run(nr, x);
        const d = db(tonePower(y, f, settle, n) / tonePower(x, f, settle, n));
        check('strong carrier untouched', Math.abs(d) < 0.5, d.toFixed(2) + ' dB');
    }

    // 5. Keyed tone (Morse-like, 100 ms on / 100 ms off) 6 dB below noise: measure during key-down
    {
        const nr = new SpectralNR(FS); nr.setStrength(strength);
        const x = bandNoise(n, 300, 3000, 0.1), f = 700;
        const amp = Math.sqrt(2 * 0.01 * Math.pow(10, -6 / 10));
        const clean = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const on = Math.floor(i / (0.1 * FS)) % 2 === 0;
            clean[i] = on ? amp * Math.sin(2 * Math.PI * f * i / FS) : 0;
            x[i] += clean[i];
        }
        const y = run(nr, x);
        // correlate output against the delayed clean signal
        let num = 0, den = 0;
        for (let i = settle; i < n; i++) { const c = clean[i - nr.latency]; num += y[i] * c; den += c * c; }
        const d = 20 * Math.log10(num / den);
        check('keyed tone kept', d > -6, d.toFixed(1) + ' dB');
    }
}

// 6. Noise level step: how long until a +12 dB jump in noise is brought back under control
{
    console.log('');
    const nr = new SpectralNR(FS); nr.setStrength(0.5);
    const n = 14 * SEC, x = bandNoise(n, 300, 3000, 0.05);
    for (let i = 6 * SEC; i < n; i++) x[i] *= 4;
    const y = run(nr, x);
    let t = -1;
    for (let s = 6 * SEC; s + SEC / 4 <= n; s += SEC / 4) {
        const red = db(power(x, s, s + SEC / 4) / power(y, s, s + SEC / 4));
        if (red > 10) { t = (s - 6 * SEC) / SEC; break; }
    }
    check('recovers after +12 dB noise step', t >= 0 && t <= 3, t >= 0 ? 'within ' + t.toFixed(2) + ' s' : 'did not recover');
}

// 6a. Silence (squelch closed, stream gaps) must not wreck the noise estimate
{
    const nrBackWithin = (x, y, from) => {
        for (let s = from; s + SEC / 4 <= x.length; s += SEC / 8) {
            if (db(power(x, s, s + SEC / 4) / power(y, s, s + SEC / 4)) > 10) return (s - from) / SEC;
        }
        return -1;
    };
    for (const profile of ['normal', 'beacon']) {
        const n = 16 * SEC;
        let x = bandNoise(n, 300, 3000, 0.1);
        for (let i = 6 * SEC; i < 10 * SEC; i++) x[i] = 0;
        let t = nrBackWithin(x, run(new SpectralNR(FS, profile), x), 10 * SEC);
        check(profile + ': working again after 4 s of silence', t >= 0 && t <= 0.5, t >= 0 ? 'within ' + t.toFixed(2) + ' s' : 'did not recover');
        x = bandNoise(n, 300, 3000, 0.1);
        for (let i = 0; i < 2 * SEC; i++) x[i] = 0;
        t = nrBackWithin(x, run(new SpectralNR(FS, profile), x), 2 * SEC);
        check(profile + ': working after a silent start', t >= 0 && t <= 0.5, t >= 0 ? 'within ' + t.toFixed(2) + ' s' : 'did not recover');
        x = bandNoise(n, 300, 3000, 0.003);
        for (let i = 6 * SEC; i < n; i++) x[i] *= 31.6;
        t = nrBackWithin(x, run(new SpectralNR(FS, profile), x), 6 * SEC);
        check(profile + ': recovers after +30 dB noise step', t >= 0 && t <= 2.5, t >= 0 ? 'within ' + t.toFixed(2) + ' s' : 'did not recover');
    }
}

// 6b. Ringing: share of the leftover noise energy coming from stray bins opened well above the floor
for (const strength of [0.5, 1.0]) {
    const nr = new SpectralNR(FS); nr.setStrength(strength);
    const n = 20 * SEC, x = bandNoise(n, 300, 3000, 0.1), out = new Float64Array(128);
    const hz = FS / nr.size, k0 = Math.round(400 / hz), k1 = Math.round(2900 / hz);
    let stray = 0, total = 0;
    for (let i = 0; i + 128 <= n; i += 128) {
        nr.process(x.subarray(i, i + 128), null, out, null, 128);
        if (i > settle && (i + 128) % nr.hop === 0) for (let k = k0; k < k1; k++) {
            const e = nr.power[k] * nr.gain[k] * nr.gain[k]; total += e; if (nr.gain[k] > nr.floor * 2) stray += e;
        }
    }
    check('ringing at strength ' + strength, 100 * stray / total < 2, (100 * stray / total).toFixed(1) + '% of leftover noise energy');
}

// 6c. Auto-notch (NR off): a heterodyne 6 dB above speech-like audio must go, the speech must stay
{
    console.log('');
    const n = 20 * SEC, f = 1500, amp = Math.sqrt(2 * 0.01 * 4);
    seed = 1;
    const sp = speechLike(n, 0.1), nz = bandNoise(n, 300, 3000, 0.01);
    const plain = new Float64Array(n), withHet = new Float64Array(n);
    for (let i = 0; i < n; i++) { plain[i] = sp[i] + nz[i]; withHet[i] = plain[i] + amp * Math.sin(2 * Math.PI * f * i / FS); }
    const mk = () => { const nr = new SpectralNR(FS); nr.nrOn = false; nr.notchOn = true; return nr; };
    let nr = mk(); const y = run(nr, withHet);
    const het = db(tonePower(y, f, settle, n) / tonePower(withHet, f, settle, n));
    check('notch removes heterodyne', het < -15, het.toFixed(1) + ' dB');
    let t = -1;
    for (let s = 0; s + SEC / 10 <= 6 * SEC; s += SEC / 20) {
        if (db(tonePower(y, f, s, s + SEC / 10) / tonePower(withHet, f, s, s + SEC / 10)) < -15) { t = s / SEC; break; }
    }
    check('notch acts within 1.5 s', t >= 0 && t <= 1.5, t.toFixed(2) + ' s to -15 dB');
    nr = mk(); const y2 = run(nr, plain);
    const kept = keptDb(y2, sp, nr.latency, settle, n);
    check('notch leaves speech-like audio alone', kept > -0.5, kept.toFixed(2) + ' dB');
    nr = mk(); const noise = bandNoise(n, 300, 3000, 0.1), y3 = run(nr, noise);
    const ch = db(power(y3, settle, n) / power(noise, settle, n));
    check('notch leaves plain noise alone', Math.abs(ch) < 0.3, ch.toFixed(2) + ' dB');
}

// 6d. Beacon profile: a carrier 20 dB below the passband noise
{
    const n = 30 * SEC, from = 8 * SEC, f = 1020, gains = {};
    for (const profile of ['normal', 'beacon']) {
        seed = 1;
        const nr = new SpectralNR(FS, profile); nr.setStrength(0.5);
        const x = bandNoise(n, 300, 3000, 0.1), noiseOnly = Float64Array.from(x);
        const amp = Math.sqrt(2 * 0.01 * Math.pow(10, -20 / 10));
        for (let i = 0; i < n; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / FS);
        const y = run(nr, x);
        const tIn = tonePower(x, f, from, n), tOut = tonePower(y, f, from, n);
        gains[profile] = db(tOut / (power(y, from, n) - tOut)) - db(tIn / power(noiseOnly, from, n));
    }
    check('beacon profile lifts a -20 dB carrier', gains.beacon > 3 && gains.beacon > gains.normal + 2,
        'SNR ' + (gains.beacon >= 0 ? '+' : '') + gains.beacon.toFixed(1) + ' dB (normal profile ' + (gains.normal >= 0 ? '+' : '') + gains.normal.toFixed(1) + ' dB)');
    const nr = new SpectralNR(FS, 'beacon');
    nr.updateGain = function () { this.gain.fill(1); };
    const m = 3 * SEC, x = new Float64Array(m);
    for (let i = 0; i < m; i++) x[i] = gauss() * 0.1;
    const y = run(nr, x);
    let err = 0, ref = 0;
    for (let i = nr.latency + 8192; i < m - 256; i++) { const d = y[i] - x[i - nr.latency]; err += d * d; ref += x[i - nr.latency] ** 2; }
    check('beacon reconstruction', db(err / ref) < -100, 'error ' + db(err / ref).toFixed(0) + ' dB, latency ' + (nr.latency / FS * 1000).toFixed(0) + ' ms');
}

// 7. Stereo: independent noise per channel, shared gain, both channels reduced alike
{
    const nr = new SpectralNR(FS); nr.setStrength(0.5);
    const n = 8 * SEC, l = bandNoise(n, 300, 3000, 0.1), r = bandNoise(n, 300, 3000, 0.1);
    const [yl, yr] = run(nr, l, r);
    const a = db(power(l, settle, n) / power(yl, settle, n)), b = db(power(r, settle, n) / power(yr, settle, n));
    check('stereo', a > 8 && Math.abs(a - b) < 1, 'L ' + a.toFixed(1) + ' dB, R ' + b.toFixed(1) + ' dB');
}

// 8. CPU cost
{
    const nr = new SpectralNR(FS);
    const n = 30 * SEC, x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = gauss() * 0.1;
    const t0 = process.hrtime.bigint();
    run(nr, x);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check('cpu', ms / 30000 < 0.05, (ms / 300).toFixed(2) + '% of one core (mono, this machine)');
}

console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
