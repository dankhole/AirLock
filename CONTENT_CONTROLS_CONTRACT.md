# Airlock content controls contract

Implementation contract frozen for the 2026-09-30 integration. The README documents supported behavior and validation boundaries. Change this contract through the integration lead before changing consumers.

## Shared feature catalog

`shared/content-controls.js` exports `AirlockControls` in browser globals and the same API through CommonJS for Node tests. Public API:

- `getDefaults()` returns a fresh `{version:1,youtube,instagram,facebook}` object.
- `normalize(raw)` returns known safe defaults merged with strictly valid known values. Unsupported future versions produce disabled effective defaults; the background preserves the raw object in storage rather than migrating it down.
- `getPlatform(hostname)` returns `youtube`, `instagram`, `facebook`, or `null`, using exact domain/subdomain boundaries.
- `isActive(platform, controls)` tests whether a platform's normalized settings contain any non-default behavior.
- `catalog` is an array of `{id,platform,key,label,description,type,default,options?}`. `id` is `platform.key`; `type` is `boolean` or `enum`; enum `options` is an array of `{value,label}`.
- `getPreset(id)` returns a fresh partial settings patch of shape `{contentControls:{...}}`. Presets `short-form` and `instagram-inbox` are additive and do not change unrelated preferences or tracking.
- Additional pure validation/classification helpers may be exported by the policy owner without changing these interfaces.

Defaults:

```json
{
  "version": 1,
  "youtube": {"hideShorts": false, "hideNavigation": false, "shortsRoute": "allow"},
  "instagram": {
    "blockReels": false, "blockExplore": false, "stories": "show",
    "homeDestination": "default", "hideHomeFeed": false,
    "hideComments": false, "hideNotes": false, "hideThreads": false,
    "hideMetrics": false, "unreadBadges": "normal",
    "hideVideos": false, "hideImages": false
  },
  "facebook": {"hideReels": false, "reelsRoute": "allow", "hideStories": false, "hideSuggested": false}
}
```

Enums: `youtube.shortsRoute = allow|watch`; `facebook.reelsRoute = allow|home`; `instagram.stories = show|home-hidden|blocked`; `instagram.homeDestination = default|following|messages`; `instagram.unreadBadges = normal|subdued|hidden`. All effective platform controls additionally require global `enabled !== false`.

## Settings messages

`GET_SETTINGS_STATE` returns `{ok:true, config, revision, pending, usage, dailyLimitCooldowns, dailyLimitUsageOffsets}`. `config` contains normalized existing Airlock keys plus contentControls; `usage` retains the existing dailyUsage shape. `pending` is null or includes `id`, `description`, `remainingMs`. Unsupported future content settings remain untouched in storage; snapshots expose disabled normalized controls with `contentControlsSupported:false` and `storedContentControlsVersion` so the UI can explain incompatibility. Unrelated core settings remain editable. Additional status fields are additive. Failures return `{ok:false,reason}`.

`REQUEST_CONFIG_CHANGE {expectedRevision, patch}` takes an allowlisted partial config patch and returns an authoritative state snapshot plus `applied:true|false`, or `{ok:false,reason, ...currentSnapshot}`. No UI settings writes go directly to storage. Known keys are the existing mutable Airlock settings (`enabled`, `sites`, `siteWaitEnabled`, delays, moving target, daily limits/policies, schedule, cooldown end) and `contentControls`. Never accept usage, session, revision, or pending state in a patch.

Nested `contentControls` is merged by known platform/key. Existing per-site maps merge by site; null removes an override. `sites` is an intentional replacement array protected by expectedRevision; removing a site triggers existing cleanup semantics. Cooldown start uses existing `START_COOLDOWN`; ending early is `patch:{cooldownUntil:null}` and guarded. No arbitrary cooldown timestamp is accepted from UI. Mixed patches are atomic and require a hold if any part is weakening. Settings hold accepts 0–600 minutes; when the current value is 0, confirmed changes apply without timed engagement. Reducing a nonzero hold to 0 still requires its current duration. Site waits remain 1–600 minutes. All edited controls confirm before requesting, including strengthening.

`ADVANCE_PENDING_CONFIG_CHANGE {pendingId, clientId, sequence, elapsedMs}` returns authoritative pending/revision/applied status. First tick establishes a short-lived single-client lease and grants no retroactive time. Subsequent monotonically sequenced ticks credit no more than reported engagement, actual elapsed time, and a bounded tick maximum. Closing/hiding/blurring/releasing input pauses progress. Worker restart invalidates the lease, preserving remaining hold time.

