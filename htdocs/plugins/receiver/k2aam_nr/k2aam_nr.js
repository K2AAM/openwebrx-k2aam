/*
 * K2AAM NR - better noise reduction for OpenWebRX+ (receiver plugin).
 *
 * Replaces what the stock NR button and slider do. Instead of asking the
 * server to run its spectral gate, the audio is cleaned up in the browser by
 * k2aam_nr_worklet.js, spliced in between the OpenWebRX+ audio worklet and
 * the volume control:
 *
 *     audioNode -> [k2aam-nr-processor] -> EQ -> CW peak -> gainNode -> speakers
 *
 * EQ (bass / mid / treble shelves) and the CW peak filter are plain Web
 * Audio biquads. Everything is per listener: it only changes your audio.
 * NR settings (on/off, strength, Notch, Beacon) are remembered separately
 * for SSB, CW, AM and FM. In AM the NR also goes easier on the treble.
 *
 * Any UI that calls UI.toggleNR() / UI.setNR() keeps working unchanged.
 * Two extra buttons are added beside the NR control (under the stock slider,
 * or in the noise reduction group of the K2AAM Dock / Console):
 *
 *     Notch   removes steady tones (heterodynes) in voice modes
 *     Beacon  longer analysis, digs out weak steady carriers
 *     Peak    CW only: narrow filter on the CW tone (follows the passband)
 *     Voice   AI speech noise reduction (RNNoise 0.2) in SSB and AM; the
 *             slider blends in the original audio. Downloaded on first use.
 *     A/B     hold to hear the audio without NR, Notch or Peak
 *
 * The EQ panel is built by createAudioPanel(); the K2AAM Dock shows it as
 * "Audio".
 * A custom UI can drive the same things with
 *     Plugins.k2aam_nr.setNotch(true|false)
 *     Plugins.k2aam_nr.setProfile('normal'|'beacon')
 *     Plugins.k2aam_nr.getState()
 *
 * If the browser has no AudioWorklet (plain http:// pages, very old
 * browsers) the plugin does nothing and the stock server NR stays in charge.
 *
 * Enable with:  Plugins.load('k2aam_nr');  in plugins/receiver/init.js
 */

Plugins.k2aam_nr._version = 0.7;

// Modes where the audio is already clean, is music, or is not audio at all.
// Everything is bypassed in these.
Plugins.k2aam_nr.BYPASS_MODES = [
    'wfm', 'bcfm', 'iq', 'drm', 'dab', 'hdr',
    'dmr', 'dstar', 'nxdn', 'ysf', 'p25', 'm17', 'freedv', 'tetra', 'radel', 'radeu'
];

// Modes where removing steady tones is wanted. Not CW, where the tone is
// the signal, and not while a digital decoder is selected.
Plugins.k2aam_nr.NOTCH_MODES = ['usb', 'lsb', 'am', 'sam', 'nfm'];

// NR settings are remembered per family of modes.
Plugins.k2aam_nr.FAMILIES = { usb: 'ssb', lsb: 'ssb', cw: 'cw', am: 'am', sam: 'am', nfm: 'fm' };
// Modes where the Voice (RNNoise) engine is offered: speech only.
Plugins.k2aam_nr.VOICE_MODES = ['usb', 'lsb', 'am', 'sam'];

Plugins.k2aam_nr.PROFILES = ['normal', 'beacon', 'voice'];

// Modes where the NR goes easier on the treble (see the worklet's tilt).
Plugins.k2aam_nr.TILT_MODES = ['am', 'sam'];

// EQ presets in dB: [bass, mid, treble]
Plugins.k2aam_nr.EQ_PRESETS = {
    'Flat': [0, 0, 0],
    'AM clarity': [-3, 2, 6],
    'SSB voice': [-6, 3, 3],
    'Warm': [4, 0, -4]
};

// small localStorage helpers that never throw
Plugins.k2aam_nr.load = function (key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
};
Plugins.k2aam_nr.store = function (key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
};

