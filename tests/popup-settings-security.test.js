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
    config: { enabled: true, sites: ["example.com"], delayMinutes: 2, settingsDelayMinutes: 2, movingTargetEnabled: false,
      siteWaitEnabled: {}, dailyLimits: {}, dailyLimitPolicies: {}, cooldownUntil: null,
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
      else if (["siteWaitEnabled", "dailyLimits", "dailyLimitPolicies"].includes(key)) {
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
      async query() { return [{ id: 7, url: "https://current.example/path" }]; },
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
    async confirm(value = "confirm") { assert.equal(dialog.open, true); dialog.close(value); await settle(); },
    get requests() { return messages.filter((message) => message.type === "REQUEST_CONFIG_CHANGE"); }
  };
}

test("general settings and quick actions confirm before authoritative commands, without storage writes", async (t) => {
  const env = await loadSurface(t);
  const cases = [["enabled-toggle", false, { enabled: false }], ["delay-input", "5", { delayMinutes: 5 }], ["settings-delay-input", "4", { settingsDelayMinutes: 4 }], ["moving-target-toggle", true, { movingTargetEnabled: true }], ["daily-lock-toggle", true, { dailyLockEnabled: true }], ["daily-lock-start", "21:00", { dailyLockStart: "21:00", dailyLockEnd: "07:00" }]];
  for (const [id, value, patch] of cases) {
    const count = env.requests.length;
    await env.dispatch(id, value);
    assert.equal(env.requests.length, count, "No settings command before confirmation for " + id);
    await env.confirm();
    assert.deepEqual(env.requests.at(-1).patch, patch);
    assert.equal(env.requests.at(-1).expectedRevision, env.snapshot.revision - 1);
  }
  await env.dispatch("cooldown-btn", undefined, "click");
  assert.equal(env.messages.some((item) => item.type === "START_COOLDOWN"), false);
  await env.confirm();
  assert.equal(env.messages.some((item) => item.type === "START_COOLDOWN"), true);
  await env.dispatch("cooldown-btn", undefined, "click"); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { cooldownUntil: null });
  assert.equal(env.storageSets.length, 0);
});

test("pending weakening keeps effective values, locks edits, and can cancel with the current pending ID", async (t) => {
  const env = await loadSurface(t, "options", {}, { pendingRequests: true });
  await env.dispatch("enabled-toggle", false);
  assert.equal(env.document.getElementById("enabled-toggle").checked, true);
  await env.confirm();
  assert.equal(env.document.getElementById("pending-config-section").hidden, false);
  assert.equal(env.document.activeElement.id, "pending-config-hover-target");
  assert.equal(env.document.getElementById("enabled-toggle").checked, true);
  assert.equal(env.document.getElementById("add-site-btn").disabled, true);
  assert.equal(env.document.getElementById("pending-config-cancel").disabled, false);
  await env.dispatch("pending-config-cancel", undefined, "click");
  assert.equal(env.messages.at(-1).pendingId, "pending-one");
  assert.equal(env.document.getElementById("pending-config-section").hidden, true);
  assert.equal(env.document.getElementById("enabled-toggle").disabled, false);
  assert.equal(env.snapshot.config.enabled, true);
  assert.equal(env.document.activeElement.id, "enabled-toggle");
});

test("cancelled confirmation preserves configuration and returns focus", async (t) => {
  const env = await loadSurface(t);
  await env.dispatch("delay-input", "5");
  await env.confirm("cancel");
  assert.equal(env.requests.length, 0);
  assert.equal(env.document.getElementById("delay-input").value, "2");
  assert.equal(env.document.activeElement.id, "delay-input");
});

test("a new confirmation waits for the previous native close event after Escape", async (t) => {
  const env = await loadSurface(t);
  const dialog = env.document.getElementById("confirm-dialog");
  await env.dispatch("enabled-toggle", false);
  assert.equal(dialog.open, true);

  // Native Escape clears open and restores focus before dispatching close.
  dialog.open = false;
  dialog.returnValue = "";
  await env.dispatch("enabled-toggle", false);
  assert.equal(dialog.open, false, "a queued close must not consume a newly opened confirmation");
  dialog.dispatchEvent(new env.window.Event("close"));
  await settle();
  assert.equal(env.requests.length, 0);

  await env.dispatch("enabled-toggle", false);
  assert.equal(dialog.open, true);
  await env.confirm();
  assert.equal(env.requests.length, 1);
  assert.equal(env.snapshot.config.enabled, false);
});

