// Airlock - Popup Configuration UI

const dailyLockApi = globalThis.AirlockDailyLock;
const enabledToggle = document.getElementById("enabled-toggle");
const delayInput = document.getElementById("delay-input");
const resetInput = document.getElementById("reset-input");
const cooldownSection = document.querySelector(".cooldown-section");
const cooldownStatus = document.getElementById("cooldown-status");
const cooldownBtn = document.getElementById("cooldown-btn");
const dailyLockToggle = document.getElementById("daily-lock-toggle");
const dailyLockStartInput = document.getElementById("daily-lock-start");
const dailyLockEndInput = document.getElementById("daily-lock-end");
const dailyLockStatus = document.getElementById("daily-lock-status");
const siteList = document.getElementById("site-list");
const addSiteForm = document.getElementById("add-site-form");
const siteInput = document.getElementById("site-input");
const addCurrentBtn = document.getElementById("add-current-btn");
const addSiteBtn = document.getElementById("add-site-btn");
const pendingConfigSection = document.getElementById("pending-config-section");
const pendingConfigTitle = document.getElementById("pending-config-title");
const pendingConfigTimer = document.getElementById("pending-config-timer");
const pendingConfigHoverTarget = document.getElementById("pending-config-hover-target");
const pendingConfigCancel = document.getElementById("pending-config-cancel");
const confirmDialog = document.getElementById("confirm-dialog");
const confirmDialogTitle = document.getElementById("confirm-dialog-title");
const confirmDialogMessage = document.getElementById("confirm-dialog-message");
const confirmDialogSubmit = document.getElementById("confirm-dialog-submit");
const PENDING_CONFIG_TICK_MS = 250;
const PENDING_CONFIG_SYNC_MS = 1000;
const DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES = 60;

confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) confirmDialog.close("cancel");
});

let sites = [];
let delayMinutes = 1;
let resetHours = 24;
let dailyLimits = {};
let dailyLimitPolicies = {};
let dailyLimitCooldowns = {};
let dailyUsage = { date: "", sites: {} };
let cooldownUntil = null;
let dailyLockEnabled = false;
let dailyLockStart = dailyLockApi.DEFAULT_START;
let dailyLockEnd = dailyLockApi.DEFAULT_END;
let currentDomain = null;
let pendingRemove = null;
let pendingConfigChange = null;
let pendingConfigTimerTimeout = null;
let pendingConfigTickAt = null;
let pendingConfigHoverActive = false;
let pendingConfigAdvanceInFlight = false;
let pendingConfigRefreshInFlight = false;
let pendingConfigTimerText = null;

// --- Load config from storage ---

browser.storage.local.get([
  "enabled",
  "sites",
  "delayMinutes",
  "resetHours",
  "dailyLimits",
  "dailyLimitPolicies",
  "dailyLimitCooldowns",
  "dailyUsage",
  "cooldownUntil",
  "dailyLockEnabled",
  "dailyLockStart",
  "dailyLockEnd"
]).then((result) => {
  enabledToggle.checked = result.enabled !== false;

  delayMinutes = normalizeDelayMinutes(result.delayMinutes || 1);
  resetHours = normalizeResetHours(result.resetHours || 24);
  dailyLimits = normalizeDailyLimits(result.dailyLimits);
  dailyLimitPolicies = normalizeDailyLimitPolicies(result.dailyLimitPolicies);
  dailyLimitCooldowns = normalizeDailyLimitCooldowns(result.dailyLimitCooldowns);
  dailyUsage = normalizeDailyUsage(result.dailyUsage);
  cooldownUntil = normalizeCooldownUntil(result.cooldownUntil);
  dailyLockStart = dailyLockApi.normalizeTimeOfDay(
    result.dailyLockStart,
    dailyLockApi.DEFAULT_START
  );
  dailyLockEnd = dailyLockApi.normalizeTimeOfDay(
    result.dailyLockEnd,
    dailyLockApi.DEFAULT_END
  );
  dailyLockEnabled = result.dailyLockEnabled === true && dailyLockStart !== dailyLockEnd;
  delayInput.value = delayMinutes;
  resetInput.value = resetHours;
  dailyLockToggle.checked = dailyLockEnabled;
  dailyLockStartInput.value = dailyLockStart;
  dailyLockEndInput.value = dailyLockEnd;
  renderDailyLockStatus();
  renderCooldown();

  sites = result.sites || [];
  renderSites();
  refreshPendingConfigChange();
});

// --- "Add current site" button ---

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab || !tab.url) return;
  const domain = cleanDomain(tab.url);
  if (!domain || domain.length < 3 || !domain.includes(".")) return;
  currentDomain = domain;
  renderAddCurrentButton();
});

