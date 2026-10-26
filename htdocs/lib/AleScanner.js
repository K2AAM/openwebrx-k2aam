/* Receive-only ALE scanning. Uses native OWRX tuning and existing server permissions. */
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
