/*
 * K2AAM NR - spectral noise reduction for OpenWebRX+ (audio worklet part).
 *
 * Runs in the browser, between the OpenWebRX+ audio worklet and the volume
 * control. Nothing here touches the server.
 *
 * How it works, per overlapping FFT frame:
 *   1. Track the noise floor in every frequency bin: the estimate falls
 *      quickly when a bin gets quieter and rises only slowly when it gets
 *      louder, so speech and keyed signals do not drag it up.
 *   2. Stop steady narrow signals (carriers, beacons, heterodynes) from
 *      being learned as noise: no bin's noise estimate may exceed the level
 *      of the broadband noise around it by more than a small factor.
 *   3. Turn signal-to-noise ratio into a gain per bin with the
 *      "decision-directed" rule (Ephraim & Malah), which smooths the gain
 *      over time and avoids the watery artifacts of a hard gate.
 *   4. Give weak steady carriers a second chance: a slow average per bin
 *      opens the gain for signals too weak to register frame by frame.
 *   5. Never attenuate below a floor set by the strength control, so the
 *      background stays natural instead of pumping to silence.
 *
 * Two extras share the same FFT frames:
 *   - Auto-notch: finds narrow tones that stay put (heterodynes, carriers)
 *     and pulls them down to the level of the audio around them.
 *   - Beacon profile: twice the frame length and longer averaging, to dig
 *     out weak steady carriers at the cost of smearing speech and fast CW.
 */

'use strict';

// ---------------------------------------------------------------------------
// Radix-2 complex FFT, in place, on separate real/imaginary arrays.
// ---------------------------------------------------------------------------
class FFT {
    constructor(size) {
        this.size = size;
        this.rev = new Uint32Array(size);
        var bits = Math.round(Math.log2(size));
        for (var i = 0; i < size; i++) {
            var r = 0;
            for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
            this.rev[i] = r;
        }
        this.cos = new Float64Array(size / 2);
        this.sin = new Float64Array(size / 2);
        for (var k = 0; k < size / 2; k++) {
            this.cos[k] = Math.cos(2 * Math.PI * k / size);
            this.sin[k] = Math.sin(2 * Math.PI * k / size);
        }
    }

