const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const controls = require("../shared/content-controls.js");
const ui = require("../shared/settings-ui.js");
const settingsClient = require("../shared/settings-client.js");
const rootDir = path.resolve(__dirname, "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

async function loadSurface(t, surface = "options", overrides = {}, options = {}) {
  const filename = surface + "/" + surface + ".html";
  const dom = new JSDOM(fs.readFileSync(path.join(rootDir, filename), "utf8"), { url: "moz-extension://airlock/" + filename + "#general", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  let timerNow = 0;
  let timerId = 0;
  const timers = new Map();
  if (options.fakeTimers) {
    window.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: timerNow + delay }); return id; };
    window.clearTimeout = (id) => timers.delete(id);
  }
  document.hasFocus = () => true;
  const dialog = document.getElementById("confirm-dialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function (value) { this.returnValue = value; this.open = false; this.dispatchEvent(new window.Event("close")); };
  let snapshot = {
    ok: true, revision: 1, pending: null, contentControlsSupported: true,
    config: { enabled: true, contentControlsEnabled: true, sites: ["example.com"], delayMinutes: 2, settingsDelayMinutes: 2, movingTargetEnabled: false,
      siteWaitEnabled: {}, siteTrackingEnabled: {}, dailyLimits: {}, dailyLimitPolicies: {}, cooldownUntil: null,
      dailyLockEnabled: false, dailyLockStart: "22:00", dailyLockEnd: "07:00", contentControls: controls.getDefaults(), ...overrides },
    usage: { date: "2026-09-30", sites: { "example.com": 90_000 } }, dailyLimitCooldowns: {},
    currentSiteStatus: { domain: "current.example", site: null, reason: "untracked", tracked: false, active: true, paused: false, ...options.currentSiteStatus }
  };
  const messages = [];
  const pageMessages = [];
  const storageSets = [];
  const storageListeners = new Set();
  let pendingRequests = options.pendingRequests === true;
  function updateSiteState() {
    if (!snapshot.config.sites.includes("current.example")) return;
    Object.assign(snapshot.currentSiteStatus, { site: "current.example", tracked: true });
    if (snapshot.config.cooldownUntil > Date.now()) Object.assign(snapshot.currentSiteStatus, { reason: "cooldown", unlockAt: snapshot.config.cooldownUntil });
    else if (!snapshot.config.enabled) snapshot.currentSiteStatus.reason = "disabled";
  }
  function apply(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "contentControls") snapshot.config.contentControls = controls.mergePatch(snapshot.config.contentControls, value);
      else if (["siteWaitEnabled", "siteTrackingEnabled", "dailyLimits", "dailyLimitPolicies"].includes(key)) {
        for (const [site, item] of Object.entries(value)) { if (item === null) delete snapshot.config[key][site]; else snapshot.config[key][site] = item; }
      } else snapshot.config[key] = value;
    }
    snapshot.revision++;
    updateSiteState();
  }
  window.browser = {
    runtime: {
      getURL: (file) => "moz-extension://airlock/" + file,
      async sendMessage(raw) {
        const message = clone(raw); messages.push(message);
        if (message.type === "REQUEST_CONFIG_CHANGE") {
          if (options.beforeRequest) await options.beforeRequest(message);
          if (message.expectedRevision !== snapshot.revision) return { ...clone(snapshot), ok: false, reason: "stale-revision" };
          if (pendingRequests) snapshot.pending = { id: "pending-one", patch: message.patch, description: "Settings change", remainingMs: 120_000 };
          else apply(message.patch);
        } else if (message.type === "CANCEL_PENDING_CONFIG_CHANGE") {
          if (snapshot.pending && message.pendingId === snapshot.pending.id) snapshot.pending = null;
        } else if (message.type === "START_COOLDOWN") { snapshot.config.cooldownUntil = Date.now() + 3_600_000; snapshot.revision++; updateSiteState(); }
        return clone(snapshot);
      }
    },
    permissions: { async contains() { return options.hostAccess !== false; }, async request() { return false; } },
    tabs: {
      async query() { return [{ id: 7, url: options.currentUrl || "https://current.example/path" }]; },
      async sendMessage(tabId, message) {
        pageMessages.push({ tabId, message: clone(message) });
        return options.pageResponse ? options.pageResponse(pageMessages.length - 1) : options.pageUnavailable ? null : { ok: true, ready: true, coreMode: "none" };
      }
    },
    storage: { local: { async set(value) { storageSets.push(value); throw new Error("UI must never write configuration directly"); } }, onChanged: { addListener(fn) { storageListeners.add(fn); }, removeListener(fn) { storageListeners.delete(fn); } } }
  };
  for (const source of ["shared/daily-lock.js", "shared/content-controls.js", "shared/settings-client.js", "shared/settings-ui.js", surface + "/" + surface + ".js"]) window.eval(fs.readFileSync(path.join(rootDir, source), "utf8"));
  await settle();
  return {
    document, window, messages, pageMessages, storageSets, get snapshot() { return snapshot; },
    async advanceTime(ms) {
      assert.equal(options.fakeTimers, true);
      const until = timerNow + ms;
      let remainingCallbacks = 100;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(remainingCallbacks-- > 0, "Timer callbacks must remain bounded");
        const [id, timer] = due; timers.delete(id); timerNow = timer.at; timer.callback(); await settle();
      }
      timerNow = until; await settle();
    },
    set pendingRequests(value) { pendingRequests = value; },
    async notify(mutator) { mutator(snapshot); storageListeners.forEach((fn) => fn({ dailyUsage: {} }, "local")); await settle(); },
    async dispatch(id, value, type = "change") {
      const input = document.getElementById(id); input.focus();
      if (input.type === "checkbox") input.checked = value; else if (value !== undefined) input.value = value;
      input.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); await settle(); return input;
    },
    async save() { const button = document.getElementById("save-settings"); button.focus(); button.click(); await settle(); },
    async confirm(value = "confirm") { assert.equal(dialog.open, true); dialog.close(value); await settle(); },
    get requests() { return messages.filter((message) => message.type === "REQUEST_CONFIG_CHANGE"); }
  };
}

