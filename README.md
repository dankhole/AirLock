# Airlock

A cross-browser (Chrome + Firefox) Manifest V3 extension that adds intentional friction before accessing distracting websites. When you navigate to a tracked site, the page is covered with a calming countdown overlay. The timer only counts down while the tab is actively focused -- switching away pauses it.

## How It Works

1. You configure a list of websites and a delay duration (in seconds) via the popup
2. When any tab navigates to a tracked site, a fullscreen overlay appears with a countdown timer and breathing animation
3. The timer **pauses** when you switch tabs, switch windows, or minimize the browser
4. The timer **resumes** when you return to the tab
5. When the countdown reaches zero, a "Continue" button appears to dismiss the overlay
6. Refreshing the page resumes the existing timer (doesn't reset it)
7. Opening a new tab to the same site starts a fresh timer
8. Navigating within a site after completing the timer does not re-trigger it

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
- **Firefox**: uses the base manifest as-is (native `browser.*` support)

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
- Close and reopen the popup -- settings persist
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

## Project Structure

```
manifest.json          Base manifest (Firefox format)
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
