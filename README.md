# Airlock

A desktop Chrome and Firefox Manifest V3 extension for managing distracting websites in one place: focused-time monitoring, intentional waits, time restrictions, and optional YouTube, Instagram and Facebook content controls.

## Controls and monitoring

Airlock combines local focused-time monitoring, site-entry waits, daily budgets and scheduled locks with optional content controls for YouTube, Instagram and Facebook. The popup shows current-site status and quick actions; **Settings** opens the full configuration page.

All new content controls start **off**. **Restrictions** must also be on for content filters to apply; turning it off preserves individual preferences but restores page content. Content controls work on their supported sites without adding those sites to the tracked list. Tracking and time restrictions still require adding a site. The optional presets change content controls only.

| Site | Content controls |
|---|---|
| YouTube | Hide Shorts cards/shelves, hide Shorts navigation, convert direct Shorts URLs to the normal watch player |
| Instagram | Block Reels and Explore, hide or block Stories, choose Following or Messages for Home, hide the home feed, comments, Notes, Threads prompts, engagement counts, unread badges, videos or images |
| Facebook | Hide Reels, send direct Reel URLs to Home, hide Stories and suggested content |

Converting a YouTube Short to the normal player still permits watching that video. Instagram media controls may also hide attachments in messages; authentication and account-recovery surfaces are exempt. Hiding content is a presentation control, not a network-level media blocker. Website changes and layout variants can affect matching; see the validation notes in this repository before treating a feature as verified against your live account.

**Instagram controls are experimental.** Authenticated Home, Following, Search, inbox, Notes and engagement layouts have not been verified against a live account. Ambiguous Explore surfaces stay available to avoid breaking Search; image controls preserve containers that also contain text or actions. Controlled fixtures establish the implemented rules, not full live-site coverage.

### Existing Airlock behavior

- A tracked site's entry wait counts only while its tab is visible, focused and the hold target is engaged. Pointer, touch and keyboard engagement use the same duration. A completed wait stays complete for that tab and hostname until local midnight; a new tab starts a separate wait.
- Refreshing resumes the existing wait. The overlay's Continue action becomes available only after the wait finishes. Daily locks, exhausted hard daily limits and active cooldowns cannot be dismissed through Continue.
- Focused usage is aggregated for each tracked site, including matching subdomains, and resets at local midnight. Waiting, blocked and pending-redirect time is excluded. Ordinary browsing with content hidden still counts.
- Turn **Site wait** off for a tracked site to retain monitoring and other restrictions without an entry countdown. Existing sites keep their wait setting.
- Use **Pause** beside a site, or **Pause tracking** in the popup, for downtime. Usage counting and that site's waits, locks, and limits pause; settings, totals, and existing wait progress remain saved. **Resume** restores them without counting the paused time. Independent content controls and the global manual cooldown still apply.
- The main Restrictions switch disables content controls, entry waits, scheduled locks and daily-limit enforcement. Usage monitoring continues on tracked sites. An active manually started one-hour cooldown remains enforced.
- Daily locks support same-day and overnight local-time windows. Daily limits support a block until midnight or a per-site break. A break blocks only that site when it exhausts its allowance, then renews the allowance; today's usage total stays recorded. Limit actions and break durations can be edited and saved without an active limit, and changing the duration does not turn on the break action. The manual cooldown and focused-use check-in block all tracked sites for one hour.

Domain matching is bounded: `reddit.com` includes `www.reddit.com` and `old.reddit.com`, not `notreddit.com`.

### Changing settings

Settings changes are confirmed in the UI and validated by the background controller. Stronger changes apply immediately after confirmation. Weaker changes require the configured **Settings hold**; examples include turning a restriction off, increasing a daily allowance, ending a cooldown early, or removing locked time from a schedule. The hold can be set from 0 to 600 minutes; at 0, all changes apply immediately after confirmation. Reducing the hold uses its current duration. A change that mixes stronger and weaker settings applies atomically after any required hold.

