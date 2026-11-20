/*
 * ALE plugin for OpenWebRX+: receive-only ALE panel, bank scanner and
 * reception log. Load with Plugins.load('ale') from init.js.
 *
 * The browser side is entirely in this file. Decoding happens on the
 * server and needs this fork's ALE backend (owrx/ale*.py and the owrx-ale
 * decoder); on a server without it the plugin stays hidden.
 */
'use strict';

class AleScanController {
    constructor(api) { this.api = api; this.running = false; this.generation = 0; }
    status(text) { this.api.status(text); }
    stop(reason = 'Stopped') {
        this.running = false; this.generation++; this.tuning = false;
        if (this.cancelTune) this.cancelTune();
        this.cancelTune = null; this.status(reason);
    }
    async start(channels, options) {
        this.stop();
        if (!Number.isFinite(options.dwell) || options.dwell < 3 || options.dwell > 60)
            throw new Error('Dwell must be between 3 and 60 seconds.');
        const snap = this.api.snapshot();
        if (!snap.connected || snap.mode !== 'ale2g') throw new Error('Select ALE 2G on a connected receiver first.');
        this.shared = !!options.shared; this.dwell = options.dwell * 1000;
        this.channels = [...new Set(channels)].filter(f => Number.isSafeInteger(f) && f > 0 &&
            (this.shared || this.api.fits(f)));
        if (!this.channels.length) throw new Error('No enabled bank channels fit this capture. Select another profile or enable Scan across HF bands.');
        this.api.stopNativeScanner(); this.profile = snap.profile; this.socket = snap.socket;
        this.running = true; this.index = -1;
        await this.next();
    }
    async next() {
        if (!this.running) return;
        const generation = this.generation;
        this.index = (this.index + 1) % this.channels.length;
        this.frequency = this.channels[this.index]; this.active = false; this.holdStart = null;
        this.releaseAt = 0; this.tuning = true;
        this.status('Tuning ' + (this.frequency / 1000).toFixed(1) + ' kHz…');
        try {
            await this.api.tune(this.frequency, this.shared, () => this.running && generation === this.generation,
                cancel => { this.cancelTune = cancel; });
            if (!this.running || generation !== this.generation) return;
            this.cancelTune = null; this.capture = this.api.snapshot().center;
            this.tuning = false; this.deadline = this.api.now() + this.dwell;
            this.status('Scanning ' + (this.index + 1) + '/' + this.channels.length + ' · ' +
                (this.frequency / 1000).toFixed(1) + ' kHz');
        } catch (error) {
            if (generation === this.generation) this.stop(error.message);
        }
    }
    event(message) {
        if (message.test_audio) { this.stop('TEST AUDIO — scanning stopped'); return; }
        if (!this.running || this.tuning || message.freq !== this.frequency) return;
        const now = this.api.now();
        if (message.event === 'activity') {
            this.active = message.active;
            if (!message.active && this.holdStart === null) return;
        }
        if (this.holdStart === null) this.holdStart = now;
        this.releaseAt = now + 3000;
        this.status((message.event === 'activity' ? 'Activity / hold' : 'Decoded / hold') + ' · ' +
            (this.frequency / 1000).toFixed(1) + ' kHz');
    }
    tick() {
        if (!this.running) return;
        const snap = this.api.snapshot();
        if (!snap.connected || snap.socket !== this.socket) return this.stop('Stopped: receiver disconnected');
        if (snap.profile !== this.profile) return this.stop('Stopped: receiver/profile changed');
        if (snap.hidden) return this.stop('Stopped: receiver tab is hidden');
        if (snap.nativeScanner) return this.stop('Stopped: stock Scanner started');
        if (this.tuning) return;
        if (snap.mode !== 'ale2g' || Math.abs(snap.frequency - this.frequency) > 1 || snap.center !== this.capture)
            return this.stop('Stopped: manual tuning, mode, or SDR center changed');
        const now = this.api.now();
        if (this.holdStart !== null) {
            if (now - this.holdStart < 120000 && (this.active || now < this.releaseAt)) return;
        } else if (now < this.deadline) return;
        void this.next();
    }
}