    // inverse = true computes the unscaled inverse transform
    transform(re, im, inverse) {
        var n = this.size, rev = this.rev, cos = this.cos, sin = this.sin;
        var i, j, k, t;
        for (i = 0; i < n; i++) {
            j = rev[i];
            if (j > i) {
                t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (var len = 2; len <= n; len <<= 1) {
            var half = len >> 1, step = n / len;
            for (i = 0; i < n; i += len) {
                for (j = 0, k = 0; j < half; j++, k += step) {
                    var wr = cos[k], wi = inverse ? sin[k] : -sin[k];
                    var a = i + j, b = a + half;
                    var xr = re[b] * wr - im[b] * wi;
                    var xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The noise reduction itself. Feed it audio one sample block at a time with
// process(); it adds a fixed delay of one FFT length.
// ---------------------------------------------------------------------------
class SpectralNR {
    // profile: 'normal' or 'beacon'
    constructor(sampleRate, profile) {
        // About 43 ms frames: 23 Hz bins at 48 kHz, fine enough to separate
        // a carrier from the noise around it. The beacon profile doubles it.
        var size = 2048;
        while (sampleRate / size > 30 && size < 8192) size <<= 1;
        while (sampleRate / size < 15 && size > 512) size >>= 1;
        var beacon = profile === 'beacon';
        if (beacon) size <<= 1;
        this.profile = beacon ? 'beacon' : 'normal';

        this.sampleRate = sampleRate;
        this.size = size;
        this.hop = size >> 2;
        this.bins = (size >> 1) + 1;
        this.fft = new FFT(size);
        this.framesPerSec = sampleRate / this.hop;

        // Square-root Hann window, used for both analysis and synthesis.
        // With 75% overlap the squared windows sum to 2.
        this.window = new Float64Array(size);
        for (var i = 0; i < size; i++) {
            this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
        }

        // Per-channel streaming buffers (0 = left, 1 = right)
        this.xin = [new Float64Array(size), new Float64Array(size)];
        this.ola = [new Float64Array(size), new Float64Array(size)];
        this.out = [new Float64Array(this.hop), new Float64Array(this.hop)];
        this.re = [new Float64Array(size), new Float64Array(size)];
        this.im = [new Float64Array(size), new Float64Array(size)];
        this.fill = 0;

        // Per-bin state
        this.power = new Float64Array(this.bins);     // this frame's power
        this.smooth = new Float64Array(this.bins);    // lightly smoothed power
        this.noise = new Float64Array(this.bins);     // tracked noise floor
        this.steady = new Float64Array(this.bins);    // slow average, for carriers
        this.cap = new Float64Array(this.bins);       // tone-protection ceiling
        this.gain = new Float64Array(this.bins);      // gain applied this frame
        this.prevGain = new Float64Array(this.bins);  // unfloored gain, last frame
        this.prevPost = new Float64Array(this.bins);  // SNR estimate, last frame
        this.hold = new Float64Array(this.bins);      // sustained level, for the notch
        this.notchRef = new Float64Array(this.bins);  // level of the surroundings
        this.notchGain = new Float64Array(this.bins).fill(1);

        // Tuning constants. See the README for what each one trades off.
        this.smoothing = Math.exp(-1 / (0.021 * this.framesPerSec)); // power smoothing
        this.fall = 1 - Math.exp(-1 / (0.10 * this.framesPerSec)); // 100 ms fall
        this.rise = Math.pow(10, (9 / 10) / this.framesPerSec);     // 9 dB/s rise
        this.bias = beacon ? SpectralNR.BIAS_BEACON : SpectralNR.BIAS; // tracker bias fix
        this.ddAlphaBase = 0.97;                             // gain smoothing at
        this.ddAlphaSlope = 0.02;                            // strength 0, and slope
        this.capFactor = 1.0;                                // ceiling vs neighbours
        // Slow path for steady carriers: builds up over ~0.6 s, lets go in ~0.1 s
        // (beacon profile: averages for longer, so it can open on less)
        this.steadyRise = 1 - Math.exp(-1 / ((beacon ? 1.5 : 0.60) * this.framesPerSec));
        this.steadyFall = 1 - Math.exp(-1 / ((beacon ? 0.2 : 0.10) * this.framesPerSec));
        this.steadyThreshold = beacon ? SpectralNR.BEACON_THRESHOLD : 0.6;
        this.steadyClamp = 4.0;
        // Auto-notch: a bin counts as a tone once its sustained level stands
        // this far above the audio around it, and is pulled down to that line.
        this.setNotchRise(40);                               // dB per second
        this.holdFall = 1 - Math.exp(-1 / (0.03 * this.framesPerSec));
        this.notchQuantile = 0.75;
        this.notchMargin = 4.0;                              // 6 dB
        this.notchDepth = 0.01;                              // at most -40 dB
        this.notchSlew = 1 - Math.exp(-1 / (0.05 * this.framesPerSec));
        this.nrOn = true;
        this.notchOn = false;
        this.capHalfWidth = Math.max(4, Math.round(550 / (sampleRate / size)));
        this.capStep = Math.max(1, Math.round(this.capHalfWidth / 4));
        this.capEvery = 4;                                   // frames between updates
        this.capScratch = new Float64Array(2 * this.capHalfWidth + 1);
        this.capGrid = new Float64Array(Math.ceil(this.bins / this.capStep) + 2);

        this.frames = 0;
        this.primed = false;
        // Frames quieter than about -80 dBFS count as silence. The sum over
        // bins of windowed FFT power is size^2 / 4 times the mean square.
        this.silence = 1e-8 * size * size / 4;
        // When nearly every bin sits well above its noise estimate for a
        // while, the floor itself has moved (band, antenna or gain change):
        // catch up quickly instead of at the normal cautious rate.
        this.fastRise = Math.pow(10, (60 / 10) / this.framesPerSec);
        this.jumpAfter = Math.round(0.3 * this.framesPerSec);
        this.jumpFrames = 0;
        this.live = 0;
        this.capDue = this.notchDue = true;
        this.setStrength(0.5);
    }

    // strength: 0 (gentle) .. 1 (aggressive)
    setStrength(strength) {
        strength = Math.min(1, Math.max(0, strength));
        this.strength = strength;
        // deepest attenuation allowed: -6 dB .. -24 dB. Going deeper makes the
        // background so quiet that every stray bin is heard as a tone.
        this.floor = Math.pow(10, -(6 + 18 * strength) / 20);
        // gain smoothing: more of it at high strength, where stray bins that
        // open for a frame or two (ringing) are most exposed
        this.ddAlpha = this.ddAlphaBase + this.ddAlphaSlope * strength;
        // how much to over-estimate the noise: 1.0 .. 1.3
        this.over = 1 + 0.3 * strength;
    }

    setNotchRise(dbPerSec) {
        this.holdRise = Math.pow(10, (dbPerSec / 10) / this.framesPerSec);
    }

    reset() {
        for (var c = 0; c < 2; c++) {
            this.xin[c].fill(0); this.ola[c].fill(0); this.out[c].fill(0);
        }
        this.smooth.fill(0); this.noise.fill(0); this.cap.fill(0); this.steady.fill(0);
        this.prevGain.fill(0); this.prevPost.fill(0);
        this.hold.fill(0); this.notchRef.fill(0); this.notchGain.fill(1);
        this.fill = 0; this.frames = 0; this.primed = false; this.jumpFrames = 0; this.live = 0;
        this.capDue = this.notchDue = true;
    }

    get latency() { return this.size; }

    // Process `length` samples. inR/outR may be null for mono.
    process(inL, inR, outL, outR, length) {
        var stereo = !!inR;
        var hop = this.hop, base = this.size - hop;
        var xl = this.xin[0], xr = this.xin[1];
        var ol = this.out[0], or = this.out[1];
        for (var i = 0; i < length; i++) {
            xl[base + this.fill] = inL[i];
            outL[i] = ol[this.fill];
            if (stereo) {
                xr[base + this.fill] = inR[i];
                outR[i] = or[this.fill];
            }
            if (++this.fill === hop) {
                this.frame(stereo);
                this.fill = 0;
            }
        }
    }

    // Run one FFT frame over the most recent `size` input samples.
    frame(stereo) {
        var n = this.size, hop = this.hop, bins = this.bins;
        var win = this.window, channels = stereo ? 2 : 1;
        var c, i, k;

        for (c = 0; c < channels; c++) {
            var re = this.re[c], im = this.im[c], x = this.xin[c];
            for (i = 0; i < n; i++) { re[i] = x[i] * win[i]; im[i] = 0; }
            this.fft.transform(re, im, false);
        }

        // Power per bin, averaged over channels so both share one gain
        // and the stereo image is preserved.
        var power = this.power;
        for (k = 0; k < bins; k++) {
            var p = this.re[0][k] * this.re[0][k] + this.im[0][k] * this.im[0][k];
            if (stereo) {
                p = 0.5 * (p + this.re[1][k] * this.re[1][k] + this.im[1][k] * this.im[1][k]);
            }
            power[k] = p;
        }

        // Digital silence (squelch closed, stream gap) says nothing about the
        // noise floor. Learning from it would leave the estimate at zero, and
        // the filter doing nothing for many seconds once audio returns.
        var total = 0;
        for (k = 0; k < bins; k++) total += power[k];
        this.live = total > this.silence ? this.live + 1 : 0;
        // The first frames after silence still contain part of it, so they
        // are too quiet to learn from. Wait for one that is all audio.
        var whole = this.live >= this.size / this.hop;
        if (whole) this.updateNoise();
        if (whole || (this.live > 0 && this.primed)) this.updateGain();
        else this.gain.fill(1);

        // Apply the gain, go back to the time domain, overlap-add.
        var gain = this.gain;
        var scale = 1 / (2 * n); // 1/n for the inverse FFT, 1/2 for the windows
        for (c = 0; c < channels; c++) {
            re = this.re[c]; im = this.im[c];
            for (k = 0; k < bins; k++) {
                re[k] *= gain[k]; im[k] *= gain[k];
                if (k > 0 && k < n - k) { re[n - k] *= gain[k]; im[n - k] *= gain[k]; }
            }
            this.fft.transform(re, im, true);
            var ola = this.ola[c], out = this.out[c];
            for (i = 0; i < n; i++) ola[i] += re[i] * win[i] * scale;
            for (i = 0; i < hop; i++) out[i] = ola[i];
            ola.copyWithin(0, hop);
            ola.fill(0, n - hop);
            this.xin[c].copyWithin(0, hop);
        }
        this.frames++;
    }

    updateNoise() {
        var bins = this.bins, power = this.power, smooth = this.smooth, noise = this.noise;
        var a = this.smoothing, fall = this.fall, rise = this.rise, k;

        if (!this.primed) {
            // First frame: start from what we hear instead of from silence.
            for (k = 0; k < bins; k++) { smooth[k] = power[k]; noise[k] = power[k]; this.steady[k] = power[k]; }
            this.hold.fill(0);
            // the neighbourhood levels below must be worked out from this
            // first real frame, not left at zero until their next update
            this.capDue = this.notchDue = true;
            this.primed = true;
        }

        if (this.jumpFrames > this.jumpAfter) rise = this.fastRise;
        var active = 0, above = 0, lift = 10 * this.bias, quiet = this.silence / bins * 1e-3;
        for (k = 0; k < bins; k++) {
            var s = smooth[k] = a * smooth[k] + (1 - a) * power[k];
            if (s > quiet) { active++; if (s > noise[k] * lift) above++; }
            if (s < noise[k]) noise[k] += (s - noise[k]) * fall;
            else noise[k] = Math.min(noise[k] * rise + 1e-30, s);
        }
        this.jumpFrames = active > 8 && above > 0.9 * active ? this.jumpFrames + 1 : 0;

        // Tone protection: every few frames, work out how loud the broadband
        // noise is around each bin (upper quartile across neighbouring bins)
        // and do not let any single bin's estimate climb far above that.
        if (this.capDue || this.frames % this.capEvery === 0) {
            this.quantile(noise, this.cap, 0.75);
            this.capDue = false;
        }
        var cap = this.cap, f = this.capFactor;
        for (k = 0; k < bins; k++) {
            var limit = cap[k] * f;
            if (noise[k] > limit) noise[k] = limit;
            // let the ceiling rise with the estimates between its updates,
            // otherwise it would slow down recovery when the band gets noisier
            cap[k] *= rise;
        }
    }

    // For every bin, the q-th quantile of `src` over the neighbouring bins
    // (about +-550 Hz), written to `dst`. Narrow peaks do not move it.
    quantile(src, dst, q) {
        var bins = this.bins, noise = src, half = this.capHalfWidth;
        var step = this.capStep, grid = this.capGrid, scratch = this.capScratch;
        var g = 0, k, i, j;
        for (k = 0; k < bins + step; k += step, g++) {
            var centre = Math.min(k, bins - 1);
            var lo = Math.max(0, centre - half), hi = Math.min(bins - 1, centre + half);
            var count = 0;
            // insertion sort of the neighbourhood
            for (i = lo; i <= hi; i++) {
                var v = noise[i];
                for (j = count; j > 0 && scratch[j - 1] > v; j--) scratch[j] = scratch[j - 1];
                scratch[j] = v;
                count++;
            }
            grid[g] = scratch[Math.min(count - 1, Math.floor(count * q))];
        }
        grid[g] = grid[g - 1];
        // interpolate the coarse grid back onto every bin
        var cap = dst;
        for (k = 0; k < bins; k++) {
            var pos = k / step, idx = Math.floor(pos), frac = pos - idx;
            cap[k] = grid[idx] * (1 - frac) + grid[idx + 1] * frac;
        }
    }

    updateGain() {
        if (this.nrOn) this.updateNrGain(); else this.gain.fill(1);
        if (this.notchOn) this.applyNotch();
    }

    // Auto-notch. `hold` follows the level a bin has kept up continuously:
    // it drops at once when the bin goes quiet and climbs back only slowly,
    // so it stays low for speech, whose harmonics come and go and wander in
    // pitch, and settles on anything that just sits there.
    applyNotch() {
        var bins = this.bins, level = this.smooth, hold = this.hold;
        var rise = this.holdRise, fall = this.holdFall, k;
        for (k = 0; k < bins; k++) {
            var p = level[k], h = hold[k];
            if (p < h) h += (p - h) * fall;
            else { h = h * rise; if (h < p * 1e-3) h = p * 1e-3; if (h > p) h = p; }
            hold[k] = h;
        }
        if (this.notchDue || this.frames % this.capEvery === 0) {
            this.quantile(hold, this.notchRef, this.notchQuantile);
            this.notchDue = false;
        }
        var ref = this.notchRef, ng = this.notchGain, gain = this.gain;
        var margin = this.notchMargin, depth = this.notchDepth, slew = this.notchSlew;
        for (k = 0; k < bins; k++) {
            var line = margin * ref[k];
            var target = hold[k] > line && hold[k] > 0 ? Math.sqrt(line / hold[k]) : 1;
            if (target < depth) target = depth;
            ng[k] += (target - ng[k]) * slew;
            gain[k] *= ng[k];
        }
    }

    updateNrGain() {
        var bins = this.bins, power = this.power, noise = this.noise;
        var gain = this.gain, prevGain = this.prevGain, prevPost = this.prevPost;
        var alpha = this.ddAlpha, floor = this.floor, steady = this.steady;
        var up = this.steadyRise, down = this.steadyFall, thr = this.steadyThreshold;
        var clamp = this.steadyClamp;
        var noiseScale = this.bias * this.over;
        for (var k = 0; k < bins; k++) {
            var nz = noise[k] * noiseScale + 1e-30;
            var post = power[k] / nz;                 // SNR seen in this frame
            var prio = alpha * prevGain[k] * prevGain[k] * prevPost[k]
                     + (1 - alpha) * Math.max(post - 1, 0); // smoothed SNR
            // Steady signals too weak to open the fast path above still stand
            // out once averaged over time. Bursty signals such as speech do
            // not build up here because the average lets go quickly.
            var st = steady[k];
            var target = post < clamp ? power[k] : clamp * nz; // strong bursts must not charge it
            st += (target - st) * (target > st ? up : down);
            steady[k] = st;
            var slow = st / nz - thr;
            if (slow > prio) prio = slow;
            var g = prio / (1 + prio);                // Wiener gain
            prevGain[k] = g;
            prevPost[k] = post;
            gain[k] = g > floor ? g : floor;
        }
    }
}

// Ratio of true mean noise power to what the fall-fast/rise-slow tracker
// settles at on stationary noise. Measured with: node test.js <this file> calibrate
SpectralNR.BIAS = 1.57;
SpectralNR.BIAS_BEACON = 1.99;
// How far a slow-averaged bin must stand above the noise before the beacon
// profile opens it. Lower digs deeper but leaves more faint steady tones.
SpectralNR.BEACON_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Audio worklet wrapper
// ---------------------------------------------------------------------------
if (typeof AudioWorkletProcessor !== 'undefined') {
    class K2aamNrProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super(options);
            this.state = { enabled: false, strength: 0.5, notch: false, profile: 'normal' };
            this.tuned = {};
            this.build();
            this.update((options && options.processorOptions) || {});
            this.port.onmessage = (m) => this.update(m.data || {});
        }

        build() {
            this.nr = new SpectralNR(sampleRate, this.state.profile);
            for (var key in this.tuned) this.nr[key] = this.tuned[key];
            this.nr.setStrength(this.state.strength);
            this.nr.nrOn = this.state.enabled;
            this.nr.notchOn = this.state.notch;
        }

        update(d) {
            var st = this.state, wasActive = st.enabled || st.notch;
            if (d.tune) {
                // live tuning from the browser console, see README
                var ok = ['ddAlphaBase', 'ddAlphaSlope', 'steadyThreshold', 'steadyClamp',
                          'capFactor', 'bias', 'notchMargin', 'notchDepth'];
                for (var key in d.tune) {
                    if (ok.indexOf(key) >= 0 && typeof d.tune[key] === 'number') {
                        this.tuned[key] = this.nr[key] = d.tune[key];
                    }
                }
                this.nr.setStrength(st.strength);
            }
            if (typeof d.strength === 'number') { st.strength = d.strength; this.nr.setStrength(d.strength); }
            if (typeof d.enabled === 'boolean') st.enabled = d.enabled;
            if (typeof d.notch === 'boolean') st.notch = d.notch;
            if ((d.profile === 'normal' || d.profile === 'beacon') && d.profile !== st.profile) {
                st.profile = d.profile;
                this.build();
            }
            // start clean when switching in, so stale audio is not replayed
            if (!wasActive && (st.enabled || st.notch)) this.nr.reset();
            this.nr.nrOn = st.enabled;
            this.nr.notchOn = st.notch;
        }

        process(inputs, outputs) {
            var input = inputs[0], output = outputs[0];
            if (!input || !input.length) return true;   // nothing connected
            var inL = input[0], inR = input.length > 1 ? input[1] : null;
            var outL = output[0], outR = output.length > 1 ? output[1] : null;
            var n = inL.length, i;

            if (!this.state.enabled && !this.state.notch) {
                outL.set(inL);
                if (outR) outR.set(inR || inL);
                return true;
            }

            // OpenWebRX+ sends mono audio as two identical channels.
            // Process it once and copy, to halve the work.
            var stereo = false;
            if (inR && outR) {
                for (i = 0; i < n; i++) if (inL[i] !== inR[i]) { stereo = true; break; }
            }
            if (stereo) {
                this.nr.process(inL, inR, outL, outR, n);
            } else {
                this.nr.process(inL, null, outL, null, n);
                if (outR) outR.set(outL);
            }
            return true;
        }
    }

    registerProcessor('k2aam-nr-processor', K2aamNrProcessor);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SpectralNR: SpectralNR, FFT: FFT };
}