test("options stages general settings and saves one reviewed revision-checked batch", async (t) => {
  const env = await loadSurface(t);
  for (const [id, value] of [["delay-input", "5"], ["settings-delay-input", "4"], ["moving-target-toggle", true], ["daily-lock-toggle", true], ["daily-lock-start", "21:00"]]) {
    await env.dispatch(id, value);
    assert.equal(env.requests.length, 0);
    assert.equal(env.document.getElementById("confirm-dialog").open, false);
  }
  assert.equal(env.snapshot.config.delayMinutes, 2);
  assert.match(env.document.getElementById("settings-draft-status").textContent, /Unsaved/);
  await env.save();
  assert.match(env.document.getElementById("confirm-dialog-differences").textContent, /Site wait minutes: 2 → 5/);
  assert.equal(env.requests.length, 0);
  await env.confirm();
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.requests[0].patch, { delayMinutes: 5, settingsDelayMinutes: 4, movingTargetEnabled: true, dailyLockEnabled: true, dailyLockStart: "21:00" });
  assert.equal(env.requests[0].expectedRevision, 1);
  assert.equal(env.document.getElementById("save-settings").disabled, true);
  assert.equal(env.document.activeElement.id, "settings-draft-title");
  assert.equal(env.storageSets.length, 0);
});

test("Site restrictions and manual cooldown stay independent confirmed actions and preserve drafts", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "5");
  await env.dispatch("enabled-toggle", false);
  assert.equal(env.document.getElementById("enabled-toggle").checked, true);
  await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { enabled: false });
  assert.equal(env.document.getElementById("delay-input").value, "5");
  assert.equal(env.snapshot.config.delayMinutes, 2);
  assert.equal(env.document.getElementById("save-settings").disabled, true);
  assert.equal(env.document.getElementById("rebase-settings").hidden, false);
  await env.dispatch("cooldown-btn", undefined, "click");
  assert.equal(env.messages.some((item) => item.type === "START_COOLDOWN"), false);
  await env.confirm();
  assert.equal(env.messages.some((item) => item.type === "START_COOLDOWN"), true);
  await env.dispatch("cooldown-btn", undefined, "click"); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { cooldownUntil: null });
  assert.equal(env.document.getElementById("delay-input").value, "5");
  assert.equal(env.storageSets.length, 0);
});

test("both views confirm Content blocking independently and keep saved rules intact", async (t) => {
  const prefs = controls.getDefaults(); prefs.youtube.hideShorts = true;
  for (const surface of ["options", "popup"]) {
    const env = await loadSurface(t, surface, { enabled: false, contentControls: prefs });
    const input = env.document.getElementById("content-controls-toggle");
    assert.equal(input.checked, true);
    assert.match(env.document.getElementById("master-help").textContent, /Content blocking stays independent/);
    assert.match(env.document.getElementById("content-controls-help").textContent, /Shorts, Reels/);
    await env.dispatch(input.id, false);
    assert.equal(input.checked, true, "the active state stays visible until confirmed");
    assert.equal(env.requests.length, 0);
    assert.match(env.document.getElementById("confirm-dialog-differences").textContent, /Content blocking: On → Off/);
    await env.confirm("cancel");
    assert.equal(input.checked, true); assert.equal(env.requests.length, 0);
    await env.dispatch(input.id, false); await env.confirm();
    assert.deepEqual(env.requests.at(-1).patch, { contentControlsEnabled: false });
    assert.equal(env.snapshot.config.enabled, false);
    assert.deepEqual(env.snapshot.config.contentControls, prefs);
    assert.equal(input.checked, false);
    await env.dispatch(input.id, true); await env.confirm();
    assert.deepEqual(env.requests.at(-1).patch, { contentControlsEnabled: true });
    assert.deepEqual(env.snapshot.config.contentControls, prefs);
    assert.equal(env.storageSets.length, 0);
  }
});

