# K2AAM NR

Better noise reduction for OpenWebRX+, as a receiver plugin. It runs in the
listener's browser, so it needs no fork patch, no csdr changes and no server CPU.

- **NR**: spectral noise reduction that keeps weak carriers and CW.
- **Notch**: removes steady tones (heterodynes) in voice modes.
- **Beacon**: longer analysis that digs out weak steady carriers.

## Install

On the receiver, set `PLUGINS` to the running install's
`htdocs/plugins/receiver` folder (find it with
`sudo find / -type d -path "*htdocs/plugins/receiver"`), then:

    BRANCH=master
    PLUGINS=/path/to/htdocs/plugins/receiver
    curl -L https://github.com/K2AAM/openwebrx-k2aam/archive/refs/heads/$BRANCH.tar.gz \
      | sudo tar xz -C "$PLUGINS" --strip-components=4 \
        "openwebrx-k2aam-$BRANCH/htdocs/plugins/receiver/k2aam_nr"

Use `BRANCH=k2aam-nr` until that branch is merged. Running the same command
again updates the plugin.

Then add this line to `init.js` in that folder (once) and reload the page:

    Plugins.load('k2aam_nr');

Once audio starts, the browser console shows `k2aam_nr: active, 48000 Hz.`

## Use

The existing **NR button and slider** drive the noise reduction. The slider is
strength: far left is gentle (about 6 dB of noise reduction), the middle is
about 15 dB, far right is about 24 dB.

Two buttons appear beside the NR control: under the slider in the stock UI,
or in the noise reduction group of the K2AAM Dock and Console:

- **Notch** removes tones that sit still, such as a carrier on top of an SSB
  signal, within about a second. It works with NR on or off. It is only
  applied in USB, LSB, AM, SAM and FM, and not while a digital decoder (FT8
  and so on) is selected or in beacon mode.
- **Beacon** doubles the analysis frame and averages for longer. A steady
  carrier 20 dB below the passband noise gains about 5 dB of signal-to-noise
  at mid strength, where the normal mode gives nothing. Speech and fast CW
  sound smeared in this mode, and at full strength more faint steady tones
  are left in the background.

Everything is bypassed automatically in WFM, broadcast FM, IQ, DRM, DAB, HD
Radio and the digital voice modes, where it could only do harm. The server's
own NR is switched off while the plugin is active.

### From a custom UI

Anything that calls `UI.toggleNR()` or `UI.setNR()` controls the NR. The
buttons follow the stock NR control and the K2AAM Dock; any other UI can use:

    Plugins.k2aam_nr.setNotch(true)          // or false
    Plugins.k2aam_nr.setProfile('beacon')    // or 'normal'
    Plugins.k2aam_nr.getState()              // what is wanted and what is applied

## Limits

- Needs AudioWorklet, which browsers only provide on https:// pages and on
  localhost. On a plain http:// page the plugin stays out of the way and the
  stock NR works as before.
- Adds 43 ms of audio delay while NR or Notch is on, 85 ms in beacon mode.
- It works on the audio you hear. Server-side decoders and the MP3 recorder
  are not affected.
- It cannot remove impulse noise (switching supplies, ignition). That needs a
  noise blanker ahead of the channel filter, on the server.
- In normal mode a steady carrier needs to be a few dB above the noise in its
  own 23 Hz slice of spectrum; weaker than that and it is treated as noise.
- The notch treats any sustained pure tone as unwanted, so it will take the
  edge off held notes in music.

## Tuning

These can be changed live from the browser console while listening. Changes
last until the page is reloaded:

    Plugins.k2aam_nr.tune({ ddAlphaBase: 0.98 })

| Name | Default | Effect of raising it |
|---|---|---|
| `ddAlphaBase` | 0.97 | Less ringing in the background, but weak or fast signals open more slowly. Keep below 0.99 |
| `ddAlphaSlope` | 0.02 | Same, but only towards the strong end of the slider |
| `steadyThreshold` | 0.6 (beacon 0.4) | Fewer faint steady tones in the background, but weak carriers are lost sooner |
| `capFactor` | 1.0 | Lets steady carriers be learned as noise and removed |
| `notchMargin` | 4 | The notch leaves more of each tone and is less likely to touch speech |
| `notchDepth` | 0.01 | Shallower notches (0.01 is -40 dB, 0.1 is -20 dB) |

To make a setting permanent, change it in the `SpectralNR` constructor in
`k2aam_nr_worklet.js`. If you change `rise`, `smoothing`, `fall` or
`capFactor` there, re-measure the tracker bias and update `SpectralNR.BIAS`
and `SpectralNR.BIAS_BEACON`:

    node test/k2aam_nr/test.js htdocs/plugins/receiver/k2aam_nr/k2aam_nr_worklet.js calibrate

## Tests

    node test/k2aam_nr/test.js htdocs/plugins/receiver/k2aam_nr/k2aam_nr_worklet.js

Synthetic signals only: band-limited noise, steady and keyed tones, a
speech-like signal with a heterodyne, a noise level step, stereo, and CPU cost.
