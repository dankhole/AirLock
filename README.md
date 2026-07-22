# Airlock

A cross-browser (Chrome + Firefox) Manifest V3 extension that adds intentional friction before accessing distracting websites. When you navigate to a tracked site, the page is covered with a calming countdown overlay. The timer only counts down while the tab is actively focused -- switching away pauses it.

## How It Works

1. You configure a list of websites, a wait duration in minutes, and a reset window in hours via the popup
2. When any tab navigates to a tracked site, a fullscreen overlay appears with a countdown timer and breathing animation
3. The timer **pauses** when you switch tabs, switch windows, or minimize the browser
4. The timer **resumes** when you return to the tab
5. When the countdown reaches zero, a "Continue" button appears to dismiss the overlay
6. Refreshing the page resumes the existing timer (doesn't reset it)
7. Opening a new tab to the same site starts a fresh timer
8. Navigating within a site after completing the timer does not re-trigger it until the configured reset window passes
9. A tracked tab left open past the configured reset window requires a fresh wait
10. Removing a tracked site or lowering the wait duration waits for the current wait duration before applying
11. Site-removal waits only count down while the settings popup is open

Adding tracked sites and increasing the delay still apply immediately.

Domain matching: entering `reddit.com` will match `reddit.com`, `www.reddit.com`, `old.reddit.com`, etc.

## Build

```sh
npm install
npm run build          # builds both Chrome and Firefox to dist/
npm run build:chrome   # Chrome only
npm run build:firefox  # Firefox only
```

The build script handles browser differences automatically:
- **Chrome**: converts background to `service_worker`, injects `webextension-polyfill` into background/popup/content scripts
- **Firefox**: uses the authored `firefox/manifest.json` with native `browser.*` support

## Firefox AMO Package

For official Firefox uploads, package the authored source files directly instead of using `dist/firefox`:

```sh
mkdir -p store
rm -f store/firefox-addon-1.0.1.zip
zip -j store/firefox-addon-1.0.1.zip firefox/manifest.json
zip -r store/firefox-addon-1.0.1.zip background content popup icons -x '*.DS_Store'
```

This keeps the submitted Firefox package free of generated extension files. The AMO generated-code question can be answered "No" when using this package.

## Install

### Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/chrome/` folder

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`

After making source changes, run `npm run build` and reload the extension.

## Testing

### Basic flow
1. Click the extension icon and add a site (e.g. `reddit.com`) -- or use the "Track current site" button
2. Navigate to that site -- overlay appears with countdown
3. Wait for countdown to finish, click "Continue" -- site is usable
4. Navigate within the site (click links, hit back) -- overlay should NOT reappear

### Timer pause/resume
- Switch to another tab -- timer pauses ("Paused" label appears)
- Switch back -- timer resumes
- Minimize the browser -- timer pauses
- Restore -- timer resumes

### Persistence
- Refresh during countdown -- timer resumes, not reset
- Open the same site in a new tab -- fresh timer
- Leave a completed tracked tab open past the configured reset window -- timer resets and appears again
- Close and reopen the popup during a site-removal wait -- remaining time is preserved
- Toggle extension off while overlay is active -- overlay removed

## Architecture

```
popup.js          <-- Config UI (toggle, delay, site list)
    | storage.local
background.js     <-- Session management, focus tracking, badge
    | messages
content.js        <-- Overlay rendering, countdown timer, visibility detection
```

- **popup.js** reads/writes config to `storage.local`
- **background.js** manages timer sessions in `storage.session`, tracks tab/window focus, updates the badge count
- **content.js** checks if the current site is tracked, requests session state from background, injects a Shadow DOM overlay, and pauses/resumes based on visibility

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist config and timer sessions locally |
| `activeTab` | Read current tab URL for the "Track this site" button |
| `alarms` | Apply delayed settings changes and configured tab resets |

## Project Structure

```
manifest.json          Base manifest used by the Chrome build
firefox/
  manifest.json        Authored Firefox manifest for AMO packaging
background/
  background.js        Service worker: sessions, focus, badge, messages
content/
  content.js           Overlay, countdown timer, visibility handling
popup/
  popup.html           Config UI structure
  popup.css            Popup styling
  popup.js             Config read/write logic
icons/                 Extension icons (16, 48, 128px)
scripts/
  build.js             Build script for Chrome/Firefox
```

## Privacy

Airlock collects no data. All storage is local to your device. See [PRIVACY.md](PRIVACY.md) for details.

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for details.