test("a stronger asynchronous change restores invoking focus after busy disabling blurs the control", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const env = await loadSurface(t, "options", {}, { beforeRequest: () => waiting });
  await env.dispatch("delay-input", "5"); await env.confirm();
  const input = env.document.getElementById("delay-input");
  assert.equal(input.disabled, true);
  env.document.body.tabIndex = -1; env.document.body.focus(); assert.equal(env.document.activeElement, env.document.body);
  release(); await settle();
  assert.equal(input.disabled, false);
  assert.equal(env.document.activeElement.id, input.id);
});

test("tracked-site controls retain wait, budget, reached-limit policy, cooldown duration, and removal", async (t) => {
  const env = await loadSurface(t, "options", { dailyLimits: { "example.com": 30 } });
  for (const [id, value, patch] of [
    ["site-wait-example.com", false, { siteWaitEnabled: { "example.com": false } }],
    ["site-limit-example.com", "20", { dailyLimits: { "example.com": 20 } }],
    ["site-policy-example.com", "cooldown", { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 60 } } }],
    ["site-cooldown-example.com", "45", { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 45 } } }],
    ["site-policy-example.com", "block", { dailyLimitPolicies: { "example.com": null } }],
    ["site-limit-example.com", "", { dailyLimits: { "example.com": null } }]
  ]) { await env.dispatch(id, value); await env.confirm(); assert.deepEqual(env.requests.at(-1).patch, patch); }
  env.document.querySelector(".site-remove").click(); await settle(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { sites: [] });
  assert.equal(env.document.querySelectorAll(".site-detail").length, 0);
});

test("popup and options can add a tracked site with no entry wait", async (t) => {
  const popup = await loadSurface(t, "popup");
  popup.document.getElementById("add-site-wait").checked = false;
  await popup.dispatch("add-current-btn", undefined, "click"); await popup.confirm();
  assert.deepEqual(popup.requests.at(-1).patch, { sites: ["current.example", "example.com"], siteWaitEnabled: { "current.example": false } });
  const options = await loadSurface(t);
  options.document.getElementById("site-input").value = "https://www.social.example/feed";
  options.document.getElementById("add-site-wait").checked = false;
  options.document.getElementById("add-site-form").dispatchEvent(new options.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); await options.confirm();
  assert.deepEqual(options.requests.at(-1).patch, { sites: ["example.com", "social.example"], siteWaitEnabled: { "social.example": false } });
});

test("all 19 content controls submit isolated guarded patches, with exact value differences", async (t) => {
  const env = await loadSurface(t);
  assert.equal(controls.catalog.length, 19);
  for (const item of controls.catalog) {
    const value = item.type === "boolean" ? true : item.options.find((option) => option.value !== item.default).value;
    await env.dispatch("rule-" + item.id, value);
    const text = env.document.getElementById("confirm-dialog-differences").textContent;
    assert.ok(text.includes(item.label)); assert.ok(text.includes("→"));
    await env.confirm();
    assert.deepEqual(env.requests.at(-1).patch, { contentControls: { [item.platform]: { [item.key]: value } } });
  }
  assert.deepEqual(env.snapshot.config.sites, ["example.com"]);
});

test("presets are additive atomic changes and a platform bulk disable includes all its rules", async (t) => {
  const prefs = controls.getDefaults(); prefs.instagram.hideComments = true;
  const env = await loadSurface(t, "options", { contentControls: prefs });
  await env.dispatch("short-form-preset", undefined, "click"); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, controls.getPreset("short-form"));
  assert.equal(env.snapshot.config.contentControls.instagram.hideComments, true);
  await env.dispatch("inbox-preset", undefined, "click"); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, controls.getPreset("instagram-inbox"));
  env.document.querySelector("#instagram .danger").click(); await settle(); await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { contentControls: { instagram: controls.getDefaults().instagram } });
  assert.equal(env.snapshot.config.contentControls.youtube.hideShorts, true);
  assert.deepEqual(env.snapshot.config.sites, ["example.com"]);
});

test("settings hold accepts zero while site waits remain at least one minute", async (t) => {
  const env = await loadSurface(t);
  const input = await env.dispatch("settings-delay-input", "0");
  assert.equal(input.min, "0");
  assert.equal(input.validationMessage, "");
  assert.equal(env.requests.length, 0);
  await env.confirm("cancel");
  assert.equal(env.snapshot.config.settingsDelayMinutes, 2);
  await env.dispatch("settings-delay-input", "0");
  await env.confirm();
  assert.deepEqual(env.requests.at(-1).patch, { settingsDelayMinutes: 0 });
  assert.equal(env.snapshot.config.settingsDelayMinutes, 0);
  assert.equal(env.snapshot.config.delayMinutes, 2);

  await env.dispatch("enabled-toggle", false);
  assert.match(env.document.getElementById("confirm-dialog-message").textContent, /0 minutes.*immediately after confirmation/);
  assert.equal(env.requests.length, 1);
  await env.confirm();
  assert.equal(env.snapshot.config.enabled, false);
});

