(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AirlockSettingsUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MASTER_HELP = "Turning Site restrictions off pauses site waits, scheduled locks, and daily-limit enforcement. Usage tracking continues. Content blocking stays independent, and an active manual cooldown remains in effect.";
  const CONTENT_HELP = "Turning Content blocking off pauses saved Shorts, Reels, and other content rules. Turn it back on to restore them. Site waits, schedules, limits, usage tracking, and manual cooldown stay independent.";
  const labels = {
    enabled: "Site restrictions", contentControlsEnabled: "Content blocking", delayMinutes: "Site wait minutes", settingsDelayMinutes: "Settings hold minutes",
    movingTargetEnabled: "Moving target", dailyLockEnabled: "Daily lock", dailyLockStart: "Daily lock starts",
    dailyLockEnd: "Daily lock ends", cooldownUntil: "Manual cooldown", sites: "Tracked sites",
    siteWaitEnabled: "Site wait", siteTrackingEnabled: "Site tracking", dailyLimits: "Daily limit", dailyLimitPolicies: "Reached-limit action"
  };

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (seconds < 60) return seconds ? seconds + " sec" : "0 min";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " min";
    return Math.floor(minutes / 60) + "h" + (minutes % 60 ? " " + minutes % 60 + "m" : "");
  }
  function formatCountdown(ms) {
    const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }
  function formatClock(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function cleanDomain(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    try {
      const url = new URL(raw.includes("://") ? raw : "https://" + raw);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      const domain = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
      if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return null;
      return domain;
    } catch { return null; }
  }
  function valueText(value, item) {
    if (item && item.options) return (item.options.find((option) => option.value === value) || {}).label || String(value);
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (value == null) return "None";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
    if (typeof value === "object" && value.mode) return value.mode === "cooldown" ? "Break for " + value.cooldownMinutes + " minutes, then renew allowance" : "Block until midnight (saved break: " + value.cooldownMinutes + " minutes)";
    return String(value);
  }
  function describePatch(config, patch, catalog) {
    const differences = [];
    for (const [key, next] of Object.entries(patch)) {
      if (key === "contentControls") {
        for (const [platform, values] of Object.entries(next)) {
          for (const [rule, value] of Object.entries(values)) {
            const item = catalog.find((entry) => entry.platform === platform && entry.key === rule);
            const before = config.contentControls[platform][rule];
            if (before !== value) differences.push((item ? item.label : rule) + ": " + valueText(before, item) + " → " + valueText(value, item));
          }
        }
      } else if (["siteWaitEnabled", "siteTrackingEnabled", "dailyLimits", "dailyLimitPolicies"].includes(key)) {
        for (const [site, value] of Object.entries(next)) {
          const fallbackPolicy = { mode: "block", cooldownMinutes: 60 };
          const booleanMap = key === "siteWaitEnabled" || key === "siteTrackingEnabled";
          const before = booleanMap ? (config[key] || {})[site] !== false : (config[key] || {})[site] || (key === "dailyLimitPolicies" ? fallbackPolicy : null);
          const after = booleanMap ? value !== false : value || (key === "dailyLimitPolicies" ? fallbackPolicy : null);
          if (JSON.stringify(before) !== JSON.stringify(after)) differences.push(labels[key] + " for " + site + ": " + valueText(before) + " → " + valueText(after));
        }
      } else if (JSON.stringify(config[key]) !== JSON.stringify(next)) {
        differences.push((labels[key] || key) + ": " + (key === "cooldownUntil" ? "Active → End early" : valueText(config[key]) + " → " + valueText(next)));
      }
    }
    return differences;
  }
  function errorMessage(reason) {
    const messages = {
      stale: "Settings changed in another view. Review the current values and try again.",
      "stale-revision": "Settings changed in another view. Review the current values and try again.",
      conflict: "Settings changed in another view. Review the current values and try again.",
      "pending-change": "Finish or cancel the pending change before editing settings.",
      "lease-busy": "The hold is progressing in another view. Release it there to continue here.",
      "lease-in-use": "The hold is progressing in another view. Release it there to continue here.",
      "lease-held": "The hold is progressing in another view. Release it there to continue here.",
      "inactive-view": "The hold is paused because this view is unfocused.",
      invalid: "This change is invalid. Check the fields and try again.",
      "invalid-patch": "This change is invalid. Check the fields and try again.",
      "unsupported-schema": "These content settings require a newer Airlock version. Update Airlock to edit them."
    };
    messages["unsupported-controls-version"] = messages["unsupported-schema"];
    return messages[reason] || "Airlock could not apply the change (" + (reason || "no response") + "). Refresh and try again.";
  }

  function createHold(target, client, options = {}) {
    const doc = options.document || target.ownerDocument;
    const win = options.window || doc.defaultView;
    const clock = options.clock || {
      now: () => Date.now(),
      setTimeout: (callback, delay) => win.setTimeout(callback, delay),
      clearTimeout: (id) => win.clearTimeout(id)
    };
    const onState = options.onState || (() => {});
    const onError = options.onError || (() => {});
    let pendingId = null;
    let timer = null;
    let generation = 0;
    let lastAt = null;
    let inFlight = false;
    const inputs = new Set();
    function visible() { return doc.visibilityState !== "hidden" && (!doc.hasFocus || doc.hasFocus()); }
    function wantsProgress() { return Boolean(pendingId && inputs.size && visible()); }
    function clearTimer() { if (timer !== null) clock.clearTimeout(timer); timer = null; }
    function pause(clearInputs = true) {
      if (clearInputs) inputs.clear();
      clearTimer();
      generation++;
      lastAt = null;
      target.classList.remove("engaged");
      onState(false);
      if (pendingId) client.release(pendingId).catch(onError);
    }
    async function pump() {
      timer = null;
      if (!wantsProgress() || inFlight) return;
      const id = pendingId;
      const token = generation;
      const now = clock.now();
      const elapsed = lastAt === null ? 0 : Math.max(0, Math.min(1000, now - lastAt));
      lastAt = now;
      inFlight = true;
      try {
        const result = await client.advance(id, elapsed);
        if (generation !== token || pendingId !== id || !wantsProgress()) return;
        if (result.ok === false) {
          lastAt = null;
          target.classList.remove("engaged");
          onState(false, errorMessage(result.reason));
        } else {
          target.classList.add("engaged");
          onState(true);
        }
      } catch (error) {
        lastAt = null;
        onError(error);
        pause();
      } finally {
        inFlight = false;
        if (wantsProgress()) timer = clock.setTimeout(pump, 250);
      }
    }
    function start(input) {
      if (!pendingId || !visible()) return;
      inputs.add(input);
      if (timer === null && !inFlight) pump();
    }
    function stop(input) { inputs.delete(input); if (!inputs.size) pause(false); }
    target.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") start("hover"); });
    target.addEventListener("pointerleave", () => stop("hover"));
    target.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" || event.pointerType === "pen") {
        event.preventDefault();
        if (target.setPointerCapture) { try { target.setPointerCapture(event.pointerId); } catch {} }
        start("press");
      }
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => target.addEventListener(type, () => stop("press")));
    target.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) start("key-" + event.key); }
    });
    target.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); stop("key-" + event.key); }
    });
    target.addEventListener("blur", () => { inputs.delete("key- "); inputs.delete("key-Enter"); if (!inputs.size) pause(false); });
    doc.addEventListener("visibilitychange", () => { if (!visible()) pause(); });
    win.addEventListener("blur", () => pause());
    win.addEventListener("pagehide", () => pause());
    return {
      update(pending) {
        const nextId = pending && pending.id;
        if (nextId === pendingId) return;
        pause();
        pendingId = nextId || null;
      },
      pause,
      dispose() { pause(); pendingId = null; }
    };
  }

  function createController(client, options = {}) {
    const doc = options.document || document;
    const win = options.window || window;
    const catalog = options.catalog || [];
    const status = doc.getElementById("ui-status");
    const dialog = doc.getElementById("confirm-dialog");
    const pendingSection = doc.getElementById("pending-config-section");
    const pendingTarget = doc.getElementById("pending-config-hover-target");
    const pendingStatus = doc.getElementById("pending-config-engagement");
    let busy = false;
    let confirming = false;
    let previousFocus = null;
    let pendingInvoker = null;
    let previousPendingId = null;
    function returnFocus(invoker) {
      if (!invoker) return;
      const target = invoker.id ? doc.getElementById(invoker.id) : invoker.isConnected ? invoker : doc.getElementById("site-list");
      if (target && !target.disabled) target.focus();
    }
    function message(text, error = false) {
      status.textContent = text;
      status.classList.toggle("error", error);
    }
    function lock() {
      const blocked = busy || !client.snapshot || Boolean(client.snapshot.pending);
      doc.querySelectorAll("[data-setting]").forEach((element) => {
        element.disabled = blocked || element.dataset.dependentDisabled === "true";
      });
    }
    const hold = createHold(pendingTarget, client, {
      document: doc, window: win,
      onState(active, detail) { pendingStatus.textContent = detail || (active ? "Hold engaged" : "Paused · engage the target to count down"); },
      onError(error) { message(error.message || "The hold could not continue. Try again.", true); }
    });
    function render(snapshot) {
      const pending = snapshot.pending;
      const finished = previousPendingId && !pending;
      pendingSection.hidden = !pending;
      if (pending) {
        doc.getElementById("pending-config-title").textContent = pending.description || "Settings change awaiting hold";
        doc.getElementById("pending-config-timer").textContent = formatCountdown(pending.remainingMs);
        const list = doc.getElementById("pending-config-differences");
        list.replaceChildren();
        if (pending.patch) describePatch(snapshot.config, pending.patch, catalog).forEach((text) => {
          const item = doc.createElement("li"); item.textContent = text; list.appendChild(item);
        });
      }
      hold.update(pending);
      lock();
      if (finished) {
        message(snapshot.applied === true ? "Settings updated." : "No settings change is pending.");
        returnFocus(pendingInvoker);
      }
      if (!pending && snapshot.applied === true) message("Settings updated.");
      previousPendingId = pending && pending.id;
    }
    client.subscribe(render);
    doc.getElementById("pending-config-cancel").addEventListener("click", async () => {
      const pending = client.snapshot && client.snapshot.pending;
      if (!pending) return;
      hold.pause();
      try {
        const result = await client.cancel(pending.id);
        message(result.ok === false ? errorMessage(result.reason) : "Change cancelled. Original settings remain in effect.", result.ok === false);
        if (result.ok !== false) returnFocus(pendingInvoker);
      } catch (error) { message(error.message, true); }
    });
    function confirm(title, differences, confirmLabel = "Confirm change") {
      // Native dialog close events are queued after open is cleared and focus is
      // restored. Keep ownership until that event consumes this confirmation.
      if (confirming || dialog.open) return Promise.resolve(false);
      confirming = true;
      previousFocus = doc.activeElement;
      doc.getElementById("confirm-dialog-title").textContent = title;
      doc.getElementById("confirm-dialog-submit").textContent = confirmLabel;
      doc.getElementById("confirm-dialog-message").textContent = client.snapshot && client.snapshot.config.settingsDelayMinutes === 0
        ? "Review these changes. Your Settings hold is 0 minutes, so changes apply immediately after confirmation."
        : "Review these changes. Any weakening requires the configured Settings hold before it takes effect.";
      const list = doc.getElementById("confirm-dialog-differences");
      list.replaceChildren();
      differences.forEach((text) => { const item = doc.createElement("li"); item.textContent = text; list.appendChild(item); });
      return new Promise((resolve) => {
        dialog.addEventListener("close", () => {
          confirming = false;
          if (previousFocus && previousFocus.isConnected && !previousFocus.disabled) previousFocus.focus();
          resolve(dialog.returnValue === "confirm");
        }, { once: true });
        dialog.returnValue = "";
        dialog.showModal();
        doc.getElementById("confirm-dialog-cancel").focus();
      });
    }
    async function change(patch, title = "Confirm settings change", extra = [], changeOptions = {}) {
      const snapshot = client.snapshot;
      if (busy || !snapshot || snapshot.pending) return false;
      const differences = describePatch(changeOptions.baseConfig || snapshot.config, patch, catalog);
      if (!differences.length) { message("These settings already match the requested change."); return false; }
      if (!(await confirm(title, differences.concat(extra), changeOptions.confirmLabel))) return false;
      const invoker = previousFocus;
      busy = true; lock();
      try {
        const result = await client.request(patch, changeOptions.expectedRevision === undefined ? snapshot.revision : changeOptions.expectedRevision);
        if (result.ok === false) { message(errorMessage(result.reason), true); return false; }
        message(result.pending ? "Change pending. Current settings stay active until the hold finishes." : "Settings updated.");
        if (result.pending) { pendingInvoker = previousFocus; pendingTarget.focus(); }
        return true;
      } catch (error) { message(error.message, true); return false; }
      finally {
        busy = false; lock();
        if (!client.snapshot.pending && (doc.activeElement === doc.body || doc.activeElement === invoker || !doc.activeElement)) returnFocus(invoker);
      }
    }
    async function cooldown() {
      const config = client.snapshot && client.snapshot.config;
      if (!config || busy || client.snapshot.pending) return;
      if (Number(config.cooldownUntil) > Date.now()) {
        return change({ cooldownUntil: null }, "End cooldown early?", ["Tracked sites become available under their other configured restrictions after the settings hold."]);
      }
      if (!(await confirm("Start a 1-hour cooldown?", ["All tracked sites will be blocked for one hour, including while Site restrictions is off."], "Start cooldown"))) return;
      const invoker = previousFocus;
      busy = true; lock();
      try {
        const result = await client.startCooldown();
        message(result.ok === false ? errorMessage(result.reason) : "1-hour cooldown started.", result.ok === false);
      } catch (error) { message(error.message, true); }
      finally {
        busy = false; lock();
        if (!client.snapshot.pending && (doc.activeElement === doc.body || doc.activeElement === invoker || !doc.activeElement)) returnFocus(invoker);
      }
    }
    function renderCooldown(config) {
      const active = Number(config.cooldownUntil) > Date.now();
      const copy = doc.getElementById("cooldown-status");
      const button = doc.getElementById("cooldown-btn");
      if (copy) copy.textContent = active ? "Tracked sites blocked until " + formatClock(config.cooldownUntil) + ". Applies with Site restrictions off." : "Block all tracked sites for one hour.";
      if (button) button.textContent = active ? "End early…" : "Start 1-hour cooldown";
    }
    const cooldownButton = doc.getElementById("cooldown-btn");
    if (cooldownButton) cooldownButton.addEventListener("click", cooldown);
    return { change, confirm, message, lock, renderCooldown, dispose() { hold.dispose(); client.dispose(); } };
  }

  function appendTrackingPatch(config, domain, waitEnabled) {
    return { sites: [...new Set(config.sites.concat(domain))].sort(), siteWaitEnabled: { [domain]: waitEnabled ? null : false } };
  }
  function rulesSummary(config, platform, catalog) {
    if (!platform) return "This site has no platform content controls.";
    const items = catalog.filter((item) => item.platform === platform && config.contentControls[platform][item.key] !== item.default);
    if (!items.length) return "None configured";
    return (config.contentControlsEnabled === false ? "Paused by Content blocking · " : "Configured · ") + items.map((item) => item.label).join(", ");
  }
  function accessSummary(state, config) {
    if (!state) return "Current access status is unavailable. Open Site settings to review the configured rules.";
    if (state.reason === "untracked") return "Not tracked · no Airlock site gate";
    if (state.reason === "cooldown") return "Manual cooldown until " + formatClock(state.unlockAt);
    if (state.reason === "paused") return "Tracking paused · site restrictions paused";
    if (state.reason === "disabled") return "Site restrictions off · usage tracking continues";
    if (state.reason === "daily-lock") return "Daily lock until " + formatClock(state.unlockAt);
    if (state.reason === "daily-limit") {
      return state.dailyLimitMode === "cooldown" ? "Daily-limit cooldown · allowance resets at " + formatClock(state.resetAt) : "Daily limit reached · resets at " + formatClock(state.resetAt);
    }
    if (state.reason === "wait") return "Site wait " + formatCountdown(state.remainingMs) + (state.paused ? " · paused while page is unfocused" : " remaining");
    return config.siteWaitEnabled && config.siteWaitEnabled[state.site] === false ? "Available · usage tracked without a site wait" : "Available";
  }
  return { MASTER_HELP, CONTENT_HELP, formatDuration, formatCountdown, formatClock, cleanDomain, describePatch, errorMessage, createHold, createController, appendTrackingPatch, rulesSummary, accessSummary };
});