addCurrentBtn.addEventListener("click", () => {
  if (pendingConfigChange) return;
  if (!currentDomain || sites.includes(currentDomain)) return;
  sites.push(currentDomain);
  sites.sort();
  browser.storage.local.set({ sites: sites });
  renderSites();
});

// --- Toggle ---

enabledToggle.addEventListener("change", () => {
  if (pendingConfigChange) {
    enabledToggle.checked = !enabledToggle.checked;
    return;
  }

  if (!enabledToggle.checked) {
    enabledToggle.checked = true;
    startPendingConfigChange({ type: "disableAirlock" });
    return;
  }

  browser.storage.local.set({ enabled: enabledToggle.checked });
});

// --- Delay ---

delayInput.addEventListener("change", async () => {
  const val = normalizeDelayMinutes(delayInput.value);

  if (pendingConfigChange) {
    delayInput.value = delayMinutes;
    return;
  }

  if (val > delayMinutes && !(await confirmSettingIncrease("hover wait", delayMinutes, val, "minute"))) {
    delayInput.value = delayMinutes;
    return;
  }

  if (val >= delayMinutes) {
    delayMinutes = val;
    delayInput.value = delayMinutes;
    browser.storage.local.set({ delayMinutes: delayMinutes });
    return;
  }

  delayInput.value = delayMinutes;
  startPendingConfigChange({
    type: "reduceDelay",
    delayMinutes: val
  });
});

resetInput.addEventListener("change", () => {
  const val = normalizeResetHours(resetInput.value);

  if (pendingConfigChange) {
    resetInput.value = resetHours;
    return;
  }

  if (val > resetHours) {
    resetInput.value = resetHours;
    startPendingConfigChange({
      type: "increaseResetHours",
      resetHours: val
    });
    return;
  }

  resetHours = val;
  resetInput.value = resetHours;
  browser.storage.local.set({ resetHours: resetHours });
});

// --- Cooldown ---

cooldownBtn.addEventListener("click", async () => {
  if (pendingConfigChange) return;

  if (isCooldownActive()) {
    startPendingConfigChange({
      type: "endCooldown",
      cooldownUntil: cooldownUntil
    });
    return;
  }

  if (sites.length === 0) return;
  if (!(await confirmInPopup({
    title: "Start cooldown?",
    message: "All tracked sites will stay blocked for one hour.",
    confirmLabel: "Start cooldown"
  }))) {
    return;
  }

  browser.runtime.sendMessage({ type: "START_COOLDOWN" }).then((response) => {
    cooldownUntil = normalizeCooldownUntil(response && response.cooldownUntil);
    renderCooldown();
  });
});

// --- Daily Lock ---

dailyLockToggle.addEventListener("change", async () => {
  if (pendingConfigChange) {
    dailyLockToggle.checked = dailyLockEnabled;
    return;
  }

  const schedule = validateDailyLockInputs();
  if (!schedule) {
    dailyLockToggle.checked = dailyLockEnabled;
    return;
  }

  const nextEnabled = dailyLockToggle.checked === true;
  if (!nextEnabled && dailyLockEnabled) {
    dailyLockToggle.checked = dailyLockEnabled;
    startPendingConfigChange({ type: "disableDailyLock" });
    return;
  }

  if (
    nextEnabled &&
    !(await confirmInPopup({
      title: "Turn on daily lock?",
      message: "Tracked sites will be blocked from " +
        formatTimeOfDayLabel(schedule.start) +
        " to " +
        formatTimeOfDayLabel(schedule.end) +
        ".",
      confirmLabel: "Turn on"
    }))
  ) {
    dailyLockToggle.checked = dailyLockEnabled;
    return;
  }

  dailyLockEnabled = nextEnabled;
  dailyLockStart = schedule.start;
  dailyLockEnd = schedule.end;
  browser.storage.local.set({
    dailyLockEnabled: dailyLockEnabled,
    dailyLockStart: dailyLockStart,
    dailyLockEnd: dailyLockEnd
  });
  renderDailyLockStatus();
});

dailyLockStartInput.addEventListener("change", saveDailyLockTimes);
dailyLockEndInput.addEventListener("change", saveDailyLockTimes);

