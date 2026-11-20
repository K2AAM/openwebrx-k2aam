// Receiver plugins for this station. See contrib/PLUGINS.md.
//
// To change the interface visitors get first, uncomment and edit:
// window.ui_select_config = { default: 'stock' };   // 'dock' (default), 'rig' or 'stock'

Plugins.load('ale');         // ALE panel and scanner; stays hidden unless the server has the ALE backend
Plugins.load('ui_select');   // interface chooser: K2AAM Dock, RIG skin or stock controls
Plugins.load('rsp_antenna'); // RSPdx antenna buttons; hidden unless /etc/openwebrx/antenna-switcher.json enables a device

// BEGIN remote plugins
// Community plugins from the 0xAF collection, loaded from its site on every page view.
// They are third-party code that updates on its own; remove a name to stop loading it.
Plugins.tune_precise_steps = [12500, 5000, 10];
(function () {
    const base = 'https://0xaf.github.io/openwebrxplus-plugins/receiver';
    const remote = [
        'colorful_spectrum',
        'connect_notify',
        'doppler',
        'freq_scanner',
        'frequency_far_jump',
        'mouse_freq',
        'screenshot',
        'search_bookmarks',
        'show_band_plan',
        'toggle_scannable',
        'tune_checkbox',
        'tune_precise',
    ];
    // utils first, then notify: the others depend on them.
    Plugins.load(base + '/utils/utils.js').then(async function () {
        if (!Plugins.utils || !Plugins.utils._script_loaded) throw new Error('utils did not load');
        await Plugins.load(base + '/notify/notify.js');
        for (const name of remote) {
            // One failing plugin must not stop the rest.
            try { await Plugins.load(base + '/' + name + '/' + name + '.js'); }
            catch (error) { console.error('Plugin failed to load: ' + name, error); }
        }
    }).catch(function (error) {
        console.error('Remote plugins were not loaded:', error);
    });
}());
// END remote plugins
