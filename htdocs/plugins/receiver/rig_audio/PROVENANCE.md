# RIG Audio Studio provenance

RIG Dock 0.4.0 replaces its adapted legacy DL1HQH filter with the separate Audio Filter Studio 2.3 beta.2 engine and presets. It does not overwrite a station's original `audio_filter/audio_filter.js`.

- Studio source: `K2AAM/openwebrxplus-audio-filter-studio`, commit `83765f6e92bd22279847fac92d8758d9e36d4285`, `audio_filter.js`, Git blob `e49b6bbcdd6fef65363d745c996250594b5933db`. MIT; see `STUDIO-LICENSE.txt`. Original DL1HQH/joer123 attribution is retained.
- RIG adaptation: plugin ID/API, explicit native gain-node attachment, session bypass, direct-route restoration, removal of global audio hooks, disposal of the neural state when detached, and native secondary-mode recognition. The Studio DSP kernel, presets and experimental RNNoise bridge are retained. The browser uses its existing receiver AudioContext; it does not capture a microphone or send audio to a third-party service.
- RNNoise wrapper/model: `jitsi/rnnoise-wasm`, commit `cb529a59a8478fe604e57986fc96afdaecfa6fb7`, `dist/rnnoise-sync.js`, Git blob `d054e0640b918141ee80f7b6e2eb5bcac9fe38a4`, 1,933,102 bytes. This file is vendored unchanged. Wrapper terms: `RNNOISE-WASM-APACHE-LICENSE.txt`.
- RNNoise C/model submodule: `xiph/rnnoise`, commit `372f7b4b76cde4ca1ec4605353dd17898a99de38`. See `RNNOISE-BSD-LICENSE.txt`.
- DSP regression scripts in `contrib/rig_dock/tests/audio` are adapted from the pinned Studio commit by changing their input path. The real-bundle test additionally verifies the vendored Git blob and executes actual WASM frames; browser tests exercise the loaded model through the native receiver attachment.

RNNoise is an optional speech experiment, enabled explicitly. It requires a 48 kHz AudioWorklet and supports spoken AM/SSB; unsupported modes/rates and initialization/inference failures retain classical NR. Synthetic audio tests establish routing, finite output and model execution, not improved intelligibility on a physical receiver. Operator comparison on weak radio speech remains necessary.