Plugins.k2aam_nr.init = function () {
    var self = this;
    self.node = null;
    self.sent = '';
    self.lastEnabled = null;
    self.notch = LS.has('k2aam_nr_notch') ? LS.loadBool('k2aam_nr_notch') : false;
    var savedProfile = LS.has('k2aam_nr_profile') ? LS.loadStr('k2aam_nr_profile') : 'normal';
    self.profile = self.PROFILES.indexOf(savedProfile) >= 0 ? savedProfile : 'normal';
    self.voiceState = '';   // '', 'loading', 'ready' or 'failed: reason'
    var eq = self.load('k2aam_nr_eq', [0, 0, 0]);
    self.eq = Array.isArray(eq) && eq.length === 3 ? eq.map(Number) : [0, 0, 0];
    self.peak = self.load('k2aam_nr_peak', false) === true;
    self.ab = false;
    self.family = null;
    self.memory = self.load('k2aam_nr_modes', {}) || {};
    self.base = (self._script_loaded || 'static/plugins/receiver/k2aam_nr/k2aam_nr.js')
        .replace(/[^\/]*$/, '');

    // audioEngine is created by openwebrx_init(), which may run after us.
    var tries = 0;
    (function waitForEngine() {
        if (typeof audioEngine !== 'undefined' && audioEngine) {
            audioEngine.onStart(function () { self.attach(); });
        } else if (++tries < 150) {
            setTimeout(waitForEngine, 200);
        } else {
            console.warn('k2aam_nr: audio engine not found, stock NR left in place.');
        }
    })();

    return true;
};

// Insert the NR worklet into the audio chain.
Plugins.k2aam_nr.attach = function () {
    var self = this;
    var ctx = audioEngine.audioContext;
    var source = audioEngine.audioNode;
    var sink = audioEngine.gainNode;

    if (self.node) return;
    if (!ctx || !ctx.audioWorklet || !source || !source.port || !sink) {
        console.info('k2aam_nr: AudioWorklet not available here, stock NR left in place.');
        return;
    }

    ctx.audioWorklet.addModule(self.base + 'k2aam_nr_worklet.js').then(function () {
        var node = new AudioWorkletNode(ctx, 'k2aam-nr-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit'
        });
        // EQ: low shelf 250 Hz, peaking 1.2 kHz, high shelf 2.5 kHz
        var bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 250;
        var mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = 0.8;
        var treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 2500;
        // CW peak: the dry path drops 12 dB and a band-pass (0 dB at its
        // centre) is mixed in, so the CW tone keeps its loudness while
        // everything around it goes down.
        var dry = ctx.createGain(), bp = ctx.createBiquadFilter(), wet = ctx.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 6;
        wet.gain.value = 0;
        source.disconnect(sink);
        source.connect(node);
        node.connect(bass); bass.connect(mid); mid.connect(treble);
        treble.connect(dry); dry.connect(sink);
        treble.connect(bp); bp.connect(wet); wet.connect(sink);
        self.node = node;
        node.port.onmessage = function (m) { self.voiceMessage(m.data || {}); };
        self.filters = { bass: bass, mid: mid, treble: treble, dry: dry, bp: bp, wet: wet, ctx: ctx };
        self.applyEq();
        self.takeOver();
        console.info('k2aam_nr: active, ' + ctx.sampleRate + ' Hz.');
    }).catch(function (e) {
        console.error('k2aam_nr: could not start, stock NR left in place: ' + (e && e.message ? e.message : e));
    });
};

// Which demodulator is selected right now.
Plugins.k2aam_nr.currentMode = function () {
    try {
        var demod = UI.getDemodulator();
        return {
            primary: (demod && demod.get_modulation()) || '',
            secondary: (demod && demod.get_secondary_demod()) || ''
        };
    } catch (e) {
        return { primary: '', secondary: '' };
    }
};

