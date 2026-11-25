/*
 * ui_select: lets each visitor choose the receiver interface.
 *
 *   dock     K2AAM Dock (plugin k2aam_dock)
 *   console  K2AAM Console (same plugin, receiver strip and side decoder panel)
 *   rig    original RIG skin by SV1DOD / HB9ISH (plugin rig_skin)
 *   stock  unmodified OpenWebRX+ controls
 *
 * Load from init.js with Plugins.load('ui_select'). The operator default is
 * set with a plain global before loading, for example
 *   window.ui_select_config = { default: 'stock' };
 * A visitor's own choice is kept in that browser and applied by reloading
 * the page, because the dock and the RIG skin both rebuild the receiver
 * panel and cannot be active together. MIT License.
 */
(function () {
    'use strict';
    const plugin = Plugins.ui_select;
    plugin._version = '0.2.0';
    plugin.no_css = true;
    const KEY = 'ui_select_choice';
    const choices = [['dock', 'K2AAM Dock'], ['console', 'K2AAM Console'], ['rig', 'RIG skin'], ['stock', 'Stock']];
    const valid = name => choices.some(choice => choice[0] === name);

    function current() {
        let saved = null;
        try { saved = localStorage.getItem(KEY); } catch (error) { /* Storage is optional. */ }
        if (valid(saved)) return saved;
        const configured = window.ui_select_config && window.ui_select_config.default;
        return valid(configured) ? configured : 'dock';
    }
    plugin.current = current;
    plugin.choose = function (name) {
        if (!valid(name)) throw new Error('Unknown interface: ' + name);
        if (name === current()) return;
        try { localStorage.setItem(KEY, name); } catch (error) { /* The choice then lasts for this load only. */ }
        window.location.reload();
    };

    function addChooser(active) {
        if (document.getElementById('ui-select-listbox')) return;
        const themes = document.getElementById('openwebrx-themes-listbox');
        const line = themes && themes.closest('.openwebrx-panel-line');
        if (!line) return;
        const row = document.createElement('div');
        row.className = 'openwebrx-panel-line ui-select-line';
        const label = document.createElement('label');
        label.htmlFor = 'ui-select-listbox';
        label.textContent = 'Interface ';
        label.style.marginRight = '6px';
        const select = document.createElement('select');
        select.id = 'ui-select-listbox';
        select.className = 'openwebrx-panel-listbox';
        select.title = 'Receiver interface; changing it reloads the page';
        choices.forEach(function (choice) {
            const option = document.createElement('option');
            option.value = choice[0]; option.textContent = choice[1];
            select.append(option);
        });
        select.value = active;
        select.addEventListener('change', function () { plugin.choose(select.value); });
        row.append(label, select);
        line.before(row);
    }

    plugin.init = async function () {
        const active = current();
        addChooser(active);
        if (active === 'rig') {
            await Plugins.load('rig_skin');
            const themes = window.jQuery && window.jQuery('#openwebrx-themes-listbox');
            if (themes && themes.find('option[value="rig"]').length) themes.val('rig').trigger('change');
        } else {
            // A saved "rig" theme has no stylesheet unless the skin is loaded.
            if (typeof UI !== 'undefined' && UI.theme === 'rig') UI.setTheme('default');
            if (active === 'dock' || active === 'console') {
                // The console is the dock plugin in its second arrangement.
                window.k2aam_dock_layout = active;
                await Plugins.load('k2aam_dock');
            }
        }
        return true;
    };
}());