function saveDailyLockTimes() {
  if (pendingConfigChange) {
    dailyLockStartInput.value = dailyLockStart;
    dailyLockEndInput.value = dailyLockEnd;
    return;
  }

  const schedule = validateDailyLockInputs();
  if (!schedule) return;

  if (
    dailyLockEnabled &&
    (schedule.start !== dailyLockStart || schedule.end !== dailyLockEnd)
  ) {
    dailyLockStartInput.value = dailyLockStart;
    dailyLockEndInput.value = dailyLockEnd;
    startPendingConfigChange({
      type: "changeDailyLockSchedule",
      dailyLockStart: schedule.start,
      dailyLockEnd: schedule.end
    });
    return;
  }

  dailyLockStart = schedule.start;
  dailyLockEnd = schedule.end;
  browser.storage.local.set({
    dailyLockStart: dailyLockStart,
    dailyLockEnd: dailyLockEnd
  });
  renderDailyLockStatus();
}

function validateDailyLockInputs() {
  const start = dailyLockApi.normalizeTimeOfDay(dailyLockStartInput.value, null);
  const end = dailyLockApi.normalizeTimeOfDay(dailyLockEndInput.value, null);
  let error = "";

  if (!start || !end) {
    error = "Choose both a start and end time.";
  } else if (start === end) {
    error = "Start and end times must be different.";
  }

  dailyLockStartInput.setCustomValidity(error);
  dailyLockEndInput.setCustomValidity(error);

  if (error) {
    dailyLockStatus.textContent = error;
    dailyLockStatus.classList.remove("locked");
    const invalidInput = !start ? dailyLockStartInput : dailyLockEndInput;
    invalidInput.reportValidity();
    return null;
  }

  return { start: start, end: end };
}

function renderDailyLockStatus() {
  dailyLockToggle.checked = dailyLockEnabled;

  const validationMessage =
    dailyLockStartInput.validationMessage || dailyLockEndInput.validationMessage;
  if (validationMessage) {
    dailyLockStatus.textContent = validationMessage;
    dailyLockStatus.classList.remove("locked");
    return;
  }

  if (!dailyLockEnabled) {
    dailyLockStatus.textContent =
      "Off · " + formatTimeOfDayLabel(dailyLockStart) + "–" + formatTimeOfDayLabel(dailyLockEnd);
    dailyLockStatus.classList.remove("locked");
    return;
  }

  if (!enabledToggle.checked) {
    dailyLockStatus.textContent = "Scheduled · Airlock is off";
    dailyLockStatus.classList.remove("locked");
    return;
  }

  const state = dailyLockApi.getState({
    enabled: true,
    start: dailyLockStart,
    end: dailyLockEnd
  });

  if (!state.valid) {
    dailyLockStatus.textContent = "Choose different start and end times.";
    dailyLockStatus.classList.remove("locked");
  } else if (state.locked) {
    dailyLockStatus.textContent = "Locked now · opens at " + formatClockTime(state.unlockAt);
    dailyLockStatus.classList.add("locked");
  } else {
    dailyLockStatus.textContent = "Next lock at " + formatClockTime(state.nextBoundaryAt);
    dailyLockStatus.classList.remove("locked");
  }
}

