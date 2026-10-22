(function () {
  "use strict";
  const ui = AirlockSettingsUI;
  const client = AirlockSettingsClient.create(browser);
  const controller = ui.createController(client, { catalog: AirlockControls.catalog });
  const enabled = document.getElementById("enabled-toggle");
  const contentEnabled = document.getElementById("content-controls-toggle");
  const coreModes = { wait: "timer", cooldown: "cooldown", "daily-lock": "dailyLock", "daily-limit": "dailyLimit", allowed: "none", disabled: "none", untracked: "none", paused: "none" };
  const probeRetryDelays = [150, 400, 1000];
  let currentDomain = null;
  let currentTabId = null;
  let currentSite = null;
  let hostAccess = null;
  let pageState = null;
  let currentSnapshot = null;
  let probeKey = null;
  let probeGeneration = 0;
  let probeRetryTimer = null;
  let probeInFlight = false;
  let disposed = false;
  document.getElementById("master-help").textContent = ui.MASTER_HELP;
  document.getElementById("content-controls-help").textContent = ui.CONTENT_HELP;
  for (const [input, key, label] of [[enabled, "enabled", "Site restrictions"], [contentEnabled, "contentControlsEnabled", "Content blocking"]]) input.addEventListener("change", () => {
    const next = input.checked;
    if (!client.snapshot) return;
    input.checked = client.snapshot.config[key] !== false;
    controller.change({ [key]: next }, "Turn " + (next ? "on " : "off ") + label + "?");
  });
  document.getElementById("add-current-btn").addEventListener("click", async () => {
    if (!currentDomain || !client.snapshot) return;
    const patch = ui.appendTrackingPatch(client.snapshot.config, currentDomain, document.getElementById("add-site-wait").checked);
    await controller.change(patch, "Track " + currentDomain + "?", ["Content-control preferences stay independently configured."]);
  });
  document.getElementById("current-tracking-btn").addEventListener("click", async () => {
    if (!currentSite || !client.snapshot) return;
    const paused = client.snapshot.config.siteTrackingEnabled && client.snapshot.config.siteTrackingEnabled[currentSite] === false;
    await controller.change({ siteTrackingEnabled: { [currentSite]: paused ? null : false } },
      (paused ? "Resume" : "Pause") + " tracking for " + currentSite + "?",
      [paused
        ? "Focused usage and this site's waits, daily locks and limits resume with their existing settings and totals."
        : "Focused usage, site waits, daily locks and limits pause. Your settings and today's usage stay saved.",
      "A global manual cooldown and independent platform content rules still apply."]);
  });
  function render(snapshot) {
    const config = snapshot.config;
    enabled.checked = config.enabled !== false;
    contentEnabled.checked = config.contentControlsEnabled !== false;
    controller.renderCooldown(config);
    const cooldownActive = Number(config.cooldownUntil) > Date.now();
    document.getElementById("cooldown-btn").textContent = cooldownActive ? "End early…" : "Start 1 hour";
    document.getElementById("cooldown-status").textContent = cooldownActive
      ? "All tracked sites blocked until " + ui.formatClock(config.cooldownUntil) + ", even with Site restrictions off."
      : "Blocks all tracked sites for 1 hour.";
    const siteState = snapshot.currentSiteStatus;
    const matched = siteState && siteState.site || (currentDomain && config.sites.find((site) => currentDomain === site || currentDomain.endsWith("." + site)));
    const tracked = Boolean(matched);
    currentSite = matched || null;
    const platform = AirlockControls.getPlatform(currentDomain || "");
    document.getElementById("current-site-title").textContent = matched || currentDomain || "This page cannot be tracked";
    document.getElementById("current-site-title").title = matched || currentDomain || "This page cannot be tracked";
    const expectedMode = siteState && coreModes[siteState.reason];
    let access = ui.accessSummary(siteState, config);
    if (hostAccess === false) access = "Access needed · allow this site in extension permissions.";
    else if (!pageState || !pageState.ready) access = "Page status unavailable · reload this site.";
    else if (expectedMode && pageState.coreMode !== expectedMode) access = "Page status updating · " + access;
    document.getElementById("current-access").textContent = currentDomain ? access : "Open a website to inspect its Airlock status.";
    const usage = tracked ? (snapshot.usage && snapshot.usage.sites && snapshot.usage.sites[matched]) || 0 : null;
    const limit = matched && config.dailyLimits && config.dailyLimits[matched];
    document.getElementById("current-usage").textContent = tracked ? ui.formatDuration(usage) + (limit ? " · " + limit + " min limit" : "") : "Not tracked";
    const allowance = siteState && siteState.dailyLimitMode === "cooldown" && siteState.dailyLimitMinutes;
    document.getElementById("current-allowance-row").hidden = !allowance;
    document.getElementById("current-allowance").textContent = allowance ? ui.formatDuration(siteState.allowanceUsedMs) + " of " + siteState.dailyLimitMinutes + " min · resets after limit cooldown" : "";
    document.getElementById("current-rules").textContent = snapshot.contentControlsSupported === false ? "Requires a newer Airlock version" : ui.rulesSummary(config, platform, AirlockControls.catalog);
    const configuredRules = platform && AirlockControls.catalog.filter((item) => item.platform === platform && config.contentControls[platform][item.key] !== item.default).length;
    let rulesStatus = snapshot.contentControlsSupported === false ? "Content rules: update required"
      : !platform ? "Content rules: unsupported site"
      : !configuredRules ? "Content rules: Off · none enabled"
      : config.contentControlsEnabled === false ? "Content rules: paused by Content blocking"
      : "Content rules: " + configuredRules + " enabled";
    if (platform && configuredRules && config.contentControlsEnabled !== false && snapshot.contentControlsSupported !== false) {
      const runtime = pageState && pageState.runtimeStatus;
      if (hostAccess === false) rulesStatus = "Content rules: allow site access";
      else if (pageState && Object.prototype.hasOwnProperty.call(pageState, "runtimeStatus")) {
        if (!runtime || runtime.disposed) rulesStatus = "Content rules: reload to connect";
        else if (runtime.failure) rulesStatus = "Content rules: error · reload this site";
        else if (runtime.initialized === false) rulesStatus = "Content rules: loading settings · reload if stuck";
      }
    }
    document.getElementById("current-rules-status").textContent = rulesStatus;
    document.getElementById("site-settings-link").href = browser.runtime.getURL("options/options.html") + "#" + (platform || "sites");
    document.getElementById("site-settings-link").textContent = platform ? "Content rules ↗" : "Site settings ↗";
    document.getElementById("track-current-section").hidden = !currentDomain || tracked;
    document.getElementById("add-current-btn").textContent = "Track this site";
    document.getElementById("add-current-btn").setAttribute("aria-label", "Track " + (currentDomain || "this site"));
    const trackingButton = document.getElementById("current-tracking-btn");
    const trackingPaused = tracked && config.siteTrackingEnabled && config.siteTrackingEnabled[matched] === false;
    trackingButton.hidden = !tracked;
    trackingButton.textContent = trackingPaused ? "Resume tracking" : "Pause tracking";
    trackingButton.setAttribute("aria-label", (trackingPaused ? "Resume" : "Pause") + " tracking for " + matched);
    document.getElementById("pending-config-title").title = snapshot.pending && snapshot.pending.description || "Settings change awaiting hold";
    controller.lock();
  }
  function pageStateMatches(expectedMode) {
    return pageState && pageState.ready && (!expectedMode || pageState.coreMode === expectedMode);
  }
  function invalidateProbe() {
    probeGeneration++;
    window.clearTimeout(probeRetryTimer);
    probeRetryTimer = null;
    probeInFlight = false;
  }
  async function probePage(generation, expectedMode, attempt = 0) {
    probeRetryTimer = null;
    if (disposed || generation !== probeGeneration || document.visibilityState === "hidden") return;
    probeInFlight = true;
    let timeout;
    let state = null;
    try {
      state = await Promise.race([
        browser.tabs.sendMessage(currentTabId, { type: "AIRLOCK_GET_PAGE_STATE" }),
        new Promise((resolve) => { timeout = window.setTimeout(() => resolve(null), 800); })
      ]);
    } catch { /* Unreachable or reloading tabs retain the unavailable state. */ }
    finally { window.clearTimeout(timeout); }
    if (disposed || generation !== probeGeneration) return;
    probeInFlight = false;
    pageState = state && state.ok ? state : null;
    render(currentSnapshot);
    if (!pageStateMatches(expectedMode) && attempt < probeRetryDelays.length) {
      probeRetryTimer = window.setTimeout(() => probePage(generation, expectedMode, attempt + 1), probeRetryDelays[attempt]);
    }
  }
  function refreshPageState(snapshot, recover = false) {
    if (disposed || !currentDomain || currentTabId === null || hostAccess === false || !browser.tabs.sendMessage || document.visibilityState === "hidden") return;
    const siteState = snapshot.currentSiteStatus;
    const expectedMode = siteState && coreModes[siteState.reason];
    const key = JSON.stringify([snapshot.revision, siteState && siteState.domain, siteState && siteState.site, siteState && siteState.reason]);
    if (key === probeKey && (!recover || pageStateMatches(expectedMode) || probeInFlight || probeRetryTimer !== null)) return;
    invalidateProbe();
    probeKey = key;
    probePage(probeGeneration, expectedMode);
  }
  client.subscribe((snapshot) => {
    if (disposed) return;
    currentSnapshot = snapshot;
    render(snapshot);
    refreshPageState(snapshot);
  });
  async function start() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0] || null;
      if (currentTab && currentTab.url) currentDomain = ui.cleanDomain(currentTab.url);
      if (currentTab && Number.isInteger(currentTab.id)) { currentTabId = currentTab.id; client.setContext({ tabId: currentTab.id }); }
      if (currentDomain && currentTab) {
        const url = new URL(currentTab.url);
        const accessCheck = browser.permissions && browser.permissions.contains
          ? browser.permissions.contains({ origins: [url.protocol + "//" + url.hostname + "/*"] }).then((granted) => { hostAccess = granted; }).catch(() => {})
          : Promise.resolve();
        await accessCheck;
      }
      if (disposed) return;
      const result = await client.refresh();
      if (disposed) return;
      controller.message(result.ok === false ? ui.errorMessage(result.reason) : "", result.ok === false);
    } catch (error) { if (!disposed) controller.message(error.message || "Settings could not be loaded. Reopen Airlock to try again.", true); }
  }
  window.addEventListener("focus", () => { if (currentSnapshot) refreshPageState(currentSnapshot, true); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { invalidateProbe(); probeKey = null; }
    else if (currentSnapshot) refreshPageState(currentSnapshot, true);
  });
  window.addEventListener("pagehide", () => { disposed = true; invalidateProbe(); controller.dispose(); });
  start();
})();
