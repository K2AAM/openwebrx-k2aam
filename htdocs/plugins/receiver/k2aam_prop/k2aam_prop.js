/* K2AAM Prop: HF propagation panel for the K2AAM Dock / Console.
 *
 * Three views: estimated band conditions from NOAA SWPC solar flux and Kp,
 * the NCDXF/IARU beacon schedule with a "radar" that grades all 18 beacons
 * by what this receiver actually hears, and the live MUF map from
 * prop.kc2g.com. Data is fetched in the visitor's browser.
 *
 * Ported from the propagation screen of the RIG skin plugin by
 * SV1DOD / HB9ISH (https://github.com/aganet/openwebrxplus-rig-skin,
 * v0.10.20, MIT License). Load with Plugins.load('k2aam_prop').
 * The dock calls Plugins.k2aam_prop.create(options) to build the panel. */
(function () {
    'use strict';
    const plugin = Plugins.k2aam_prop;
    plugin._version = '0.1.0';

    const SWPC_FLUX = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';
    const SWPC_KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
    const MUF_URL = 'https://prop.kc2g.com/renders/current/mufd-normal-now.svg';
    const MUF_PAGE = 'https://prop.kc2g.com/';

    // ---- shared helpers -------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function button(text, fn, className) {
        const node = el('button', 'rd-button' + (className ? ' ' + className : ''), text);
        node.type = 'button';
        node.addEventListener('click', fn);
        return node;
    }

    // One hook on the FFT feed: keep the last line for the beacon radar.
    // Wrapping is harmless if another plugin (the RIG skin) also wraps it.
    function hookFft() {
        if (plugin._fftHooked || typeof waterfall_add !== 'function') return;
        plugin._fftHooked = true;
        const orig = waterfall_add;
        waterfall_add = function (data) {
            const res = orig.apply(this, arguments);
            if (data && data.length) plugin._lastFft = data;
            return res;
        };
    }

    // Peak within +/-peakHz of f against the median of the +/-floorHz
    // neighbourhood outside +/-guardHz, in dB; null without usable FFT data.
    function snrAt(f, peakHz, guardHz, floorHz, edgeBins) {
        const data = plugin._lastFft;
        if (!data || typeof center_freq === 'undefined' || typeof bandwidth === 'undefined') return null;
        const hzPerBin = bandwidth / data.length;
        const c = (f - center_freq) / hzPerBin + data.length / 2;
        if (c < edgeBins || c > data.length - edgeBins) return null;
        let pk = -1000;
        const b0 = Math.max(0, Math.floor(c - peakHz / hzPerBin));
        const b1 = Math.min(data.length - 1, Math.ceil(c + peakHz / hzPerBin));
        for (let b = b0; b <= b1; b++) if (data[b] > pk) pk = data[b];
        const g0 = Math.max(0, Math.floor(c - floorHz / hzPerBin));
        const g1 = Math.min(data.length - 1, Math.ceil(c + floorHz / hzPerBin));
        const guard = guardHz / hzPerBin, vals = [];
        for (let b = g0; b <= g1; b++) if (Math.abs(b - c) > guard) vals.push(data[b]);
        if (vals.length < 4) return null;
        vals.sort((x, y) => x - y);
        return pk - vals[Math.floor(vals.length / 2)];
    }

    // Tune to f in mode; asks the server to move the SDR window if f is
    // outside it. Resolves true when landed, false if the SDR can't reach f.
    function defaultTune(f, mode) {
        return new Promise(resolve => {
            if (typeof UI === 'undefined') { resolve(false); return; }
            if (typeof UI.toggleScanner === 'function') UI.toggleScanner(false);
            const land = () => { if (mode) UI.setModulation(mode); UI.setFrequency(f, false); resolve(true); };
            if (typeof center_freq !== 'undefined' && typeof bandwidth !== 'undefined' &&
                Math.abs(f - center_freq) < bandwidth / 2 - 10000) { land(); return; }
            if (typeof ws === 'undefined') { resolve(false); return; }
            let key;
            try { key = UI.getDemodulatorPanel().getMagicKey(); } catch (e) { key = undefined; }
            ws.send(JSON.stringify({ type: 'setfrequency', params: { frequency: f, key: key } }));
            let tries = 0;
            const iv = setInterval(() => {
                if (Math.abs(f - center_freq) < bandwidth / 2) {
                    clearInterval(iv);
                    setTimeout(land, 500); // let the demodulator restart on the new window
                } else if (++tries > 20) {
                    clearInterval(iv);
                    resolve(false);
                }
            }, 250);
        });
    }

    // ---- band conditions (NOAA SWPC) -----------------------------------

    // Rough but honest heuristic from solar flux and Kp; labelled an estimate.
    function cond(group, night, sfi, k) {
        switch (group) {
            case 0:  // 80m-40m
                if (night) return k <= 2 ? 'good' : k <= 4 ? 'fair' : 'poor';
                return k <= 3 ? 'fair' : 'poor';
            case 1:  // 30m-20m
                if (night) return sfi >= 120 && k <= 3 ? 'good' : sfi >= 90 && k <= 5 ? 'fair' : 'poor';
                return sfi >= 100 && k <= 3 ? 'good' : sfi >= 80 && k <= 5 ? 'fair' : 'poor';
            case 2:  // 17m-15m
                if (night) return sfi >= 105 && k <= 4 ? 'fair' : 'poor';
                return sfi >= 120 && k <= 3 ? 'good' : sfi >= 95 && k <= 5 ? 'fair' : 'poor';
            default: // 12m-10m
                if (night) return 'poor';
                return sfi >= 160 && k <= 3 ? 'good' : sfi >= 120 && k <= 5 ? 'fair' : 'poor';
        }
    }
    const GROUPS = ['80m–40m', '30m–20m', '17m–15m', '12m–10m'];

    // Shared across panels and remounts; refetched at most every 10 minutes.
    let solar = null, solarTime = 0, solarPending = null;
    function fetchSolar() {
        if (solar && Date.now() - solarTime < 600000) return Promise.resolve(solar);
        if (solarPending) return solarPending;
        solarPending = Promise.all([
            fetch(SWPC_FLUX).then(r => r.json()),
            fetch(SWPC_KP).then(r => r.json())
        ]).then(res => {
            const sfi = Math.round(Number(res[0][0].flux));
            const last = res[1][res[1].length - 1];
            // the Kp product is an array of objects on current SWPC; older
            // versions were arrays of arrays with a header row
            const kp = Array.isArray(last) ? Number(last[1]) : Number(last.Kp);
            const a = Array.isArray(last) ? last[2] : last.a_running;
            if (!isFinite(sfi) || !isFinite(kp)) throw new Error('unexpected NOAA data');
            solar = { sfi, k: kp, a }; solarTime = Date.now();
            return solar;
        }).finally(() => { solarPending = null; });
        return solarPending;
    }

    function buildBands() {
        const node = el('div', 'kp-bands');
        const head = el('div', 'kp-solar', 'Loading NOAA data…');
        const table = el('div', 'kp-table');
        table.append(el('span'), el('span', 'kp-col', 'Day'), el('span', 'kp-col', 'Night'));
        const cells = GROUPS.map(name => {
            const day = el('span', 'kp-cond', '--'), night = el('span', 'kp-cond', '--');
            table.append(el('span', 'kp-band', name), day, night);
            return [day, night];
        });
        node.append(head, table,
            el('p', 'rd-note', 'An estimate from solar flux (SFI) and the planetary K index, not a measurement. Low K and high SFI favour the higher bands.'));
        function refresh() {
            fetchSolar().then(s => {
                head.textContent = 'SFI ' + s.sfi + '   K ' + s.k.toFixed(1) + (s.a !== undefined ? '   A ' + s.a : '');
                cells.forEach((pair, i) => pair.forEach((cell, n) => {
                    const c = cond(i, n === 1, s.sfi, s.k);
                    cell.className = 'kp-cond kp-' + c; cell.textContent = c.toUpperCase();
                }));
            }).catch(() => { head.textContent = 'NOAA data unavailable'; });
        }
        return { node, refresh };
    }

    // ---- NCDXF / IARU beacons and radar --------------------------------

    // 18 beacons in a fixed UTC-synchronised 3 minute rotation, 10 s per
    // beacon per band. Pure clock math, no external data.
    const BEACONS = [
        ['4U1UN', 'United Nations NY'], ['VE8AT', 'Canada'], ['W6WX', 'USA West'],
        ['KH6RS', 'Hawaii'], ['ZL6B', 'New Zealand'], ['VK6RBP', 'Australia'],
        ['JA2IGY', 'Japan'], ['RR9O', 'Russia'], ['VR2B', 'Hong Kong'],
        ['4S7B', 'Sri Lanka'], ['ZS6DN', 'South Africa'], ['5Z4B', 'Kenya'],
        ['4X6TU', 'Israel'], ['OH2B', 'Finland'], ['CS3B', 'Madeira'],
        ['LU4AA', 'Argentina'], ['OA4B', 'Peru'], ['YV5B', 'Venezuela']
    ];
    const BFREQ = [14100000, 18110000, 21150000, 24930000, 28200000];
    const BNAME = ['20m', '17m', '15m', '12m', '10m'];

    function buildBeacons(ctx) {
        const node = el('div', 'kp-beacons');
        const bar = el('div', 'kp-radar-bar');
        bar.append(el('span', 'rd-label', 'Radar'));
        const chips = BNAME.map((name, b) => {
            const chip = button(name, () => setRadar(radarBand === b ? -1 : b), 'kp-chip');
            chip.title = 'Tune to the ' + name + ' beacon frequency and grade all 18 beacons by what this receiver hears (3 minute cycle)';
            chip.setAttribute('aria-pressed', 'false');
            bar.append(chip);
            return chip;
        });

        // schedule view: what each band's beacon frequency carries right now
        const schedule = el('div', 'kp-list');
        const rows = BFREQ.map((f, b) => {
            const row = el('div', 'kp-row');
            const freq = button((f / 1e6).toFixed(3), () => ctx.tune(f, 'cw'), 'kp-freq');
            freq.title = 'Listen to ' + BNAME[b] + ' beacons in CW';
            const call = el('span', 'kp-call'), where = el('span', 'kp-where'), slot = el('span', 'kp-slot');
            row.append(freq, call, where, slot);
            schedule.append(row);
            return { f, row, call, where, slot, i: -1, listening: null };
        });

        // radar view: all 18 beacons on one band with their measured SNR
        const radarList = el('div', 'kp-list kp-radar-list'); radarList.hidden = true;
        const radarRows = BEACONS.map(bc => {
            const row = el('div', 'kp-row');
            const snr = el('span', 'kp-snr');
            row.append(el('span', 'kp-call', bc[0]), el('span', 'kp-where', bc[1]), snr);
            radarList.append(row);
            return { row, snr, txt: null, lit: null };
        });
        const status = el('p', 'rd-note',
            'Each band carries one beacon every 10 seconds. Click a frequency to listen. Radar retunes the receiver to that band for everyone listening.');
        node.append(bar, schedule, radarList, status);

        let radarBand = -1, radarData = {}, slotBeacon = -1, slotSamples = [];

        function setRadar(b) {
            radarBand = b; radarData = {}; slotBeacon = -1; slotSamples = [];
            chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(i === b)));
            radarList.hidden = b < 0; schedule.hidden = b >= 0;
            radarRows.forEach(r => { r.txt = null; r.lit = null; r.snr.textContent = ''; r.snr.className = 'kp-snr'; r.row.classList.remove('kp-live'); });
            if (b >= 0) {
                hookFft();
                ctx.tune(BFREQ[b], 'cw').then(ok => { if (!ok && radarBand === b) { setRadar(-1); ctx.message(BNAME[b] + ' beacon frequency is out of range for this receiver.'); } });
            }
        }

        function tick() {
            const sec = Math.floor(Date.now() / 1000) % 180, ten = Math.floor(sec / 10);
            const tuned = typeof UI !== 'undefined' && UI.getFrequency ? UI.getFrequency() : 0;
            rows.forEach((r, b) => {
                const i = ((ten - b) % 18 + 18) % 18;
                if (r.i !== i) { r.i = i; r.call.textContent = BEACONS[i][0]; r.where.textContent = BEACONS[i][1]; }
                const listening = Math.abs(tuned - r.f) < 3000;
                if (r.listening !== listening) { r.listening = listening; r.row.classList.toggle('kp-live', listening); }
                r.slot.textContent = (10 - sec % 10) + 's';
            });
            if (!(radarBand >= 0)) return;
            // Moving the dial away or closing the panel hands the receiver back.
            if (!ctx.visible() || Math.abs(tuned - BFREQ[radarBand]) > 3000) {
                // give the initial retune time to land before giving up
                if (slotBeacon !== -1 || !ctx.visible()) { setRadar(-1); return; }
                return;
            }
            const i = ((ten - radarBand) % 18 + 18) % 18;
            if (i !== slotBeacon) { slotBeacon = i; slotSamples = []; }
            // Skip the start of the slot (keying delay), then grade by the
            // median: a beacon is a steady carrier, single noise spikes are not.
            if (sec % 10 >= 2) {
                const snr = snrAt(BFREQ[radarBand], 300, 1000, 6000, 10);
                if (snr !== null) {
                    slotSamples.push(snr);
                    const s = slotSamples.slice().sort((x, y) => x - y);
                    radarData[i] = s[Math.floor(s.length / 2)];
                }
            }
            radarRows.forEach((r, n) => {
                const lit = n === i;
                if (r.lit !== lit) { r.lit = lit; r.row.classList.toggle('kp-live', lit); }
                if (!(n in radarData)) return;
                const v = radarData[n];
                const cls = v >= 14 ? 'good' : v >= 8 ? 'fair' : 'none';
                const txt = v >= 8 ? '+' + Math.round(v) + ' dB' : '–';
                if (r.txt === txt) return;
                r.txt = txt; r.snr.textContent = txt; r.snr.className = 'kp-snr kp-' + cls;
            });
        }
        return { node, tick, stop: () => { if (radarBand >= 0) setRadar(-1); } };
    }

    // ---- MUF map ---------------------------------------------------------

    function buildMuf() {
        const node = el('div', 'kp-muf');
        const link = el('a'); link.href = MUF_PAGE; link.target = '_blank'; link.rel = 'noopener';
        link.title = 'Open prop.kc2g.com';
        const img = el('img'); img.alt = 'Maximum usable frequency map from prop.kc2g.com'; img.loading = 'lazy';
        link.append(img);
        node.append(link, el('p', 'rd-note', 'Maximum usable frequency for a 3000 km path, from ionosonde data (KC2G). Click to open the site.'));
        function refresh() {
            // new URL every 10 minutes so the browser cache doesn't pin an old map
            img.src = MUF_URL + '?_=' + Math.floor(Date.now() / 600000);
        }
        return { node, refresh };
    }

    // ---- panel ------------------------------------------------------------

    /* options: { tune(f, mode) -> Promise<bool>, message(text), visible() -> bool }
     * Returns { node, show(), destroy() }. show() is called when the panel opens. */
    plugin.create = function (options) {
        options = options || {};
        const node = el('div', 'kp-panel');
        const ctx = {
            tune: options.tune || defaultTune,
            message: options.message || (text => console.warn('k2aam_prop: ' + text)),
            visible: options.visible || (() => node.isConnected && node.offsetParent !== null)
        };
        const views = [
            { key: 'bands', label: 'Bands', view: buildBands() },
            { key: 'beacons', label: 'Beacons', view: buildBeacons(ctx) },
            { key: 'muf', label: 'MUF map', view: buildMuf() }
        ];
        const tabs = el('div', 'kp-tabs'); tabs.setAttribute('role', 'tablist');
        let current = 0;
        try { const saved = Number(localStorage.getItem('k2aam_prop_view')); if (saved >= 0 && saved < views.length) current = saved; } catch (e) { /* storage blocked */ }
        views.forEach((v, i) => {
            v.tab = button(v.label, () => select(i), 'kp-tab');
            v.tab.setAttribute('role', 'tab');
            tabs.append(v.tab);
        });
        node.append(tabs);
        views.forEach(v => { v.view.node.setAttribute('role', 'tabpanel'); node.append(v.view.node); });

        function select(i) {
            current = i;
            views.forEach((v, n) => {
                v.tab.setAttribute('aria-selected', String(n === i));
                v.tab.setAttribute('aria-pressed', String(n === i));
                v.view.node.hidden = n !== i;
            });
            if (views[i].view.refresh) views[i].view.refresh();
            try { localStorage.setItem('k2aam_prop_view', String(i)); } catch (e) { /* storage blocked */ }
        }
        select(current);

        const beacons = views[1].view;
        const timer = setInterval(() => { if (ctx.visible()) beacons.tick(); else beacons.stop(); }, 1000);
        return {
            node,
            show() { const v = views[current].view; if (v.refresh) v.refresh(); beacons.tick(); },
            destroy() { clearInterval(timer); beacons.stop(); node.remove(); }
        };
    };

    plugin.tune = defaultTune;
    plugin.init = function () { return true; };
}());
