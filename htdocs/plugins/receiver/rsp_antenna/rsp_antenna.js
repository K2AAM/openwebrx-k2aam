/* Shared RSPdx antenna controls. No additional libraries or browser extensions. */
(function () {
    'use strict';
    const plugin = Plugins.rsp_antenna;
    plugin._version = 0.1;
    let socket = null;
    let section = null;
    let heading = null;
    let buttons = null;
    let status = null;
    let state = null;
    let lastReply = 0;
    let pending = 0;
    let lastRequest = 0;
    let lastError = '';
    let buttonSignature = '';

    function send(type, params) {
        if (!socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify({type: type, params: params || {}}));
            return true;
        } catch (error) {
            return false;
        }
    }

    function key() {
        if (typeof UI !== 'undefined' && UI.getDemodulatorPanel) {
            const panel = UI.getDemodulatorPanel();
            if (panel && panel.getMagicKey) return panel.getMagicKey();
        }
        return '';
    }

    function select(antenna) {
        if (!state || !state.ready || pending) return;
        lastError = '';
        pending = Date.now();
        if (!send('setantenna', {
            sdr_id: state.sdr_id, antenna: antenna, key: key()
        })) {
            pending = 0;
            lastError = 'Connection unavailable.';
        }
        render();
    }

    function render() {
        if (!section) return;
        const connected = socket && socket.readyState === 1;
        const supported = !state || state.supported;
        heading.hidden = !supported;
        section.hidden = !supported;
        if (!supported) return;
        // Preserve focused buttons across the regular status polls.
        const signature = JSON.stringify([state && state.antennas,
            state && state.selected, !!connected, state && state.ready, !!pending]);
        if (signature !== buttonSignature) {
            buttonSignature = signature;
            buttons.replaceChildren();
            if (state) {
                state.antennas.forEach(function (antenna) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = antenna.label;
                    button.title = antenna.value;
                    button.setAttribute('aria-pressed', String(state.selected === antenna.value));
                    button.disabled = !connected || !state.ready || !!pending;
                    button.addEventListener('click', function () { select(antenna.value); });
                    buttons.appendChild(button);
                });
            }
        }
        if (!connected) {
            status.textContent = 'Receiver disconnected.';
        } else if (lastError) {
            status.textContent = lastError;
        } else if (pending) {
            status.textContent = 'Requesting antenna change…';
        } else if (!state) {
            status.textContent = 'Waiting for antenna controls…';
        } else if (!state.ready) {
            status.textContent = 'Waiting for the SDR to start…';
        } else {
            const antenna = state.antennas.find(function (item) { return item.value === state.selected; });
            const selection = antenna ? antenna.label : (state.selected || 'Profile default');
            status.textContent = selection + (state.held ? ' · Held across profiles.' : ' · Profile setting.');
        }
        status.classList.toggle('rsp-antenna-error', !!lastError);
    }

    function receive(event) {
        if (typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.type !== 'rsp_antenna_state') return;
        // This plugin owns these messages; keep the core's unknown-type logger quiet.
        event.stopImmediatePropagation();
        const value = message.value;
        if (!value || typeof value.supported !== 'boolean') return;
        // Ignore a late reply for the SDR we just left.
        if (typeof currentprofile !== 'undefined' && currentprofile.sdr_id &&
                value.sdr_id !== currentprofile.sdr_id) return;
        if (value.supported && !Array.isArray(value.antennas)) return;
        state = value;
        lastReply = Date.now();
        pending = 0;
        // Keep an error visible until the next click, rather than erasing it on a poll.
        if (value.error) lastError = value.error;
        else if (lastError.startsWith('Antenna status is stale.')) lastError = '';
        render();
    }

    function mount() {
        const settings = document.querySelector('#openwebrx-section-settings');
        if (!settings) return;
        if (typeof Plugins.addSection === 'function') {
            section = Plugins.addSection('rsp_antenna', 'Antenna');
            heading = section.previousElementSibling;
            if (typeof Plugins.toggleSection === 'function') {
                const saved = typeof LS !== 'undefined' && LS.has('plugin-section-rsp_antenna');
                if (!saved) Plugins.toggleSection('rsp_antenna', true);
            }
        } else {
            heading = document.createElement('div');
            heading.className = 'openwebrx-section-divider';
            heading.textContent = 'Antenna';
            section = document.createElement('div');
            section.className = 'openwebrx-section';
            settings.before(heading, section);
        }
        section.classList.add('rsp-antenna');
        buttons = document.createElement('div');
        buttons.className = 'rsp-antenna-buttons';
        status = document.createElement('div');
        status.className = 'rsp-antenna-status';
        status.setAttribute('role', 'status');
        const note = document.createElement('div');
        note.className = 'rsp-antenna-note';
        note.textContent = 'Shared receiver: changing antennas affects all listeners.';
        section.append(buttons, status, note);
    }

    function tick() {
        if (!section) mount();
        const next = typeof ws !== 'undefined' ? ws : null;
        if (next !== socket) {
            if (socket) socket.removeEventListener('message', receive, true);
            socket = next;
            state = null;
            pending = 0;
            lastError = '';
            lastReply = 0;
            lastRequest = 0;
            if (socket) socket.addEventListener('message', receive, true);
        }
        if (state && typeof currentprofile !== 'undefined' &&
                currentprofile.sdr_id && state.sdr_id !== currentprofile.sdr_id) {
            state = null;
            pending = 0;
            lastRequest = 0;
        }
        const now = Date.now();
        if (now - lastRequest >= 2500 && send('getantenna')) lastRequest = now;
        if (pending && now - pending > 7000) {
            pending = 0;
            lastError = 'No response to the change. Check reception and try again.';
        }
        if (state && lastReply && now - lastReply > 10000) {
            state.ready = false;
            lastError = 'Antenna status is stale. Waiting for the server…';
        }
        render();
    }

    plugin.init = function () {
        if (plugin.timer) return true;
        plugin.timer = window.setInterval(tick, 750);
        tick();
        return true;
    };
}());