function formatTimeOfDayLabel(value) {
  const parsed = dailyLockApi.parseTimeOfDay(value);
  if (!parsed) return value;

  const date = new Date(2000, 0, 1, parsed.hours, parsed.minutes);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatClockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function normalizeCooldownUntil(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
}

function isCooldownActive() {
  return typeof cooldownUntil === "number" && cooldownUntil > Date.now();
}

function renderCooldown() {
  if (!isCooldownActive()) cooldownUntil = null;

  const active = isCooldownActive();
  cooldownSection.classList.toggle("active", active);
  cooldownBtn.textContent = active ? "End early" : "Start 1 hour";

  if (active) {
    cooldownStatus.textContent = "All tracked sites blocked · " + formatTime(cooldownUntil - Date.now()) + " left";
  } else if (sites.length === 0) {
    cooldownStatus.textContent = "Add a tracked site to start a cooldown";
  } else {
    cooldownStatus.textContent = "Block all tracked sites for one hour";
  }

  cooldownBtn.disabled = Boolean(pendingConfigChange) || (!active && sites.length === 0);
}

// --- Site List ---

function renderSites() {
  siteList.innerHTML = "";
  pendingRemove = null;
  sites.sort();
  sites.forEach((site) => {
    const li = document.createElement("li");
    li.className = "site-item";

    const info = document.createElement("div");
    info.className = "site-info";

    const domain = document.createElement("span");
    domain.className = "site-domain";
    domain.textContent = site;

    const usage = document.createElement("span");
    usage.className = "site-usage";
    usage.dataset.site = site;
    usage.textContent = formatSiteUsage(site);

    info.appendChild(domain);
    info.appendChild(usage);

    const actions = document.createElement("div");
    actions.className = "site-actions";

    const settings = document.createElement("div");
    settings.className = "site-settings";

    const limitGroup = document.createElement("label");
    limitGroup.className = "site-limit-group";
    limitGroup.title = "Daily time limit in minutes; leave blank for no limit";

    const limitInput = document.createElement("input");
    limitInput.className = "site-limit-input";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.max = "1440";
    limitInput.placeholder = "—";
    limitInput.value = dailyLimits[site] || "";
    limitInput.setAttribute("aria-label", "Daily limit for " + site + " in minutes");
    limitInput.disabled = Boolean(pendingConfigChange);
    limitInput.addEventListener("change", () => changeDailyLimit(site, limitInput));

    const limitUnit = document.createElement("span");
    limitUnit.textContent = "min/day";

    limitGroup.appendChild(limitInput);
    limitGroup.appendChild(limitUnit);
    settings.appendChild(limitGroup);

    const limit = dailyLimits[site] || null;
    if (limit !== null) {
      const policy = normalizeDailyLimitPolicy(dailyLimitPolicies[site]);
      const policyGroup = document.createElement("div");
      policyGroup.className = "site-limit-policy";

      const policySelect = document.createElement("select");
      policySelect.setAttribute("aria-label", "Action when " + site + " reaches its daily limit");
      policySelect.disabled = Boolean(pendingConfigChange);
      policySelect.innerHTML = '<option value="block">Block until tomorrow</option><option value="cooldown">Cooldown</option>';
      policySelect.value = policy.mode;

      const cooldownInput = document.createElement("input");
      cooldownInput.type = "number";
      cooldownInput.min = "1";
      cooldownInput.max = "1440";
      cooldownInput.value = policy.cooldownMinutes;
      cooldownInput.setAttribute("aria-label", "Cooldown for " + site + " in minutes");
      cooldownInput.disabled = Boolean(pendingConfigChange) || policy.mode !== "cooldown";
      cooldownInput.hidden = policy.mode !== "cooldown";

      const cooldownUnit = document.createElement("span");
      cooldownUnit.textContent = "min";
      cooldownUnit.hidden = policy.mode !== "cooldown";

      policySelect.addEventListener("change", () => {
        changeDailyLimitPolicy(site, {
          mode: policySelect.value,
          cooldownMinutes: cooldownInput.value
        });
      });
      cooldownInput.addEventListener("change", () => {
        changeDailyLimitPolicy(site, {
          mode: "cooldown",
          cooldownMinutes: cooldownInput.value
        });
      });

      policyGroup.appendChild(policySelect);
      policyGroup.appendChild(cooldownInput);
      policyGroup.appendChild(cooldownUnit);
      settings.appendChild(policyGroup);
    }

    const btn = document.createElement("button");
    btn.className = "site-remove";
    btn.textContent = "\u00d7";
    btn.title = "Remove";
    btn.disabled = Boolean(pendingConfigChange);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pendingConfigChange) return;

      if (pendingRemove === site) {
        startPendingConfigChange({
          type: "removeSite",
          site: site
        });
      } else {
        clearPendingRemove();
        pendingRemove = site;
        li.classList.add("confirm-remove");
        btn.textContent = "Remove?";
      }
    });

    actions.appendChild(settings);
    actions.appendChild(btn);
    li.appendChild(info);
    li.appendChild(actions);
    siteList.appendChild(li);
  });

  setControlsLocked(Boolean(pendingConfigChange));

  renderAddCurrentButton();
  renderCooldown();
}

function changeDailyLimitPolicy(site, nextValue) {
  if (pendingConfigChange) return;

  const currentPolicy = normalizeDailyLimitPolicy(dailyLimitPolicies[site]);
  const nextPolicy = normalizeDailyLimitPolicy(nextValue);
  if (JSON.stringify(currentPolicy) === JSON.stringify(nextPolicy)) return;

  startPendingConfigChange({
    type: "changeDailyLimitPolicy",
    site: site,
    dailyLimitPolicy: nextPolicy
  });
}

function changeDailyLimit(site, input) {
  if (pendingConfigChange) {
    input.value = dailyLimits[site] || "";
    return;
  }

  const currentLimit = dailyLimits[site] || null;
  const nextLimit = input.value.trim() === "" ? null : normalizeDailyLimitMinutes(input.value);
  if (nextLimit === null && input.value.trim() !== "") {
    input.value = currentLimit || "";
    input.setCustomValidity("Choose a value from 1 to 1440 minutes.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");

  if (nextLimit === currentLimit) return;

  const isMorePermissive = currentLimit !== null && (nextLimit === null || nextLimit > currentLimit);
  if (isMorePermissive) {
    input.value = currentLimit;
    startPendingConfigChange({
      type: "changeDailyLimit",
      site: site,
      dailyLimitMinutes: nextLimit
    });
    return;
  }

  dailyLimits = { ...dailyLimits, [site]: nextLimit };
  if (nextLimit === null) delete dailyLimits[site];
  input.value = nextLimit || "";
  browser.storage.local.set({ dailyLimits: dailyLimits });
  updateSiteUsageLabels();
}

function formatSiteUsage(site) {
  const limit = dailyLimits[site];
  if (!limit) return "No daily limit";

  const cooldownUntil = Number(dailyLimitCooldowns[site]);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return "Cooldown · " + formatTime(cooldownUntil - Date.now()) + " left";
  }

  const usedMinutes = Math.min(limit, Math.floor(getTodayUsageMs(site) / 60000));
  return usedMinutes + " of " + limit + " min used today";
}

