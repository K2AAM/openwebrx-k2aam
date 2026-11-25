/* K2AAM Spots: live DX cluster spots for OpenWebRX+.
 *
 * Polls DX Summit (https, CORS-enabled) once a minute in the listener's
 * browser. Spots inside the current view are labelled above the waterfall
 * (as bookmarks; click to tune), and the K2AAM Dock / Console shows the full
 * list as "Spots" (click a row to tune, retuning the SDR if needed).
 *
 * Idea after the DX window of the RIG skin by SV1DOD / HB9ISH (MIT).
 * Load with Plugins.load('k2aam_spots'). */
(function () {
    'use strict';
    const plugin = Plugins.k2aam_spots;
    plugin._version = '0.1.0';

    const API = 'https://www.dxsummit.fi/api/v1/spots?limit=200';
    const POLL_MS = 60000;
    const NEAR_KM = 3000;

    const settings = load('k2aam_spots', {});
    let showOnWaterfall = settings.waterfall !== false;  // default on
    let nearOnly = settings.near === true;               // default off
    let maxAge = [15, 30, 60].includes(settings.age) ? settings.age : 30; // minutes

    let spots = [];             // newest first, de-duplicated by call + band
    let lastFetch = 0, fetching = false, lastError = '';
    const listeners = [];

    function load(key, fallback) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    }
    function save() {
        try { localStorage.setItem('k2aam_spots', JSON.stringify({ waterfall: showOnWaterfall, near: nearOnly, age: maxAge })); }
        catch (e) { /* storage blocked */ }
    }
    // Spot text comes from the internet and the bookmark bar renders HTML.
    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    function cleanCall(call) { return String(call || '').toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 15); }

    // Mode from the comment, else from where in the band the spot is.
    const CW_SEGMENTS = [[1800, 1840], [3500, 3600], [7000, 7040], [10100, 10140], [14000, 14070],
        [18068, 18095], [21000, 21070], [24890, 24915], [28000, 28070], [50000, 50100]];
    function modeFor(khz, info) {
        if (/\b(FT8|FT4|JT65|JT9|PSK\d*|RTTY|WSPR|JS8|OLIVIA|SSTV|FST4)\b/i.test(info)) return 'usb';
        if (/\bCW\b/i.test(info)) return 'cw';
        if (/\bUSB\b/i.test(info)) return 'usb';
        if (/\bSSB\b/i.test(info)) return khz < 10000 ? 'lsb' : 'usb';
        if (/\bLSB\b/i.test(info)) return 'lsb';
        if (/\bAM\b/i.test(info)) return 'am';
        if (CW_SEGMENTS.some(([lo, hi]) => khz >= lo && khz < hi)) return 'cw';
        return khz < 10000 ? 'lsb' : 'usb';
    }
    function bandOf(khz) {
        const bands = [[1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'], [7000, 7300, '40m'],
            [10100, 10150, '30m'], [14000, 14350, '20m'], [18068, 18168, '17m'], [21000, 21450, '15m'],
            [24890, 24990, '12m'], [28000, 29700, '10m'], [50000, 54000, '6m']];
        const b = bands.find(([lo, hi]) => khz >= lo && khz < hi);
        return b ? b[2] : '';
    }
    function distanceKm(a, b) {
        const rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
        return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    function station() {
        const pos = typeof Utils !== 'undefined' && Utils.getReceiverPos ? Utils.getReceiverPos() : null;
        return pos && isFinite(pos.lat) && isFinite(pos.lon) ? { lat: Number(pos.lat), lon: Number(pos.lon) } : null;
    }

    function parse(rows) {
        const now = Date.now(), seen = new Set(), out = [];
        (rows || []).forEach(r => {
            const khz = Number(r.frequency), call = cleanCall(r.dx_call);
            const time = Date.parse(r.time + 'Z');
            if (!call || !isFinite(khz) || khz <= 0 || !isFinite(time)) return;
            const band = bandOf(khz) || Math.round(khz) + '';
            const key = call + '/' + band;
            if (seen.has(key)) return;  // keep only the newest spot of a call per band
            seen.add(key);
            // DX Summit longitudes are west-positive
            const de = isFinite(r.de_latitude) && isFinite(r.de_longitude) ? { lat: r.de_latitude, lon: -r.de_longitude } : null;
            const info = String(r.info || '').slice(0, 80);
            out.push({
                call, khz, hz: Math.round(khz * 1000), time, age: (now - time) / 60000, band,
                country: String(r.dx_country || '').slice(0, 40), spotter: cleanCall(r.de_call), info,
                de, mode: modeFor(khz, info)
            });
        });
        return out;
    }

    function visibleSpots() {
        const here = nearOnly ? station() : null;
        const now = Date.now();
        return spots.filter(s => (now - s.time) / 60000 <= maxAge &&
            (!here || (s.de && distanceKm(here, s.de) <= NEAR_KM)));
    }

    function refresh(force) {
        if (fetching || (!force && Date.now() - lastFetch < POLL_MS - 1000)) return;
        if (typeof fetch !== 'function') return;
        fetching = true;
        fetch(API, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(rows => { spots = parse(rows); lastError = ''; })
            .catch(error => { lastError = 'DX Summit unavailable (' + (error.message || error) + ')'; })
            .finally(() => { fetching = false; lastFetch = Date.now(); render(); });
    }

    // Waterfall labels: spots inside the current view, as bookmarks.
    function renderWaterfall() {
        if (typeof bookmarks === 'undefined' || !bookmarks || typeof bookmarks.replace_bookmarks !== 'function') return;
        let list = [];
        if (showOnWaterfall && typeof center_freq !== 'undefined' && typeof bandwidth !== 'undefined') {
            list = visibleSpots().filter(s => Math.abs(s.hz - center_freq) < bandwidth / 2).map(s => ({
                name: escapeHtml(s.call),
                frequency: s.hz,
                modulation: s.mode,
                description: escapeHtml([s.country, Math.round(s.age) + ' min ago', s.spotter && 'de ' + s.spotter, s.info].filter(Boolean).join(' · '))
            }));
        }
        const signature = JSON.stringify(list.map(b => b.name + b.frequency));
        if (signature === plugin._wfSignature) return;
        plugin._wfSignature = signature;
        bookmarks.replace_bookmarks(list, 'dxspots', false);
    }

    function render() {
        renderWaterfall();
        listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    }

    // ---- panel for the dock -------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function checkbox(text, value, fn) {
        const label = el('label', 'rd-check'), input = el('input');
        input.type = 'checkbox'; input.checked = value;
        input.addEventListener('change', () => fn(input.checked));
        label.append(input, el('span', '', text));
        return { label, input };
    }

    /* options: { tune(hz, mode) } -> { node, show(), destroy() } */
    plugin.create = function (options) {
        options = options || {};
        const tune = options.tune || ((hz, mode) => { UI.setModulation(mode); UI.setFrequency(hz, false); });
        const node = el('div', 'ks-panel');
        const controls = el('div', 'ks-controls');
        const wf = checkbox('Label spots on the waterfall', showOnWaterfall, v => { showOnWaterfall = v; save(); plugin._wfSignature = null; render(); });
        const near = checkbox('Only spots heard within ' + NEAR_KM + ' km of this receiver', nearOnly, v => { nearOnly = v; save(); plugin._wfSignature = null; render(); });
        const inView = checkbox('Only the current view', false, () => draw());
        const age = el('select'); age.setAttribute('aria-label', 'Maximum spot age');
        [15, 30, 60].forEach(m => { const o = el('option', '', 'Last ' + m + ' min'); o.value = String(m); age.append(o); });
        age.value = String(maxAge);
        age.addEventListener('change', () => { maxAge = Number(age.value); save(); plugin._wfSignature = null; render(); });
        controls.append(wf.label, near.label, inView.label, age);
        const status = el('div', 'ks-status');
        const list = el('div', 'ks-list');
        node.append(controls, status, list,
            el('p', 'rd-note', 'From the DX Summit cluster, refreshed every minute. Clicking a spot outside the current view retunes the receiver for everyone listening.'));

        function draw() {
            let shown = visibleSpots();
            if (inView.input.checked && typeof center_freq !== 'undefined')
                shown = shown.filter(s => Math.abs(s.hz - center_freq) < bandwidth / 2);
            status.textContent = lastError || (lastFetch ? shown.length + ' spots' : 'Loading spots…');
            list.replaceChildren(...shown.slice(0, 120).map(s => {
                const row = el('button', 'ks-row'); row.type = 'button';
                row.title = [s.country, s.spotter && 'spotted by ' + s.spotter, s.info].filter(Boolean).join(' · ');
                row.append(el('span', 'ks-freq', s.khz.toFixed(1)), el('span', 'ks-call', s.call),
                    el('span', 'ks-where', s.country || s.info), el('span', 'ks-mode', s.mode.toUpperCase()),
                    el('span', 'ks-age', Math.max(0, Math.round((Date.now() - s.time) / 60000)) + 'm'));
                row.addEventListener('click', () => tune(s.hz, s.mode));
                return row;
            }));
        }
        listeners.push(draw);
        draw();
        return {
            node,
            show() { refresh(false); draw(); },
            destroy() { const i = listeners.indexOf(draw); if (i >= 0) listeners.splice(i, 1); node.remove(); }
        };
    };

    // for tests
    plugin._parse = parse;

    plugin.init = function () {
        // Poll while the page is visible: the waterfall labels need fresh data
        // even when no panel is open. A hidden tab stops polling.
        refresh(true);
        setInterval(() => { if (!document.hidden) refresh(false); }, 5000);
        // the view moves when the SDR or profile changes; keep labels in step
        setInterval(() => { if (!document.hidden) renderWaterfall(); }, 2000);
        return true;
    };
}());
