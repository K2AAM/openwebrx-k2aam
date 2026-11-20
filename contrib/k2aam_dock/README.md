# K2AAM Dock (`k2aam_dock`)

A receiver plugin that replaces the floating receiver panel with a compact dock along the bottom of
the page and a shared decoder tray directly above it. Source: `htdocs/plugins/receiver/k2aam_dock/`.

Load it through the interface chooser (`Plugins.load('ui_select')`, the default in this fork) or on
its own with `Plugins.load('k2aam_dock')`. It cannot run together with the RIG skin.

## K2AAM Console

The same plugin has a second arrangement, chosen as **K2AAM Console** in the Interface list (or
`window.k2aam_dock_layout = 'console'` before loading the plugin directly). It uses every control
described below, laid out differently:

- **Receiver strip:** a large frequency readout with the S-meter directly beneath it, then mode,
  filter width, step, bands and bookmarks, then profile, volume with mute, squelch and noise
  reduction, each labelled.
- **Side decoder panel:** on screens at least 900 px wide, decoder output opens as a full-height
  panel on the right and the waterfall narrows beside it. **Side panel** in the panel header moves
  decoders back below the waterfall. With no decoder running the waterfall has the full width.
- **Decoder tabs:** FT8, Aircraft, Packet and ALE, limited to what the receiver offers. A tab
  switches to the mode last used in that family; a family with several modes (HFDL, VDL2, ACARS,
  ADS-B) shows a button for each; a family with more than five shows four and a **More** button.
  CQ calls are highlighted in the FT8 list.
- **Aircraft lists:** HFDL, VDL2, ACARS and UAT reports are two-line entries (time, flight and
  aircraft, then position or message type, with free text beneath). ADS-B shows one entry per
  aircraft with labelled altitude, speed and squawk. These are the native lists restyled, so the
  flight, aircraft and map links work as before.
- **Phone:** tuning, meter, mode/filter/step/bands, volume, squelch, noise reduction and profile
  are always shown; recording, bookmarks, antenna and waterfall settings are behind **Controls**.

The side panel narrows the page so the native waterfall and frequency scale stay aligned. That has
been checked in the browser tests against a simulated receiver, not yet on a real one; if the
waterfall and scale ever disagree, switch **Side panel** off.

## Controls

- Frequency readout with native digit and wheel tuning. Click it, or **Tune**, to type a frequency
  in Hz, kHz or MHz. A frequency outside the current capture asks the server to retune, which moves
  the SDR for every listener and requires the server to allow center-frequency changes.
- Profile, mode (with search and underlying-mode choice), volume, squelch, NR, step, bandpass,
  waterfall palette/levels/zoom, scanner and recording, all driving the native controls.
- **More** holds zoom, plugin buttons, the native settings section (including the interface
  chooser) and **Use stock controls**, which restores the native panel in the current tab.
- The footer shows connection state, S-meter, CPU, listeners, antenna and UTC.

## Bands and bookmarks

**Bands** lists amateur, broadcast and time-signal entries. A band inside the current view just
tunes and sets its mode. Outside it, the dock switches to a profile whose name contains the band
("40m", "40 m SSB"); if there is none it asks the server to retune, which needs center-frequency
changes to be allowed. Either route changes the SDR for every listener.

To replace the list, set this in `init.js` before the plugin loads:

```js
window.k2aam_dock_config = { bands: [
    { label: '40m', frequency: 7150000, mode: 'lsb', group: 'Amateur' },
    { label: 'CHU', frequency: 7850000, mode: 'usb', group: 'Time' }
] };
```

**Bookmarks** lists the bookmarks OpenWebRX+ has sent for the current profile, with search.

The S-meter sits beside the frequency. Mute, squelch and NR use the dock's button style.

## Phones

At widths up to 620 px the dock starts compact: the frequency with large − / + step buttons (hold
to keep stepping), Tune, mode, volume and the status line. **Controls** reveals profile, antenna,
recording, squelch, NR, step, bands, bookmarks, bandpass, waterfall and scan; the choice is
remembered in the browser. A phone held sideways (height up to 500 px) gets the same compact dock
on a single row.

## Decoder tray

Native message panels, digital voice metadata panels and the secondary waterfall/text panel move
into one tray above the dock. The main waterfall keeps the remaining space.

- Height slider, **Collapse** (decoding continues) and **IF waterfall** toggle; preferences are
  saved in the browser.
- With the `ale` plugin loaded, **Fit** sizes the tray to the latest ALE rows, and dock tuning
  actions wait for a running ALE scan to stop first.

## Startup

A connecting bar is shown until the stylesheet, waterfall, modes and profile are ready. If the
stylesheet fails or startup takes more than 20 seconds, the stock controls stay in place.
