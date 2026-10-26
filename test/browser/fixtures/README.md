# Browser integration fixtures

`screenshot.js` is the unmodified MIT-licensed Screenshot plugin by Stanislav Lechev (0xAF), LZ2SLL, copied from:

https://github.com/0xAF/openwebrxplus-plugins/blob/main/receiver/screenshot/screenshot.js

Verified upstream Git blob: `6be0b6b2ac86183550ba4da2fde207a243790ca7` (reviewed 2026-10-25). Its license and attribution remain in the file. This is a regression-test fixture, not a bundled receiver plugin.

The browser test substitutes only the external html2canvas script with a deterministic canvas result. The original plugin's DOM wrapping, inline styles, click handler, download path and cleanup execute unchanged. This reproduces the Record/PIC collision and checks handler preservation without depending on external script downloads or validating html2canvas rendering quality.