test("Content blocking changes preserve options drafts and stay outside the saved batch", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "5");
  await env.dispatch("rule-youtube.hideShorts", true);
  // A native checkbox emits input before change. Neither event may create a
  // draft change for the independent master action.
  await env.dispatch("content-controls-toggle", false, "input");
  await env.dispatch("content-controls-toggle", false); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { contentControlsEnabled: false });
  assert.equal(env.document.getElementById("delay-input").value, "5");
  assert.equal(env.document.getElementById("rule-youtube.hideShorts").checked, true);
  assert.match(env.document.getElementById("youtube-status").textContent, /Draft: Paused by Content blocking/);
  assert.equal(env.document.getElementById("save-settings").disabled, true);
  await env.dispatch("rebase-settings", undefined, "click"); await env.confirm();
  await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { delayMinutes: 5, contentControls: { youtube: { hideShorts: true } } });
  assert.equal(env.snapshot.config.contentControlsEnabled, false);
  assert.equal(env.document.getElementById("content-controls-toggle").checked, false);
});

test("a pending Content blocking toggle locks both independent masters and can be cancelled", async (t) => {
  for (const surface of ["options", "popup"]) {
    const env = await loadSurface(t, surface, {}, { pendingRequests: true });
    await env.dispatch("content-controls-toggle", false); await env.confirm();
    assert.deepEqual(env.requests.at(-1).patch, { contentControlsEnabled: false });
    assert.equal(env.snapshot.config.contentControlsEnabled, true);
    assert.equal(env.document.getElementById("content-controls-toggle").checked, true);
    assert.equal(env.document.getElementById("content-controls-toggle").disabled, true);
    assert.equal(env.document.getElementById("enabled-toggle").disabled, true);
    assert.equal(env.document.activeElement.id, "pending-config-hover-target");
    await env.dispatch("pending-config-cancel", undefined, "click");
    assert.equal(env.document.getElementById("content-controls-toggle").disabled, false);
    assert.equal(env.document.activeElement.id, "content-controls-toggle");
  }
});

test("content summaries follow Content blocking independently of Site restrictions", async (t) => {
  const prefs = controls.getDefaults(); prefs.youtube.hideShorts = true;
  for (const enabled of [true, false]) for (const contentControlsEnabled of [true, false]) {
    const config = { enabled, contentControlsEnabled, contentControls: prefs };
    const summary = ui.rulesSummary(config, "youtube", controls.catalog);
    assert.match(summary, contentControlsEnabled ? /^Configured/ : /^Paused by Content blocking/);
    const env = await loadSurface(t, "popup", config, { currentUrl: "https://www.youtube.com/watch?v=test" });
    assert.equal(env.document.getElementById("enabled-toggle").checked, enabled);
    assert.equal(env.document.getElementById("content-controls-toggle").checked, contentControlsEnabled);
    assert.equal(env.document.getElementById("current-rules-status").textContent, contentControlsEnabled ? "Content rules: 1 enabled" : "Content rules: paused by Content blocking");
    assert.equal(env.document.getElementById("current-rules").textContent, summary);
  }
});

test("pending quick action keeps active values, locks edits, and cancels by current pending ID", async (t) => {
  const env = await loadSurface(t, "options", {}, { pendingRequests: true });
  await env.dispatch("enabled-toggle", false); await env.confirm();
  assert.equal(env.document.getElementById("pending-config-section").hidden, false);
  assert.equal(env.document.activeElement.id, "pending-config-hover-target");
  assert.equal(env.document.getElementById("enabled-toggle").checked, true);
  assert.equal(env.document.getElementById("add-site-btn").disabled, true);
  assert.equal(env.document.getElementById("pending-config-cancel").disabled, false);
  await env.dispatch("pending-config-cancel", undefined, "click");
  assert.equal(env.messages.at(-1).pendingId, "pending-one");
  assert.equal(env.document.getElementById("pending-config-section").hidden, true);
  assert.equal(env.snapshot.config.enabled, true);
  assert.equal(env.document.activeElement.id, "enabled-toggle");
});

test("cancelled Save preserves draft and returns focus, while Discard restores active values", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "5"); await env.save(); await env.confirm("cancel");
  assert.equal(env.requests.length, 0);
  assert.equal(env.document.getElementById("delay-input").value, "5");
  assert.equal(env.document.activeElement.id, "save-settings");
  await env.dispatch("discard-settings", undefined, "click");
  assert.equal(env.document.getElementById("delay-input").value, "2");
  assert.equal(env.document.getElementById("save-settings").disabled, true);
  assert.equal(env.document.activeElement.id, "settings-draft-title");
});

test("a new confirmation waits for the previous native close event after Escape", async (t) => {
  const env = await loadSurface(t);
  const dialog = env.document.getElementById("confirm-dialog");
  await env.dispatch("enabled-toggle", false);
  assert.equal(dialog.open, true);
  dialog.open = false; dialog.returnValue = "";
  await env.dispatch("enabled-toggle", false);
  assert.equal(dialog.open, false);
  dialog.dispatchEvent(new env.window.Event("close")); await settle();
  assert.equal(env.requests.length, 0);
  await env.dispatch("enabled-toggle", false); await env.confirm();
  assert.equal(env.requests.length, 1); assert.equal(env.snapshot.config.enabled, false);
});

test("an asynchronous save locks all edits and restores focus to the draft heading", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const env = await loadSurface(t, "options", {}, { beforeRequest: () => waiting });
  await env.dispatch("delay-input", "5"); await env.save(); await env.confirm();
  assert.equal(env.document.getElementById("delay-input").disabled, true);
  assert.equal(env.document.getElementById("discard-settings").disabled, true);
  env.document.body.tabIndex = -1; env.document.body.focus();
  release(); await settle();
  assert.equal(env.document.getElementById("delay-input").disabled, false);
  assert.equal(env.document.activeElement.id, "settings-draft-title");
});