function updateSiteUsageLabels() {
  siteList.querySelectorAll(".site-usage").forEach((label) => {
    label.textContent = formatSiteUsage(label.dataset.site);
  });
}

function clearPendingRemove() {
  if (pendingRemove === null) return;
  pendingRemove = null;
  siteList.querySelectorAll(".confirm-remove").forEach((el) => {
    el.classList.remove("confirm-remove");
    el.querySelector("button").textContent = "\u00d7";
  });
}

function renderAddCurrentButton() {
  if (!currentDomain || sites.includes(currentDomain)) {
    addCurrentBtn.textContent = "";
    addCurrentBtn.style.display = "none";
    return;
  }

  addCurrentBtn.textContent = "Track " + currentDomain;
  addCurrentBtn.style.display = "block";
  addCurrentBtn.disabled = Boolean(pendingConfigChange);
}

// Click anywhere else to cancel pending remove
document.addEventListener("click", (e) => {
  if (pendingRemove !== null && !e.target.closest(".site-item")) {
    clearPendingRemove();
  }
});

function cleanDomain(input) {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.split("/")[0];
  domain = domain.replace(/^www\./, "");
  domain = domain.split(":")[0];
  return domain;
}

addSiteForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (pendingConfigChange) return;

  const domain = cleanDomain(siteInput.value);
  if (!domain || domain.length < 3 || !domain.includes(".")) return;
  if (sites.includes(domain)) {
    siteInput.value = "";
    return;
  }
  sites.push(domain);
  browser.storage.local.set({ sites: sites });
  renderSites();
  siteInput.value = "";
});

pendingConfigCancel.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "CANCEL_PENDING_CONFIG_CHANGE" }).then((response) => {
    pendingConfigChange = response && response.pending ? response.pending : null;
    renderPendingConfigChange();
    renderSites();
  });
});

pendingConfigHoverTarget.addEventListener("pointerenter", (event) => {
  setPendingConfigHoverActive(event.pointerType !== "touch");
});
pendingConfigHoverTarget.addEventListener("pointerleave", () => setPendingConfigHoverActive(false));
pendingConfigHoverTarget.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "mouse" && typeof pendingConfigHoverTarget.setPointerCapture === "function") {
    try {
      pendingConfigHoverTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort for touch press-and-hold.
    }
  }
  setPendingConfigHoverActive(true);
});
pendingConfigHoverTarget.addEventListener("pointerup", () => setPendingConfigHoverActive(false));
pendingConfigHoverTarget.addEventListener("pointercancel", () => setPendingConfigHoverActive(false));
pendingConfigHoverTarget.addEventListener("lostpointercapture", () => setPendingConfigHoverActive(false));

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled) {
    enabledToggle.checked = changes.enabled.newValue !== false;
    renderDailyLockStatus();
  }

  if (changes.delayMinutes) {
    delayMinutes = normalizeDelayMinutes(changes.delayMinutes.newValue || 1);
    delayInput.value = delayMinutes;
  }

  if (changes.resetHours) {
    resetHours = normalizeResetHours(changes.resetHours.newValue || 24);
    resetInput.value = resetHours;
  }

  if (changes.cooldownUntil) {
    cooldownUntil = normalizeCooldownUntil(changes.cooldownUntil.newValue);
    renderCooldown();
  }

  if (changes.dailyLockEnabled) {
    dailyLockEnabled = changes.dailyLockEnabled.newValue === true;
  }

  if (changes.dailyLockStart) {
    dailyLockStart = dailyLockApi.normalizeTimeOfDay(
      changes.dailyLockStart.newValue,
      dailyLockApi.DEFAULT_START
    );
    dailyLockStartInput.value = dailyLockStart;
  }

  if (changes.dailyLockEnd) {
    dailyLockEnd = dailyLockApi.normalizeTimeOfDay(
      changes.dailyLockEnd.newValue,
      dailyLockApi.DEFAULT_END
    );
    dailyLockEndInput.value = dailyLockEnd;
  }

  if (changes.dailyLockEnabled || changes.dailyLockStart || changes.dailyLockEnd) {
    dailyLockEnabled = dailyLockEnabled && dailyLockStart !== dailyLockEnd;
    dailyLockStartInput.setCustomValidity("");
    dailyLockEndInput.setCustomValidity("");
    renderDailyLockStatus();
  }

  if (changes.sites) {
    sites = changes.sites.newValue || [];
    renderSites();
  }

  if (changes.dailyLimits) {
    dailyLimits = normalizeDailyLimits(changes.dailyLimits.newValue);
    renderSites();
  }

  if (changes.dailyLimitPolicies) {
    dailyLimitPolicies = normalizeDailyLimitPolicies(changes.dailyLimitPolicies.newValue);
    renderSites();
  }

  if (changes.dailyLimitCooldowns) {
    dailyLimitCooldowns = normalizeDailyLimitCooldowns(changes.dailyLimitCooldowns.newValue);
    renderSites();
  }

  if (changes.dailyUsage) {
    dailyUsage = normalizeDailyUsage(changes.dailyUsage.newValue);
    updateSiteUsageLabels();
  }

  if (changes.pendingConfigChange) {
    const nextPendingConfigChange = changes.pendingConfigChange.newValue || null;
    if (
      pendingConfigAdvanceInFlight &&
      nextPendingConfigChange &&
      pendingConfigChange &&
      nextPendingConfigChange.id === pendingConfigChange.id
    ) {
      pendingConfigChange = nextPendingConfigChange;
      return;
    }

    pendingConfigChange = nextPendingConfigChange;
    renderPendingConfigChange();
    renderSites();
  }
});