// What the user asked for, and what is actually applied in the current mode.
// The stock slider runs -20..+20; we read it as strength 0..1.
Plugins.k2aam_nr.getState = function () {
    var level = parseFloat(UI.nrThreshold);
    if (isNaN(level)) level = 0;
    var mode = this.currentMode();
    var bypass = this.BYPASS_MODES.indexOf(mode.primary) >= 0;
    var notchOk = !bypass && !mode.secondary && this.profile !== 'beacon'
        && this.NOTCH_MODES.indexOf(mode.primary) >= 0;
    var voiceOk = !bypass && !mode.secondary && this.VOICE_MODES.indexOf(mode.primary) >= 0;
    return {
        mode: mode.secondary || mode.primary,
        bypass: bypass,
        notchAvailable: notchOk,
        wanted: { enabled: !!UI.nrEnabled, notch: this.notch, profile: this.profile },
        enabled: !!UI.nrEnabled && !bypass,
        notch: this.notch && notchOk,
        profile: this.profile === 'voice' && !voiceOk ? 'normal' : this.profile,
        voiceAvailable: voiceOk,
        strength: Math.min(1, Math.max(0, (level + 20) / 40)),
        level: level,
        family: this.FAMILIES[mode.secondary ? '' : mode.primary] || null,
        tilt: !bypass && this.TILT_MODES.indexOf(mode.primary) >= 0 ? 1 : 0,
        peakAvailable: mode.primary === 'cw' && !mode.secondary,
        peak: this.peak && mode.primary === 'cw' && !mode.secondary,
        ab: this.ab
    };
};

// Point the stock NR controls at the worklet instead of the server.
Plugins.k2aam_nr.takeOver = function () {
    var self = this;
    self.stockUpdateNR = UI.updateNR;
    UI.updateNR = function () { self.apply(); };
    self.apply();
    // follow mode changes
    setInterval(function () { self.apply(); }, 500);
};

Plugins.k2aam_nr.setPeak = function (on) {
    this.peak = !!on;
    this.store('k2aam_nr_peak', this.peak);
    this.apply();
};

// A/B: true while the button is held
Plugins.k2aam_nr.setAB = function (on) {
    this.ab = !!on;
    this.apply();
};

// gains in dB for [bass, mid, treble], each -12..+12
Plugins.k2aam_nr.setEq = function (gains) {
    this.eq = gains.map(function (g) { return Math.max(-12, Math.min(12, Math.round(Number(g) || 0))); });
    this.store('k2aam_nr_eq', this.eq);
    this.applyEq();
    if (this._eqListeners) this._eqListeners.forEach(function (fn) { fn(); });
};

Plugins.k2aam_nr.applyEq = function () {
    var f = this.filters;
    if (!f) return;
    var t = f.ctx.currentTime;
    f.bass.gain.setTargetAtTime(this.eq[0], t, 0.03);
    f.mid.gain.setTargetAtTime(this.eq[1], t, 0.03);
    f.treble.gain.setTargetAtTime(this.eq[2], t, 0.03);
};

// CW peak follows the centre of the current passband.
Plugins.k2aam_nr.applyPeak = function (s) {
    var f = this.filters;
    if (!f) return;
    var on = s.peak && !s.ab, t = f.ctx.currentTime;
    if (on) {
        try {
            var b = UI.getDemodulator().getBandpass();
            var centre = Math.abs((b.low_cut + b.high_cut) / 2);
            if (centre >= 200 && centre <= 3000) f.bp.frequency.setTargetAtTime(centre, t, 0.02);
        } catch (e) { /* keep the last centre */ }
    }
    f.dry.gain.setTargetAtTime(on ? 0.25 : 1, t, 0.02);
    f.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
};