The popup and settings page share one authoritative pending change. A hold advances only while its target is engaged in a focused, visible view, and pauses on release, blur or closing the view. Only one view can advance it at a time. The remaining hold survives reopening the UI. Concurrent settings edits are revision-checked to prevent one view silently overwriting another.

## Build

```sh
npm install
npm run build          # builds both Chrome and Firefox to dist/
npm run build:chrome   # Chrome only
npm run build:firefox  # Firefox only
```

The build script handles browser differences automatically:
- **Chrome**: converts background to `service_worker`, injects `webextension-polyfill` into the background, popup, options page and each content-script entry
- **Firefox**: uses the authored `firefox/manifest.json` with native `browser.*` support

## Firefox AMO Package

Use Node.js 22 or later. To validate and package an official Firefox upload:

```sh
npm ci
npm run package:firefox
```

This builds both browsers, verifies that both manifests and npm version files agree, copies the authored Firefox files into `store/firefox-source/`, runs Mozilla's `web-ext lint`, and creates `store/firefox-addon-<version>.zip`. The ZIP has `manifest.json` at its root. Hidden files are excluded and the authored source files are preserved byte-for-byte. The AMO generated-code question can be answered "No" when using this package.

## Automated Firefox releases

[Release Firefox](.github/workflows/release-firefox.yml) submits an update to the existing `airlock@dankhole` AMO listing when a stable GitHub release is published. Drafts and prereleases do not upload. The workflow runs tests and packaging, requires a tag of exactly `v<package.json version>`, saves the validated ZIP as a workflow artifact, and includes the GitHub release body as AMO release notes.

### One-time setup

1. Merge the workflow and release tooling into the repository.
2. Generate [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/) using the Mozilla account that owns Airlock.
3. Under GitHub **Settings → Secrets and variables → Actions**, add repository secrets `AMO_JWT_ISSUER` (JWT issuer/API key) and `AMO_JWT_SECRET` (JWT secret/API secret). Enter the credentials directly into GitHub's secret fields.

### Publish a version

```sh
npm run release:version -- patch  # also accepts minor or major
npm test
npm run package:firefox
```

The version command updates `package.json`, `package-lock.json`, `manifest.json`, and `firefox/manifest.json` together. Commit and push those changes with the release's source changes, then publish a GitHub release targeting that commit with the matching tag (for example, `v1.0.13`) and release notes. The workflow starts automatically; pushing a commit or tag alone does not submit an update.

Check **Actions → Release Firefox** for the package and submission result. A successful workflow means the update was submitted; publication still depends on Mozilla's validation and review. The workflow does not wait for review or download a signed XPI for listed submissions. See [Mozilla's submission reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).

If a run fails after upload, check the AMO developer dashboard before rerunning: the version may already exist. If AMO accepted it, do not resubmit that version. If it did not, fix the cause and rerun; source changes require a new version and release tag.

For a local upload, first run `npm run package:firefox`, supply `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` through your local secret manager/environment, then run `npm run submit:firefox`. This command uploads the staged package to the public listing immediately.

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

Run `npm test` for policy, runtime, adapter, UI and packaging tests. After building, `npm run test:browser` runs the Chromium and Firefox extension fixtures; individual commands are `npm run test:browser:chromium` and `npm run test:browser:firefox`. The browser harness needs the corresponding browser/driver tooling and uses isolated test profiles.

Build output is generated from source; never edit `dist/` directly. Browser fixture checks exercise controlled pages and do not establish compatibility with every authenticated website layout.