function normalizeDelayMinutes(value) {
  let minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 600) minutes = 600;
  return minutes;
}

function normalizeResetHours(value) {
  let hours = parseInt(value, 10);
  if (isNaN(hours) || hours < 1) hours = 1;
  if (hours > 8760) hours = 8760;
  return hours;
}

function normalizeDailyLimitMinutes(value) {
  const minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1 || minutes > 1440) return null;
  return minutes;
}

function normalizeDailyLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([site, minutes]) => [site, normalizeDailyLimitMinutes(minutes)])
      .filter(([, minutes]) => minutes !== null)
  );
}

function normalizeDailyLimitCooldownMinutes(value) {
  let minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES;
  if (minutes > 1440) minutes = 1440;
  return minutes;
}

function normalizeDailyLimitPolicy(value) {
  if (!value || value.mode !== "cooldown") {
    return { mode: "block", cooldownMinutes: DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES };
  }

  return {
    mode: "cooldown",
    cooldownMinutes: normalizeDailyLimitCooldownMinutes(value.cooldownMinutes)
  };
}

function normalizeDailyLimitPolicies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, policy]) => policy && policy.mode === "cooldown")
      .map(([site, policy]) => [site, normalizeDailyLimitPolicy(policy)])
  );
}

function normalizeDailyLimitCooldowns(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([site, until]) => [site, Number(until)])
      .filter(([, until]) => Number.isFinite(until) && until > Date.now())
  );
}

