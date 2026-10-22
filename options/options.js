(function () {
  "use strict";
  const ui = AirlockSettingsUI;
  const controls = AirlockControls;
  const client = AirlockSettingsClient.create(browser);
  const controller = ui.createController(client, { catalog: controls.catalog });
  const dirty = new Set();
  let renderedRevision = null;
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
      input.setCustomValidity(message); input.reportValidity(); controller.message(message, true); return undefined;
    }
    input.setCustomValidity(""); return value;
  }
  function bindBoolean(id, key) {
    const input = document.getElementById(id);
    input.addEventListener("change", () => {
      const next = input.checked;
      if (!client.snapshot) return;
      input.checked = client.snapshot.config[key] === true;
      dirty.delete(id);
      controller.change({ [key]: next });
    });
  }
  bindBoolean("enabled-toggle", "enabled");
  bindBoolean("moving-target-toggle", "movingTargetEnabled");
  bindBoolean("daily-lock-toggle", "dailyLockEnabled");
  for (const [id, key] of [["delay-input", "delayMinutes"], ["settings-delay-input", "settingsDelayMinutes"]]) {
    const input = document.getElementById(id);
    input.addEventListener("change", () => {
      if (!client.snapshot) return;
      const next = validNumber(input, key === "settingsDelayMinutes" ? 0 : 1, 600);
      if (next === undefined) return;
      input.value = client.snapshot.config[key]; dirty.delete(id);
      controller.change({ [key]: next });
    });
  }
  for (const id of ["daily-lock-start", "daily-lock-end"]) {
    document.getElementById(id).addEventListener("change", () => {
      if (!client.snapshot) return;
      const start = document.getElementById("daily-lock-start");
      const end = document.getElementById("daily-lock-end");
      if (!AirlockDailyLock.parseTimeOfDay(start.value) || !AirlockDailyLock.parseTimeOfDay(end.value) || start.value === end.value) {
        const message = "Choose valid, different start and end times.";
        document.getElementById(id).setCustomValidity(message); document.getElementById(id).reportValidity(); controller.message(message, true); return;
      }
      start.setCustomValidity(""); end.setCustomValidity("");
      const patch = { dailyLockStart: start.value, dailyLockEnd: end.value };
      start.value = client.snapshot.config.dailyLockStart; end.value = client.snapshot.config.dailyLockEnd;
      dirty.delete(start.id); dirty.delete(end.id);
      controller.change(patch, "Change daily lock schedule?");
    });
  }
  document.getElementById("master-help").textContent = ui.MASTER_HELP;
  document.getElementById("short-form-preset").addEventListener("click", () => controller.change(controls.getPreset("short-form"), "Hide short-form content?", ["No site is added to tracking and unrelated content preferences remain saved."]));
  document.getElementById("inbox-preset").addEventListener("click", () => controller.change(controls.getPreset("instagram-inbox"), "Use Instagram inbox focus?", ["Profiles, Search, and ordinary posts stay accessible. This is not a messaging-only mode."]));
  document.addEventListener("input", (event) => {
    if (event.target.id && event.target.matches("input, select")) {
      dirty.add(event.target.id);
      event.target.setCustomValidity("");
    }
  });
  document.getElementById("add-site-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client.snapshot) return;
    const input = document.getElementById("site-input");
    const domain = ui.cleanDomain(input.value);
    if (!domain) { input.setCustomValidity("Enter a valid website domain, such as example.com."); input.reportValidity(); controller.message("Enter a valid website domain, such as example.com.", true); return; }
    input.setCustomValidity("");
    if (client.snapshot.config.sites.includes(domain)) { controller.message(domain + " is already tracked."); return; }
    const patch = ui.appendTrackingPatch(client.snapshot.config, domain, document.getElementById("add-site-wait").checked);
    if (await controller.change(patch, "Track " + domain + "?", ["Daily locks and configured limits can apply with or without a site wait. Content rules stay independent."])) {
      input.value = ""; dirty.delete(input.id);
    }
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
      pause.addEventListener("click", () => controller.change({ siteTrackingEnabled: { [site]: paused ? null : false } }, (paused ? "Resume" : "Pause") + " tracking for " + site + "?", [paused ? "Resume focused usage, site waits, scheduled locks, and limits with the saved settings and totals." : "Pause usage counting, site waits, scheduled locks, and limits. Keep this site’s settings and usage totals. Manual cooldown and independent content rules still apply."]));
      const fields = element("div", "site-fields");
      const trackingHelp = element("p", "help site-tracking-status", paused ? "Paused for downtime. Settings below stay editable; resume to apply them." : "Tracking active. Pause for downtime without removing this site’s settings.");
      fields.appendChild(trackingHelp);
      const wait = element("input", "site-wait-input"); wait.id = "site-wait-" + suffix; wait.type = "checkbox"; wait.dataset.setting = ""; wait.checked = (config.siteWaitEnabled || {})[site] !== false;
      const waitLabel = element("label", "check-label"); waitLabel.htmlFor = wait.id; waitLabel.append(wait, element("span", "", "Require site wait")); fields.appendChild(waitLabel);
      wait.addEventListener("change", () => {
        const next = wait.checked; wait.checked = (client.snapshot.config.siteWaitEnabled || {})[site] !== false; dirty.delete(wait.id);
        controller.change({ siteWaitEnabled: { [site]: next ? null : false } }, "Change site wait for " + site + "?", ["Usage tracking, daily locks, and limits stay configured."]);
      });
      const limit = element("input", "site-limit-input"); limit.id = "site-limit-" + suffix; limit.type = "number"; limit.min = "1"; limit.max = "1440"; limit.step = "1"; limit.value = (config.dailyLimits || {})[site] || "";
      fields.appendChild(settingField(limit, "Daily limit in minutes", "Optional. Leave blank for no limit; range 1–1440 minutes."));
      limit.addEventListener("change", () => {
        const next = validNumber(limit, 1, 1440, true); if (next === undefined) return;
        limit.value = (client.snapshot.config.dailyLimits || {})[site] || ""; dirty.delete(limit.id);
        controller.change({ dailyLimits: { [site]: next } }, "Change daily limit for " + site + "?");
      });
      const policy = (config.dailyLimitPolicies || {})[site] || { mode: "block", cooldownMinutes: 60 };
      const select = element("select", "site-policy-input"); select.id = "site-policy-" + suffix;
      for (const [value, label] of [["block", "Block until midnight"], ["cooldown", "Take a break"]]) { const option = element("option", "", label); option.value = value; select.appendChild(option); }
      select.value = policy.mode;
      fields.appendChild(settingField(select, "When this site’s limit is reached", "Saved even without a limit. A break blocks only this site, then renews its allowance. Today’s total does not reset."));
      const cooldown = element("input", "site-cooldown-input"); cooldown.id = "site-cooldown-" + suffix; cooldown.type = "number"; cooldown.min = "1"; cooldown.max = "1440"; cooldown.step = "1"; cooldown.value = policy.cooldownMinutes || 60;
      fields.appendChild(settingField(cooldown, "Break duration in minutes", "Saved independently. Applies only when the break action and a limit are active. Range: 1–1440 minutes."));
      function changePolicy(fromCooldown) {
        const current = (client.snapshot.config.dailyLimitPolicies || {})[site] || { mode: "block", cooldownMinutes: 60 };
        const mode = fromCooldown ? current.mode : select.value;
        const minutes = fromCooldown ? validNumber(cooldown, 1, 1440) : current.cooldownMinutes;
        if (minutes === undefined) return;
        select.value = current.mode; cooldown.value = current.cooldownMinutes || 60; dirty.delete(select.id); dirty.delete(cooldown.id);
        controller.change({ dailyLimitPolicies: { [site]: { mode, cooldownMinutes: minutes } } }, "Change limit preferences for " + site + "?");
      }
      select.addEventListener("change", () => changePolicy(false)); cooldown.addEventListener("change", () => changePolicy(true));
      const cooldownCopy = element("p", "help site-cooldown-status"); cooldownCopy.dataset.site = site; fields.appendChild(cooldownCopy);
      const remove = element("button", "danger site-remove", "Remove site…"); remove.type = "button"; remove.dataset.setting = "";
      remove.setAttribute("aria-label", "Stop tracking " + site);
      remove.addEventListener("click", () => controller.change({ sites: client.snapshot.config.sites.filter((value) => value !== site) }, "Stop tracking " + site + "?", ["Remove its usage tracking, site wait, daily limit, and site-cooldown settings. Independently configured platform content rules stay saved."]));
      fields.appendChild(remove); details.appendChild(fields); row.append(details, pause); list.appendChild(row);
    });
    drafts.forEach((value, id) => { const node = document.getElementById(id); if (node) { if (node.type === "checkbox") node.checked = value; else node.value = value; } });
    if (focusedId && !document.activeElement.id && document.getElementById(focusedId)) document.getElementById(focusedId).focus();
  }

  function createPlatform(platform) {
    const container = document.querySelector("#" + platform + " .platform-content");
    container.appendChild(element("p", "help", "Content rules can run without tracking this site. They require Restrictions to be on; saved preferences return when you turn it back on."));
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
          const current = client.snapshot.config.contentControls[platform][key];
          if (item.type === "boolean") input.checked = current; else input.value = current;
          dirty.delete(input.id);
          controller.change({ contentControls: { [platform]: { [key]: next } } }, "Change " + item.label.toLowerCase() + "?");
        });
      });
      container.appendChild(group);
    }
    const bulk = element("button", "danger", "Disable this site’s content controls…"); bulk.dataset.setting = ""; bulk.dataset.contentSetting = ""; bulk.type = "button";
    bulk.addEventListener("click", () => controller.change({ contentControls: { [platform]: controls.getDefaults()[platform] } }, "Disable " + platform[0].toUpperCase() + platform.slice(1) + " content controls?", ["Tracked-site waits, limits, and monitoring stay independently configured."]));
    container.appendChild(bulk);
  }
  ["youtube", "instagram", "facebook"].forEach(createPlatform);

  function render(snapshot) {
    const config = snapshot.config;
    if (renderedRevision !== snapshot.revision) {
      for (const [id, key] of [["enabled-toggle", "enabled"], ["moving-target-toggle", "movingTargetEnabled"], ["daily-lock-toggle", "dailyLockEnabled"]]) if (!dirty.has(id)) document.getElementById(id).checked = config[key] === true;
      for (const [id, key] of [["delay-input", "delayMinutes"], ["settings-delay-input", "settingsDelayMinutes"], ["daily-lock-start", "dailyLockStart"], ["daily-lock-end", "dailyLockEnd"]]) if (!dirty.has(id)) document.getElementById(id).value = config[key];
      controls.catalog.forEach((item) => { const input = document.getElementById("rule-" + item.id); if (!dirty.has(input.id)) { if (item.type === "boolean") input.checked = config.contentControls[item.platform][item.key]; else input.value = config.contentControls[item.platform][item.key]; } });
      renderSites(snapshot); renderedRevision = snapshot.revision;
    }
    document.querySelectorAll(".site-usage").forEach((node) => { const site = node.dataset.site; const used = snapshot.usage && snapshot.usage.sites && snapshot.usage.sites[site] || 0; const limit = (config.dailyLimits || {})[site]; node.textContent = ((config.siteTrackingEnabled || {})[site] === false ? "Paused · " : "") + ui.formatDuration(used) + " today" + (limit ? " · " + limit + " min limit" : ""); });
    document.querySelectorAll(".site-cooldown-status").forEach((node) => { const until = (snapshot.dailyLimitCooldowns || {})[node.dataset.site]; node.textContent = until && until > Date.now() ? "Site cooldown until " + ui.formatClock(until) + ". Allowance resets then; Today usage remains recorded." : ""; });
    controller.renderCooldown(config);
    const schedule = AirlockDailyLock.getState({ enabled: config.enabled !== false && config.dailyLockEnabled, start: config.dailyLockStart, end: config.dailyLockEnd });
    document.getElementById("daily-lock-status").textContent = !config.dailyLockEnabled ? "Schedule off" : config.enabled === false ? "Schedule saved · paused by Restrictions" : schedule.locked ? "Locked until " + ui.formatClock(schedule.unlockAt) : "Schedule on · currently outside its lock window";
    ["youtube", "instagram", "facebook"].forEach((platform) => {
      const node = document.getElementById(platform + "-status");
      node.textContent = snapshot.contentControlsSupported === false ? "These settings were created by a newer Airlock version. Update Airlock to edit content controls." : ui.rulesSummary(config, platform, controls.catalog);
    });
    document.querySelectorAll("[data-content-setting]").forEach((node) => { node.dataset.dependentDisabled = snapshot.contentControlsSupported === false ? "true" : "false"; });
    controller.lock();
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
