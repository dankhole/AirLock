(function () {
  "use strict";
  const ui = AirlockSettingsUI;
  const controls = AirlockControls;
  const client = AirlockSettingsClient.create(browser);
  const controller = ui.createController(client, { catalog: controls.catalog });
  const dirty = new Set();
  let renderedRevision = null;
  let baseline = null;
  let draft = null;
  let submittedPendingId = null;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const scalarKeys = ["delayMinutes", "settingsDelayMinutes", "movingTargetEnabled", "dailyLockEnabled", "dailyLockStart", "dailyLockEnd", "sites"];
  const mapKeys = ["siteWaitEnabled", "siteTrackingEnabled", "dailyLimits", "dailyLimitPolicies"];
  const fallbackPolicy = { mode: "block", cooldownMinutes: 60 };
  function beginDraft() {
    if (!client.snapshot || client.snapshot.pending) return false;
    if (!draft) { baseline = { config: clone(client.snapshot.config), revision: client.snapshot.revision }; draft = clone(baseline.config); }
    return true;
  }
  function effectiveMapValue(config, key, site) {
    if (key === "siteWaitEnabled" || key === "siteTrackingEnabled") return (config[key] || {})[site] !== false ? null : false;
    return (config[key] || {})[site] || (key === "dailyLimitPolicies" ? fallbackPolicy : null);
  }
  function draftPatch() {
    const patch = {};
    if (!draft) return patch;
    scalarKeys.forEach((key) => { if (JSON.stringify(baseline.config[key]) !== JSON.stringify(draft[key])) patch[key] = clone(draft[key]); });
    mapKeys.forEach((key) => {
      const values = {};
      draft.sites.forEach((site) => {
        const before = effectiveMapValue(baseline.config, key, site);
        const after = effectiveMapValue(draft, key, site);
        if (JSON.stringify(before) !== JSON.stringify(after)) values[site] = clone(after);
      });
      if (Object.keys(values).length) patch[key] = values;
    });
    controls.catalog.forEach(({ platform, key }) => {
      const value = draft.contentControls[platform][key];
      if (value !== baseline.config.contentControls[platform][key]) {
        patch.contentControls ||= {};
        patch.contentControls[platform] ||= {};
        patch.contentControls[platform][key] = value;
      }
    });
    return patch;
  }
  function mergeDraft(config, patch) {
    Object.entries(patch).forEach(([key, value]) => {
      if (key === "contentControls") config.contentControls = controls.mergePatch(config.contentControls, value);
      else if (mapKeys.includes(key)) {
        config[key] ||= {};
        Object.entries(value).forEach(([site, entry]) => { if (entry === null) delete config[key][site]; else config[key][site] = clone(entry); });
      } else config[key] = clone(value);
    });
    return config;
  }
  function stage(patch, rebuildSites = false) {
    if (!beginDraft()) return;
    mergeDraft(draft, patch);
    const ids = { delayMinutes: "delay-input", settingsDelayMinutes: "settings-delay-input", movingTargetEnabled: "moving-target-toggle", dailyLockEnabled: "daily-lock-toggle", dailyLockStart: "daily-lock-start", dailyLockEnd: "daily-lock-end" };
    Object.keys(patch).forEach((key) => { if (ids[key]) dirty.delete(ids[key]); });
    if (patch.contentControls) controls.catalog.forEach(({ platform, key }) => { if (Object.hasOwn(patch.contentControls[platform] || {}, key)) dirty.delete("rule-" + platform + "." + key); });
    if (rebuildSites) renderSites({ config: draft });
    render(client.snapshot);
  }
  function clearDraft() {
    baseline = null; draft = null; submittedPendingId = null; dirty.clear(); renderedRevision = null;
    document.querySelectorAll("input[data-setting], select[data-setting]").forEach((input) => input.setCustomValidity(""));
  }
  function focusDraft() { document.getElementById("settings-draft-title").focus(); }
  function revealInvalid(input) {
    const panel = input.closest(".settings-panel");
    if (panel) { history.replaceState(null, "", "#" + panel.id); navigate(); }
    const details = input.closest("details"); if (details) details.open = true;
    input.focus(); input.reportValidity();
  }
  function renderDraft(snapshot) {
    const changes = ui.describePatch(baseline ? baseline.config : snapshot.config, draftPatch(), controls.catalog);
    const hasDraft = Boolean(draft);
    const stale = hasDraft && baseline.revision !== snapshot.revision;
    const pending = Boolean(snapshot.pending);
    document.getElementById("settings-draft").classList.toggle("has-draft", hasDraft);
    document.getElementById("settings-draft-status").textContent = submittedPendingId && pending
      ? "Submitted changes: fields show your requested settings. Current settings stay active until the hold finishes. Cancel keeps this draft for retry."
      : stale
        ? "Settings changed in another view or action. Your draft is preserved. Review latest settings to keep it, or discard it. Nothing will be retried automatically."
        : hasDraft
          ? "Unsaved changes: fields show your draft. Current settings stay active. Save changes to review and apply everything together."
          : "Changes below are saved together. Site restrictions, Content blocking, and manual cooldown have their own confirmation.";
    const list = document.getElementById("settings-draft-differences"); list.replaceChildren();
    changes.forEach((text) => list.appendChild(element("li", "", text)));
    list.hidden = !changes.length;
    document.getElementById("save-settings").dataset.dependentDisabled = !hasDraft || stale ? "true" : "false";
    document.getElementById("discard-settings").dataset.dependentDisabled = !hasDraft ? "true" : "false";
    const rebase = document.getElementById("rebase-settings"); rebase.hidden = !stale; rebase.dataset.dependentDisabled = !stale ? "true" : "false";
  }
  const groupNames = {
    youtube: [["Shorts", ["hideShorts", "hideNavigation", "shortsRoute"]]],
    instagram: [
      ["Reels and discovery", ["blockReels", "blockExplore", "hideThreads"]],
      ["Stories and Home", ["stories", "homeDestination", "hideHomeFeed"]],
      ["Attention cues", ["unreadBadges", "hideMetrics", "hideNotes"]],
      ["Media and discussion", ["hideComments", "hideVideos", "hideImages"]]
    ],
    facebook: [["Reels", ["hideReels", "reelsRoute"]], ["Other distractions", ["hideStories", "hideSuggested"]]]
  };
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function settingField(input, labelText, helpText) {
    const wrapper = element("div", "field");
    const label = element("label", "", labelText);
    label.htmlFor = input.id;
    input.dataset.setting = "";
    wrapper.append(label, input);
    if (helpText) {
      const help = element("p", "help", helpText); help.id = input.id + "-help";
      input.setAttribute("aria-describedby", help.id); wrapper.appendChild(help);
    }
    return wrapper;
  }
  function validNumber(input, min, max, optional = false) {
    const raw = input.value.trim();
    const value = Number(raw);
    if (optional && raw === "") { input.setCustomValidity(""); return null; }
    if (raw === "" || !Number.isInteger(value) || value < min || value > max) {
      const message = "Choose a whole number from " + min + " to " + max + " minutes.";
      input.setCustomValidity(message); revealInvalid(input); controller.message(message, true); return undefined;
    }
    input.setCustomValidity(""); return value;
  }
  function bindBoolean(id, key) {
    const input = document.getElementById(id);
    input.addEventListener("change", () => {
      if (!client.snapshot) return;
      const next = input.checked;
      if (key === "enabled" || key === "contentControlsEnabled") {
        input.checked = client.snapshot.config[key] !== false;
        const label = key === "enabled" ? "Site restrictions" : "Content blocking";
        controller.change({ [key]: next }, "Turn " + (next ? "on " : "off ") + label + "?");
      } else stage({ [key]: next });
    });
  }
  bindBoolean("enabled-toggle", "enabled");
  bindBoolean("content-controls-toggle", "contentControlsEnabled");
  bindBoolean("moving-target-toggle", "movingTargetEnabled");
  bindBoolean("daily-lock-toggle", "dailyLockEnabled");
  for (const [id, key] of [["delay-input", "delayMinutes"], ["settings-delay-input", "settingsDelayMinutes"]]) {
    const input = document.getElementById(id);
    input.addEventListener("change", () => {
      if (!beginDraft()) return;
      dirty.add(id);
      const next = validNumber(input, key === "settingsDelayMinutes" ? 0 : 1, 600);
      if (next !== undefined) stage({ [key]: next });
      else render(client.snapshot);
    });
  }
  function readSchedule() {
    const start = document.getElementById("daily-lock-start");
    const end = document.getElementById("daily-lock-end");
    start.setCustomValidity(""); end.setCustomValidity("");
    if (AirlockDailyLock.parseTimeOfDay(start.value) === null || AirlockDailyLock.parseTimeOfDay(end.value) === null || start.value === end.value) {
      const message = "Choose valid, different start and end times.";
      start.setCustomValidity(message); revealInvalid(start); controller.message(message, true); return null;
    }
    return { dailyLockStart: start.value, dailyLockEnd: end.value };
  }
  for (const id of ["daily-lock-start", "daily-lock-end"]) {
    document.getElementById(id).addEventListener("change", () => {
      if (!beginDraft()) return;
      dirty.add(id);
      const patch = readSchedule();
      if (patch) stage(patch); else render(client.snapshot);
    });
  }
  document.getElementById("master-help").textContent = ui.MASTER_HELP;
  document.getElementById("content-controls-help").textContent = ui.CONTENT_HELP;
  document.getElementById("short-form-preset").addEventListener("click", () => stage(controls.getPreset("short-form")));
  document.getElementById("inbox-preset").addEventListener("click", () => stage(controls.getPreset("instagram-inbox")));
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!input.matches("input, select")) return;
    input.setCustomValidity("");
    if (input.matches("[data-setting]") && !["enabled-toggle", "content-controls-toggle", "site-input", "add-site-wait"].includes(input.id) && beginDraft()) {
      dirty.add(input.id); renderDraft(client.snapshot); controller.lock();
    }
  });
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("input[data-setting], select[data-setting]") && !["enabled-toggle", "content-controls-toggle", "site-input", "add-site-wait"].includes(input.id) && beginDraft()) {
      dirty.add(input.id); renderDraft(client.snapshot); controller.lock();
    }
  }, true);
  document.getElementById("add-site-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!client.snapshot || client.snapshot.pending) return;
    const input = document.getElementById("site-input");
    const domain = ui.cleanDomain(input.value);
    if (!domain) { input.setCustomValidity("Enter a valid website domain, such as example.com."); input.reportValidity(); controller.message("Enter a valid website domain, such as example.com.", true); return; }
    input.setCustomValidity("");
    const config = draft || client.snapshot.config;
    if (config.sites.includes(domain)) { controller.message(domain + " is already in the settings shown."); return; }
    stage(ui.appendTrackingPatch(config, domain, document.getElementById("add-site-wait").checked), true);
    input.value = "";
    controller.message(domain + " added to your draft. Save changes to start tracking.");
  });
  function collectDraft() {
    if (!beginDraft()) return false;
    const patch = {};
    for (const [id, key, min] of [["delay-input", "delayMinutes", 1], ["settings-delay-input", "settingsDelayMinutes", 0]]) {
      const input = document.getElementById(id);
      const value = validNumber(input, min, 600);
      if (value === undefined) return false;
      patch[key] = value;
    }
    const schedule = readSchedule(); if (!schedule) return false;
    Object.assign(patch, schedule, { movingTargetEnabled: document.getElementById("moving-target-toggle").checked, dailyLockEnabled: document.getElementById("daily-lock-toggle").checked });
    patch.dailyLimits = {}; patch.dailyLimitPolicies = {}; patch.siteWaitEnabled = {};
    for (const site of draft.sites) {
      const suffix = encodeURIComponent(site);
      const limit = validNumber(document.getElementById("site-limit-" + suffix), 1, 1440, true);
      if (limit === undefined) return false;
      const minutes = validNumber(document.getElementById("site-cooldown-" + suffix), 1, 1440);
      if (minutes === undefined) return false;
      patch.dailyLimits[site] = limit;
      patch.dailyLimitPolicies[site] = { mode: document.getElementById("site-policy-" + suffix).value, cooldownMinutes: minutes };
      patch.siteWaitEnabled[site] = document.getElementById("site-wait-" + suffix).checked ? null : false;
    }
    if (client.snapshot.contentControlsSupported !== false) {
      patch.contentControls = {};
      controls.catalog.forEach((item) => {
        const input = document.getElementById("rule-" + item.id);
        patch.contentControls[item.platform] ||= {};
        patch.contentControls[item.platform][item.key] = item.type === "boolean" ? input.checked : input.value;
      });
    }
    mergeDraft(draft, patch); return true;
  }
  document.getElementById("save-settings").addEventListener("click", async () => {
    if (!draft || client.snapshot.pending || baseline.revision !== client.snapshot.revision || !collectDraft()) return;
    const patch = draftPatch();
    if (!Object.keys(patch).length) { clearDraft(); render(client.snapshot); controller.message("No settings changes to save."); focusDraft(); return; }
    const saved = await controller.change(patch, "Save all settings changes?", [], { expectedRevision: baseline.revision, baseConfig: baseline.config, confirmLabel: "Save changes" });
    if (saved) {
      if (client.snapshot.pending) submittedPendingId = client.snapshot.pending.id;
      else { clearDraft(); focusDraft(); }
    }
    render(client.snapshot);
  });
  document.getElementById("discard-settings").addEventListener("click", () => {
    if (!draft || client.snapshot.pending) return;
    clearDraft(); render(client.snapshot); controller.message("Draft discarded. Current settings are shown."); focusDraft();
  });
  document.getElementById("rebase-settings").addEventListener("click", async () => {
    if (!draft || client.snapshot.pending || !collectDraft()) return;
    const patch = draftPatch();
    const snapshot = client.snapshot;
    const differences = ui.describePatch(snapshot.config, patch, controls.catalog);
    if (!(await controller.confirm("Keep draft on latest settings?", differences.concat("Review the differences from the latest active settings. Keeping this draft does not save it; use Save changes afterward."), "Keep draft"))) return;
    if (client.snapshot.revision !== snapshot.revision || client.snapshot.pending) { controller.message("Settings changed again. Review latest settings before saving your draft.", true); return; }
    baseline = { config: clone(snapshot.config), revision: snapshot.revision };
    draft = mergeDraft(clone(snapshot.config), patch); dirty.clear(); renderedRevision = null;
    render(snapshot); controller.message("Draft reviewed against the latest settings. Save changes when ready."); document.getElementById("save-settings").focus();
  });

  function renderSites(snapshot) {
    const list = document.getElementById("site-list");
    const config = snapshot.config;
    const openSites = new Set([...list.querySelectorAll("details[open]")].map((node) => node.dataset.site));
    const focusedId = document.activeElement && document.activeElement.id;
    const drafts = new Map();
    list.querySelectorAll("input, select").forEach((node) => { if (dirty.has(node.id)) drafts.set(node.id, node.type === "checkbox" ? node.checked : node.value); });
    list.replaceChildren();
    if (!config.sites.length) list.appendChild(element("p", "help empty-sites", "No tracked sites yet. Add a site below to record focused usage and configure access restrictions."));
    config.sites.forEach((site) => {
      const suffix = encodeURIComponent(site);
      const paused = (config.siteTrackingEnabled || {})[site] === false;
      const row = element("div", "site-row");
      const details = element("details", "site-detail"); details.dataset.site = site; details.open = openSites.has(site);
      const summary = element("summary");
      summary.id = "site-summary-" + suffix;
      summary.append(element("span", "site-domain", site));
      const usage = element("span", "site-usage"); usage.dataset.site = site; summary.appendChild(usage);
      details.appendChild(summary);
      const pause = element("button", "site-tracking-toggle", paused ? "Resume" : "Pause");
      pause.id = "site-tracking-" + suffix; pause.type = "button"; pause.dataset.setting = "";
      pause.setAttribute("aria-label", (paused ? "Resume" : "Pause") + " tracking for " + site);
      pause.addEventListener("click", () => stage({ siteTrackingEnabled: { [site]: paused ? null : false } }, true));
      const fields = element("div", "site-fields");
      const trackingHelp = element("p", "help site-tracking-status", paused ? "Paused for downtime. Settings below stay editable; resume to apply them." : "Tracking active. Pause for downtime without removing this site’s settings.");
      fields.appendChild(trackingHelp);
      const wait = element("input", "site-wait-input"); wait.id = "site-wait-" + suffix; wait.type = "checkbox"; wait.dataset.setting = ""; wait.checked = (config.siteWaitEnabled || {})[site] !== false;
      const waitLabel = element("label", "check-label"); waitLabel.htmlFor = wait.id; waitLabel.append(wait, element("span", "", "Require site wait")); fields.appendChild(waitLabel);
      wait.addEventListener("change", () => {
        stage({ siteWaitEnabled: { [site]: wait.checked ? null : false } });
      });
      const limit = element("input", "site-limit-input"); limit.id = "site-limit-" + suffix; limit.type = "number"; limit.min = "1"; limit.max = "1440"; limit.step = "1"; limit.value = (config.dailyLimits || {})[site] || "";
      fields.appendChild(settingField(limit, "Daily limit in minutes", "Optional. Leave blank for no limit; range 1–1440 minutes."));
      limit.addEventListener("change", () => {
        const next = validNumber(limit, 1, 1440, true); if (next === undefined) return;
        stage({ dailyLimits: { [site]: next } });
      });
      const policy = (config.dailyLimitPolicies || {})[site] || { mode: "block", cooldownMinutes: 60 };
      const select = element("select", "site-policy-input"); select.id = "site-policy-" + suffix;
      for (const [value, label] of [["block", "Block until midnight"], ["cooldown", "Take a break"]]) { const option = element("option", "", label); option.value = value; select.appendChild(option); }
      select.value = policy.mode;
      fields.appendChild(settingField(select, "When this site’s limit is reached", "Saved even without a limit. A break blocks only this site, then renews its allowance. Today’s total does not reset."));
      const cooldown = element("input", "site-cooldown-input"); cooldown.id = "site-cooldown-" + suffix; cooldown.type = "number"; cooldown.min = "1"; cooldown.max = "1440"; cooldown.step = "1"; cooldown.value = policy.cooldownMinutes || 60;
      fields.appendChild(settingField(cooldown, "Break duration in minutes", "Saved independently. Applies only when the break action and a limit are active. Range: 1–1440 minutes."));
      function changePolicy() {
        const minutes = validNumber(cooldown, 1, 1440);
        if (minutes === undefined) return;
        stage({ dailyLimitPolicies: { [site]: { mode: select.value, cooldownMinutes: minutes } } });
      }
      select.addEventListener("change", changePolicy); cooldown.addEventListener("change", changePolicy);
      const cooldownCopy = element("p", "help site-cooldown-status"); cooldownCopy.dataset.site = site; fields.appendChild(cooldownCopy);
      const remove = element("button", "danger site-remove", "Remove from draft"); remove.type = "button"; remove.dataset.setting = "";
      remove.setAttribute("aria-label", "Stop tracking " + site);
      remove.addEventListener("click", () => { stage({ sites: (draft || client.snapshot.config).sites.filter((value) => value !== site) }, true); document.getElementById("site-list").focus(); });
      fields.appendChild(remove); details.appendChild(fields); row.append(details, pause); list.appendChild(row);
    });
    drafts.forEach((value, id) => { const node = document.getElementById(id); if (node) { if (node.type === "checkbox") node.checked = value; else node.value = value; } });
    if (focusedId && !document.activeElement.id && document.getElementById(focusedId)) document.getElementById(focusedId).focus();
  }

  function createPlatform(platform) {
    const container = document.querySelector("#" + platform + " .platform-content");
    container.appendChild(element("p", "help", "Content rules can run without tracking this site. Content blocking controls whether saved rules run, independently of Site restrictions. Turning Content blocking back on restores saved preferences."));
    const state = element("p", "platform-status"); state.id = platform + "-status"; container.appendChild(state);
    const permission = element("p", "help permission-status", "Checking website access…"); permission.id = platform + "-permission"; container.appendChild(permission);
    const grant = element("button", "", "Allow website access"); grant.id = platform + "-grant"; grant.type = "button"; grant.hidden = true; container.appendChild(grant);
    const origins = ["*://*." + platform + ".com/*", "*://" + platform + ".com/*"];
    grant.addEventListener("click", async () => {
      try {
        const granted = await browser.permissions.request({ origins });
        permission.textContent = granted ? "Website access granted." : "Access needed. Permission was not granted; content rules cannot run.";
        grant.hidden = granted;
      } catch (error) { permission.textContent = "Website access could not be granted. Check this extension’s browser permissions."; controller.message(error.message, true); }
    });
    if (browser.permissions && browser.permissions.contains) browser.permissions.contains({ origins }).then((granted) => {
      permission.textContent = granted ? "Website access granted." : "Access needed before content rules can run."; grant.hidden = granted;
    }).catch(() => { permission.textContent = "Website access status unavailable. Check the browser’s extension permissions."; });
    else permission.textContent = "Check this extension’s website access in your browser if rules do not appear.";
    if (platform === "instagram") container.appendChild(element("p", "help support-note", "Experimental: Instagram’s authenticated layouts have not been live-verified. Layout changes may leave some content visible. Media hiding does not prevent downloads or promise bandwidth savings."));
    else container.appendChild(element("p", "help support-note", "Rules apply to identified content. Website layout changes may leave some surfaces visible; ordinary neighboring content is preserved."));
    const trackingLink = element("a", "", "Manage site tracking and usage"); trackingLink.href = "#sites"; container.appendChild(trackingLink);
    for (const [name, keys] of groupNames[platform]) {
      const group = element("section", "rule-group"); group.appendChild(element("h3", "", name));
      keys.forEach((key) => {
        const item = controls.catalog.find((entry) => entry.platform === platform && entry.key === key);
        const input = element(item.type === "boolean" ? "input" : "select"); input.id = "rule-" + item.id; input.dataset.setting = ""; input.dataset.contentSetting = "";
        if (item.type === "boolean") input.type = "checkbox";
        else item.options.forEach((choice) => { const option = element("option", "", choice.label); option.value = choice.value; input.appendChild(option); });
        let description = item.description;
        if (key === "blockExplore") description += " Experimental: discovery-only surfaces are hidden where identified, including narrow layouts; intentional Search stays available.";
        const wrapper = element("div", "rule-field");
        const label = element("label", item.type === "boolean" ? "check-label" : "field"); label.htmlFor = input.id;
        if (item.type === "boolean") {
          const copy = element("span"); copy.appendChild(element("strong", "", item.label)); const help = element("span", "help", description); help.id = input.id + "-help"; copy.appendChild(help); label.append(input, copy);
        } else { label.append(element("strong", "", item.label), input); const help = element("p", "help", description); help.id = input.id + "-help"; wrapper.appendChild(help); }
        input.setAttribute("aria-describedby", input.id + "-help"); wrapper.prepend(label); group.appendChild(wrapper);
        input.addEventListener("change", () => {
          if (!client.snapshot || client.snapshot.contentControlsSupported === false) return;
          const next = item.type === "boolean" ? input.checked : input.value;
          stage({ contentControls: { [platform]: { [key]: next } } });
        });
      });
      container.appendChild(group);
    }
    const bulk = element("button", "danger", "Disable this site’s content controls"); bulk.dataset.setting = ""; bulk.dataset.contentSetting = ""; bulk.type = "button";
    bulk.addEventListener("click", () => stage({ contentControls: { [platform]: controls.getDefaults()[platform] } }));
    container.appendChild(bulk);
  }
  ["youtube", "instagram", "facebook"].forEach(createPlatform);

  function render(snapshot) {
    const config = snapshot.config;
    let finishedDraft = false;
    if (submittedPendingId && (!snapshot.pending || snapshot.pending.id !== submittedPendingId)) {
      if (!ui.describePatch(config, draftPatch(), controls.catalog).length) { clearDraft(); finishedDraft = true; }
      else submittedPendingId = null;
    }
    const shown = draft || config;
    document.getElementById("enabled-toggle").checked = config.enabled === true;
    document.getElementById("content-controls-toggle").checked = config.contentControlsEnabled !== false;
    for (const [id, key] of [["moving-target-toggle", "movingTargetEnabled"], ["daily-lock-toggle", "dailyLockEnabled"]]) if (!dirty.has(id)) document.getElementById(id).checked = shown[key] === true;
    for (const [id, key] of [["delay-input", "delayMinutes"], ["settings-delay-input", "settingsDelayMinutes"], ["daily-lock-start", "dailyLockStart"], ["daily-lock-end", "dailyLockEnd"]]) if (!dirty.has(id)) document.getElementById(id).value = shown[key];
    controls.catalog.forEach((item) => { const input = document.getElementById("rule-" + item.id); if (!dirty.has(input.id)) { if (item.type === "boolean") input.checked = shown.contentControls[item.platform][item.key]; else input.value = shown.contentControls[item.platform][item.key]; } });
    if (renderedRevision !== snapshot.revision) { renderSites({ config: shown }); renderedRevision = snapshot.revision; }
    document.querySelectorAll(".site-usage").forEach((node) => { const site = node.dataset.site; const used = snapshot.usage && snapshot.usage.sites && snapshot.usage.sites[site] || 0; const limit = (config.dailyLimits || {})[site]; node.textContent = (!config.sites.includes(site) ? "Draft · not tracked yet · " : (config.siteTrackingEnabled || {})[site] === false ? "Paused · " : "") + ui.formatDuration(used) + " today" + (limit ? " · " + limit + " min limit" : ""); });
    document.querySelectorAll(".site-cooldown-status").forEach((node) => { const until = (snapshot.dailyLimitCooldowns || {})[node.dataset.site]; node.textContent = until && until > Date.now() ? "Site cooldown until " + ui.formatClock(until) + ". Allowance resets then; Today usage remains recorded." : ""; });
    controller.renderCooldown(config);
    const schedule = AirlockDailyLock.getState({ enabled: config.enabled !== false && config.dailyLockEnabled, start: config.dailyLockStart, end: config.dailyLockEnd });
    document.getElementById("daily-lock-status").textContent = !config.dailyLockEnabled ? "Schedule off" : config.enabled === false ? "Schedule saved · paused by Site restrictions" : schedule.locked ? "Locked until " + ui.formatClock(schedule.unlockAt) : "Schedule on · currently outside its lock window";
    ["youtube", "instagram", "facebook"].forEach((platform) => {
      const node = document.getElementById(platform + "-status");
      node.textContent = snapshot.contentControlsSupported === false ? "These settings were created by a newer Airlock version. Update Airlock to edit content controls." : "Active: " + ui.rulesSummary(config, platform, controls.catalog) + (draft ? " | Draft: " + ui.rulesSummary({ ...draft, contentControlsEnabled: config.contentControlsEnabled }, platform, controls.catalog) : "");
    });
    document.querySelectorAll("[data-content-setting]").forEach((node) => { node.dataset.dependentDisabled = snapshot.contentControlsSupported === false ? "true" : "false"; });
    renderDraft(snapshot);
    controller.lock();
    if (finishedDraft) focusDraft();
  }
  client.subscribe(render);
  function navigate(focus = false) {
    const section = location.hash.slice(1);
    const selected = ["general", "sites", "youtube", "instagram", "facebook"].includes(section) ? section : "general";
    document.querySelectorAll(".settings-panel").forEach((panel) => { panel.hidden = panel.id !== selected; });
    document.querySelectorAll(".settings-nav a").forEach((link) => { if (link.hash === "#" + selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
    if (focus) document.getElementById(selected + "-title").focus();
  }
  window.addEventListener("hashchange", () => navigate(true)); navigate();
  window.addEventListener("pagehide", () => controller.dispose());
  client.refresh().then((result) => controller.message(result.ok === false ? ui.errorMessage(result.reason) : "", result.ok === false)).catch((error) => controller.message(error.message, true));
})();