function aleNativeScanApi(status) {
    const fits = frequency => {
        const demod = UI.getDemodulator();
        const pass = demod && demod.get_bandpass ? demod.get_bandpass() : {low_cut:600, high_cut:2650};
        return typeof center_freq === 'number' && typeof bandwidth === 'number' && bandwidth > 0 &&
            frequency + Math.min(200, pass.low_cut) > center_freq - bandwidth / 2 &&
            frequency + Math.max(2800, pass.high_cut) < center_freq + bandwidth / 2;
    };
    const snapshot = () => ({
        connected: typeof ws !== 'undefined' && ws && ws.readyState === 1,
        socket: typeof ws !== 'undefined' ? ws : null,
        mode: UI.getModulation(), frequency: UI.getFrequency(),
        center: typeof center_freq !== 'undefined' ? center_freq : null,
        profile: $('#openwebrx-sdr-profiles-listbox').val(), hidden: document.hidden,
        nativeScanner: typeof scanner !== 'undefined' && scanner.isRunning()
    });
    return {
        now: () => performance.now(), status, snapshot, fits,
        stopNativeScanner: () => UI.toggleScanner(false),
        tune: (frequency, shared, alive, onCancel) => new Promise((resolve, reject) => {
            if (!alive()) return reject(new Error('Scan cancelled'));
            if (fits(frequency)) {
                if (UI.setFrequency(frequency, false) === false || Math.abs(UI.getFrequency() - frequency) > 1)
                    return reject(new Error('Receiver refused tuning'));
                return resolve();
            }
            if (!shared) return reject(new Error('Channel no longer fits the capture'));
            const initial = snapshot(), sock = initial.socket;
            if (!initial.connected) return reject(new Error('Receiver disconnected'));
            let acknowledged = false, timer, settled = false;
            const deadline = performance.now() + 10000;
            const done = error => {
                if (settled) return;
                settled = true;
                clearInterval(timer); sock.removeEventListener('message', receive);
                error ? reject(new Error(error)) : resolve();
            };
            const receive = event => {
                if (typeof event.data !== 'string') return;
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'config' && data.value) {
                        if (data.value.allow_center_freq_changes === false) return done('Server does not allow SDR retuning');
                        if (data.value.center_freq === frequency) acknowledged = true;
                    }
                } catch (_) { /* Non-config messages are irrelevant. */ }
            };
            sock.addEventListener('message', receive);
            onCancel(() => done('Scan cancelled'));
            timer = setInterval(() => {
                const current = snapshot(), panel = UI.getDemodulatorPanel();
                if (!alive() || current.hidden || current.profile !== initial.profile || current.socket !== sock || !current.connected)
                    return done('Tuning cancelled: receiver changed or disconnected');
                if (!acknowledged && (current.center !== initial.center || Math.abs(current.frequency-initial.frequency)>1))
                    return done('Tuning cancelled: manual tuning or external SDR center change');
                if (performance.now() > deadline) return done('Retune timed out: check server permission, magic key, and SDR range');
                if (!acknowledged || panel.centerFreqTimeout || panel.center_freq !== center_freq || !fits(frequency)) return;
                UI.setModulation('ale2g');
                if (UI.setFrequency(frequency, false) === false || Math.abs(UI.getFrequency() - frequency) > 1)
                    return done('SDR moved but listening frequency was refused');
                done();
            }, 100);
            try {
                sock.send(JSON.stringify({type:'setfrequency',params:{frequency, key:UI.getDemodulatorPanel().getMagicKey()}}));
            } catch (error) { done(error.message); }
        })
    };
}

// Generated from contrib/ale/channels.json; no live activity is implied.
const ALE_SCAN_BANKS = [
  {
    "id": "hfn_us_hf",
    "name": "Amateur HFN \u2014 US HF",
    "channels": [
      1843000,
      3596000,
      7102000,
      10145500,
      14109000,
      18106000,
      21096000,
      24926000,
      28146000
    ]
  },
  {
    "id": "hfl_us_hf",
    "name": "Amateur HFL \u2014 US HF",
    "channels": [
      1996000,
      3996000,
      5357000,
      5371500,
      7296000,
      10131000,
      14346000,
      18117500,
      21432500,
      24932000,
      28312500
    ]
  },
  {
    "id": "cothen_candidates",
    "name": "COTHEN \u2014 monitoring candidates",
    "channels": [
      5250000,
      5732000,
      5909500,
      7527000,
      8912000,
      10242000,
      11494000,
      12222000,
      13312000,
      13907000,
      14582000,
      15867000,
      18594000,
      20890000,
      24838500
    ]
  },
  {
    "id": "hfgcs_candidates",
    "name": "HFGCS ALE \u2014 monitoring candidates",
    "channels": [
      3137000,
      4721000,
      5708000,
      6721000,
      9025000,
      11226000,
      13215000,
      15043000,
      18003000,
      23337000
    ]
  }
];