test("site drafts retain dependent policy values and are saved with waits and budgets together", async (t) => {
  const env = await loadSurface(t, "options", { dailyLimits: { "example.com": 30 } });
  for (const [id, value] of [["site-wait-example.com", false], ["site-limit-example.com", "20"], ["site-policy-example.com", "cooldown"], ["site-cooldown-example.com", "45"]]) await env.dispatch(id, value);
  assert.equal(env.requests.length, 0);
  await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { siteWaitEnabled: { "example.com": false }, dailyLimits: { "example.com": 20 }, dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 45 } } });
  await env.dispatch("site-policy-example.com", "block");
  await env.dispatch("site-limit-example.com", "");
  await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { dailyLimits: { "example.com": null }, dailyLimitPolicies: { "example.com": { mode: "block", cooldownMinutes: 45 } } });
  env.document.querySelector(".site-remove").click(); await settle();
  assert.equal(env.document.querySelectorAll(".site-detail").length, 0);
  assert.deepEqual(env.snapshot.config.sites, ["example.com"]);
  await env.save(); await env.confirm(); assert.deepEqual(env.requests.at(-1).patch, { sites: [] });
});

test("inactive limit preferences stay editable and break duration preserves the draft mode", async (t) => {
  const env = await loadSurface(t, "options", { enabled: false });
  await env.dispatch("site-cooldown-example.com", "15");
  await env.save();
  assert.match(env.document.getElementById("confirm-dialog-differences").textContent, /saved break: 15 minutes/);
  await env.confirm("cancel");
  await env.dispatch("site-policy-example.com", "cooldown");
  await env.dispatch("site-cooldown-example.com", "20");
  await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 20 } } });
  assert.deepEqual(env.snapshot.config.dailyLimits, {}); assert.equal(env.snapshot.config.enabled, false);
});

test("collapsed site tracking stages pause and resume while active totals stay authoritative", async (t) => {
  const env = await loadSurface(t, "options", { dailyLimits: { "example.com": 30 }, siteWaitEnabled: { "example.com": false } });
  const id = "site-tracking-example.com";
  assert.equal(env.document.querySelector(".site-detail").open, false);
  assert.equal(env.document.querySelector(".site-detail").contains(env.document.getElementById(id)), false);
  await env.dispatch(id, undefined, "click");
  assert.equal(env.document.getElementById(id).textContent, "Resume");
  assert.deepEqual(env.snapshot.config.siteTrackingEnabled, {});
  assert.equal(env.document.activeElement.id, id);
  await env.save();
  assert.match(env.document.getElementById("confirm-dialog-differences").textContent, /Site tracking for example.com: On → Off/);
  await env.confirm(); assert.match(env.document.querySelector(".site-usage").textContent, /^Paused/);
  assert.deepEqual(env.snapshot.config.dailyLimits, { "example.com": 30 });
  assert.deepEqual(env.snapshot.usage.sites, { "example.com": 90000 });
  await env.dispatch(id, undefined, "click"); await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { siteTrackingEnabled: { "example.com": null } });
});

