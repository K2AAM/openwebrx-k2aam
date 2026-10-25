/* RIG Dock for OpenWebRX+ 1.2.126. MIT License. */
(function () {
    'use strict';
    const plugin = Plugins.rig_dock;
    plugin._version = '0.3.1';
    plugin.no_css = true;
    const base = ((document.currentScript && document.currentScript.src) ||
        'static/plugins/receiver/rig_dock/rig_dock.js').replace(/[^/]*$/, '');
    let panel, dock, popup, opener, observer, socket, timer;
    let cpu = null, clients = null, moved = [], listeners = [], audioPromise;
    let modeSignature = '', mounted = false, chatWasVisible = false;
    let pendingTune = null, centerChangesAllowed = null;
    let decoderObserver, decoderFrame = null, decoderCanvasTimer = null;
    let decoderNodes = [], decoderSignature = '', decoderCollapsed = false, decoderPercent = 28;
    let decoderIFPreference = null, decoderFit = true;
    let startupStyle, startupNotice;
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
    function showStartup() {
        // The main stylesheet may still be downloading on a cold connection.
        // Visibility keeps native panel measurements and initialization intact.
        startupStyle = el('style');
        startupStyle.textContent = 'body.rig-dock-loading #openwebrx-panels-container { visibility: hidden !important; }' +
            '#rig-dock-startup { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1050;' +
            'box-sizing: border-box; padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));' +
            'background: #111c2c; color: #b8d5e8; border-top: 1px solid #4b6481;' +
            'font: 13px system-ui, -apple-system, sans-serif; pointer-events: none; }';
        startupNotice = el('div', '', 'Connecting to receiver…');
        startupNotice.id = 'rig-dock-startup'; startupNotice.setAttribute('role', 'status');
        document.head.append(startupStyle);
        document.body.classList.add('rig-dock-loading');
        document.body.append(startupNotice);
    }
    function hideStartup() {
        document.body.classList.remove('rig-dock-loading');
        if (startupNotice) startupNotice.remove();
        if (startupStyle) startupStyle.remove();
        startupNotice = startupStyle = null;
    }
    function receiverReady() {
        const profiles = $('#openwebrx-sdr-profiles-listbox');
        const nativePanel = window.jQuery && window.jQuery('#openwebrx-panel-receiver').data('panel');
        return typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done &&
            typeof scale_canvas !== 'undefined' && scale_canvas &&
            typeof scale_ctx !== 'undefined' && scale_ctx &&
            typeof Modes !== 'undefined' && Modes.initComplete() &&
            nativePanel && !nativePanel.centerFreqTimeout &&
            typeof center_freq !== 'undefined' && nativePanel.center_freq === center_freq &&
            nativePanel.getDemodulator() && typeof UI !== 'undefined' &&
            Number.isFinite(UI.getFrequency()) && UI.getFrequency() > 0 &&
            profiles && profiles.selectedIndex >= 0 && !!profiles.value;
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
        try {
            const result = fn();
            if (result && typeof result.then === 'function') result.then(() => message(''), error => message(error.message || String(error)));
            else message('');
        } catch (error) { message(error.message || String(error)); }
    }
    function manualControl(action) {
        const scan = window.owrxAleScanner;
        if (scan && scan.isRunning()) return scan.takeControl().then(action);
        return action();
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
        if (popup === refs.tunePopup) finishTune('');
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
                    return manualControl(() => { UI.setModulation(mode.modulation); closePopup(true); tick(); });
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
        on(refs.underlying, 'change', () => safely(() => manualControl(() =>
            UI.setModulation(UI.getModulation(), refs.underlying.value))));
        refs.modePopup = pop.node;
    }
    function finishTune(error) {
        if (pendingTune) window.clearInterval(pendingTune.timer);
        pendingTune = null;
        if (refs.tuneSubmit) refs.tuneSubmit.disabled = false;
        if (refs.tuneCancel) refs.tuneCancel.hidden = true;
        if (refs.tuneFeedback) refs.tuneFeedback.textContent = error || '';
        if (refs.message) message(error || '');
    }
    function inCapture(value) {
        return typeof center_freq === 'number' && typeof bandwidth === 'number' &&
            bandwidth > 0 && Math.abs(value - center_freq) < bandwidth / 2;
    }
    function tuneFrequency(value) {
        finishTune('');
        const activeSocket = typeof ws !== 'undefined' ? ws : null;
        if (!activeSocket || activeSocket.readyState !== 1)
            throw new Error('The receiver is disconnected. Reconnect and try again.');
        if (inCapture(value)) {
            UI.toggleScanner(false);
            if (UI.setFrequency(value, false) === false || Math.abs(UI.getFrequency() - value) > 1)
                throw new Error('The receiver could not tune there.');
            closePopup(true);
            return;
        }
        if (centerChangesAllowed === false)
            throw new Error('Enable Allow center frequency changes in the receiver settings to tune outside the current view.');
        const demodPanel = UI.getDemodulatorPanel();
        const request = {
            value, socket: activeSocket, acknowledged: false, deadline: Date.now() + 10000,
            profile: $('#openwebrx-sdr-profiles-listbox').value,
            mode: UI.getModulation(), underlying: UI.getUnderlying(), timer: null
        };
        UI.toggleScanner(false);
        pendingTune = request;
        refs.tuneSubmit.disabled = true;
        refs.tuneCancel.hidden = false;
        refs.tuneFeedback.textContent = 'Waiting for the receiver to tune…';
        request.timer = window.setInterval(() => {
            if (pendingTune !== request) return;
            try {
                if (!mounted) { finishTune(''); return; }
                if (typeof ws === 'undefined' || ws !== request.socket || request.socket.readyState !== 1)
                    throw new Error('The receiver disconnected before tuning completed.');
                if ($('#openwebrx-sdr-profiles-listbox').value !== request.profile) {
                    finishTune('Tuning stopped because the receiver or profile changed.'); return;
                }
                if (Date.now() > request.deadline)
                    throw new Error('The receiver did not retune. Check Allow center frequency changes, your magic key, and the SDR tuning range.');
                const currentPanel = UI.getDemodulatorPanel();
                // Native OWRX restarts the demodulator 50 ms after a center change.
                if (!request.acknowledged || !inCapture(value) || currentPanel.centerFreqTimeout ||
                    currentPanel.center_freq !== center_freq || !UI.getDemodulator()) return;
                UI.setModulation(request.mode, request.underlying);
                if (UI.setFrequency(value, false) === false || Math.abs(UI.getFrequency() - value) > 1)
                    throw new Error('The receiver moved, but could not set the listening frequency.');
                finishTune('');
                closePopup(true);
            } catch (error) { finishTune(error.message || String(error)); }
        }, 100);
        try {
            activeSocket.send(JSON.stringify({type: 'setfrequency', params: {
                frequency: value, key: demodPanel.getMagicKey()
            }}));
        } catch (error) { finishTune(error.message || String(error)); }
    }
    function buildTune(main) {
        const frequency = group(main);
        frequency.classList.add('rd-frequency');
        move($('.frequencies-container', panel), frequency);
        const pop = popover('tune', 'Tune frequency', 'Tune ▴');
        refs.tunePopup = pop.node;
        frequency.append(pop.trigger);
        const form = el('form', 'rd-tune-form');
        const input = el('input'); input.type = 'text'; input.inputMode = 'decimal';
        input.placeholder = '7.121 MHz'; input.setAttribute('aria-label', 'Frequency with units');
        const units = el('select'); units.setAttribute('aria-label', 'Frequency units');
        ['Hz','kHz','MHz'].forEach(unit => { const option = el('option', '', unit); option.value = unit; units.append(option); });
        units.value = 'MHz';
        const submit = el('button', 'rd-button rd-primary', 'Tune'); submit.type = 'submit';
        refs.tuneSubmit = submit;
        form.append(input, units, submit);
        pop.node.append(form, el('p', 'rd-note', 'Use Hz, kHz, or MHz. A value without units is MHz.'));
        pop.node.append(el('p', 'rd-note', 'Outside the current view, Tune moves the receiver for everyone using this SDR. Server tuning limits still apply.'));
        refs.tuneFeedback = el('p', 'rd-note'); refs.tuneFeedback.setAttribute('role', 'status');
        refs.tuneCancel = button('Stop waiting', () => finishTune('Stopped waiting for receiver tuning.'));
        refs.tuneCancel.hidden = true;
        pop.node.append(refs.tuneFeedback, refs.tuneCancel);
        on(form, 'submit', async event => {
            event.preventDefault();
            if (pendingTune) return;
            try {
                const match = /^\s*(\d+(?:\.\d+)?)\s*(Hz|kHz|MHz)?\s*$/i.exec(input.value);
                if (!match) throw new Error('Enter a frequency such as 7.121 MHz.');
                const unit = (match[2] || units.value).toLowerCase();
                const value = Math.round(Number(match[1]) * {hz: 1, khz: 1e3, mhz: 1e6}[unit]);
                if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Enter a positive frequency.');
                refs.tuneSubmit.disabled = true;
                await manualControl(() => tuneFrequency(value));
                if (!pendingTune) refs.tuneSubmit.disabled = false;
            } catch (error) { finishTune(error.message || String(error)); }
        });
        const readout = $('.webrx-actual-freq', frequency);
        const readoutAttributes = ['role','tabindex','title','aria-label'].map(name => [name,readout.getAttribute(name)]);
        listeners.push(() => readoutAttributes.forEach(([name,value]) => value === null ? readout.removeAttribute(name) : readout.setAttribute(name,value)));
        readout.setAttribute('role','button'); readout.tabIndex = 0;
        readout.title = 'Enter a frequency'; readout.setAttribute('aria-label','Enter frequency');
        const edit = () => { input.value = String(UI.getFrequency()/1e6); units.value = 'MHz'; openPopup(pop.node,pop.trigger); input.focus(); input.select(); };
        on(readout,'click',event => { event.preventDefault(); event.stopImmediatePropagation(); edit(); },true);
        on(readout,'keydown',event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
        on($('#openwebrx-sdr-profiles-listbox'), 'change', () => {
            if (pendingTune) finishTune('Tuning stopped because the receiver or profile changed.');
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
        const pop = popover('more', 'More controls'); toolbar.append(pop.trigger); refs.more = pop.node; refs.moreTrigger = pop.trigger;
        const actions = group(pop.node);
        actions.append(button('Zoom −', () => zoomOutOneStep()), button('Zoom +', () => zoomInOneStep()));
        native('#openwebrx-panel-plugins', pop.node, 'Plugins');
        const settings = $('#openwebrx-section-settings', panel);
        if (settings) {
            const content = move(settings.nextElementSibling, pop.node);
            content.classList.add('rd-settings-native');
        }
        pop.node.append(button('Use stock controls', () => plugin.destroy(true)));
    }
    function decoderActive(node) {
        // Native visibility remains meaningful when the parent tray or its IF
        // view is collapsed. Layout visibility must not stop a decoder's data.
        return node.isConnected && node.style.display !== 'none' && !node.hidden && !node.classList.contains('disabled');
    }
    function settleDecoderPanels() {
        decoderNodes.forEach(node => {
            // Docked panels do not use the floating UI's 3-D animation. Finish
            // its state change explicitly: transitionend cannot run while the
            // tray is collapsed or an animation has been disabled by CSS.
            if (node.movement === 'collapse') node.style.display = 'none';
            if (node.movement === 'collapse' || node.movement === 'expand') delete node.movement;
        });
    }
    function adoptDecoders() {
        let changed = false;
        all('.openwebrx-panel.openwebrx-message-panel, .openwebrx-panel.openwebrx-meta-panel, #openwebrx-panel-digimodes').forEach(node => {
            if (decoderNodes.includes(node)) return;
            decoderNodes.push(node);
            node.classList.add('rd-decoder-native');
            move(node, refs.decoderBody);
            changed = true;
        });
        decoderNodes.forEach(node => all('.openwebrx-button, button', node).forEach(control => {
            if (control.textContent.trim() === 'Clear' && !control.classList.contains('rd-native-clear'))
                control.classList.add('rd-native-clear');
        }));
        return changed;
    }
    function saveDecoderSetting(key, value) {
        try { localStorage.setItem('rig_dock_decoder_' + key, String(value)); } catch (error) { /* Optional preference. */ }
    }
    function clearDecoders() {
        decoderNodes.filter(decoderActive).forEach(node => {
            const clear = $('.rd-native-clear', node);
            if (clear) clear.click();
            if (node.id === 'openwebrx-panel-digimodes') {
                const text = $('#openwebrx-digimode-content .nano-content', node);
                const cursor = $('#openwebrx-cursor-blink', node);
                if (text && cursor) { text.replaceChildren(cursor); }
            }
        });
    }
    function refreshDecoderCanvas() {
        clearTimeout(decoderCanvasTimer);
        decoderCanvasTimer = setTimeout(() => {
            if (!mounted || refs.decoderTray.hidden || refs.decoderBody.hidden) return;
            const host = $('#openwebrx-digimode-canvas-container');
            if (!host || host.getBoundingClientRect().width < 1 || host.getBoundingClientRect().height < 1) return;
            if (typeof secondary_demod_canvases_initialized !== 'undefined' && secondary_demod_canvases_initialized &&
                typeof secondary_demod_init_canvases === 'function') {
                secondary_demod_init_canvases();
                if (typeof secondary_demod_waterfall_set_zoom === 'function' &&
                    typeof secondary_demod_low_cut === 'number' && typeof secondary_demod_high_cut === 'number')
                    secondary_demod_waterfall_set_zoom(secondary_demod_low_cut, secondary_demod_high_cut);
            }
            if (window.jQuery && window.jQuery.fn.nanoScroller)
                window.jQuery('#openwebrx-digimode-content').nanoScroller();
        }, 80);
    }
    function layoutDecoders() {
        if (!refs.decoderTray) return 0;
        settleDecoderPanels();
        const active = decoderNodes.filter(decoderActive);
        refs.decoderTray.hidden = !active.length;
        if (!active.length) return 0;
        const mode = modes().find(item => item.modulation === UI.getModulation());
        refs.decoderTitle.textContent = (mode ? mode.name : 'Decoder') + ' · Decoders';
        refs.decoderBody.hidden = decoderCollapsed;
        refs.decoderCollapse.textContent = decoderCollapsed ? 'Expand' : 'Collapse';
        refs.decoderCollapse.setAttribute('aria-expanded', String(!decoderCollapsed));
        refs.decoderHeight.disabled = decoderCollapsed;
        refs.decoderClear.disabled = !active.some(node => $('.rd-native-clear', node) ||
            (node.id === 'openwebrx-panel-digimodes' && $('#openwebrx-cursor-blink', node)));
        const digimodes = $('#openwebrx-panel-digimodes');
        const hasIF = active.includes(digimodes) && !!$('#openwebrx-digimode-canvas-container');
        const content = $('#openwebrx-digimode-content-container');
        const hasText = !!(active.includes(digimodes) && content && getComputedStyle(content).display !== 'none');
        const hasResults = active.some(node => node !== digimodes);
        refs.decoderTray.dataset.text = String(hasText);
        refs.decoderTray.dataset.results = String(hasResults);
        const showIF = decoderIFPreference === null ? !(innerWidth <= 620 && (hasResults || hasText)) : decoderIFPreference;
        const changedIF = refs.decoderTray.classList.contains('rd-if-hidden') === showIF;
        refs.decoderTray.classList.toggle('rd-if-hidden', !showIF);
        refs.decoderIF.setAttribute('aria-pressed', String(showIF));
        refs.decoderIF.hidden = !hasIF;
        const dockHeight = panel.getBoundingClientRect().height;
        const top = $('#webrx-canvas-background').getBoundingClientRect().top;
        const available = Math.max(0, window.innerHeight - dockHeight - top);
        const headerHeight = refs.decoderHeader.getBoundingClientRect().height;
        const maximum = Math.max(headerHeight, available - Math.min(80, available * .35));
        const minimumBody = innerWidth <= 620 ? 72 : 48;
        let requestedHeight = available * decoderPercent / 100;
        const ale = active.find(node => node.id === 'openwebrx-panel-ale2g-message');
        refs.decoderFit.hidden = !ale;
        refs.decoderFit.setAttribute('aria-pressed',String(decoderFit));
        if (ale && decoderFit) {
            const controls = $('.ale-scan-controls',ale), head = $('thead',ale), rows = all('tbody tr',ale);
            const rowHeight = rows.slice(-6).reduce((total,row) => total+row.getBoundingClientRect().height,0);
            requestedHeight = headerHeight+(controls ? Math.max(controls.getBoundingClientRect().height,controls.scrollHeight) : 0)+
                (head ? head.getBoundingClientRect().height : 0)+Math.max(48,rowHeight)+12;
        }
        const height = decoderCollapsed ? headerHeight : Math.min(maximum, Math.max(headerHeight + minimumBody, requestedHeight));
        const previous = refs.decoderTray.style.height;
        refs.decoderTray.style.height = Math.ceil(height) + 'px';
        if (changedIF || previous !== refs.decoderTray.style.height) refreshDecoderCanvas();
        return Math.ceil(height);
    }
    function syncDecoders() {
        if (!mounted || !refs.decoderBody) return;
        adoptScreenshot();
        const adopted = adoptDecoders();
        settleDecoderPanels();
        const active = decoderNodes.filter(decoderActive);
        const ale = active.find(node => node.id === 'openwebrx-panel-ale2g-message');
        const fitSignature = ale && decoderFit ? all('tbody tr',ale).slice(-6).map(row => row.getBoundingClientRect().height).join(',') : '';
        const signature = active.map(node => node.id).join('|') + ':' + UI.getModulation()+':'+fitSignature;
        if (adopted || signature !== decoderSignature) {
            decoderSignature = signature;
            reserveSpace();
            refreshDecoderCanvas();
        }
    }
    function buildDecoders() {
        try {
            decoderCollapsed = localStorage.getItem('rig_dock_decoder_collapsed') === 'true';
            const savedHeight = localStorage.getItem('rig_dock_decoder_height');
            decoderFit = localStorage.getItem('rig_dock_decoder_fit') === 'true' || (localStorage.getItem('rig_dock_decoder_fit') === null && savedHeight === null);
            const percent = Number(savedHeight);
            decoderPercent = percent >= 16 && percent <= 65 ? percent : 28;
            const showIF = localStorage.getItem('rig_dock_decoder_if');
            decoderIFPreference = showIF === null ? null : showIF === 'true';
        } catch (error) { /* Defaults also work without storage. */ }
        const tray = refs.decoderTray = el('section', 'rig-dock-ui rd-decoder-tray');
        tray.id = 'rig-decoder-tray'; tray.hidden = true;
        tray.setAttribute('aria-label', 'Decoder output');
        const header = refs.decoderHeader = el('div', 'rd-decoder-header');
        refs.decoderTitle = el('strong', 'rd-decoder-title', 'Decoders');
        const heightLabel = el('label', 'rd-decoder-height', 'Height');
        const height = refs.decoderHeight = el('input');
        height.type = 'range'; height.min = '16'; height.max = '65'; height.value = String(decoderPercent);
        height.setAttribute('aria-label', 'Decoder pane height');
        heightLabel.append(height);
        const changeHeight = () => {
            decoderFit = false; saveDecoderSetting('fit', false);
            decoderPercent = Number(height.value);
            saveDecoderSetting('height', decoderPercent); reserveSpace(); refreshDecoderCanvas();
        };
        on(height, 'input', changeHeight); on(height, 'change', changeHeight);
        refs.decoderFit = button('Fit', () => { decoderFit = !decoderFit; saveDecoderSetting('fit',decoderFit); reserveSpace(); });
        refs.decoderFit.title = 'Fit ALE output to the latest rows; use Height for a fixed size';
        refs.decoderIF = button('IF waterfall', () => {
            decoderIFPreference = tray.classList.contains('rd-if-hidden');
            saveDecoderSetting('if', decoderIFPreference); reserveSpace(); refreshDecoderCanvas();
        });
        refs.decoderIF.setAttribute('aria-pressed', 'true');
        refs.decoderIF.title = 'Show or hide the decoder waterfall; decoding continues';
        refs.decoderClear = button('Clear', clearDecoders);
        refs.decoderCollapse = button('Collapse', () => {
            decoderCollapsed = !decoderCollapsed;
            saveDecoderSetting('collapsed', decoderCollapsed); reserveSpace(); refreshDecoderCanvas();
        });
        refs.decoderCollapse.setAttribute('aria-controls', 'rig-decoder-body');
        refs.decoderCollapse.title = 'Collapse the output area while decoding continues';
        refs.decoderBody = el('div', 'rd-decoder-body'); refs.decoderBody.id = 'rig-decoder-body';
        header.append(refs.decoderTitle, heightLabel, refs.decoderFit, refs.decoderIF, refs.decoderClear, refs.decoderCollapse);
        tray.append(header, refs.decoderBody);
        on(tray,'toggle',reserveSpace,true);
        // A fixed child of the native animated receiver panel can inherit its
        // transformed containing block. Keep the tray beside the panel stacks.
        $('#openwebrx-panels-container').append(tray);
        adoptDecoders();
        decoderObserver = new MutationObserver(() => {
            if (decoderFrame !== null) return;
            decoderFrame = requestAnimationFrame(() => { decoderFrame = null; syncDecoders(); });
        });
        decoderObserver.observe($('#openwebrx-panels-container'), {
            subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-mode']
        });
    }
    function adoptScreenshot() {
        if (!refs.actions || !refs.record) return;
        const screenshots = all('#screenshot-btn',panel);
        if (!screenshots.length) return;
        // The upstream plugin wraps every .openwebrx-record-button, including
        // our permission marker. Its first native PIC node owns the handler;
        // a second id created beside our Record button has no handler.
        const pic = screenshots.includes(refs.screenshot) ? refs.screenshot :
            screenshots.find(node => !dock.contains(node)) || screenshots[0];
        screenshots.filter(node => node !== pic && dock.contains(node)).forEach(node => node.remove());
        const wrapper = refs.record.parentElement;
        if (wrapper !== refs.actions && wrapper.parentElement === refs.actions &&
            wrapper.matches('.openwebrx-button.openwebrx-square-button')) {
            refs.actions.prepend(refs.record);
            if (!wrapper.children.length) wrapper.remove();
        }
        if (pic !== refs.screenshot) {
            const attributes = ['class','role','tabindex','title','aria-label'].map(name => [name,pic.getAttribute(name)]);
            const text = pic.textContent;
            listeners.push(() => {
                attributes.forEach(([name,value]) => value === null ? pic.removeAttribute(name) : pic.setAttribute(name,value));
                pic.textContent = text;
            });
            pic.classList.add('rd-button','rd-screenshot'); pic.textContent = 'Screenshot';
            pic.setAttribute('role','button'); pic.tabIndex = 0;
            pic.title = 'Save a waterfall screenshot'; pic.setAttribute('aria-label','Save waterfall screenshot');
            on(pic,'keydown',event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pic.click(); }
            });
            move(pic,refs.actions); refs.screenshot = pic;
        }
        if (pic.parentElement === refs.actions && pic.nextElementSibling !== refs.moreTrigger)
            refs.actions.insertBefore(pic,refs.moreTrigger);
    }
    function adoptPlugins() {
        adoptScreenshot();
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
            if (data.type === 'config' && data.value) {
                if (typeof data.value.allow_center_freq_changes === 'boolean') {
                    centerChangesAllowed = data.value.allow_center_freq_changes;
                    if (pendingTune && !centerChangesAllowed)
                        finishTune('Enable Allow center frequency changes in the receiver settings to tune outside the current view.');
                }
                if (pendingTune && data.value.center_freq === pendingTune.value)
                    pendingTune.acknowledged = true;
            }
            if (data.type === 'sdr_error' && pendingTune)
                finishTune('The SDR reported an error while tuning. Check the receiver and its tuning range.');
        } catch (error) { /* Binary and unrelated messages belong to OWRX. */ }
    }
    function reserveSpace() {
        if (!mounted) return;
        document.documentElement.style.setProperty('--rig-dock-height', Math.ceil(panel.getBoundingClientRect().height) + 'px');
        document.documentElement.style.setProperty('--rig-decoder-height', layoutDecoders() + 'px');
        positionPopup();
        if (typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done && typeof scale_canvas !== 'undefined' && scale_canvas && typeof scale_ctx !== 'undefined' && scale_ctx && typeof openwebrx_resize === 'function') openwebrx_resize();
    }
    function tick() {
        if (!mounted) return;
        adoptPlugins();
        syncDecoders();
        const nextSocket = typeof ws !== 'undefined' ? ws : null;
        if (socket !== nextSocket) {
            if (pendingTune) finishTune('The receiver connection changed before tuning completed.');
            if (socket) socket.removeEventListener('message', receive);
            socket = nextSocket; cpu = clients = null; centerChangesAllowed = null;
            // A client count may have arrived before this plugin finished loading.
            if (window.jQuery) {
                const bar = window.jQuery('#openwebrx-bar-clients').data('progressbar');
                if (bar && Number.isFinite(bar.clients)) clients = bar.clients;
            }
            if (socket) socket.addEventListener('message', receive);
        }
        const connected = socket && socket.readyState === 1;
        const aleScan = window.owrxAleScanner;
        refs.aleStatus.hidden = !(aleScan && aleScan.isRunning());
        if (!refs.aleStatus.hidden) refs.aleStatus.textContent = 'ALE · '+aleScan.status()+' · Stop';
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
        refs.antennaStatus.title = 'Current receiver antenna. ' + refs.antennaStatus.textContent;
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
        const nr = group(toolbar);
        move($('.openwebrx-nr-toggle', panel), nr); move($('#openwebrx-panel-nr'), nr);
        const step = group(toolbar, 'Step'); move($('#openwebrx-tuning-step-listbox'), step);
        step.append(button('−', () => safely(() => manualControl(() => tuneBySteps(-1)))), button('+', () => safely(() => manualControl(() => tuneBySteps(1)))));
        buildBandpass(toolbar); buildWaterfall(toolbar); buildAudio(toolbar);
        const nativeRecord = $('.openwebrx-record-button', panel);
        refs.record = button('● Record', () => safely(() => { UI.toggleRecording(); tick(); }));
        // Native UI.toggleRecording gates recording on a visible control with
        // this class. The same class also receives server permission changes.
        refs.record.classList.add('openwebrx-record-button');
        refs.record.style.display = nativeRecord ? nativeRecord.style.display : 'none';
        refs.record.title = 'Record receiver audio; stop to download the MP3';
        const actions = refs.actions = group(main); refs.screenshot = null; actions.classList.add('rd-actions'); actions.append(refs.record);
        buildMore(actions);
        toolbar.append(button('Scan', () => safely(() => manualControl(() => UI.toggleScanner()))));
        refs.connection = el('span', 'rd-connection', 'Connecting');
        refs.cpu = el('span'); refs.clients = el('span'); refs.clock = el('span', 'rd-clock');
        refs.antennaStatus = el('span', 'rd-antenna-status');
        const meter = el('span', 'rd-meter'); move($('#openwebrx-smeter'), meter); move($('#openwebrx-smeter-db'), meter);
        refs.aleStatus = button('ALE', () => safely(() => window.owrxAleScanner.takeControl()), 'rd-ale-status');
        refs.aleStatus.title = 'Stop the ALE scanner and take manual control'; refs.aleStatus.hidden = true;
        footer.append(refs.connection, meter, refs.cpu, refs.clients, refs.antennaStatus, refs.aleStatus, refs.clock);
        refs.message = el('div', 'rd-message'); refs.message.hidden = true; refs.message.setAttribute('role', 'status'); dock.append(refs.message);
        buildDecoders();
        const chat = $('#openwebrx-panel-log');
        chatWasVisible = !!(chat && getComputedStyle(chat).display !== 'none');
        if (chatWasVisible) toggle_panel('openwebrx-panel-log', false);
        document.body.classList.add('rig-dock-active');
        on(window, 'resize', reserveSpace);
        if (window.visualViewport) on(window.visualViewport, 'resize', reserveSpace);
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
        let styleTimeout;
        try {
            showStartup();
            const deadline = Date.now() + 20000;
            await Promise.race([
                Plugins._load_style(base + 'rig_dock.css?v=' + plugin._version),
                new Promise((resolve, reject) => {
                    styleTimeout = window.setTimeout(() => reject(new Error('RIG Dock: stylesheet load timed out; stock controls retained.')), 20000);
                })
            ]);
            clearTimeout(styleTimeout);
            // Config, modes/features, profiles, and the native 50 ms demodulator
            // restart can finish independently. The canvas alone is not readiness.
            while (!receiverReady()) {
                if (Date.now() > deadline) throw new Error('RIG Dock: receiver startup timed out; stock controls retained. Reload after the receiver connects.');
                await new Promise(resolve => window.setTimeout(resolve, 100));
            }
            mount(); return true;
        } catch (error) {
            console.error(error); if (mounted) plugin.destroy(false); return false;
        } finally {
            clearTimeout(styleTimeout); hideStartup();
        }
    };
    plugin.destroy = function (showReturn) {
        const decoderSet = new Set(decoderNodes);
        finishTune('');
        if (decoderObserver) decoderObserver.disconnect();
        if (decoderFrame !== null) cancelAnimationFrame(decoderFrame);
        decoderFrame = null; clearTimeout(decoderCanvasTimer);
        decoderNodes.forEach(node => {
            node.classList.remove('rd-decoder-native');
            all('.rd-native-clear', node).forEach(control => control.classList.remove('rd-native-clear'));
        });
        decoderNodes = []; decoderSignature = '';
        closePopup(false);
        if (Plugins.rig_audio && Plugins.rig_audio.setEnabled) Plugins.rig_audio.setEnabled(false);
        clearInterval(timer); if (observer) observer.disconnect();
        if (socket) socket.removeEventListener('message', receive);
        socket = null; cpu = clients = null;
        listeners.reverse().forEach(remove => remove()); listeners = [];
        moved.reverse().forEach(({node, marker}) => {
            node.classList.remove('rd-settings-native');
            if (marker.parentNode) {
                if (decoderSet.has(node) && !node.isConnected) marker.remove();
                else marker.replaceWith(node);
            }
        }); moved = [];
        if (refs.decoderTray) refs.decoderTray.remove();
        all('.rig-dock-ui', panel).forEach(node => node.remove());
        document.body.classList.remove('rig-dock-active');
        document.documentElement.style.removeProperty('--rig-dock-height');
        document.documentElement.style.removeProperty('--rig-decoder-height');
        refs.screenshot = null; refs.actions = null;
        mounted = false; modeSignature = '';
        if (chatWasVisible) toggle_panel('openwebrx-panel-log', true);
        if (typeof waterfall_setup_done !== 'undefined' && waterfall_setup_done && typeof scale_canvas !== 'undefined' && scale_canvas && typeof scale_ctx !== 'undefined' && scale_ctx && typeof openwebrx_resize === 'function') openwebrx_resize();
        if (showReturn) {
            const back = el('button', 'rd-return', 'RIG Dock'); back.id = 'rig-dock-return'; back.type = 'button';
            back.addEventListener('click', () => plugin.init()); document.body.append(back);
        }
    };
}());