// Per-mode-family memory of the NR controls. When the family changes, the
// previous family's settings are kept and the new family's are restored.
Plugins.k2aam_nr.followFamily = function (s) {
    if (s.family === this.family) {
        if (s.family) {
            var now = { enabled: s.wanted.enabled, level: s.level, notch: this.notch, profile: this.profile };
            var old = this.memory[s.family];
            if (!old || JSON.stringify(old) !== JSON.stringify(now)) {
                this.memory[s.family] = now;
                this.store('k2aam_nr_modes', this.memory);
            }
        }
        return false;
    }
    this.family = s.family;
    var saved = s.family && this.memory[s.family];
    if (!saved) return false;
    this.notch = !!saved.notch;
    this.profile = this.PROFILES.indexOf(saved.profile) >= 0 ? saved.profile : 'normal';
    if (typeof saved.level === 'number') UI.setNR(saved.level);
    if (!!UI.nrEnabled !== !!saved.enabled) UI.toggleNR(!!saved.enabled);
    return true;
};

Plugins.k2aam_nr.setNotch = function (on) {
    this.notch = !!on;
    LS.save('k2aam_nr_notch', this.notch);
    this.apply();
};

Plugins.k2aam_nr.setProfile = function (profile) {
    this.profile = this.PROFILES.indexOf(profile) >= 0 ? profile : 'normal';
    LS.save('k2aam_nr_profile', this.profile);
    this.apply();
};

// Push the current state to the worklet and the buttons, if it changed.
Plugins.k2aam_nr.apply = function () {
    if (this._applying) return;
    this._applying = true;
    try { this._apply(); } finally { this._applying = false; }
};

Plugins.k2aam_nr._apply = function () {
    var s = this.getState();
    if (this.followFamily(s)) s = this.getState();
    this.applyPeak(s);
    if (s.enabled && s.profile === 'voice' && !this.voiceState) this.loadVoice();
    var msg = { enabled: s.enabled, strength: s.strength, notch: s.notch, profile: s.profile,
                tilt: s.tilt, bypass: s.ab };
    var key = JSON.stringify(msg) + s.bypass + s.notchAvailable + this.notch + s.peak + s.peakAvailable
        + s.voiceAvailable + this.profile + this.voiceState;
    var rebuilt = this.placeButtons();
    if (key === this.sent && !rebuilt) return;

    if (this.node && key !== this.sent) this.node.port.postMessage(msg);
    this.sent = key;

    $('#openwebrx-panel-nr').attr('title', s.bypass
        ? 'Noise reduction is bypassed in ' + s.mode.toUpperCase() + ' mode'
        : 'Noise reduction strength (' + Math.round(s.strength * 100) + '%)');

    $('.k2aam-nr-notch')
        .toggleClass('highlighted rd-active', s.notch)
        .attr('aria-pressed', String(s.notch))
        .toggleClass('disabled', !s.notchAvailable)
        .attr('title', s.notchAvailable
            ? 'Auto-notch: remove steady tones (heterodynes)'
            : (this.profile === 'beacon'
                ? 'Auto-notch is off in beacon mode, where steady tones are the signal'
                : 'Auto-notch works in SSB, AM and FM voice modes only'));
    $('.k2aam-nr-peak')
        .toggleClass('highlighted rd-active', s.peak)
        .attr('aria-pressed', String(s.peak))
        .toggleClass('disabled', !s.peakAvailable)
        .attr('title', s.peakAvailable
            ? 'CW peak: narrow filter on the CW tone, follows the passband centre'
            : 'CW peak works in CW mode only');
    var voiceOn = this.profile === 'voice';
    $('.k2aam-nr-voice')
        .toggleClass('highlighted rd-active', voiceOn && s.voiceAvailable)
        .attr('aria-pressed', String(voiceOn))
        .toggleClass('disabled', !s.voiceAvailable)
        .text(voiceOn && this.voiceState === 'loading' ? 'Voice…' : 'Voice')
        .attr('title', !s.voiceAvailable
            ? 'Voice (AI) noise reduction works in SSB and AM only'
            : /^failed/.test(this.voiceState)
                ? 'Voice (AI) could not start (' + this.voiceState.slice(8) + '); the normal NR is used instead'
                : 'Voice: AI speech noise reduction (RNNoise). Removes everything that is not speech. The NR slider blends in the original audio.');
    $('.k2aam-nr-ab').toggleClass('highlighted rd-active', s.ab).attr('aria-pressed', String(s.ab));
    $('.k2aam-nr-beacon')
        .toggleClass('highlighted rd-active', s.profile === 'beacon')
        .attr('aria-pressed', String(s.profile === 'beacon'))
        .toggleClass('disabled', s.bypass)
        .attr('title', 'Beacon mode: longer analysis for weak steady carriers. Smears speech and fast CW.');

    // Make sure the server is not also running its own NR on our audio.
    if (s.wanted.enabled !== this.lastEnabled) {
        this.lastEnabled = s.wanted.enabled;
        this.serverNrOff();
    }
};