test("popup adds immediately after confirmation while options stages a site with no entry wait", async (t) => {
  const popup = await loadSurface(t, "popup");
  popup.document.getElementById("add-site-wait").checked = false;
  await popup.dispatch("add-current-btn", undefined, "click"); await popup.confirm();
  assert.deepEqual(popup.requests.at(-1).patch, { sites: ["current.example", "example.com"], siteWaitEnabled: { "current.example": false } });
  const options = await loadSurface(t);
  options.document.getElementById("site-input").value = "https://www.social.example/feed";
  options.document.getElementById("add-site-wait").checked = false;
  options.document.getElementById("add-site-form").dispatchEvent(new options.window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.equal(options.requests.length, 0);
  assert.ok(options.document.getElementById("site-wait-social.example"));
  assert.match(options.document.querySelector('[data-site="social.example"] .site-usage').textContent, /not tracked yet/);
  await options.save(); await options.confirm();
  assert.deepEqual(options.requests.at(-1).patch, { sites: ["example.com", "social.example"], siteWaitEnabled: { "social.example": false } });
});

test("all 19 content controls stage and save one atomic patch with exact review differences", async (t) => {
  const env = await loadSurface(t); const patch = { contentControls: {} };
  assert.equal(controls.catalog.length, 19);
  for (const item of controls.catalog) {
    const value = item.type === "boolean" ? true : item.options.find((option) => option.value !== item.default).value;
    await env.dispatch("rule-" + item.id, value);
    (patch.contentControls[item.platform] ||= {})[item.key] = value;
    assert.equal(env.document.getElementById("confirm-dialog").open, false);
  }
  await env.save();
  const text = env.document.getElementById("confirm-dialog-differences").textContent;
  controls.catalog.forEach((item) => assert.ok(text.includes(item.label)));
  await env.confirm(); assert.equal(env.requests.length, 1); assert.deepEqual(env.requests[0].patch, patch);
  assert.deepEqual(env.snapshot.config.sites, ["example.com"]);
});

test("presets merge into drafts and bulk disable replaces edited platform values", async (t) => {
  const prefs = controls.getDefaults(); prefs.instagram.hideComments = true;
  const env = await loadSurface(t, "options", { contentControls: prefs });
  await env.dispatch("rule-instagram.hideVideos", true);
  await env.dispatch("short-form-preset", undefined, "click");
  await env.dispatch("inbox-preset", undefined, "click");
  assert.equal(env.document.getElementById("rule-instagram.hideComments").checked, true);
  assert.equal(env.document.getElementById("rule-instagram.hideVideos").checked, true);
  assert.equal(env.requests.length, 0);
  env.document.querySelector("#instagram .danger").click(); await settle();
  assert.equal(env.document.getElementById("rule-instagram.hideVideos").checked, false);
  assert.equal(env.document.getElementById("rule-instagram.hideComments").checked, false);
  await env.save(); await env.confirm();
  assert.equal(env.snapshot.config.contentControls.youtube.hideShorts, true);
  assert.deepEqual(env.snapshot.config.contentControls.instagram, controls.getDefaults().instagram);
  assert.deepEqual(env.snapshot.config.sites, ["example.com"]);
});

test("settings hold accepts zero and independent confirmation explains immediate changes", async (t) => {
  const env = await loadSurface(t);
  const input = await env.dispatch("settings-delay-input", "0"); assert.equal(input.min, "0"); assert.equal(input.validationMessage, "");
  await env.save(); await env.confirm("cancel"); assert.equal(env.snapshot.config.settingsDelayMinutes, 2);
  await env.save(); await env.confirm(); assert.deepEqual(env.requests.at(-1).patch, { settingsDelayMinutes: 0 });
  await env.dispatch("enabled-toggle", false);
  assert.match(env.document.getElementById("confirm-dialog-message").textContent, /0 minutes.*immediately after confirmation/);
  await env.confirm(); assert.equal(env.snapshot.config.enabled, false);
});

test("Save rejects invalid fields across panels even when a valid change is staged", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("moving-target-toggle", true);
  for (const [id, value] of [["delay-input", "0"], ["settings-delay-input", "-1"], ["settings-delay-input", "1.5"], ["site-limit-example.com", "1441"], ["daily-lock-start", "07:00"]]) {
    const old = env.document.getElementById(id).value;
    const input = await env.dispatch(id, value);
    assert.ok(input.validationMessage);
    await env.save(); assert.equal(env.document.getElementById("confirm-dialog").open, false);
    await env.dispatch(id, old);
  }
  assert.equal(env.requests.length, 0);
  // Save also reads a raw, uncommitted input value and exposes its hidden panel.
  const raw = env.document.getElementById("site-cooldown-example.com"); raw.value = "0";
  raw.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  await env.save(); assert.equal(env.document.getElementById("confirm-dialog").open, false);
  assert.equal(env.document.getElementById("sites").hidden, false); assert.equal(env.document.activeElement.id, raw.id);
});

test("a rejected domain can be corrected and added through native form validation", async (t) => {
  const env = await loadSurface(t); const input = env.document.getElementById("site-input"); const form = env.document.getElementById("add-site-form");
  input.value = "not a domain"; form.requestSubmit(); await settle(); assert.ok(input.validationMessage);
  input.value = "social.example"; input.dispatchEvent(new env.window.Event("input", { bubbles: true })); assert.equal(input.validationMessage, "");
  form.requestSubmit(); await settle(); await env.save(); await env.confirm(); assert.ok(env.snapshot.config.sites.includes("social.example"));
});

test("configuration refresh preserves focus on a site disclosure summary", async (t) => {
  const env = await loadSurface(t); const summary = env.document.querySelector("#site-list summary"); summary.focus();
  await env.notify((snapshot) => { snapshot.revision++; snapshot.config.delayMinutes = 5; });
  const replacement = env.document.querySelector("#site-list summary"); assert.notEqual(replacement, summary); assert.equal(env.document.activeElement, replacement);
});

test("usage and revision refresh preserve raw drafts, disclosure and focus, with explicit rebase", async (t) => {
  const env = await loadSurface(t); const details = env.document.querySelector("details"); details.open = true;
  const input = env.document.getElementById("site-limit-example.com"); input.focus(); input.value = "42";
  input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  await env.notify((snapshot) => { snapshot.usage.sites["example.com"] = 300_000; });
  assert.equal(env.document.getElementById(input.id), input); assert.equal(input.value, "42"); assert.equal(env.document.activeElement, input); assert.equal(details.open, true);
  assert.match(env.document.querySelector(".site-usage").textContent, /5 min/);
  await env.notify((snapshot) => { snapshot.revision++; snapshot.config.delayMinutes = 5; });
  assert.equal(env.document.getElementById(input.id).value, "42"); assert.equal(env.document.getElementById("delay-input").value, "2");
  assert.equal(env.document.activeElement.id, input.id); assert.equal(env.document.getElementById("save-settings").disabled, true);
  await env.dispatch("rebase-settings", undefined, "click"); await env.confirm();
  assert.equal(env.document.getElementById("delay-input").value, "5"); assert.equal(env.document.getElementById(input.id).value, "42");
  await env.save(); await env.confirm(); assert.deepEqual(env.requests.at(-1).patch, { dailyLimits: { "example.com": 42 } }); assert.equal(env.requests.at(-1).expectedRevision, 2);
});

