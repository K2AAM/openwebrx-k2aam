// Receiver plugins for this station. See contrib/PLUGINS.md.
//
// The interface a visitor gets until they pick another: 'console', 'dock', 'rig' or 'stock'.
window.ui_select_config = { default: 'console' };

Plugins.load('ale');         // ALE panel and scanner; stays hidden unless the server has the ALE backend
Plugins.load('ui_select');   // interface chooser: K2AAM Dock, RIG skin or stock controls
Plugins.load('rsp_antenna'); // RSPdx antenna buttons; hidden unless /etc/openwebrx/antenna-switcher.json enables a device
Plugins.load('k2aam_nr');    // browser-side noise reduction; drives the NR button/slider, adds Notch and Beacon
Plugins.load('k2aam_prop');  // propagation panel (NOAA band conditions, NCDXF beacons, MUF map); shown as Prop in the Console
Plugins.load('k2aam_spots'); // DX Summit spots: labels on the waterfall, list as Spots in the Console

// BEGIN community plugins
// Pinned local copies of plugins from the 0xAF collection; see community/PROVENANCE.md.
// Remove a name to stop loading it.
Plugins.tune_precise_steps = [12500, 5000, 10];
(function () {
    // Loaded by full address so they keep their own names and do not replace
    // the older "utils" plugin that ships with OpenWebRX+.
    const base = new URL('static/plugins/receiver/community/', document.baseURI).href;
    const community = [
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
    Plugins.load(base + 'utils/utils.js').then(async function () {
        if (!Plugins.utils || !Plugins.utils._script_loaded) throw new Error('utils did not load');
        await Plugins.load(base + 'notify/notify.js');
        for (const name of community) {
            // One failing plugin must not stop the rest.
            try { await Plugins.load(base + name + '/' + name + '.js'); }
            catch (error) { console.error('Plugin failed to load: ' + name, error); }
        }
    }).catch(function (error) {
        console.error('Community plugins were not loaded:', error);
    });
}());
// END community plugins