test("validation rejects malformed numbers and equal schedules without a command", async (t) => {
  const env = await loadSurface(t);
  for (const [id, value] of [["delay-input", "0"], ["settings-delay-input", "-1"], ["settings-delay-input", "1.5"], ["site-limit-example.com", "1441"], ["daily-lock-start", "07:00"]]) {
    const input = await env.dispatch(id, value);
    assert.equal(env.document.getElementById("confirm-dialog").open, false);
    assert.ok(input.validationMessage);
  }
  assert.equal(env.requests.length, 0);
});

test("a rejected domain can be corrected and submitted through native form validation", async (t) => {
  const env = await loadSurface(t);
  const input = env.document.getElementById("site-input");
  const form = env.document.getElementById("add-site-form");
  input.value = "not a domain"; form.requestSubmit(); await settle();
  assert.ok(input.validationMessage);
  input.value = "social.example"; input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  assert.equal(input.validationMessage, "");
  form.requestSubmit(); await settle(); await env.confirm();
  assert.ok(env.snapshot.config.sites.includes("social.example"));
});

test("configuration refresh preserves keyboard focus on a site disclosure summary", async (t) => {
  const env = await loadSurface(t);
  const summary = env.document.querySelector("#site-list summary");
  summary.focus();
  await env.notify((snapshot) => { snapshot.revision++; snapshot.config.delayMinutes = 5; });
  const replacement = env.document.querySelector("#site-list summary");
  assert.notEqual(replacement, summary);
  assert.equal(env.document.activeElement, replacement);
});

test("usage and lease refresh preserve in-progress inputs, open disclosure, and keyboard focus", async (t) => {
  const env = await loadSurface(t);
  const details = env.document.querySelector("details"); details.open = true;
  const input = env.document.getElementById("site-limit-example.com"); input.focus(); input.value = "42";
  input.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  await env.notify((snapshot) => { snapshot.usage.sites["example.com"] = 300_000; });
  assert.equal(env.document.getElementById(input.id), input);
  assert.equal(input.value, "42"); assert.equal(env.document.activeElement, input); assert.equal(details.open, true);
  assert.ok(env.document.querySelector(".site-usage").textContent.includes("5 min"));
  await env.notify((snapshot) => { snapshot.revision++; snapshot.config.delayMinutes = 5; });
  assert.equal(env.document.getElementById(input.id).value, "42");
  assert.equal(env.document.activeElement.id, input.id);
});

test("future schema disables only content edits while General stays usable", async (t) => {
  const env = await loadSurface(t);
  await env.notify((snapshot) => { snapshot.contentControlsSupported = false; });
  assert.equal(env.document.getElementById("rule-youtube.hideShorts").disabled, true);
  assert.equal(env.document.getElementById("short-form-preset").disabled, true);
  assert.equal(env.document.getElementById("delay-input").disabled, false);
  assert.match(env.document.getElementById("instagram-status").textContent, /newer Airlock/);
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
  assert.equal(env.document.getElementById("current-access").textContent, "Restrictions off · usage tracking continues");
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
  assert.equal(env.document.getElementById("current-access").textContent, "Restrictions off · usage tracking continues");
  finishOldProbe({ ok: true, ready: true, coreMode: "cooldown" }); await settle();
  assert.equal(env.document.getElementById("current-access").textContent, "Restrictions off · usage tracking continues");
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
  await env.dispatch("delay-input", "5");
  await env.notify((snapshot) => { snapshot.config.delayMinutes = 3; snapshot.revision++; });
  await env.confirm();
  assert.equal(env.requests.at(-1).expectedRevision, 1);
  assert.equal(env.snapshot.config.delayMinutes, 3);
  assert.match(env.document.getElementById("ui-status").textContent, /another view/);
});

test("domain input rejects internal schemes, credentials, invalid labels, and whitespace", () => {
  for (const value of ["chrome://extensions", "https://user:secret@example.com", "-bad.example", "example..com", "example com", "localhost"]) assert.equal(ui.cleanDomain(value), null);
  assert.equal(ui.cleanDomain("https://www.Example.com/a"), "example.com");
});
