# Community plugins

Pinned local copies of receiver plugins from the 0xAF collection, so visitors do not run code
fetched from a third-party site on each page view.

- Source: https://github.com/0xAF/openwebrxplus-plugins, commit `dfd87d5ef9d08bfea1ad7f810efd1382cb4c5afc` (2026-11-17)
- Licence: MIT (`LICENSE`); `search_bookmarks` carries its own MIT licence file.
- Copied: each plugin's `.js` and `.css` files. READMEs and screenshots are not copied; see the
  source repository for documentation.

## Changes from the source

Only the addresses of companion files were changed, from `0xaf.github.io` and `cdnjs.cloudflare.com`
to this folder. No other code was edited.

- `colorful_spectrum/colorful_spectrum.js`: 1 line
- `connect_notify/connect_notify.js`: 1 line
- `doppler/doppler.js`: 4 lines
- `frequency_far_jump/frequency_far_jump.js`: 1 line
- `mouse_freq/mouse_freq.js`: 1 line
- `screenshot/screenshot.js`: 1 line
- `search_bookmarks/search_bookmarks.js`: 1 line

`doppler/vendor/` holds the two libraries that plugin used to fetch from cdnjs, taken from npm:
`lz-string` 1.5.0 and `jquery-modal` 0.9.1 (both MIT; licence files alongside).

## What still leaves the receiver

- `doppler` fetches satellite orbital elements from `celestrak.org` when you use it.
- `search_bookmarks` fetches a bookmark list only if `Plugins.search_bookmarks.url` is set.

## Updating

Replace the files from a newer commit of the source repository, reapply the address changes above
(search the new files for `0xaf.github.io` and `cdnjs`), and update the commit here.
