/*
 * K2AAM NR - better noise reduction for OpenWebRX+ (receiver plugin).
 *
 * Replaces what the stock NR button and slider do. Instead of asking the
 * server to run its spectral gate, the audio is cleaned up in the browser by
 * k2aam_nr_worklet.js, spliced in between the OpenWebRX+ audio worklet and
 * the volume control:
 *
 *     audioNode -> [k2aam-nr-processor] -> gainNode -> speakers
 *
 * Any UI that calls UI.toggleNR() / UI.setNR() keeps working unchanged.
 * Two extra buttons are added under the NR slider:
 *
 *     Notch   removes steady tones (heterodynes) in voice modes
 *     Beacon  longer analysis, digs out weak steady carriers
 *
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

Plugins.k2aam_nr._version = 0.3;

// Modes where the audio is already clean, is music, or is not audio at all.
// Everything is bypassed in these.
Plugins.k2aam_nr.BYPASS_MODES = [
    'wfm', 'bcfm', 'iq', 'drm', 'dab', 'hdr',
    'dmr', 'dstar', 'nxdn', 'ysf', 'p25', 'm17', 'freedv', 'tetra', 'radel', 'radeu'
];

// Modes where removing steady tones is wanted. Not CW, where the tone is
// the signal, and not while a digital decoder is selected.
Plugins.k2aam_nr.NOTCH_MODES = ['usb', 'lsb', 'am', 'sam', 'nfm'];

Plugins.k2aam_nr.init = function () {
    var self = this;
    self.node = null;
    self.sent = '';
    self.lastEnabled = null;
    self.notch = LS.has('k2aam_nr_notch') ? LS.loadBool('k2aam_nr_notch') : false;
    self.profile = LS.has('k2aam_nr_profile') && LS.loadStr('k2aam_nr_profile') === 'beacon'
        ? 'beacon' : 'normal';
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
        source.disconnect(sink);
        source.connect(node);
        node.connect(sink);
        self.node = node;
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
    return {
        mode: mode.secondary || mode.primary,
        bypass: bypass,
        notchAvailable: notchOk,
        wanted: { enabled: !!UI.nrEnabled, notch: this.notch, profile: this.profile },
        enabled: !!UI.nrEnabled && !bypass,
        notch: this.notch && notchOk,
        profile: this.profile,
        strength: Math.min(1, Math.max(0, (level + 20) / 40))
    };
};

// Point the stock NR controls at the worklet instead of the server.
Plugins.k2aam_nr.takeOver = function () {
    var self = this;
    self.stockUpdateNR = UI.updateNR;
    UI.updateNR = function () { self.apply(); };
    self.addButtons();
    self.apply();
    // follow mode changes
    setInterval(function () { self.apply(); }, 500);
};

Plugins.k2aam_nr.setNotch = function (on) {
    this.notch = !!on;
    LS.save('k2aam_nr_notch', this.notch);
    this.apply();
};

Plugins.k2aam_nr.setProfile = function (profile) {
    this.profile = profile === 'beacon' ? 'beacon' : 'normal';
    LS.save('k2aam_nr_profile', this.profile);
    this.apply();
};

// Push the current state to the worklet and the buttons, if it changed.
Plugins.k2aam_nr.apply = function () {
    var s = this.getState();
    var msg = { enabled: s.enabled, strength: s.strength, notch: s.notch, profile: s.profile };
    var key = JSON.stringify(msg) + s.bypass + s.notchAvailable + this.notch;
    if (key === this.sent) return;
    this.sent = key;

    if (this.node) this.node.port.postMessage(msg);

    $('#openwebrx-panel-nr').attr('title', s.bypass
        ? 'Noise reduction is bypassed in ' + s.mode.toUpperCase() + ' mode'
        : 'Noise reduction strength (' + Math.round(s.strength * 100) + '%)');

    $('.k2aam-nr-notch')
        .toggleClass('highlighted', s.notch)
        .toggleClass('disabled', !s.notchAvailable)
        .attr('title', s.notchAvailable
            ? 'Auto-notch: remove steady tones (heterodynes)'
            : (this.profile === 'beacon'
                ? 'Auto-notch is off in beacon mode, where steady tones are the signal'
                : 'Auto-notch works in SSB, AM and FM voice modes only'));
    $('.k2aam-nr-beacon')
        .toggleClass('highlighted', s.profile === 'beacon')
        .toggleClass('disabled', s.bypass)
        .attr('title', 'Beacon mode: longer analysis for weak steady carriers. Smears speech and fast CW.');

    // Make sure the server is not also running its own NR on our audio.
    if (s.wanted.enabled !== this.lastEnabled) {
        this.lastEnabled = s.wanted.enabled;
        this.serverNrOff();
    }
};

// Two small buttons under the stock NR line. Skipped quietly when the stock
// receiver panel is not there (custom UIs can use setNotch / setProfile).
Plugins.k2aam_nr.addButtons = function () {
    var self = this;
    var $line = $('.openwebrx-nr-toggle').closest('.openwebrx-panel-line');
    if (!$line.length || $('.k2aam-nr-line').length) return;
    $line.after(
        '<div class="openwebrx-panel-line k2aam-nr-line">'
      + '<div class="openwebrx-button k2aam-nr-notch">Notch</div>'
      + '<div class="openwebrx-button k2aam-nr-beacon">Beacon</div>'
      + '</div>'
    );
    $('.k2aam-nr-notch').on('click', function () { self.setNotch(!self.notch); });
    $('.k2aam-nr-beacon').on('click', function () {
        self.setProfile(self.profile === 'beacon' ? 'normal' : 'beacon');
    });
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
