// Receiver plugins for this station. See contrib/PLUGINS.md.
//
// To change the interface visitors get first, uncomment and edit:
// window.ui_select_config = { default: 'stock' };   // 'dock' (default), 'rig' or 'stock'

Plugins.load('ale');         // ALE panel and scanner; stays hidden unless the server has the ALE backend
Plugins.load('ui_select');   // interface chooser: dock, RIG skin or stock controls

// RSPdx receivers with the antenna-switcher backend installed:
// Plugins.load('rsp_antenna');