function getLocalDateKey(now = Date.now()) {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function normalizeDailyUsage(value) {
  if (
    !value ||
    value.date !== getLocalDateKey() ||
    !value.sites ||
    typeof value.sites !== "object"
  ) {
    return { date: getLocalDateKey(), sites: {} };
  }
  return value;
}

function getTodayUsageMs(site) {
  if (dailyUsage.date !== getLocalDateKey()) return 0;
  return Math.max(0, Number(dailyUsage.sites[site]) || 0);
}

function confirmSettingIncrease(label, currentValue, nextValue, unit) {
  const currentUnit = currentValue === 1 ? unit : unit + "s";
  const nextUnit = nextValue === 1 ? unit : unit + "s";
  return confirmInPopup({
    title: "Increase " + label + "?",
    message:
      "Change from " +
      currentValue +
      " " +
      currentUnit +
      " to " +
      nextValue +
      " " +
      nextUnit +
      ".",
    confirmLabel: "Increase"
  });
}

function confirmInPopup({ title, message, confirmLabel = "Confirm" }) {
  if (confirmDialog.open) confirmDialog.close("cancel");

  confirmDialogTitle.textContent = title;
  confirmDialogMessage.textContent = message;
  confirmDialogSubmit.textContent = confirmLabel;
  confirmDialog.returnValue = "cancel";

  return new Promise((resolve) => {
    confirmDialog.addEventListener(
      "close",
      () => resolve(confirmDialog.returnValue === "confirm"),
      { once: true }
    );
    confirmDialog.showModal();
  });
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function setControlsLocked(locked) {
  enabledToggle.disabled = locked;
  delayInput.disabled = locked;
  resetInput.disabled = locked;
  cooldownBtn.disabled = locked || (!isCooldownActive() && sites.length === 0);
  dailyLockToggle.disabled = locked;
  dailyLockStartInput.disabled = locked;
  dailyLockEndInput.disabled = locked;
  siteInput.disabled = locked;
  addSiteBtn.disabled = locked;
  addCurrentBtn.disabled = locked;

  siteList.querySelectorAll("button").forEach((btn) => {
    btn.disabled = locked;
  });
  siteList.querySelectorAll("input").forEach((input) => {
    input.disabled = locked;
  });
  siteList.querySelectorAll("select").forEach((select) => {
    select.disabled = locked;
  });
}

function renderPendingConfigChange() {
  clearPendingConfigTimerTimeout();
  pendingConfigTickAt = null;
  pendingConfigHoverActive = false;
  pendingConfigAdvanceInFlight = false;
  pendingConfigTimerText = null;
  updatePendingConfigHoverTarget();

  if (!pendingConfigChange) {
    pendingConfigSection.hidden = true;
    pendingConfigTitle.textContent = "";
    setPendingConfigTimerText(0);
    setControlsLocked(false);
    return;
  }

  clearPendingRemove();
  pendingConfigSection.hidden = false;
  pendingConfigTitle.textContent = pendingConfigChange.description || getPendingConfigTitle(pendingConfigChange);
  setControlsLocked(true);
  pendingConfigTickAt = Date.now();
  updatePendingConfigHoverTarget();
  updatePendingConfigTimer();
  schedulePendingConfigTimerTick();
}

function getPendingConfigTitle(pending) {
  if (pending.type === "removeSite") {
    return "Removing " + pending.site;
  }

  if (pending.type === "disableAirlock") {
    return "Turning off Airlock";
  }

  if (pending.type === "reduceDelay") {
    const unit = pending.delayMinutes === 1 ? "minute" : "minutes";
    return "Reducing wait to " + pending.delayMinutes + " " + unit;
  }

  if (pending.type === "increaseResetHours") {
    const unit = pending.resetHours === 1 ? "hour" : "hours";
    return "Increasing reset window to " + pending.resetHours + " " + unit;
  }

  if (pending.type === "changeDailyLimit") {
    return pending.dailyLimitMinutes === null
      ? "Removing daily limit for " + pending.site
      : "Increasing daily limit for " + pending.site;
  }

  if (pending.type === "changeDailyLimitPolicy") {
    return pending.previousDailyLimitPolicy.mode === "block"
      ? "Changing limit to cooldown for " + pending.site
      : "Reducing cooldown for " + pending.site;
  }

  if (pending.type === "endCooldown") {
    return "Ending cooldown early";
  }

  if (pending.type === "disableDailyLock") {
    return "Turning off daily lock";
  }

  if (pending.type === "changeDailyLockSchedule") {
    return "Changing daily lock schedule";
  }

  return "Updating settings";
}

function updatePendingConfigTimer() {
  if (!pendingConfigChange) return;

  const remainingMs = getPendingConfigRemainingMs();
  setPendingConfigTimerText(remainingMs);

  if (isPendingConfigHoverGated()) {
    if (pendingConfigHoverActive) {
      advancePendingConfigChangeCountdown(remainingMs);
      schedulePendingConfigTimerTick();
    }
    return;
  }

  if (remainingMs <= 0 && !pendingConfigRefreshInFlight) {
    pendingConfigRefreshInFlight = true;
    refreshPendingConfigChange().finally(() => {
      pendingConfigRefreshInFlight = false;
    });
  } else {
    schedulePendingConfigTimerTick();
  }
}

function clearPendingConfigTimerTimeout() {
  if (pendingConfigTimerTimeout) {
    clearTimeout(pendingConfigTimerTimeout);
    pendingConfigTimerTimeout = null;
  }
}

function schedulePendingConfigTimerTick() {
  if (pendingConfigTimerTimeout || !pendingConfigChange) return;
  if (isPendingConfigHoverGated() && !pendingConfigHoverActive) return;

  pendingConfigTimerTimeout = setTimeout(() => {
    pendingConfigTimerTimeout = null;
    updatePendingConfigTimer();
  }, PENDING_CONFIG_TICK_MS);
}

function getPendingConfigRemainingMs() {
  if (typeof pendingConfigChange.remainingMs === "number") {
    const tickAt = pendingConfigTickAt || Date.now();
    const elapsedMs = pendingConfigHoverActive ? Math.max(0, Date.now() - tickAt) : 0;
    return Math.max(0, (pendingConfigChange.remainingMs || 0) - elapsedMs);
  }

  if (typeof pendingConfigChange.unlockAt === "number") {
    return Math.max(0, pendingConfigChange.unlockAt - Date.now());
  }

  return 0;
}

function isPendingConfigHoverGated() {
  return Boolean(pendingConfigChange && typeof pendingConfigChange.remainingMs === "number");
}

function setPendingConfigTimerText(ms) {
  const nextText = formatTime(ms);
  if (pendingConfigTimerText === nextText) return;

  pendingConfigTimerText = nextText;
  pendingConfigTimer.textContent = nextText;
}

function updatePendingConfigHoverTarget() {
  if (!pendingConfigHoverTarget) return;

  const hoverGated = isPendingConfigHoverGated();
  pendingConfigHoverTarget.hidden = !hoverGated;
  pendingConfigHoverTarget.classList.toggle("active", hoverGated && pendingConfigHoverActive);
}

function setPendingConfigHoverActive(active) {
  const nextActive = isPendingConfigHoverGated() && active === true;
  if (pendingConfigHoverActive === nextActive) return;

  if (!nextActive) {
    flushPendingConfigChange();
    clearPendingConfigTimerTimeout();
  }

  pendingConfigHoverActive = nextActive;
  pendingConfigTickAt = Date.now();
  updatePendingConfigHoverTarget();
  updatePendingConfigTimer();
  schedulePendingConfigTimerTick();
}

function advancePendingConfigChangeCountdown(remainingMs) {
  if (pendingConfigAdvanceInFlight || !pendingConfigHoverActive || !pendingConfigTickAt) return;

  const now = Date.now();
  const elapsedMs = Math.max(0, now - pendingConfigTickAt);
  if (elapsedMs < PENDING_CONFIG_SYNC_MS && remainingMs > 0) return;

  pendingConfigChange = {
    ...pendingConfigChange,
    remainingMs: remainingMs
  };
  pendingConfigTickAt = now;
  pendingConfigAdvanceInFlight = true;
  browser.runtime
    .sendMessage({
      type: "ADVANCE_PENDING_CONFIG_CHANGE",
      elapsedMs: elapsedMs
    })
    .then((response) => {
      pendingConfigChange = response && response.pending ? response.pending : null;
      if (!pendingConfigChange) {
        renderPendingConfigChange();
        renderSites();
        return;
      }

      pendingConfigTickAt = Date.now();
      setPendingConfigTimerText(getPendingConfigRemainingMs());
    })
    .catch(() => {
      // Background may be unavailable while the popup is closing.
    })
    .finally(() => {
      pendingConfigAdvanceInFlight = false;
      schedulePendingConfigTimerTick();
    });
}

function flushPendingConfigChange() {
  if (!isPendingConfigHoverGated() || !pendingConfigHoverActive || !pendingConfigTickAt) return;

  const now = Date.now();
  const elapsedMs = Math.max(0, now - pendingConfigTickAt);
  if (elapsedMs <= 0) return;

  const remainingMs = Math.max(0, (pendingConfigChange.remainingMs || 0) - elapsedMs);
  pendingConfigChange = {
    ...pendingConfigChange,
    remainingMs: remainingMs
  };
  pendingConfigTickAt = now;
  setPendingConfigTimerText(remainingMs);

  try {
    const request = browser.runtime.sendMessage({
      type: "ADVANCE_PENDING_CONFIG_CHANGE",
      elapsedMs: elapsedMs
    });
    if (request && typeof request.catch === "function") {
      request.catch(() => {
        // Popup teardown can interrupt async message delivery.
      });
    }
  } catch {
    // Popup is closing or the extension context is no longer available.
  }
}

function refreshPendingConfigChange() {
  return browser.runtime.sendMessage({ type: "GET_PENDING_CONFIG_CHANGE" }).then((response) => {
    pendingConfigChange = response && response.pending ? response.pending : null;
    renderPendingConfigChange();
    renderSites();
  });
}

function startPendingConfigChange(change) {
  clearPendingRemove();
  browser.runtime
    .sendMessage({
      type: "START_PENDING_CONFIG_CHANGE",
      change: change
    })
    .then((response) => {
      pendingConfigChange = response && response.pending ? response.pending : null;
      renderPendingConfigChange();
      renderSites();
      renderCooldown();
    });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingConfigChange();
  }
});

window.addEventListener("pagehide", flushPendingConfigChange);

setInterval(() => {
  renderDailyLockStatus();
  renderCooldown();
  updateSiteUsageLabels();
}, 1000);