// The Notch and Beacon buttons. They go wherever the NR control currently
// lives: in the K2AAM Dock / Console noise reduction group when that UI is
// mounted, otherwise on a line of their own under the stock NR slider. The
// dock can be mounted or removed at any time, so this is re-checked on every
// poll and the buttons follow. Returns true when they were (re)built.
Plugins.k2aam_nr.placeButtons = function () {
    var self = this;
    var dockGroup = document.querySelector('#k2aam-dock .rd-nr');
    var $stockLine = $('.openwebrx-nr-toggle').closest('.openwebrx-panel-line');
    var where = dockGroup ? 'dock' : ($stockLine.length ? 'stock' : '');
    var $box = $('.k2aam-nr-buttons');

    if ($box.length && $box.attr('data-where') === where && $box[0].isConnected) return false;
    $('.k2aam-nr-line').remove();
    $box.remove();
    if (!where) return false;

    var kind = where === 'dock' ? 'rd-button' : 'openwebrx-button';
    $box = $(
        '<div class="k2aam-nr-buttons" data-where="' + where + '">'
      + '<button type="button" class="' + kind + ' k2aam-nr-btn k2aam-nr-notch">Notch</button>'
      + '<button type="button" class="' + kind + ' k2aam-nr-btn k2aam-nr-beacon">Beacon</button>'
      + '<button type="button" class="' + kind + ' k2aam-nr-btn k2aam-nr-voice">Voice</button>'
      + '<button type="button" class="' + kind + ' k2aam-nr-btn k2aam-nr-peak">Peak</button>'
      + '<button type="button" class="' + kind + ' k2aam-nr-btn k2aam-nr-ab" title="Hold to hear the audio without NR, Notch or Peak">A/B</button>'
      + '</div>'
    );
    if (where === 'dock') {
        $(dockGroup).append($box);
    } else {
        $stockLine.after($('<div class="openwebrx-panel-line k2aam-nr-line"></div>').append($box));
    }
    $box.find('.k2aam-nr-notch').on('click', function () { self.setNotch(!self.notch); });
    $box.find('.k2aam-nr-beacon').on('click', function () {
        self.setProfile(self.profile === 'beacon' ? 'normal' : 'beacon');
    });
    $box.find('.k2aam-nr-peak').on('click', function () { self.setPeak(!self.peak); });
    $box.find('.k2aam-nr-voice').on('click', function () {
        self.setProfile(self.profile === 'voice' ? 'normal' : 'voice');
        // turning Voice on implies wanting NR on
        if (self.profile === 'voice' && !UI.nrEnabled) UI.toggleNR(true);
    });
    // A/B is held: pointer or touch down to compare, up (or leaving) to return.
    // Space or Enter held on the focused button does the same.
    var ab = $box.find('.k2aam-nr-ab');
    ab.on('pointerdown', function (e) { e.preventDefault(); try { this.setPointerCapture(e.pointerId); } catch (x) {} self.setAB(true); });
    ab.on('pointerup pointercancel lostpointercapture', function () { self.setAB(false); });
    ab.on('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); self.setAB(true); } });
    ab.on('keyup blur', function () { self.setAB(false); });
    ab.on('contextmenu', function (e) { e.preventDefault(); });
    return true;
};

Plugins.k2aam_nr.serverNrOff = function () {
    try {
        if (typeof ws !== 'undefined' && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                'type': 'connectionproperties',
                'params': { 'nr_enabled': false }
            }));
        }
    } catch (e) { /* not connected yet; the server default is off */ }
};