test("pending batch locks draft actions, cancellation retains draft, and completion clears it", async (t) => {
  const env = await loadSurface(t, "options", {}, { pendingRequests: true });
  await env.dispatch("delay-input", "1"); await env.dispatch("rule-youtube.hideShorts", true); await env.save(); await env.confirm();
  assert.equal(env.requests.length, 1); assert.equal(env.snapshot.config.delayMinutes, 2);
  assert.equal(env.document.getElementById("delay-input").value, "1"); assert.equal(env.document.getElementById("discard-settings").disabled, true);
  assert.match(env.document.getElementById("settings-draft-status").textContent, /Submitted/);
  await env.dispatch("pending-config-cancel", undefined, "click");
  assert.equal(env.document.getElementById("delay-input").value, "1"); assert.equal(env.document.getElementById("save-settings").disabled, false);
  await env.save(); await env.confirm();
  await env.notify((snapshot) => { snapshot.config.delayMinutes = 1; snapshot.config.contentControls.youtube.hideShorts = true; snapshot.revision++; snapshot.pending = null; snapshot.applied = true; });
  assert.equal(env.document.getElementById("save-settings").disabled, true); assert.equal(env.document.activeElement.id, "settings-draft-title");
});

test("Discard clears invalid draft fields and restores all panels without commands", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "0");
  await env.dispatch("site-policy-example.com", "cooldown");
  await env.dispatch("rule-instagram.hideComments", true);
  await env.dispatch("discard-settings", undefined, "click");
  assert.equal(env.document.getElementById("delay-input").value, "2");
  assert.equal(env.document.getElementById("delay-input").validationMessage, "");
  assert.equal(env.document.getElementById("site-policy-example.com").value, "block");
  assert.equal(env.document.getElementById("rule-instagram.hideComments").checked, false);
  assert.equal(env.requests.length, 0);
});

test("remove and re-add within a draft retains saved site preferences and can be a no-op", async (t) => {
  const env = await loadSurface(t, "options", { dailyLimits: { "example.com": 30 }, dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 15 } } });
  env.document.querySelector(".site-remove").click(); await settle();
  env.document.getElementById("site-input").value = "example.com";
  env.document.getElementById("add-site-form").requestSubmit(); await settle();
  assert.equal(env.document.getElementById("site-limit-example.com").value, "30");
  assert.equal(env.document.getElementById("site-policy-example.com").value, "cooldown");
  assert.equal(env.document.getElementById("site-cooldown-example.com").value, "15");
  await env.save();
  assert.equal(env.document.getElementById("confirm-dialog").open, false);
  assert.equal(env.requests.length, 0);
});

test("an input-only edit is validated and included when Save is clicked directly", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("settings-delay-input", "0", "input");
  await env.dispatch("site-limit-example.com", "45", "input");
  await env.save(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { settingsDelayMinutes: 0, dailyLimits: { "example.com": 45 } });
});

test("future schema disables only content edits while General stays usable", async (t) => {
  const env = await loadSurface(t); await env.notify((snapshot) => { snapshot.contentControlsSupported = false; });
  assert.equal(env.document.getElementById("rule-youtube.hideShorts").disabled, true); assert.equal(env.document.getElementById("short-form-preset").disabled, true);
  assert.equal(env.document.getElementById("delay-input").disabled, false); assert.match(env.document.getElementById("instagram-status").textContent, /newer Airlock/);
});

test("popup reports access needed or unavailable page state without claiming enforced access", async (t) => {
  const denied = await loadSurface(t, "popup", {}, { hostAccess: false });
  assert.match(denied.document.getElementById("current-access").textContent, /Access needed/);
  assert.equal(denied.pageMessages.length, 0);
  const unavailable = await loadSurface(t, "popup", {}, { pageUnavailable: true });
  assert.match(unavailable.document.getElementById("current-access").textContent, /Page status unavailable/);
});

test("popup converges after starting cooldown even when the first new probe precedes the core update", async (t) => {
  let coreMode = "none";
  const env = await loadSurface(t, "popup", { sites: ["current.example"], siteWaitEnabled: { "current.example": false } }, {
    fakeTimers: true,
    currentSiteStatus: { site: "current.example", tracked: true, reason: "allowed" },
    pageResponse: () => ({ ok: true, ready: true, coreMode })
  });
  assert.equal(env.pageMessages.length, 1);
  await env.dispatch("cooldown-btn", undefined, "click"); await env.confirm();
  assert.equal(env.snapshot.currentSiteStatus.reason, "cooldown");
  assert.match(env.document.getElementById("current-access").textContent, /Page status updating/);
  assert.equal(env.pageMessages.length, 2);
  coreMode = "cooldown";
  await env.advanceTime(150);
  assert.match(env.document.getElementById("current-access").textContent, /^Manual cooldown until/);
  const settledCount = env.pageMessages.length;
  await env.notify((snapshot) => { snapshot.usage.sites["current.example"] = 120_000; });
  await env.advanceTime(10_000);
  assert.equal(env.pageMessages.length, settledCount, "Unchanged usage must not restart a converged probe");
});

