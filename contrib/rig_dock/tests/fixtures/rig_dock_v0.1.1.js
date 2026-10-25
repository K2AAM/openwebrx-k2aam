/* RIG Dock for OpenWebRX+ 1.2.126. MIT License. */
(function () {
    'use strict';
    const plugin = Plugins.rig_dock;
    plugin._version = '0.1.1';
    plugin.no_css = true;
    const base = ((document.currentScript && document.currentScript.src) ||
        'static/plugins/receiver/rig_dock/rig_dock.js').replace(/[^/]*$/, '');
    let panel, dock, popup, opener, observer, socket, timer;
    let cpu = null, clients = null, moved = [], listeners = [], audioPromise;
    let modeSignature = '', mounted = false, chatWasVisible = false;
    const refs = {};
    const $ = (selector, root) => (root || document).querySelector(selector);
    const all = (selector, root) => Array.from((root || document).querySelectorAll(selector));

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function on(node, type, fn, options) {
        node.addEventListener(type, fn, options);
        listeners.push(() => node.removeEventListener(type, fn, options));
    }
    function button(text, fn, className) {
        const node = el('button', 'rd-button ' + (className || ''), text);
        node.type = 'button';
        on(node, 'click', fn);
        return node;
    }
    function move(node, target) {
        if (!node) return null;
        const marker = document.createComment('rig-dock original position');
        node.before(marker);
        moved.push({node, marker});
        target.append(node);
        return node;
    }
    function native(selector, target, label) {
        const node = $(selector);
        if (!node) return null;
        const wrap = el('div', 'rd-native');
        if (label) {
            const caption = el('label', 'rd-label', label);
            if (node.id) caption.htmlFor = node.id;
            else {
                node.id = 'rd-native-' + moved.length;
                caption.htmlFor = node.id;
            }
            wrap.append(caption);
        }
        target.append(wrap);
        move(node, wrap);
        return node;
    }
    function message(text) {
        refs.message.textContent = text;
        refs.message.hidden = !text;
    }
    function safely(fn) {
        try { fn(); message(''); } catch (error) { message(error.message || String(error)); }
    }
    function positionPopup() {
        if (!popup || !opener) return;
        const height = panel.getBoundingClientRect().height;
        popup.style.bottom = (height + 8) + 'px';
        popup.style.maxHeight = Math.max(60, window.innerHeight - height - 20) + 'px';
        const width = popup.getBoundingClientRect().width;
        const left = Math.min(opener.getBoundingClientRect().left, window.innerWidth - width - 10);
        popup.style.left = Math.max(10, left) + 'px';
    }
    function closePopup(focus) {
        if (!popup) return;
        popup.hidden = true;
        opener.setAttribute('aria-expanded', 'false');
        if (focus) opener.focus();
        popup = opener = null;
    }
    function openPopup(node, trigger) {
        if (popup === node) { closePopup(true); return; }
        closePopup(false);
        popup = node; opener = trigger;
        popup.hidden = false;
        opener.setAttribute('aria-expanded', 'true');
        tick();
        positionPopup();
        const focus = $('input:not(:disabled), select:not(:disabled), button:not(:disabled)', popup);
        if (focus) focus.focus();
    }
    function popover(id, title, label) {
        const node = el('section', 'rig-dock-ui rd-popover');
        node.id = 'rd-popover-' + id;
        node.hidden = true;
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', title);
        const heading = el('div', 'rd-popover-heading');
        heading.append(el('strong', '', title), button('×', () => closePopup(true), 'rd-close'));
        $('button', heading).setAttribute('aria-label', 'Close ' + title);
        node.append(heading);
        panel.append(node);
        const trigger = button(label || title + ' ▴', () => openPopup(node, trigger));
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-controls', node.id);
        trigger.setAttribute('aria-expanded', 'false');
        return {node, trigger};
    }
    function group(parent, label) {
        const node = el('div', 'rd-group');
        if (label) node.append(el('span', 'rd-label', label));
        parent.append(node);
        return node;
    }
    function checkbox(parent, text, fn) {
        const label = el('label', 'rd-check');
        const input = el('input'); input.type = 'checkbox';
        label.append(input, document.createTextNode(text)); parent.append(label);
        on(input, 'change', () => safely(() => fn(input.checked)));
        return input;
    }
    function number(parent, title) {
        const label = el('label', 'rd-field', title);
        const input = el('input'); input.type = 'number'; input.step = '1';
        label.append(input); parent.append(label);
        return input;
    }
    function modes() {
        return typeof Modes !== 'undefined' && Modes.getModes ? Modes.getModes() : [];
    }
    function renderModes() {
        const available = modes();
        const term = refs.modeSearch.value.trim().toLowerCase();
        const signature = JSON.stringify([available.map(m => [m.modulation, m.name, m.type]), term]);
        if (signature === modeSignature) return;
        modeSignature = signature;
        refs.modeList.replaceChildren();
        let count = 0;
        [['analog', 'Primary modes'], ['digimode', 'Data decoders']].forEach(([type, title]) => {
            const items = available.filter(m => m.type === type &&
                (m.name + ' ' + m.modulation).toLowerCase().includes(term));
            if (!items.length) return;
            refs.modeList.append(el('div', 'rd-menu-label', title));
            const grid = el('div', 'rd-mode-grid');
            items.forEach(mode => {
                const item = el('button', 'rd-button rd-mode-item', mode.name);
                item.type = 'button'; item.dataset.mode = mode.modulation;
                // These short-lived list nodes do not need a global cleanup entry.
                item.addEventListener('click', () => safely(() => {
                    UI.setModulation(mode.modulation);
                    closePopup(true); tick();
                }));
                grid.append(item); count++;
            });
            refs.modeList.append(grid);
        });
        if (!count) refs.modeList.append(el('p', 'rd-note', available.length ?
            'No matching modes.' : 'Waiting for the receiver’s supported modes…'));
    }
    function buildMode(main) {
        const pop = popover('mode', 'Mode', 'Mode ▴');
        refs.modeTrigger = pop.trigger; main.append(pop.trigger);
        refs.modeSearch = el('input', 'rd-search');
        refs.modeSearch.type = 'search'; refs.modeSearch.placeholder = 'Find a mode…';
        refs.modeSearch.setAttribute('aria-label', 'Search modes');
        refs.modeList = el('div', 'rd-mode-list');
        pop.node.append(refs.modeSearch, refs.modeList);
        on(refs.modeSearch, 'input', renderModes);
        refs.underlyingRow = el('label', 'rd-field', 'Underlying mode');
        refs.underlying = el('select'); refs.underlyingRow.append(refs.underlying);
        pop.node.append(refs.underlyingRow);
        on(refs.underlying, 'change', () => safely(() =>
            UI.setModulation(UI.getModulation(), refs.underlying.value)));
        refs.modePopup = pop.node;
    }
    function buildTune(main) {
        const frequency = group(main);
        frequency.classList.add('rd-frequency');
        move($('.frequencies-container', panel), frequency);
        const pop = popover('tune', 'Tune frequency', 'Tune ▴');
        frequency.append(pop.trigger);
        const form = el('form', 'rd-tune-form');
        const input = el('input'); input.type = 'text'; input.inputMode = 'decimal';
        input.placeholder = '7.121 MHz'; input.setAttribute('aria-label', 'Frequency with units');
        const submit = el('button', 'rd-button rd-primary', 'Tune'); submit.type = 'submit';
        form.append(input, submit);
        pop.node.append(form, el('p', 'rd-note', 'Use Hz, kHz, or MHz. A value without units is MHz.'));
        on(form, 'submit', event => {
            event.preventDefault(); safely(() => {
                const match = /^\s*(\d+(?:\.\d+)?)\s*(Hz|kHz|MHz)?\s*$/i.exec(input.value);
                if (!match) throw new Error('Enter a frequency such as 7.121 MHz.');
                const unit = (match[2] || 'MHz').toLowerCase();
                const value = Math.round(Number(match[1]) * {hz: 1, khz: 1e3, mhz: 1e6}[unit]);
                const range = typeof center_freq === 'number' && typeof bandwidth === 'number' ?
                    [center_freq - bandwidth / 2, center_freq + bandwidth / 2] : null;
                if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Enter a positive frequency.');
                if (range && (value < range[0] || value > range[1]))
                    throw new Error('Choose a profile covering that frequency first.');
                if (UI.setFrequency(value, false) === false) throw new Error('The receiver could not tune there.');
                closePopup(true);
            });
        });
    }
    function buildWaterfall(toolbar) {
        const pop = popover('waterfall', 'Waterfall'); toolbar.append(pop.trigger);
        refs.waterfallPopup = pop.node;
        native('#openwebrx-wf-themes-listbox', pop.node, 'Palette');
        refs.wfMin = native('#openwebrx-waterfall-color-min', pop.node, 'Minimum level');
        refs.wfMax = native('#openwebrx-waterfall-color-max', pop.node, 'Maximum level');
        refs.wfReadout = el('div', 'rd-note'); pop.node.append(refs.wfReadout);
        const actions = group(pop.node);
        actions.append(button('Auto once', () => safely(() => Waterfall.setAutoRange())),
            button('Reset levels', () => safely(() => Waterfall.setDefaultRange())));
        refs.wfAuto = checkbox(pop.node, 'Continuous auto levels', value => Waterfall.toggleContinuousRange(value));
        refs.spectrum = checkbox(pop.node, 'Show spectrum', value => UI.toggleSpectrum(value));
        const zoom = group(pop.node, 'Zoom');
        zoom.append(button('−', () => zoomOutOneStep()), button('+', () => zoomInOneStep()),
            button('Full band', () => zoomOutTotal()));
    }
    function buildBandpass(toolbar) {
        const pop = popover('bandpass', 'Receive bandpass', 'Bandpass ▴'); toolbar.append(pop.trigger);
        refs.bpLow = number(pop.node, 'Low cut (Hz)');
        refs.bpHigh = number(pop.node, 'High cut (Hz)');
        on(pop.trigger, 'click', () => {
            const d = UI.getDemodulator();
            if (d) { refs.bpLow.value = d.low_cut; refs.bpHigh.value = d.high_cut; }
        });
        pop.node.append(button('Apply', () => safely(() => {
            const d = UI.getDemodulator(), low = Number(refs.bpLow.value), high = Number(refs.bpHigh.value);
            if (!d || !Number.isFinite(low) || !Number.isFinite(high) || low >= high)
                throw new Error('Low cut must be below high cut.');
            if (Math.abs(low) > 100000 || Math.abs(high) > 100000)
                throw new Error('Cutoff must be between −100000 and 100000 Hz.');
            d.setBandpass({low_cut: low, high_cut: high}); closePopup(true);
        }), 'rd-primary'));
        pop.node.append(el('p', 'rd-note', 'This is OWRX’s receive bandpass. The optional audio filter has its own bypass.'));
    }
    async function audio() {
        if (Plugins.rig_audio && Plugins.rig_audio.setEnabled) return Plugins.rig_audio;
        if (!audioPromise) audioPromise = Plugins.load('rig_audio').then(() => {
            if (!Plugins.rig_audio || !Plugins.rig_audio.setEnabled)
                throw new Error('The optional audio filter could not load.');
            return Plugins.rig_audio;
        }).catch(error => { audioPromise = null; throw error; });
        return audioPromise;
    }
    function buildAudio(toolbar) {
        const pop = popover('audio', 'Audio filter', 'Audio: Bypassed ▴');
        refs.audioTrigger = pop.trigger; toolbar.append(pop.trigger);
        refs.audioEnable = checkbox(pop.node, 'Enable audio filter for this session', () => {});
        // Async enable is explicit; no filter script or audio nodes load at startup.
        on(refs.audioEnable, 'change', async () => {
            const desired = refs.audioEnable.checked;
            refs.audioEnable.disabled = true;
            try { const filter = await audio(); filter.setEnabled(desired); message(''); }
            catch (error) { message(error.message); }
            finally { refs.audioEnable.disabled = false; tick(); }
        });
        pop.node.append(el('p', 'rd-note', 'Bypass keeps the normal OWRX audio path. Filter choices are remembered; processing starts off on each page load.'));
        const settings = button('Filter settings…', async () => {
            settings.disabled = true;
            try { await audio(); Plugins.toggleWindow('rig_audio', true); closePopup(false); }
            catch (error) { message(error.message); }
            finally { settings.disabled = false; }
        });
        pop.node.append(settings);
    }
    function buildMore(toolbar) {
        const pop = popover('more', 'More controls'); toolbar.append(pop.trigger); refs.more = pop.node;
        const actions = group(pop.node);
        actions.append(button('Chat / log', () => { toggle_panel('openwebrx-panel-log'); closePopup(false); }),
            button('Zoom −', () => zoomOutOneStep()), button('Zoom +', () => zoomInOneStep()));
        native('#openwebrx-panel-plugins', pop.node, 'Plugins');
        const settings = $('#openwebrx-section-settings', panel);
        if (settings) {
            const content = move(settings.nextElementSibling, pop.node);
            content.classList.add('rd-settings-native');
        }
        pop.node.append(button('Use stock controls', () => plugin.destroy(true)));
    }
    function adoptPlugins() {
        const antenna = $('.rsp-antenna', panel);
        if (antenna && !refs.antennas.contains(antenna)) move(antenna, refs.antennas);
        const sectionIds = new Set(['openwebrx-section-modes', 'openwebrx-section-controls',
            'openwebrx-section-settings', 'openwebrx-section-display', 'plugin-section-rsp_antenna']);
        all(':scope > .openwebrx-section-divider', panel).forEach(heading => {
            if (sectionIds.has(heading.id)) return;
            const content = heading.nextElementSibling;
            if (content && content.classList.contains('openwebrx-section')) {
                move(heading, refs.more); move(content, refs.more);
            }
        });
    }
    function receive(event) {
        if (typeof event.data !== 'string' || event.data[0] !== '{') return;
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'cpuusage' && Number.isFinite(data.value)) cpu = data.value;
            if (data.type === 'clients' && Number.isFinite(data.value)) clients = data.value;
        } catch (error) { /* Binary and unrelated messages belong to OWRX. */ }
    }
    function reserveSpace() {
        if (!mounted) return;
        document.documentElement.style.setProperty('--rig-dock-height', Math.ceil(panel.getBoundingClientRect().height) + 'px');
        positionPopup();
        if (typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done && typeof scale_canvas !== 'undefined' && scale_canvas && typeof scale_ctx !== 'undefined' && scale_ctx && typeof openwebrx_resize === 'function') openwebrx_resize();
    }
    function tick() {
        if (!mounted) return;
        adoptPlugins();
        const nextSocket = typeof ws !== 'undefined' ? ws : null;
        if (socket !== nextSocket) {
            if (socket) socket.removeEventListener('message', receive);
            socket = nextSocket; cpu = clients = null;
            // A client count may have arrived before this plugin finished loading.
            if (window.jQuery) {
                const bar = window.jQuery('#openwebrx-bar-clients').data('progressbar');
                if (bar && Number.isFinite(bar.clients)) clients = bar.clients;
            }
            if (socket) socket.addEventListener('message', receive);
        }
        const connected = socket && socket.readyState === 1;
        refs.connection.textContent = connected ? 'Connected' : 'Disconnected';
        refs.connection.classList.toggle('rd-connected', !!connected);
        const err = $('#openwebrx-error-overlay');
        if (connected && err && getComputedStyle(err).display !== 'none') refs.connection.textContent = 'Receiver unavailable';
        refs.cpu.textContent = cpu === null ? '' : 'CPU ' + Math.round(cpu * 100) + '%';
        refs.clients.textContent = clients === null ? '' : clients + (clients === 1 ? ' listener' : ' listeners');
        refs.clock.textContent = new Date().toISOString().slice(11, 19) + ' UTC';
        const selectedMode = UI.getModulation();
        const currentMode = modes().find(m => m.modulation === selectedMode);
        refs.modeTrigger.textContent = (currentMode ? currentMode.name : selectedMode.toUpperCase() || 'Mode') + ' ▴';
        refs.modeTrigger.disabled = !connected;
        const activeAudio = !!(Plugins.rig_audio && Plugins.rig_audio.isEnabled && Plugins.rig_audio.isEnabled());
        refs.audioTrigger.textContent = 'Audio: ' + (activeAudio ? 'On' : 'Bypassed') + ' ▴';
        refs.audioTrigger.classList.toggle('rd-active', activeAudio);
        if (!refs.audioEnable.disabled) refs.audioEnable.checked = activeAudio;
        const ant = $('.rsp-antenna', refs.antennas);
        refs.antennas.hidden = !ant || ant.hidden;
        const status = ant && $('.rsp-antenna-status', ant);
        refs.antennaStatus.textContent = ant && !ant.hidden && status ? status.textContent : '';
        refs.antennaStatus.title = 'Shared antenna selection affects everyone on this SDR. ' + refs.antennaStatus.textContent;
        refs.antennaStatus.classList.toggle('rd-error', !!(status && status.classList.contains('rsp-antenna-error')));
        const recording = typeof audioEngine !== 'undefined' && audioEngine && audioEngine.recording;
        refs.record.classList.toggle('rd-recording', !!recording);
        refs.record.textContent = recording ? '■ Stop REC' : '● Record';
        refs.record.setAttribute('aria-pressed', String(!!recording));
        if (popup === refs.modePopup) {
            renderModes();
            all('[data-mode]', refs.modeList).forEach(item => item.setAttribute('aria-pressed', String(item.dataset.mode === selectedMode)));
            const underlying = currentMode && currentMode.type === 'digimode' ? currentMode.underlying || [] : [];
            refs.underlyingRow.hidden = !underlying.length;
            if (refs.underlying.dataset.signature !== underlying.join(',')) {
                refs.underlying.replaceChildren(...underlying.map(name => {
                    const option = el('option', '', name.toUpperCase()); option.value = name; return option;
                }));
                refs.underlying.dataset.signature = underlying.join(',');
            }
            if (underlying.length) refs.underlying.value = UI.getUnderlying();
        }
        if (popup === refs.waterfallPopup && typeof Waterfall !== 'undefined') {
            refs.wfAuto.checked = !!Waterfall.measure_minmax_continuous;
            refs.spectrum.checked = !!UI.spectrum;
            const range = Waterfall.getRange();
            refs.wfReadout.textContent = Math.round(range.min) + ' to ' + Math.round(range.max) + ' dB';
        }
    }
    function mount() {
        if (mounted) return;
        panel = $('#openwebrx-panel-receiver');
        if (!panel || typeof UI === 'undefined') throw new Error('RIG Dock: receiver controls were not found.');
        if (Plugins.rig_skin && Plugins.rig_skin._script_loaded)
            throw new Error('RIG Dock: disable rig_skin and reload before using the dock.');
        if (Plugins.audio_filter && Plugins.audio_filter._script_loaded)
            throw new Error('RIG Dock: disable the original audio_filter and reload to start bypassed.');
        mounted = true;
        dock = el('div', 'rig-dock-ui'); dock.id = 'rig-dock';
        panel.append(dock);
        const main = el('div', 'rd-main'), toolbar = el('div', 'rd-toolbar'), footer = el('div', 'rd-footer');
        dock.append(main, toolbar, footer);
        buildTune(main);
        const profiles = group(main); profiles.classList.add('rd-profiles');
        native('#openwebrx-sdr-profiles-listbox', profiles, 'Receiver / profile');
        buildMode(main);
        refs.antennas = group(main); refs.antennas.classList.add('rd-antennas');
        const volume = group(toolbar, 'Volume');
        move($('.openwebrx-mute-button', panel), volume); move($('#openwebrx-panel-volume'), volume);
        const squelch = group(toolbar, 'Squelch');
        move($('.openwebrx-squelch-auto', panel), squelch); move($('.openwebrx-squelch-slider', panel), squelch);
        const nr = group(toolbar, 'NR');
        move($('.openwebrx-nr-toggle', panel), nr); move($('#openwebrx-panel-nr'), nr);
        const step = group(toolbar, 'Step'); move($('#openwebrx-tuning-step-listbox'), step);
        step.append(button('−', () => tuneBySteps(-1)), button('+', () => tuneBySteps(1)));
        buildBandpass(toolbar); buildWaterfall(toolbar); buildAudio(toolbar);
        refs.record = button('● Record', () => safely(() => UI.toggleRecording())); toolbar.append(refs.record);
        toolbar.append(button('Scan', () => safely(() => UI.toggleScanner())));
        buildMore(toolbar);
        refs.connection = el('span', 'rd-connection', 'Connecting');
        refs.cpu = el('span'); refs.clients = el('span'); refs.clock = el('span', 'rd-clock');
        refs.antennaStatus = el('span', 'rd-antenna-status');
        const meter = el('span', 'rd-meter'); move($('#openwebrx-smeter'), meter); move($('#openwebrx-smeter-db'), meter);
        footer.append(refs.connection, meter, refs.cpu, refs.clients, refs.antennaStatus, refs.clock);
        refs.message = el('div', 'rd-message'); refs.message.hidden = true; refs.message.setAttribute('role', 'status'); dock.append(refs.message);
        const chat = $('#openwebrx-panel-log');
        chatWasVisible = !!(chat && getComputedStyle(chat).display !== 'none');
        if (chatWasVisible) toggle_panel('openwebrx-panel-log', false);
        document.body.classList.add('rig-dock-active');
        on(window, 'resize', reserveSpace);
        on(document, 'pointerdown', event => {
            if (popup && !popup.contains(event.target) && !opener.contains(event.target)) closePopup(false);
        });
        on(document, 'keydown', event => {
            if (event.key === 'Escape' && popup) { event.preventDefault(); event.stopPropagation(); closePopup(true); }
        }, true);
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(reserveSpace); observer.observe(panel); }
        timer = window.setInterval(tick, 500);
        tick(); reserveSpace();
    }
    plugin.init = async function () {
        if (mounted) return true;
        const returning = $('#rig-dock-return'); if (returning) returning.remove();
        try {
            await Plugins._load_style(base + 'rig_dock.css?v=' + plugin._version);
            // Plugins run at DOM ready, before the first receiver config creates the scale.
            const deadline = Date.now() + 20000;
            while (!(typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done &&
                    typeof scale_canvas !== 'undefined' && scale_canvas &&
                    typeof scale_ctx !== 'undefined' && scale_ctx)) {
                if (Date.now() > deadline) throw new Error('RIG Dock: waiting for the receiver to initialize; stock controls retained. Reload after the receiver connects.');
                await new Promise(resolve => window.setTimeout(resolve, 100));
            }
            mount(); return true;
        } catch (error) {
            console.error(error); if (mounted) plugin.destroy(false); return false;
        }
    };
    plugin.destroy = function (showReturn) {
        closePopup(false);
        if (Plugins.rig_audio && Plugins.rig_audio.setEnabled) Plugins.rig_audio.setEnabled(false);
        clearInterval(timer); if (observer) observer.disconnect();
        if (socket) socket.removeEventListener('message', receive);
        socket = null; cpu = clients = null;
        listeners.reverse().forEach(remove => remove()); listeners = [];
        moved.reverse().forEach(({node, marker}) => {
            node.classList.remove('rd-settings-native');
            if (marker.parentNode) marker.replaceWith(node);
        }); moved = [];
        all('.rig-dock-ui', panel).forEach(node => node.remove());
        document.body.classList.remove('rig-dock-active');
        document.documentElement.style.removeProperty('--rig-dock-height');
        mounted = false; modeSignature = '';
        if (chatWasVisible) toggle_panel('openwebrx-panel-log', true);
        if (typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done && typeof scale_canvas !== 'undefined' && scale_canvas && typeof scale_ctx !== 'undefined' && scale_ctx && typeof openwebrx_resize === 'function') openwebrx_resize();
        if (showReturn) {
            const back = el('button', 'rd-return', 'RIG Dock'); back.id = 'rig-dock-return'; back.type = 'button';
            back.addEventListener('click', () => plugin.init()); document.body.append(back);
        }
    };
}());