// Live tuning from the browser console, for adjusting by ear. Example:
//     Plugins.k2aam_nr.tune({ ddAlphaBase: 0.98 })
// Settings last until the page is reloaded. See the README for the names.
Plugins.k2aam_nr.tune = function (values) {
    if (!this.node) return 'k2aam_nr is not active';
    this.node.port.postMessage({ tune: values });
    return 'ok';
};

// EQ panel for the K2AAM Dock ("Audio"). Returns { node, destroy() }.
Plugins.k2aam_nr.createAudioPanel = function () {
    var self = this;
    var node = document.createElement('div');
    node.className = 'k2aam-nr-audio';
    var names = ['Bass', 'Mid', 'Treble'], sliders = [], values = [];
    var presets = document.createElement('div');
    presets.className = 'k2aam-nr-presets';
    Object.keys(self.EQ_PRESETS).forEach(function (name) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'rd-button'; b.textContent = name;
        b.addEventListener('click', function () { self.setEq(self.EQ_PRESETS[name]); });
        presets.append(b);
    });
    node.append(presets);
    names.forEach(function (name, i) {
        var row = document.createElement('label');
        row.className = 'k2aam-nr-eq-row';
        var label = document.createElement('span'); label.textContent = name;
        var input = document.createElement('input');
        input.type = 'range'; input.min = '-12'; input.max = '12'; input.step = '1';
        input.setAttribute('aria-label', name + ' (dB)');
        var value = document.createElement('span'); value.className = 'k2aam-nr-eq-value';
        input.addEventListener('input', function () {
            var g = self.eq.slice(); g[i] = Number(input.value); self.setEq(g);
        });
        row.append(label, input, value);
        node.append(row);
        sliders.push(input); values.push(value);
    });
    var note = document.createElement('p');
    note.className = 'rd-note';
    note.textContent = 'Only your audio changes. Bass shelf at 250 Hz, mid at 1.2 kHz, treble shelf at 2.5 kHz. '
        + 'AM clarity helps when NR makes AM sound muffled.';
    node.append(note);
    function render() {
        self.eq.forEach(function (g, i) {
            sliders[i].value = String(g);
            values[i].textContent = (g > 0 ? '+' : '') + g + ' dB';
        });
    }
    self._eqListeners = self._eqListeners || [];
    self._eqListeners.push(render);
    render();
    return {
        node: node,
        destroy: function () {
            self._eqListeners = self._eqListeners.filter(function (fn) { return fn !== render; });
            node.remove();
        }
    };
};

// Fetch and compile rnnoise.wasm (about 1 MB) the first time Voice is used,
// then hand the compiled module to the audio worklet.
Plugins.k2aam_nr.loadVoice = function () {
    var self = this;
    if (!self.node || self.voiceState) return;
    self.voiceState = 'loading';
    var url = self.base + 'rnnoise.wasm?v=' + self._version;
    fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
    }).then(function (bytes) {
        return WebAssembly.compile(bytes);
    }).then(function (module) {
        self.node.port.postMessage({ rnnoise: module });
    }).catch(function (e) {
        self.voiceMessage({ voiceError: e && e.message ? e.message : String(e) });
    });
};

Plugins.k2aam_nr.voiceMessage = function (d) {
    if (d.voiceReady) {
        this.voiceState = 'ready';
        console.info('k2aam_nr: Voice (RNNoise 0.2) ready.');
    } else if (d.voiceError) {
        this.voiceState = 'failed: ' + d.voiceError;
        console.error('k2aam_nr: Voice could not start: ' + d.voiceError);
    } else {
        return;
    }
    this.sent = '';
    this.apply();
};
