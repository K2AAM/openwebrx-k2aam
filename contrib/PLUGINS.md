# Receiver plugins

Everything here is an ordinary OpenWebRX+ receiver plugin under `htdocs/plugins/receiver/`. Which ones
load is decided by `htdocs/plugins/receiver/init.js`; none is forced by the fork.

| Plugin | What it does | Needs |
| --- | --- | --- |
| `ui_select` | Adds an **Interface** choice to the receiver settings: Dock, RIG skin or Stock. Loads the chosen one. | — |
| `k2aam_dock` | The K2AAM dock: compact controls along the bottom and a shared decoder tray above them. | — |
| `rig_skin` | The original RIG skin by SV1DOD / HB9ISH, pinned at 0.10.20 and unmodified. See its `PROVENANCE.md`. | — |
| `ale` | ALE message panel, bank scanner controls, reception log and CSV export. | This fork's ALE backend |
| `rsp_antenna` | Antenna buttons for an RSPdx. | This fork's antenna handler and a config file |

## Choosing the interface

`ui_select` loads the dock unless the visitor has picked something else. The choice is stored in the
visitor's browser, and changing it reloads the page: the dock and the RIG skin both rebuild the
receiver panel, so only one is loaded at a time.

To change what a first-time visitor gets, set this in `init.js` before `Plugins.load('ui_select')`:

```js
window.ui_select_config = { default: 'stock' };   // 'dock', 'rig' or 'stock'
```

To offer only one interface, drop `ui_select` and load `k2aam_dock` or `rig_skin` directly.

## ALE

`Plugins.load('ale')` works with any of the three interfaces. It shows nothing until the server
reports the `ale2g` mode, so it is safe to leave loaded on a server without the backend. Decoding
itself runs on the server; see [ALE](ale/README.md).

## Antenna buttons

`rsp_antenna` is loaded by default and stays hidden unless the server reports switchable antennas
for the current SDR, which requires `/etc/openwebrx/antenna-switcher.json`. See
[antenna switcher](antenna/README.md). The dock shows the buttons in its top row; with stock
controls they appear as an **Antenna** section.

## Using a plugin on stock OpenWebRX+

`k2aam_dock`, `rig_skin` and `ui_select` do not depend on the fork. Copy the plugin's
folder into the receiver's `htdocs/plugins/receiver/` and add its `Plugins.load(...)` line to
`init.js` there.

## Tests

```bash
npm ci --ignore-scripts
npx playwright install --with-deps chromium webkit
npm run test:receiver            # dock, chooser, RIG skin loading, ALE panel, antenna buttons
npm run test:startup:webkit      # mobile cold start
node contrib/ale/tests/scanner.cjs && node contrib/ale/tests/observer.cjs
```

The browser tests drive the real OpenWebRX+ page scripts with a simulated receiver connection. They
do not exercise RF, DSP or a physical SDR.