Automated popup captures load the popup document in an extension tab. This exercises its rendering and shared settings behavior but does not reproduce the toolbar click that grants `activeTab`; manually check current-site actions from the actual toolbar popup. Media tests cover pause/suppression calls and DOM restoration; live authenticated playback and site layout variants still need account-level checks.

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:browser
```

Firefox defaults to `/Applications/Firefox.app/Contents/MacOS/firefox`; set `AIRLOCK_FIREFOX_BINARY` for another installation. The pinned geckodriver is downloaded to a temporary cache on first use, which requires network access. To test the packaged Firefox ZIP, set `AIRLOCK_FIREFOX_ADDON` to its absolute path. The fixture proxy uses local `openssl` to create a temporary certificate and serves controlled pages at supported site origins without contacting those sites. Screenshots are written under `store/test-artifacts/`.

### Integration and usability validation — 2026-10-21

Airlock 1.1.1 follow-up:

- The popup uses compact quick actions, visible content-rule status, expandable details, and diagnostics for missing/failed page scripts. An authored-UI check with mocked browser authority passed 117 rendered states at 300/360/400 × 600 pixels; maximum content height was 572.8 pixels, with no page overflow and the hold/global actions visible. This does not remove the native Firefox WebDriver limitation described below. Run `node scripts/popup-layout-check.js` after UI changes.
- All 204 Node tests passed. Added coverage includes inactive policy persistence, editing break duration without switching actions, per-site Pause/Resume, settings-hold upgrade compatibility, authoritative usage ordering, missing startup responses and recovery without usage backfill, additional Shorts/Reels structures, and retrying failed content-settings reads.
- Actual temporary-extension integration passed in Chromium 153 and packaged Firefox 158 using synthetic HTTPS site origins. Checks cover the real settings hold, reversible filters and routes, core-gate priority, inactive preference editing, Pause/Resume with real foreground downtime and no usage backfill, retained waits, and independent content rules/manual cooldown. UI checks cover keyboard dialogs/focus, narrow layouts, and 200% root text; Chromium also passed forced-colors and reduced-motion emulation. Final test-harness changes wait for panel navigation and capture real content sender IDs without expanding extension permissions. Firefox package lint reported no errors, notices, or warnings.
- Expanded YouTube/Facebook matching follows the relevant donor patterns and preserves ordinary/mixed content in regression fixtures. Instagram's reported `/reels/DcPL-RdxD7v/` route already redirects in an enabled, allowed-core runtime test; that test does not establish why it remained visible in the reported authenticated session. Controls default off, so inspect the individual platform controls and Restrictions state. Existing tabs may need reloading after installing/updating the extension. Authenticated site compatibility remains unverified.

The combined implementation from `distraction-blocker/AirLock` is integrated into this repository, including source, tests, options UI, packaging and license notices. Existing settings are retained and new content controls default off.

- Node 22.22.2: all 185 automated tests passed, with none skipped. Added coverage verifies zero-minute holds, preserving the previous hold when reducing it to zero, keyboard focus after site-list refresh, and native dialog close-event ordering.
- Chrome and Firefox builds succeeded; Firefox packaging reported zero lint errors, notices or warnings. The separate web-ext update check could not access its local configuration store; packaging still succeeded.
- The complete browser suites passed on Chromium 153.0.8010.12 and Firefox 158.0 (packaged ZIP). Browser checks use isolated profiles and controlled HTTPS fixtures, including real 60-second settings holds, reversible filtering, route handling and core wait priority. Expanded UI checks cover keyboard confirmation/cancel, focus return, background controls remaining inaccessible behind modal dialogs, zero-minute confirmed changes, named controls on every settings panel, narrow layouts, enlarged text and long/empty site lists.
- Representative desktop, narrow, pending-change, empty-site, enlarged-text and forced-color screenshots were visually inspected. No blocking layout defect was found. Fixed a lost-focus issue on refreshed site disclosures and a rapid cancel/reopen confirmation race.
- Actual logged-out YouTube, Facebook and Instagram pages loaded with the short-form preset enabled. Search/sign-in and account access remained visible; no horizontal overflow or observed Airlock page errors occurred. Facebook and Instagram presented login pages, so this does not validate their authenticated feeds or playback. Reports/screenshots: `store/test-artifacts/public-sites/`.
- A real Firefox toolbar pointer click opened Airlock's native popup URL at a 300×600-pixel content size. WebDriver cannot inspect its XUL popup browser, so native current-site actions, activeTab behavior, keyboard/scrolling and Settings navigation remain unverified. Report: `store/test-artifacts/native-firefox/report.json`.
- Authenticated layouts, mobile devices and a screen-reader audit remain outside these checks. Instagram controls remain experimental.
- Updated web-ext to 10.8.0 and refreshed compatible tooling dependencies. Audit decreased from 10 entries to three high entries, with no critical entries; all remaining entries arise from one unfixed node-forge advisory through adbkit/web-ext. The production dependency audit is clean. Tooling packages are not shipped in the extension.

Supplemental checks: `node scripts/browser-ui-smoke.js chromium` (or `firefox`), `node scripts/native-toolbar-smoke.js`, and `node scripts/public-site-smoke.js`. Public-site checks require network access and use an isolated logged-out profile.

### Original distraction-blocker validation — 2026-09-30

- Node 22.23.3: **180 tests passed**, with none failed or skipped. Regression coverage includes delayed back/forward-cache settings reads and popup status convergence after configuration changes.
- Both builds and Firefox packaging passed; Mozilla lint reported **zero errors, notices or warnings**.
- Chromium 153.0.8010.12 loaded the unpacked build; Firefox 156.0.1 loaded the final packaged ZIP. Both passed controlled-origin checks for settings confirmations, real 60-second keyboard holds with release/pause/resume, reversible filtering on all three sites, normal-content preservation, route redirects and entry-wait priority.
- Visual checks covered narrow layouts, enlarged text, pending changes, long domains and empty/large site lists. Chromium reached 320 CSS pixels and checked forced colors/reduced motion; this Firefox harness enforced a 500 CSS pixel minimum. Screenshots were inspected for wrapping, clipping and focus visibility.

The original workspace’s unsigned Firefox package was `store/firefox-addon-1.0.13.zip` (SHA-256 `fef9d90d69d4950768f661f3e6b01e1ba011f27f8364fefdeff7b95895649f53`). Its 27 regular files match the authored package inputs. These are local fixture results; authenticated layouts, native toolbar popup context and mobile releases still need their respective live checks.

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
- Start a guarded settings change -- its independent **Settings hold** countdown only runs while engaging the settings hold target
- Hold Space/Enter or use touch on the target; releasing, switching views or losing focus must pause it
- Open popup and settings together; the same pending change must not advance twice as fast

### Content controls
- Start with all new controls off and check normal site content remains visible
- Enable one rule, check a matching element is hidden, then disable it and verify the element returns
- Check dynamically inserted content and same-document navigation without refreshing
- Verify ordinary videos/posts, mixed YouTube shelves, messages, intentional Search and account access survive
- Open a direct blocked route while a site wait or hard lock is active; navigation must wait until Airlock allows access
- Turn Restrictions off and verify content is restored, while tracked-site usage and an active manual cooldown retain their documented behavior
- Test selected controls against your logged-in site layouts; record any unrecognized surfaces rather than assuming fixture coverage proves live coverage

### Daily lock
- Enable **Daily lock** and choose different start and end times
- Use a same-day window (for example, 9:00 AM–5:00 PM) or an overnight window (10:00 PM–7:00 AM)
- During the window, verify that the overlay shows the local unlock time and has no Continue button
- Leave a tracked tab open across either boundary and verify that it locks or unlocks automatically
- After unlock, verify that an incomplete wait session resumes and a previously completed session remains complete

### Daily time limits
- Complete the normal wait and verify that the popup reports today's focused usage even before a limit is configured
- Enter a value in the **min/day** field beside a tracked site
- Complete the normal wait, then keep the site focused until its allowance is exhausted
- Verify that matching tabs show a non-dismissible limit overlay and that the popup reports today's usage
- Verify that unfocused, hidden, waiting, and scheduled-lock time does not count
- Raising or removing a limit uses the same guarded settings countdown as other less-restrictive changes

### Tracking without a site wait
- Uncheck **Require site wait for new sites**, then add a site manually or with the current-site button
- Visit, refresh, or open a new tab to that site and verify no countdown appears while focused usage still accumulates
- Enable a daily lock or daily limit and verify it still blocks the site; after unlocking, no countdown should appear
- Turn off **Site wait** for an existing site and verify the current wait remains until the settings hold completes
- Turn **Site wait** back on and verify entry requires a fresh countdown
- Leave a site with its wait off open across midnight and verify usage resets without a countdown

### Cooldown
- Click **Start 1 hour** and verify every tracked site immediately shows a non-dismissible cooldown overlay
- Reach 20 minutes of focused use on a tracked site and verify the small check-in can either be dismissed or start the same one-hour cooldown
- Keep using the site after dismissing and verify another check-in appears at 40 minutes, not before
- Toggle Airlock off and verify the cooldown remains active
- Click **End early**, hover the orange popup target for the configured settings hold, and verify access resumes only after the hold completes
- Change an enabled daily lock so that it loses any currently locked time and verify the same hold is required; expand it without losing locked time and verify it applies immediately after confirmation

### Persistence
- Refresh during countdown -- timer resumes, not reset
- Open the same site in a new tab -- fresh timer
- Leave a completed tracked tab open across local midnight -- the timer resets and appears again
- Close and reopen the popup during a guarded settings wait -- remaining time is preserved
- Toggle the extension off during a normal wait -- overlay removed (an active cooldown remains enforced)

## Architecture

- **`background/background.js`** owns settings validation, revision checks, guarded holds, timer sessions, usage totals and schedule boundaries. Supported-site navigation notifications trigger content reconciliation.
- **`shared/content-controls.js`** defines the versioned control schema, catalog, presets and restriction comparisons. **`shared/settings-client.js`** provides the shared popup/options messaging client.
- **`content/content.js`** owns the existing overlay and usage clock. **`shared/page-state.js`** shares readiness, the active core gate and redirect status with the content runtime.
- **`content/controls/runtime.js`** owns reversible DOM effects, media suppression, mutation observation and guarded redirects. Independent adapters under **`content/controls/sites/`** identify site elements and propose destinations; they do not create their own timers or observers.
- **`popup/`** and **`options/`** present settings through the background command API. They do not write configuration directly to storage.

The interface and file boundaries are documented in [CONTENT_CONTROLS_CONTRACT.md](CONTENT_CONTROLS_CONTRACT.md).

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist configuration, daily usage and timer sessions locally |
| `activeTab` | Read the current tab URL for the popup's current-site actions |
| `alarms` | Handle midnight resets, daily-lock boundaries and cooldown expiry |
| `webNavigation` | Re-evaluate supported-site controls after top-frame page and History API navigation |
| Site access | Run the core overlay on tracked websites and apply optional controls on YouTube, Instagram and Facebook |

## Project structure

```text
manifest.json                 Chrome build's base manifest
firefox/manifest.json         Authored Firefox manifest
background/background.js     Settings authority, sessions and usage
content/content.js           Core overlay and focused-time clock
content/controls/runtime.js  Shared content-control lifecycle
content/controls/sites/      YouTube, Instagram and Facebook adapters
shared/                      Schedule, catalog, state and settings UI helpers
popup/                       Compact current-site controls
options/                     Full settings page
scripts/                     Build, packaging and verification tooling
tests/                       Policy, runtime, adapter, UI and package tests
licenses/                    Third-party notices and license texts
```

## Privacy

Airlock stores settings and tracked-site usage locally and sends no analytics or telemetry. See [PRIVACY.md](PRIVACY.md) for details.

## License

This project is licensed under GPL-3.0-only. Selected YouTube and Facebook logic is adapted from MIT-licensed projects, with attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Instagram adapter is an original implementation; no IGPlus source is included. See [LICENSE](LICENSE) for the project license.
