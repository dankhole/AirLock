# Airlock

A cross-browser (Chrome + Firefox) Manifest V3 extension that adds intentional friction before accessing distracting websites. When you navigate to a tracked site, the page is covered with a calming countdown overlay. The timer only counts down while the tab is actively focused -- switching away pauses it. Per-site daily time limits, scheduled daily locks, and one-hour cooldowns can make tracked sites unavailable.

## How It Works

1. You configure a list of websites, optional per-site daily limits, a wait duration in minutes, a reset window in hours, optional hover-target enforcement, and an optional daily lock window via the popup
2. When any tab navigates to a tracked site, a fullscreen overlay appears with a countdown timer and breathing focus target
3. The timer **pauses** when you switch tabs, switch windows, or minimize the browser
4. The timer **resumes** when you return to the tab, and optionally only while the pointer is on the overlay target
5. When the countdown reaches zero, a "Continue" button appears to dismiss the overlay
6. Refreshing the page resumes the existing timer (doesn't reset it)
7. Opening a new tab to the same site starts a fresh timer
8. Navigating within a site after completing the timer does not re-trigger it until the configured reset window passes
9. A tracked tab left open past the configured reset window requires a fresh wait
10. Removing a tracked site or lowering the wait duration requires the separately configured unlock hold before applying
11. Guarded settings waits only count down while the settings popup is open and the settings hover target is active
12. During the daily lock window, tracked sites show a non-dismissible lock overlay until the configured local end time
13. Daily lock windows can run within one day or across midnight; open tabs update automatically at both boundaries
14. A per-site daily limit counts only focused, visible time after the wait overlay is dismissed, is shared across matching tabs and subdomains, and resets at local midnight
15. Starting a cooldown blocks every tracked site for one hour, even if the main Airlock toggle is turned off
16. Ending a cooldown early, disabling a daily lock, or shortening its window requires hovering the popup target for the configured unlock hold; making a daily lock longer applies immediately

Adding tracked sites and increasing the delay still apply immediately.
Increasing time settings and turning on hover-target enforcement require confirmation. Changes that weaken restrictions use the unlock hold configured in the popup.

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
rm -f store/firefox-addon-1.0.7.zip
zip -j store/firefox-addon-1.0.7.zip firefox/manifest.json
zip -r store/firefox-addon-1.0.7.zip background content popup shared icons -x '*.DS_Store'
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
- Enable hover target -- timer only runs while hovering the circle
- Start a guarded settings change -- countdown only runs while hovering the popup target

### Daily lock
- Enable **Daily lock** and choose different start and end times
- Use a same-day window (for example, 9:00 AM–5:00 PM) or an overnight window (10:00 PM–7:00 AM)
- During the window, verify that the overlay shows the local unlock time and has no Continue button
- Leave a tracked tab open across either boundary and verify that it locks or unlocks automatically
- After unlock, verify that an incomplete wait session resumes and a previously completed session remains complete

### Daily time limits
- Enter a value in the **min/day** field beside a tracked site
- Complete the normal wait, then keep the site focused until its allowance is exhausted
- Verify that matching tabs show a non-dismissible limit overlay and that the popup reports today's usage
- Verify that unfocused, hidden, waiting, and scheduled-lock time does not count
- Raising or removing a limit uses the same guarded settings countdown as other less-restrictive changes

### Cooldown
- Click **Start 1 hour** and verify every tracked site immediately shows a non-dismissible cooldown overlay
- Toggle Airlock off and verify the cooldown remains active
- Click **End early**, hover the orange popup target for the configured unlock hold, and verify access resumes only after the hold completes
- Shorten an enabled daily lock and verify the same hold is required; lengthen it and verify the update applies immediately

### Persistence
- Refresh during countdown -- timer resumes, not reset
- Open the same site in a new tab -- fresh timer
- Leave a completed tracked tab open past the configured reset window -- timer resets and appears again
- Close and reopen the popup during a guarded settings wait -- remaining time is preserved
- Toggle the extension off during a normal wait -- overlay removed (an active cooldown remains enforced)

## Architecture

```
popup.js          <-- Config UI (toggle, delay, site list)
    | storage.local
background.js     <-- Session management, focus tracking, badge
    | messages
content.js        <-- Overlay rendering, countdown timer, visibility detection
    ^
shared/daily-lock.js  <-- Daily schedule calculation shared with the popup
```

- **popup.js** reads/writes config to `storage.local`
- **background.js** manages timer sessions in `storage.session`, tracks tab/window focus, updates the badge count
- **content.js** checks if the current site is tracked, requests session state from background, injects a Shadow DOM overlay, and pauses/resumes based on visibility

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist config and timer sessions locally |
| `activeTab` | Read current tab URL for the "Track this site" button |
| `alarms` | Apply delayed settings changes, configured tab resets, daily lock boundaries, and cooldown expiry |

## Project Structure

```
manifest.json          Base manifest used by the Chrome build
firefox/
  manifest.json        Authored Firefox manifest for AMO packaging
background/
  background.js        Service worker: sessions, focus, badge, messages
content/
  content.js           Overlay, countdown timer, visibility handling
shared/
  daily-lock.js        Daily lock validation and local-time boundary calculation
tests/
  *.test.js            Schedule and background integration tests
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