// The browser observes and controls the background worker; it does not own it.
class AleServerScanClient {
    constructor(status, event, reset = () => {}) {
        this.status = status; this.event = event; this.running = false;
        this.reset = reset;
        this.socket = null; this.session = null; this.sequence = 0; this.pending = false;
        this.requestedStart = false;
        this.logRequests = new Map(); this.logSerial = 0;
        this.receive = this.receive.bind(this);
        this.timer = setInterval(() => this.poll(), 2000);
    }
    sourceId() {
        return String($('#openwebrx-sdr-profiles-listbox').val() || '').split('|')[0];
    }
    observerIntent(source, session, save) {
        if (!source) return false;
        try {
            const key = 'owrx_ale_observer_v1:' + source;
            if (save === true && typeof session === 'string') sessionStorage.setItem(key, session);
            else if (save === false) sessionStorage.removeItem(key);
            return typeof session === 'string' && sessionStorage.getItem(key) === session;
        } catch (_) { return false; } // Storage denial must not break live controls.
    }
    send(action, options = {}) {
        this.bind();
        if (!this.socket || this.socket.readyState !== 1) throw new Error('Receiver disconnected');
        this.socket.send(JSON.stringify({type:'ale_scan', params:{...options, action, after:this.sequence,
            key:action === 'status' ? undefined : UI.getDemodulatorPanel().getMagicKey()}}));
    }
    bind() {
        const current = typeof ws !== 'undefined' ? ws : null;
        if (current === this.socket) return;
        if (this.socket) this.socket.removeEventListener('message', this.receive);
        this.socket = current;
        if (current) current.addEventListener('message', this.receive);
    }
    poll() {
        if (this.pending && performance.now()-this.pendingSince > 12000) {
            this.pending = false; this.requestedStart = false;
            this.status('No server scanner response: restart OWRX after upgrading');
        }
        this.bind();
        if (this.socket && this.socket.readyState === 1) {
            try { this.send('status'); } catch (_) { /* Retry after reconnect. */ }
        }
    }
    start(options) {
        this.following = true; this.manualTakeover = false;
        this.requestedStart = true;
        this.followingSource = this.sourceId();
        this.pending = true; this.pendingSince = performance.now(); this.status('Starting server scanner…');
        try { this.send('start', options); }
        catch (error) { this.pending = false; this.requestedStart = false; this.status(error.message); }
    }
    stop() {
        this.following = false; this.manualTakeover = true; this.requestedStart = false;
        this.followingSource = this.sourceId() || this.followingSource;
        this.observerIntent(this.followingSource, null, false);
        this.pending = true; this.pendingSince = performance.now(); this.status('Stopping server scanner…');
        try { this.send('stop'); }
        catch (error) { this.pending = false; this.status(error.message); }
    }
    takeControl() {
        if (this.handoff) return this.handoff;
        this.manualTakeover = true; this.handoffError = null;
        this.stop();
        this.handoff = (async () => {
            const deadline = performance.now()+12000;
            while (this.running || this.pending) {
                if (this.handoffError) throw new Error(this.handoffError);
                if (performance.now() >= deadline) throw new Error('ALE scanner did not stop; manual tuning was cancelled');
                await new Promise(resolve => setTimeout(resolve,100));
                this.poll();
            }
            if (this.handoffError) throw new Error(this.handoffError);
        })().finally(() => { this.handoff = null; });
        return this.handoff;
    }
    requestLog(action = 'log', options = {}) {
        const request_id = String(++this.logSerial);
        const source = String($('#openwebrx-sdr-profiles-listbox').val() || '').split('|')[0];
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.logRequests.delete(request_id);
                reject(new Error('No ALE log response: restart OWRX after upgrading'));
            }, 12000);
            this.logRequests.set(request_id, {resolve, reject, timer, source});
            try { this.send(action, {...options, request_id}); }
            catch (error) { clearTimeout(timer); this.logRequests.delete(request_id); reject(error); }
        });
    }
    receive(event) {
        if (typeof event.data !== 'string') return;
        let data;
        try { data = JSON.parse(event.data); } catch (_) { return; }
        if (data.type !== 'ale_scan_state' || !data.value) return;
        const state = data.value;
        if (state.kind === 'log') {
            const request = this.logRequests.get(state.request_id);
            if (!request) return;
            clearTimeout(request.timer); this.logRequests.delete(state.request_id);
            const current = String($('#openwebrx-sdr-profiles-listbox').val() || '').split('|')[0];
            if (request.source !== current || state.source_id !== current)
                request.reject(new Error('Receiver changed; request cancelled'));
            else if (state.error) request.reject(new Error(state.error));
            else request.resolve(state);
            return;
        }
        if (state.error) { this.pending = false; this.requestedStart = false; this.handoffError = state.error; this.status(state.error); return; }
        if (!state.available) return;
        const selectedSource = String($('#openwebrx-sdr-profiles-listbox').val() || '').split('|')[0];
        if (state.source_id !== selectedSource) return;
        this.pending = this.requestedStart && !state.running;
        if (state.running || state.stopping) this.requestedStart = false;
        if (this.followingSource !== selectedSource) {
            this.followingSource = selectedSource; this.following = false; this.manualTakeover = false; this.requestedStart = false; this.pending = false;
        }
        if (state.session !== this.session) {
            if (this.session !== null || (Array.isArray(state.events) && state.events.length)) this.reset();
            this.session = state.session; this.sequence = 0;
        }
        this.running = !!state.running;
        this.state = state;
        if (Array.isArray(state.events)) for (const message of state.events) {
            if (Number.isSafeInteger(message.scan_seq) && message.scan_seq > this.sequence) {
                this.sequence = message.scan_seq;
                this.event(message);
            }
        }
        if (!this.running || state.stopping) {
            if (!this.requestedStart) {
                this.following = false; this.observerIntent(selectedSource, null, false);
            }
        } else if (!this.manualTakeover && (this.following || UI.getModulation() === 'ale2g' ||
                   this.observerIntent(selectedSource, state.session))) {
            this.following = true;
            this.observerIntent(selectedSource, state.session, true);
        }
        if (this.running && this.following && !this.manualTakeover && Number.isSafeInteger(state.frequency)) {
            // Follow inside the hardware capture only; never send a hardware retune from polling.
            const panel = UI.getDemodulatorPanel();
            if (!panel.centerFreqTimeout && panel.center_freq === center_freq &&
                Math.abs(state.frequency-center_freq)+2800 < bandwidth/2 && UI.getDemodulator()) {
                UI.setModulation('ale2g');
                UI.setFrequency(state.frequency, false);
            }
        }
        this.status(state.status || 'Stopped');
    }
    resume() {
        if (!this.timer) this.timer = setInterval(() => this.poll(), 2000);
        this.poll();
    }
    destroy() {
        clearInterval(this.timer); this.timer = null;
        if (this.socket) this.socket.removeEventListener('message', this.receive);
        this.socket = null;
        for (const request of this.logRequests.values()) {
            clearTimeout(request.timer); request.reject(new Error('Receiver page closed'));
        }
        this.logRequests.clear();
        // Deliberately do not send stop when a tab is hidden, navigated or closed.
    }
}