test("popup rechecks after a master-off hold completes, but does not probe each pending hold update", async (t) => {
  let coreMode = "timer";
  const env = await loadSurface(t, "popup", { sites: ["current.example"] }, {
    fakeTimers: true, pendingRequests: true,
    currentSiteStatus: { site: "current.example", tracked: true, reason: "wait", remainingMs: 120_000 },
    pageResponse: () => ({ ok: true, ready: true, coreMode })
  });
  await env.dispatch("enabled-toggle", false); await env.confirm();
  await env.notify((snapshot) => { snapshot.pending.remainingMs = 119_750; });
  assert.equal(env.pageMessages.length, 1);
  await env.notify((snapshot) => {
    snapshot.config.enabled = false; snapshot.revision++; snapshot.pending = null; snapshot.applied = true;
    snapshot.currentSiteStatus.reason = "disabled";
  });
  assert.equal(env.pageMessages.length, 2);
  assert.match(env.document.getElementById("current-access").textContent, /Page status updating/);
  coreMode = "none";
  await env.advanceTime(150);
  assert.equal(env.document.getElementById("current-access").textContent, "Site restrictions off · usage tracking continues");
  assert.equal(env.pageMessages.length, 3);
  assert.equal(env.storageSets.length, 0);
});

test("popup recovers unavailable or not-yet-ready page state through finite retries", async (t) => {
  const responses = [null, { ok: true, ready: false, coreMode: "unknown" }, { ok: true, ready: true, coreMode: "none" }];
  const env = await loadSurface(t, "popup", {}, { fakeTimers: true, pageResponse: (index) => responses[index] });
  assert.match(env.document.getElementById("current-access").textContent, /Page status unavailable/);
  await env.advanceTime(150);
  assert.match(env.document.getElementById("current-access").textContent, /Page status unavailable/);
  await env.advanceTime(400);
  assert.equal(env.document.getElementById("current-access").textContent, "Not tracked · no Airlock site gate");
  await env.advanceTime(10_000);
  assert.equal(env.pageMessages.length, 3);
});

test("an access reason change reprobes without a revision change, while timer and focus metadata do not", async (t) => {
  let coreMode = "none";
  const env = await loadSurface(t, "popup", { sites: ["current.example"] }, {
    fakeTimers: true, currentSiteStatus: { site: "current.example", tracked: true, reason: "allowed" },
    pageResponse: () => ({ ok: true, ready: true, coreMode })
  });
  coreMode = "dailyLock";
  await env.notify((snapshot) => { snapshot.currentSiteStatus.reason = "daily-lock"; snapshot.currentSiteStatus.unlockAt = Date.now() + 600_000; });
  assert.equal(env.snapshot.revision, 1);
  assert.equal(env.pageMessages.length, 2);
  assert.match(env.document.getElementById("current-access").textContent, /^Daily lock until/);
  await env.notify((snapshot) => { snapshot.currentSiteStatus.remainingMs = 250; snapshot.currentSiteStatus.paused = true; });
  await env.advanceTime(10_000);
  assert.equal(env.pageMessages.length, 2);
});

test("popup ignores a delayed response for an earlier authoritative status", async (t) => {
  let finishOldProbe;
  const oldProbe = new Promise((resolve) => { finishOldProbe = resolve; });
  const env = await loadSurface(t, "popup", { sites: ["current.example"] }, {
    fakeTimers: true, currentSiteStatus: { site: "current.example", tracked: true, reason: "allowed" },
    pageResponse: (index) => index === 1 ? oldProbe : { ok: true, ready: true, coreMode: "none" }
  });
  await env.notify((snapshot) => { snapshot.revision++; snapshot.currentSiteStatus.reason = "cooldown"; snapshot.currentSiteStatus.unlockAt = Date.now() + 3_600_000; });
  await env.notify((snapshot) => { snapshot.revision++; snapshot.config.enabled = false; snapshot.currentSiteStatus.reason = "disabled"; });
  assert.equal(env.document.getElementById("current-access").textContent, "Site restrictions off · usage tracking continues");
  finishOldProbe({ ok: true, ready: true, coreMode: "cooldown" }); await settle();
  assert.equal(env.document.getElementById("current-access").textContent, "Site restrictions off · usage tracking continues");
  await env.advanceTime(10_000);
  assert.equal(env.pageMessages.length, 3);
});

test("unresponsive page probes time out at 800ms and stop after a bounded series, with recovery on refocus", async (t) => {
  let responsive = false;
  const env = await loadSurface(t, "popup", {}, {
    fakeTimers: true,
    pageResponse: () => responsive ? { ok: true, ready: true, coreMode: "none" } : new Promise(() => {})
  });
  await env.advanceTime(799); assert.equal(env.pageMessages.length, 1);
  await env.advanceTime(1); assert.equal(env.pageMessages.length, 1);
  await env.advanceTime(149); assert.equal(env.pageMessages.length, 1);
  await env.advanceTime(1); assert.equal(env.pageMessages.length, 2);
  await env.advanceTime(10_000); assert.equal(env.pageMessages.length, 4);
  await env.notify((snapshot) => { snapshot.usage.sites["example.com"] = 180_000; });
  await env.advanceTime(10_000); assert.equal(env.pageMessages.length, 4);
  responsive = true;
  env.window.dispatchEvent(new env.window.Event("focus")); await settle();
  assert.equal(env.pageMessages.length, 5);
  assert.equal(env.document.getElementById("current-access").textContent, "Not tracked · no Airlock site gate");
  await env.advanceTime(10_000); assert.equal(env.pageMessages.length, 5);
});