`RELEASE_PENDING_CONFIG_CHANGE {pendingId,clientId}` releases only the matching progress lease. `CANCEL_PENDING_CONFIG_CHANGE {pendingId}` cancels the current matching pending request from either trusted UI, without requiring the lease. All settings mutations are serialized. Exact extension popup/options URLs are trusted; an options page may have sender.tab. Ordinary content scripts cannot mutate configuration or advance a hold.

`shared/settings-client.js` exposes `AirlockSettingsClient`; UI owner chooses private presentation helpers. It uses the messages above, maintains revision/client identity, and never bypasses the background guard. UI controls refresh from returned authoritative state/storage notifications.

## Shared page state

`shared/page-state.js` idempotently initializes global `AirlockPageState` and exposes:

- `get()` -> `{ready:boolean, coreMode:'unknown'|'none'|'timer'|'dailyLock'|'dailyLimit'|'cooldown', navigationPending:boolean}`.
- `setCore({ready,coreMode})`, called only by core content controller.
- `setNavigationPending(boolean)`, called only by content-control runtime.
- `subscribe(listener)` -> unsubscribe function; listeners receive the new snapshot.

Initialization defaults ready=false/coreMode=unknown/navigationPending=false. No page DOM event is trusted as a core gate decision. Core publishes readiness even on an untracked site. Existing usage tracking excludes navigationPending and resets tick origin when it changes. Redirects wait for ready && coreMode===none.

The read-only tab message `AIRLOCK_GET_PAGE_STATE` returns `{ok:true, ...pageState.get(), runtimeStatus}` for popup status. It does not mutate enforcement. UI must distinguish missing permission, an unavailable/not-ready content controller, configured rules and confirmed page state; a background configuration snapshot alone is not proof that an overlay is running.

## Adapter interface

Site modules are IIFEs with CommonJS exports for tests. Browser registration is `AirlockContentRuntime.registerAdapter(adapter)`. Runtime loads before the site module and one adapter runs per host-matched top-level document.

```js
const adapter = {
  id: 'youtube', // or instagram / facebook
  decideNavigation({url, controls, document}) {
    // url is a URL instance; controls is this platform's normalized object.
    return null; // or {featureId:'youtube.shortsRoute', targetUrl:'https://...'}
  },
  collect({document, root, url, controls}) {
    // root may be Document or an affected subtree; document is always available.
    return []; // {element, featureId:'youtube.hideShorts', effect:'hide'|'subdue', pauseMedia?:true}
  }
};
```

`collect` is side-effect free and must return only validated element matches. The runtime may perform a full reconciliation for initial/config/route changes and coalesce mutation passes. A worker can use document context for ancestor/surface classification even when root is a subtree; avoid broad page scans for every individual mutation. No adapter observers, long-lived timers, storage calls, browser messages, or navigation side effects. The runtime owns styles, reversible feature-specific marks, media pause/play suppression, mutation scheduling, and disposal. `pauseMedia` covers the matched video or video descendants while hidden. Shared style rules are generated by runtime; separate adapter CSS is unnecessary unless agreed.

Runtime exposes `registerAdapter` and an idempotent `dispose`. It reads `enabled`, `contentControls`, and `configRevision` from local storage and listens for changes. It does not enforce before the first successful read; future unsupported schema disables new controls. Background emits `{type:'AIRLOCK_ROUTE_CHANGED'}` for supported top-frame committed/History API navigation. Runtime also evaluates startup, pageshow/popstate, changes and relevant DOM updates, always reading the current URL.

Validate redirect targets as HTTP(S), same origin by default, different from current URL, and not another denied destination. Apply with replace semantics after latest generation/settings/URL/core gate checks. Clear navigationPending after completion, failure, no-op, cancellation, disable or disposal; use bounded recovery so usage never remains stuck paused. Do not clear core locks or manufacture TIMER_DONE.

## File and test ownership

- Policy worker: background/background.js, shared/content-controls.js, background and policy tests.
- Runtime worker: shared/page-state.js, content/controls/runtime.js, content/content.js, core/runtime tests.
- Site workers: content/controls/sites/{youtube,facebook,instagram}.js and site-specific tests/fixtures only.
- UI worker: popup/*, options/*, shared/settings-client.js, shared/settings-ui.*, popup/options tests.
- Build worker: both manifests, scripts/*, package and lock file, licenses/notices, tests/helpers/*, tests/contracts/*, build/release/browser harness.
- Lead: this contract, product README/PRIVACY/CLAUDE updates, integration review and final stable validation.

Each site test can use jsdom via the build owner's pinned dependency. Shared helper changes go through the build owner; site tests must assert positive and negative semantic behavior, reversibility through runtime, and route boundaries. No test-only attributes may be required for production matching. All product packaging is from AirLock, not the surrounding donor workspace.