function aleLogCsvCell(value) {
    let text = String(value == null ? '' : value);
    // Quoting alone does not prevent spreadsheets from executing radio-supplied formulas.
    if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}

function aleLogCsvRow(message) {
    return [new Date(message.timestamp).toISOString(), message.source_id, message.freq,
        message.source, message.destination, message.event, message.message, message.bank]
        .map(aleLogCsvCell).join(',') + '\r\n';
}

/* Browser integration. Skipped when this file is loaded outside OpenWebRX+ (unit tests). */
if (typeof Plugins !== 'undefined' && typeof MessagePanel !== 'undefined' && typeof jQuery !== 'undefined') (function ($) {
    const plugin = Plugins.ale = Plugins.ale || {};
    plugin._version = '0.6.1';
    plugin.no_css = true;
    const MODE = 'ale2g', PANEL = 'openwebrx-panel-ale2g-message';

    function Ale2gMessagePanel(el) {
        MessagePanel.call(this, el);
    }
    Ale2gMessagePanel.prototype = Object.create(MessagePanel.prototype);
    Ale2gMessagePanel.prototype.supportsMessage = function(message) {
        return message.mode === 'ALE2G';
    };
    Ale2gMessagePanel.prototype.render = function() {
        const me = this;
        if (!document.getElementById('ale-scan-style')) {
            $('<style id="ale-scan-style">').text(
                '.ale-layout{display:flex;flex-direction:column;min-height:0;height:100%}' +
                '.ale-layout>table{display:flex;flex-direction:column;width:100%;flex:1 1 0;min-height:24px;height:auto!important}' +
                '.ale-layout thead{flex:0 0 auto}.ale-layout tbody{scrollbar-gutter:stable}' +
                '#openwebrx-panel-ale2g-message .ale-layout tr{display:grid;grid-template-columns:76px 94px 88px 88px 160px minmax(0,1fr);width:100%;box-sizing:border-box}' +
                '#openwebrx-panel-ale2g-message .ale-layout th,#openwebrx-panel-ale2g-message .ale-layout td{text-align:left;min-width:0;width:auto!important;padding:5px 7px;overflow-wrap:anywhere;white-space:normal;box-sizing:border-box}' +
                '#openwebrx-panel-ale2g-message .ale-layout th{color:#a7bad0;font-size:11px}' +
                '.ale-layout tbody tr{border-top:1px solid #ffffff0a;font-variant-numeric:tabular-nums}' +
                '.ale-event{color:#9de2c3}.ale-raw{display:inline-block;margin-left:10px;vertical-align:top;font-size:11px;color:#a7bad0}' +
                '.ale-raw summary{cursor:pointer}.ale-raw pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0}' +
                '@media(max-width:620px){#openwebrx-panel-ale2g-message .ale-layout tr{grid-template-columns:66px 62px minmax(0,1fr) minmax(0,.7fr) 104px}' +
                '#openwebrx-panel-ale2g-message .ale-layout th,#openwebrx-panel-ale2g-message .ale-layout td{padding:5px 4px}' +
                '#openwebrx-panel-ale2g-message .ale-layout thead th:nth-child(6){display:none}' +
                '#openwebrx-panel-ale2g-message .ale-layout td:nth-child(6){grid-column:1/6;padding-top:0}' +
                '#openwebrx-panel-ale2g-message .ale-layout tr.ale-routine{cursor:pointer}' +
                '#openwebrx-panel-ale2g-message .ale-layout tr.ale-routine:not(.ale-open) td:nth-child(6){display:none}}' +
                '.ale-layout tbody{flex:1 1 0;min-height:0;height:auto!important;overflow:auto}' +
                '.ale-scan-controls{flex:0 1 auto;overflow:auto;padding:6px 55px 6px 6px;box-sizing:border-box;font:12px system-ui}' +
                '.ale-scan-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px}' +
                '.ale-scan-controls button,.ale-scan-controls select,.ale-scan-controls input{font:inherit;color:inherit;background:transparent;border:1px solid #65809a;border-radius:4px;padding:4px}' +
                '.ale-scan-controls select option{color:#111;background:#fff}' +
                '.ale-scan-controls input[type=number]{width:48px}.ale-scan-channels{max-height:90px;overflow:auto}' +
                '.ale-scan-channels label{display:inline-block;margin:3px 8px 3px 0}.ale-scan-status{overflow-wrap:anywhere}' +
                '.ale-log{flex:0 1 auto;padding:2px 6px 4px;font:12px system-ui}.ale-log>summary,.ale-scan-controls>summary{cursor:pointer;padding:3px 0}' +
                '.ale-log-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:4px 0;flex:0 0 auto}' +
                '.ale-log-tools button{font:inherit;color:inherit;background:transparent;border:1px solid #65809a;border-radius:4px;padding:4px}' +
                '.ale-log-status{overflow-wrap:anywhere;color:#a7bad0}.ale-heard{max-height:160px;overflow:auto;padding:4px 0}' +
                '.ale-heard-list{list-style:none;padding:0;margin:5px 0}.ale-heard-list li{display:grid;grid-template-columns:90px 160px minmax(0,1fr) 80px;gap:8px;padding:4px 0;border-top:1px solid #ffffff12;overflow-wrap:anywhere}' +
                '@media(max-width:620px){.ale-heard-list li{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.ale-heard-list li span:nth-child(3){grid-column:1/2}}'
            ).appendTo('head');
        }
        const layout = $('<div class="ale-layout">').appendTo(this.el);
        const controls = $('<details class="ale-scan-controls">').appendTo(layout);
        const summary = $('<summary>').text('ALE scanner · ').appendTo(controls);
        const status = $('<span class="ale-scan-status" role="status">').text('Stopped · current capture only').appendTo(summary);
        const row = $('<div class="ale-scan-row">').appendTo(controls);
        const bank = $('<select aria-label="ALE scan bank">').appendTo(row);
        ALE_SCAN_BANKS.forEach(b => $('<option>').val(b.id).text(b.name).appendTo(bank));
        const dwellLabel = $('<label>').text('Dwell (s) ').appendTo(row);
        const dwell = $('<input type="number" min="3" max="60" value="10" aria-label="ALE dwell seconds">').appendTo(dwellLabel);
        const start = $('<button type="button">').text('Start ALE scan').appendTo(row);
        const stop = $('<button type="button">').text('Stop').prop('disabled',true).appendTo(row);
        const engineRow = $('<div class="ale-scan-row">').appendTo(controls);
        const engineLabel = $('<label>').appendTo(engineRow);
        const server = $('<input type="checkbox" checked aria-label="Run scanner on server">').appendTo(engineLabel);
        engineLabel.append(document.createTextNode(' Run on server — continues with tab closed'));
        const scopeRow = $('<div class="ale-scan-row">').appendTo(controls);
        const scopeLabel = $('<label>').appendTo(scopeRow);
        const shared = $('<input type="checkbox" aria-label="Scan across HF bands">').appendTo(scopeLabel);
        scopeLabel.append(document.createTextNode(' Scan across HF bands (retunes SDR)'));
        const details = $('<details>').appendTo(controls);
        $('<summary>').text('Channels / skip · published plans and monitoring candidates').appendTo(details);
        const channels = $('<div class="ale-scan-channels">').appendTo(details);
        function renderChannels() {
            channels.empty();
            ALE_SCAN_BANKS.find(b => b.id === bank.val()).channels.forEach(frequency => {
                const label = $('<label>').appendTo(channels);
                $('<input type="checkbox" checked>').val(frequency).appendTo(label);
                label.append(document.createTextNode(' ' + (frequency/1000).toFixed(1) + ' kHz'));
            });
        }
        function updateControls(text) {
            const busy = !!(me.scanner && me.scanner.running) || !!(me.serverScanner && (me.serverScanner.running || me.serverScanner.pending));
            status.text(text); start.prop('disabled', busy); stop.prop('disabled', !busy);
            bank.add(dwell).add(shared).add(server).add(channels.find('input')).prop('disabled',busy);
        }
        this.scanner = new AleScanController(aleNativeScanApi(updateControls));
        this.serverScanner = new AleServerScanClient(text => {
            const state = me.serverScanner.state;
            if (me.serverScanner.running && state && state.options) {
                server.prop('checked',true);
                if (bank.val() !== state.bank) { bank.val(state.bank); renderChannels(); }
                dwell.val(state.options.dwell); shared.prop('checked',state.options.across);
                channels.find('input').each(function(){this.checked=state.options.channels.includes(Number(this.value));});
            }
            if (!me.serverScanner.running && me.serverWasRunning) restoreChannels();
            me.serverWasRunning = me.serverScanner.running;
            if (me.serverScanner.running && me.scanner.running) me.scanner.stop('Server scanner owns this SDR');
            if (server.prop('checked') || me.serverScanner.running) updateControls(text);
            if (state && state.log_error && me.logWarning) me.logWarning(state.log_error);
        }, event => me.pushMessage(event), () => me.el.find('tbody').empty());
        let loadedSource = null, preferences = {enabled:{}};
        const preferenceKey = 'owrx_ale_scan_preferences_v1';
        function currentSource() { return String($('#openwebrx-sdr-profiles-listbox').val() || '').split('|')[0]; }
        function savePreferences() {
            const source = currentSource(); if (!source) return;
            preferences.bank = bank.val(); preferences.dwell = Number(dwell.val());
            preferences.across = shared.prop('checked'); preferences.server = server.prop('checked');
            preferences.enabled[bank.val()] = channels.find('input:checked').map(function(){return Number(this.value);}).get();
            try {
                const stored = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
                stored[source] = preferences; localStorage.setItem(preferenceKey,JSON.stringify(stored));
            } catch (_) { /* Scanning remains usable with unavailable storage. */ }
        }
        function restoreChannels() {
            renderChannels();
            const selected = preferences.enabled[bank.val()];
            if (Array.isArray(selected)) channels.find('input').each(function(){ this.checked=selected.includes(Number(this.value)); });
        }
        function loadPreferences() {
            const source = currentSource(); if (!source || source === loadedSource) return;
            loadedSource = source; preferences = {enabled:{}};
            me.el.find('tbody').empty(); me.el.find('.ale-heard-list').empty();
            if (me.refreshLog) me.refreshLog();
            try {
                const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}')[source];
                if (saved && typeof saved === 'object') preferences = {...saved,enabled:saved.enabled && typeof saved.enabled === 'object' ? saved.enabled : {}};
            } catch (_) { /* Ignore damaged preferences. */ }
            const savedBank = ALE_SCAN_BANKS.find(item => item.id === preferences.bank);
            bank.val(savedBank ? savedBank.id : ALE_SCAN_BANKS[0].id);
            dwell.val(Number.isFinite(preferences.dwell) && preferences.dwell >= 3 && preferences.dwell <= 60 ? preferences.dwell : 10);
            shared.prop('checked',preferences.across === true); server.prop('checked',preferences.server !== false);
            restoreChannels();
        }
        window.owrxAleScanner = {
            isRunning: () => me.scanner.running || me.serverScanner.running || me.serverScanner.pending,
            status: () => status.text(),
            takeControl: () => {
                me.scanner.stop('Stopped: manual receiver control');
                return me.serverScanner.running || me.serverScanner.pending ? me.serverScanner.takeControl() : Promise.resolve();
            }
        };
        renderChannels(); loadPreferences();
        bank.on('change', () => { restoreChannels(); savePreferences(); });
        channels.on('change','input',savePreferences);
        dwell.add(shared).add(server).on('change',savePreferences);
        server.on('change', () => updateControls('Stopped · '+(server.prop('checked') ? 'server' : 'browser')));
        start.on('click', async () => {
            try {
                savePreferences();
                const selected = channels.find('input:checked').map(function(){return Number(this.value);}).get();
                if (server.prop('checked')) {
                    UI.toggleScanner(false);
                    me.scanner.stop();
                    me.serverScanner.start({bank:bank.val(), channels:selected, dwell:Number(dwell.val()), across:shared.prop('checked')});
                } else await me.scanner.start(selected, {dwell:Number(dwell.val()), shared:shared.prop('checked')});
            } catch(error) { updateControls(error.message); }
        });
        stop.on('click', () => {
            if (me.serverScanner.running || me.serverScanner.pending) me.serverScanner.stop();
            else me.scanner.stop();
        });
        this.scanTimer = setInterval(() => { this.scanner.tick(); if (!window.owrxAleScanner.isRunning()) loadPreferences(); }, 200);
        window.addEventListener('pagehide', () => {
            this.scanner.stop('Stopped: page closed');
            this.serverScanner.destroy();
        });
        window.addEventListener('pageshow', () => this.serverScanner.resume());
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.serverScanner.resume(); });
        window.addEventListener('online', () => this.serverScanner.resume());
        // One disclosure keeps export, refresh and the station list out of the
        // way of the decodes; its summary always shows the log status.
        const logBox = $('<details class="ale-log">').appendTo(layout);
        const logSummary = $('<summary>').text('Log · ').appendTo(logBox);
        const logStatus = $('<span class="ale-log-status" role="status">').text('loading…').appendTo(logSummary);
        const logTools = $('<div class="ale-log-tools">').appendTo(logBox);
        const exportLog = $('<button type="button">').text('Export CSV').appendTo(logTools);
        const refreshLog = $('<button type="button">').text('Refresh log').appendTo(logTools);
        const heard = $('<details class="ale-heard">').appendTo(logBox);
        const heardSummary = $('<summary>').text('Stations heard').appendTo(heard);
        const heardList = $('<ul class="ale-heard-list" aria-label="Stations heard from server scans">').appendTo(heard);
        let logBusy = false, lastLogSource = '', exportBusy = false;
        async function updateLog() {
            if (logBusy) return;
            logBusy = true;
            const source = currentSource();
            if (source !== lastLogSource) { heardList.empty(); lastLogSource = source; }
            try {
                const state = await me.serverScanner.requestLog();
                if (source !== currentSource()) return;
                logStatus.text(me.serverScanner.state && me.serverScanner.state.log_error || state.total.toLocaleString()+' saved decodes');
                logStatus.attr('title','Server scan log; newest '+state.retention.toLocaleString()+' receptions retained across receivers');
                heardSummary.text('Stations heard · '+state.stations.length+(state.stations.length === state.station_limit ? ' most recent' : ''));
                heardList.empty();
                if (!state.stations.length) $('<li>').text('No source addresses logged yet.').appendTo(heardList);
                for (const station of state.stations) {
                    const item = $('<li>').appendTo(heardList);
                    $('<strong>').text(station.address).appendTo(item);
                    $('<span>').text(new Date(station.timestamp).toISOString().replace('T',' ').slice(0,19)+' UTC').appendTo(item);
                    $('<span>').text(station.frequencies.map(f => (f/1000).toFixed(1)).join(', ')+' kHz').appendTo(item);
                    $('<span>').text(station.count+(station.count === 1 ? ' decode' : ' decodes')).appendTo(item);
                }
            } catch (error) { if (source === currentSource()) logStatus.text(error.message); }
            finally { logBusy = false; if (source !== currentSource()) updateLog(); }
        }
        this.refreshLog = updateLog;
        this.logWarning = text => logStatus.text(text);
        refreshLog.on('click',updateLog);
        heard.on('toggle', () => { if (heard.prop('open')) updateLog(); });
        logBox.on('toggle', () => { if (logBox.prop('open')) updateLog(); });
        exportLog.on('click', async () => {
            if (exportBusy) return;
            exportBusy = true; exportLog.prop('disabled',true);
            const source = currentSource();
            try {
                const chunks = ['UTC,Receiver,Frequency_Hz,From,To,Event,Message,Bank\r\n'];
                let after = 0, through, count = 0, expected;
                do {
                    if (source !== currentSource()) throw new Error('Receiver changed; export cancelled');
                    const page = await me.serverScanner.requestLog('export',{log_after:after,log_through:through});
                    if (expected === undefined) expected = page.total;
                    through = page.through;
                    for (const event of page.events) { chunks.push(aleLogCsvRow(event)); count++; }
                    if (count > 50000 || (page.more && page.after <= after)) throw new Error('Invalid log export response');
                    after = page.after;
                    logStatus.text('Exporting '+count.toLocaleString()+' decodes…');
                    if (!page.more) break;
                } while (true);
                if (count !== expected) throw new Error('Log retention changed during export; please retry');
                if (source !== currentSource()) throw new Error('Receiver changed; export cancelled');
                const url = URL.createObjectURL(new Blob(chunks,{type:'text/csv;charset=utf-8'}));
                const link = document.createElement('a');
                link.href = url; link.download = 'ALE-'+source.replace(/[^a-z0-9_-]/gi,'_')+'-'+new Date().toISOString().slice(0,10)+'.csv';
                document.body.append(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url),1000);
                logStatus.text('Exported '+count.toLocaleString()+' retained decodes');
            } catch (error) { logStatus.text(error.message); }
            finally { exportBusy = false; exportLog.prop('disabled',false); }
        });
        this.logTimer = setInterval(() => { if (!document.hidden) updateLog(); },15000);
        window.addEventListener('pagehide', () => { clearInterval(this.logTimer); this.logTimer = null; });
        window.addEventListener('pageshow', () => {
            if (!this.logTimer) this.logTimer = setInterval(() => { if (!document.hidden) updateLog(); },15000);
            updateLog();
        });
        updateLog();
        layout.append($('<table><thead><tr><th>UTC</th><th>kHz</th><th>From</th><th>To</th><th>Event</th><th>Message / details</th></tr></thead><tbody></tbody></table>'));
    };
    Ale2gMessagePanel.prototype.pushMessage = function(message) {
        if (message.test_audio && this.serverScanner.running) this.serverScanner.stop();
        if (this.serverScanner.running && !message.server_scan && !message.test_audio) return;
        if (!message.restored) this.scanner.event(message);
        if (message.event === 'activity') return;
        const row = $('<tr>');
        const events = {
            sounding_this_was:['Sounding · TWS','Station identification'],
            sounding_this_is:['Sounding · TIS','Station identification'],
            destination:['Address','Destination received'], call:['Call','Call received'],
            call_ack:['Call ACK','Acknowledgment'], call_established:['Call EST','Link established'],
            amd:['AMD text',null], dtm:['DTM text',null], command:['Command',null]
        };
        const event = events[message.event] || ['Decode',null];
        const values = [Utils.HHMMSS(message.timestamp), (message.freq / 1000).toFixed(1),
            message.source || '—', message.destination || '—', event[0]];
        values.forEach(function(value, index) {
            // Decoder output is untrusted radio text, never HTML.
            $('<td>').addClass(index === 4 ? 'ale-event' : '').text(String(value)).appendTo(row);
        });
        const body = $('<td class="message">').appendTo(row);
        if (event[1] === null) body.text(String(message.message || ''));
        else {
            // Soundings and link handshakes: on a phone the description opens on tap.
            row.addClass('ale-routine').on('click', function (clicked) {
                if (!$(clicked.target).closest('summary, pre').length) row.toggleClass('ale-open');
            });
            $('<span>').text((message.test_audio ? '[TEST AUDIO] ' : '')+event[1]).appendTo(body);
            const details = $('<details class="ale-raw">').appendTo(body);
            $('<summary>').text('Raw decode').appendTo(details);
            $('<pre>').text(String(message.message || '')).appendTo(details);
        }
        this.el.find('tbody').append(row);
        this.clearMessages(250);
        this.scrollToBottom();
    };
    $.fn.ale2gMessagePanel = function() {
        if (!this.data('panel')) this.data('panel', new Ale2gMessagePanel(this));
        return this.data('panel');
    };

    function available() {
        return typeof Modes !== 'undefined' && Modes.getModes &&
            Modes.getModes().some(mode => mode.modulation === MODE);
    }
    plugin.isAvailable = available;
    plugin.init = function () {
        if (document.getElementById(PANEL)) return true;
        const node = $('<div class="openwebrx-panel openwebrx-message-panel">')
            .attr({id: PANEL, 'data-panel-name': 'ale2g-message'}).css({display: 'none', width: '619px'});
        const anchor = $('#openwebrx-panel-wsjt-message');
        if (anchor.length) node.insertBefore(anchor); else node.appendTo('#openwebrx-panels-container');
        // Same bookkeeping initPanels() applies to the panels present at page load.
        const el = node[0];
        el.addEventListener('transitionend', function (event) {
            if (event.target !== el) return;
            el.style.transitionDuration = el.style.transitionDelay = el.style.transitionProperty = null;
            if (el.movement === 'collapse') el.style.display = 'none';
            delete el.movement;
        });
        // Build the panel only once the server reports the ALE mode, so a
        // server without the backend never receives scanner or log requests.
        let panel = null;
        const ensure = () => {
            if (!panel && available()) panel = node.ale2gMessagePanel();
            return panel;
        };
        const waiting = setInterval(() => {
            if (ensure() || (typeof Modes !== 'undefined' && Modes.initComplete && Modes.initComplete())) clearInterval(waiting);
        }, 500);
        ensure();
        // Native dispatch hands decodes no stock panel claims to this function.
        const pushData = window.secondary_demod_push_data;
        window.secondary_demod_push_data = function (value) {
            if (value && typeof value === 'object' && value.mode === 'ALE2G') {
                if (ensure()) panel.pushMessage(value);
                return;
            }
            return pushData.apply(this, arguments);
        };
        // Native panel switching knows only the stock decoder list.
        const updatePanels = DemodulatorPanel.prototype.updatePanels;
        DemodulatorPanel.prototype.updatePanels = function () {
            const result = updatePanels.apply(this, arguments);
            const active = this.getDemodulator().get_secondary_demod() === MODE;
            if (active) ensure();
            toggle_panel(PANEL, active);
            return result;
        };
        return true;
    };
}(jQuery));