test("popup teardown invalidates delayed responses and scheduled recovery attempts", async (t) => {
  let resolveProbe;
  const deferred = new Promise((resolve) => { resolveProbe = resolve; });
  const env = await loadSurface(t, "popup", {}, { fakeTimers: true, pageResponse: () => deferred });
  const initialText = env.document.getElementById("current-access").textContent;
  env.window.dispatchEvent(new env.window.Event("pagehide"));
  resolveProbe({ ok: true, ready: true, coreMode: "none" }); await settle();
  await env.advanceTime(10_000);
  assert.equal(env.document.getElementById("current-access").textContent, initialText);
  assert.equal(env.pageMessages.length, 1);
  const scheduled = await loadSurface(t, "popup", {}, { fakeTimers: true, pageUnavailable: true });
  scheduled.window.dispatchEvent(new scheduled.window.Event("pagehide"));
  await scheduled.advanceTime(10_000);
  assert.equal(scheduled.pageMessages.length, 1);
});

test("hiding the popup invalidates recovery, and becoming visible starts a fresh bounded check", async (t) => {
  let visibility = "visible";
  let ready = false;
  const env = await loadSurface(t, "popup", {}, {
    fakeTimers: true, pageResponse: () => ready ? { ok: true, ready: true, coreMode: "none" } : null
  });
  Object.defineProperty(env.document, "visibilityState", { get: () => visibility });
  visibility = "hidden"; env.document.dispatchEvent(new env.window.Event("visibilitychange"));
  await env.advanceTime(10_000); assert.equal(env.pageMessages.length, 1);
  ready = true; visibility = "visible"; env.document.dispatchEvent(new env.window.Event("visibilitychange")); await settle();
  assert.equal(env.pageMessages.length, 2);
  assert.equal(env.document.getElementById("current-access").textContent, "Not tracked · no Airlock site gate");
});

test("client keeps newer configuration and same-revision pending progress when responses arrive out of order", async () => {
  const calls = [];
  const browser = { runtime: { sendMessage(message) { return new Promise((resolve) => calls.push({ message, resolve })); } } };
  const client = settingsClient.create(browser, { clientId: "one", tabId: 7 });
  const oldRefresh = client.refresh();
  const request = client.request({ enabled: false }, 1);
  calls[1].resolve({ ok: true, revision: 2, config: { enabled: false }, pending: null }); await request;
  calls[0].resolve({ ok: true, revision: 1, config: { enabled: true }, pending: null }); await oldRefresh;
  assert.equal(client.snapshot.config.enabled, false);
  const early = client.advance("p", 250); const late = client.advance("p", 250);
  calls[3].resolve({ ok: true, revision: 2, config: { enabled: false }, pending: { id: "p", remainingMs: 1000 } }); await late;
  calls[2].resolve({ ok: true, revision: 2, config: { enabled: false }, pending: { id: "p", remainingMs: 2000 } }); await early;
  assert.equal(client.snapshot.pending.remainingMs, 1000);
  assert.equal(calls[3].message.sequence, calls[2].message.sequence + 1);
  assert.equal(calls[0].message.tabId, 7);
});

test("UI captures confirmation revision, and stale errors preserve current authoritative values", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "5"); await env.save();
  await env.notify((snapshot) => { snapshot.config.delayMinutes = 3; snapshot.revision++; });
  await env.confirm();
  assert.equal(env.requests.at(-1).expectedRevision, 1);
  assert.equal(env.snapshot.config.delayMinutes, 3);
  assert.match(env.document.getElementById("ui-status").textContent, /another view/);
  assert.equal(env.document.getElementById("delay-input").value, "5");
  assert.equal(env.document.getElementById("save-settings").disabled, true);
  assert.equal(env.requests.length, 1, "a stale save must never retry automatically");
  await env.dispatch("rebase-settings", undefined, "click");
  assert.match(env.document.getElementById("confirm-dialog-differences").textContent, /3 → 5/);
  await env.confirm("cancel"); assert.equal(env.document.getElementById("save-settings").disabled, true);
  await env.dispatch("rebase-settings", undefined, "click"); await env.confirm();
  await env.save(); await env.confirm();
  assert.equal(env.requests.length, 2); assert.equal(env.requests[1].expectedRevision, 2);
});

test("domain input rejects internal schemes, credentials, invalid labels, and whitespace", () => {
  for (const value of ["chrome://extensions", "https://user:secret@example.com", "-bad.example", "example..com", "example com", "localhost"]) assert.equal(ui.cleanDomain(value), null);
  assert.equal(ui.cleanDomain("https://www.Example.com/a"), "example.com");
});
