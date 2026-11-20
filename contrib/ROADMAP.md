# Roadmap

## Done

- Fork rebased onto OpenWebRX+ 1.2.131.
- Audio filter (Studio / RNNoise) removed.
- Dock, RIG skin, ALE front end and antenna buttons are separate optional plugins; core front-end
  files match upstream.

## Dock interface

- Phone layout pass: larger touch targets, one-handed tuning, fewer rows in portrait.
- Review against a real receiver on a phone and a desktop; the browser tests simulate the receiver.
- Consider renaming the plugin from `rig_dock`, since "RIG" is the name of the original skin.

## ALE

- 2G: qualify the decoder on live signals, add service-start resume and scan fault recovery.
- 3G (MIL-STD-188-141 Appendix C): new decoder; not started.
- Server side stays a small patch to OpenWebRX+ core (`modes.py`, `feature.py`, `dsp.py`,
  `connection.py` plus new `owrx/ale*.py` and `csdr/*/ale.py`).

## Antenna switcher

- Bring the RSPdx server handler into this repository so `rsp_antenna` is complete on its own.

## Upstream maintenance

`master` mirrors luarvique/openwebrx. Merge it into the working branch for each upstream release
and re-run the tests before updating a receiver.
