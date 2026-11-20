// Receiver plugins for this station. See contrib/PLUGINS.md.
//
// To change the interface visitors get first, uncomment and edit:
// window.ui_select_config = { default: 'stock' };   // 'dock' (default), 'rig' or 'stock'

Plugins.load('ale');         // ALE panel and scanner; stays hidden unless the server has the ALE backend
Plugins.load('ui_select');   // interface chooser: dock, RIG skin or stock controls

Plugins.load('rsp_antenna'); // RSPdx antenna buttons; hidden unless /etc/openwebrx/antenna-switcher.json enables a device
