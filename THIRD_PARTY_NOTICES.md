# Third-party notices

Airlock is distributed under GPL-3.0-only; see the accompanying LICENSE.

## YouTube Shorts Block

Upstream: https://github.com/doma-itachi/Youtube-shorts-block

Reviewed revision: 1542e8eceb4fcbd876be67890f91a3087d53c8c6.

Adapted sources: src/filter/shorts.ts, src/filter/reelShelf.ts, src/filter/richShelf.ts, and src/main.css. YouTube route and renderer detection are integrated into content/controls/sites/youtube.js. Airlock integrates selected behavior with its own normalized settings, exact route parsing, reversible hiding, and shared lifecycle; upstream manifest, background, popup, storage, assets, and build system are excluded. The complete MIT notice, Copyright (c) 2022 土間いたち, is included in licenses/youtube-shorts-block-MIT.txt.

## Facebook Reels Blocker

Upstream: https://github.com/safwat-fathi/facebook-reels-blocker

Reviewed revision: af3b8c9600ab9883a615981d8de5f604cd0f5de1.

Adapted sources: src/scan.ts and src/background.ts. Facebook surface and route detection are integrated into content/controls/sites/facebook.js. Airlock uses narrower positive classification, independent settings, reversible hiding, and the shared lifecycle; upstream manifest, background, popup, storage, assets, and build system are excluded. The complete MIT notice, Copyright (c) 2025 Facebook Reels Blocker, is included in licenses/facebook-reels-blocker-MIT.txt.

## WebExtension browser API polyfill

Upstream: https://github.com/mozilla/webextension-polyfill

Version: 0.12.0. Distributed only in the Chrome build as lib/browser-polyfill.min.js, under MPL-2.0. The package's original license is included in licenses/webextension-polyfill-MPL-2.0.txt. Firefox uses its native browser API.

## Instagram implementation

Instagram modules are original Airlock code. No IGPlus implementation, styles, wording, or assets are distributed. Inspection informed the behavior specification; this is not a formal clean-room claim.

Development-only test dependencies are excluded from extension artifacts.
