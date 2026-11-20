# Roadmap

## Done

- Fork rebased onto OpenWebRX+ 1.2.131.
- Audio filter (Studio / RNNoise) removed.
- Dock, RIG skin, ALE front end and antenna buttons are separate optional plugins; core front-end
  files match upstream.

## Dock interface

- Done: compact phone and landscape layouts, touch step buttons, band buttons, bookmarks, S-meter
  beside the frequency, restyled native controls, renamed to `k2aam_dock`.
- Done: K2AAM Console arrangement (receiver strip, side decoder panel, decoder tabs).
- Next for the Console: an aircraft view with one row per aircraft, bookmark and band markers on
  the waterfall, a draggable filter band, and a "what's on" start screen.
- Next: review all of it on a real phone and receiver; the browser tests simulate the receiver.

## ALE

- Done: plugin front end, key-only scanner control, resume after restart, address watchlist,
  one-line phone rows, simultaneous decoding of every channel in view, cluster hopping, repeat
  counts, fault retries; browser-side scanner removed.
- Next: qualify the 2G decoder on live signals and measure parallel-decoding CPU load (both need
  the receiver); fast in-place hopping for out-of-view channels; history-weighted hopping.
- Later: 3G (MIL-STD-188-141 Appendix C), a new decoder; not started.
- Server side stays a small patch to OpenWebRX+ core (`modes.py`, `feature.py`, `dsp.py`,
  `connection.py`, `__main__.py`, one default and one settings checkbox, plus new `owrx/ale*.py`
  and `csdr/*/ale.py`).

## Antenna switcher

- RSPdx handler and plugin are in the fork; confirm on the RSPdx receiver after it moves to this package.

## Upstream maintenance

`master` mirrors luarvique/openwebrx. Merge it into the working branch for each upstream release
and re-run the tests before updating a receiver.
