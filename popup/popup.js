// Airlock - Popup Configuration UI

const dailyLockApi = globalThis.AirlockDailyLock;
const enabledToggle = document.getElementById("enabled-toggle");
const delayInput = document.getElementById("delay-input");
const resetInput = document.getElementById("reset-input");
const hoverTargetToggle = document.getElementById("hover-target-toggle");
const guardInput = document.getElementById("guard-input");
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
const PENDING_CONFIG_TICK_MS = 250;
const PENDING_CONFIG_SYNC_MS = 1000;

let sites = [];
let delayMinutes = 1;
let resetHours = 24;
let requireHoverTarget = false;
let guardMinutes = 1;
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
  "requireHoverTarget",
  "guardMinutes",
  "cooldownUntil",
  "dailyLockEnabled",
  "dailyLockStart",
  "dailyLockEnd"
]).then((result) => {
  enabledToggle.checked = result.enabled !== false;

  delayMinutes = normalizeDelayMinutes(result.delayMinutes || 1);
  resetHours = normalizeResetHours(result.resetHours || 24);
  requireHoverTarget = result.requireHoverTarget === true;
  guardMinutes = normalizeGuardMinutes(result.guardMinutes || 1);
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
  hoverTargetToggle.checked = requireHoverTarget;
  guardInput.value = guardMinutes;
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

  browser.storage.local.set({ enabled: enabledToggle.checked });
});

// --- Delay ---

delayInput.addEventListener("change", () => {
  const val = normalizeDelayMinutes(delayInput.value);

  if (pendingConfigChange) {
    delayInput.value = delayMinutes;
    return;
  }

  if (val > delayMinutes && !confirmSettingIncrease("wait", delayMinutes, val, "minute")) {
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

  if (val > resetHours && !confirmSettingIncrease("reset window", resetHours, val, "hour")) {
    resetInput.value = resetHours;
    return;
  }

  resetHours = val;
  resetInput.value = resetHours;
  browser.storage.local.set({ resetHours: resetHours });
});

guardInput.addEventListener("change", () => {
  const val = normalizeGuardMinutes(guardInput.value);

  if (pendingConfigChange) {
    guardInput.value = guardMinutes;
    return;
  }

  if (val > guardMinutes && !confirmSettingIncrease("unlock hold", guardMinutes, val, "minute")) {
    guardInput.value = guardMinutes;
    return;
  }

  if (val >= guardMinutes) {
    guardMinutes = val;
    guardInput.value = guardMinutes;
    browser.storage.local.set({ guardMinutes: guardMinutes });
    return;
  }

  guardInput.value = guardMinutes;
  startPendingConfigChange({
    type: "reduceGuardMinutes",
    guardMinutes: val
  });
});

// --- Hover Target ---

hoverTargetToggle.addEventListener("change", () => {
  const nextRequireHoverTarget = hoverTargetToggle.checked === true;

  if (pendingConfigChange) {
    hoverTargetToggle.checked = requireHoverTarget;
    return;
  }

  if (nextRequireHoverTarget) {
    if (!window.confirm("Turn on hover target? The timer will only count down while the pointer is on the overlay target.")) {
      hoverTargetToggle.checked = requireHoverTarget;
      return;
    }

    requireHoverTarget = true;
    hoverTargetToggle.checked = true;
    browser.storage.local.set({ requireHoverTarget: true });
    return;
  }

  hoverTargetToggle.checked = requireHoverTarget;
  startPendingConfigChange({
    type: "disableHoverTarget"
  });
});

// --- Cooldown ---

cooldownBtn.addEventListener("click", () => {
  if (pendingConfigChange) return;

  if (isCooldownActive()) {
    startPendingConfigChange({
      type: "endCooldown",
      cooldownUntil: cooldownUntil
    });
    return;
  }

  if (sites.length === 0) return;
  if (!window.confirm("Start a one-hour cooldown? All tracked sites will stay blocked until it ends.")) {
    return;
  }

  browser.runtime.sendMessage({ type: "START_COOLDOWN" }).then((response) => {
    cooldownUntil = normalizeCooldownUntil(response && response.cooldownUntil);
    renderCooldown();
  });
});

// --- Daily Lock ---

dailyLockToggle.addEventListener("change", () => {
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
    !window.confirm(
      "Turn on the daily lock from " +
        formatTimeOfDayLabel(schedule.start) +
        " to " +
        formatTimeOfDayLabel(schedule.end) +
        "? Tracked sites cannot be opened during this window."
    )
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

  const currentDuration = dailyLockApi.getDurationMinutes(dailyLockStart, dailyLockEnd);
  const nextDuration = dailyLockApi.getDurationMinutes(schedule.start, schedule.end);

  if (dailyLockEnabled && nextDuration < currentDuration) {
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

    const span = document.createElement("span");
    span.textContent = site;

    const btn = document.createElement("button");
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

    li.appendChild(span);
    li.appendChild(btn);
    siteList.appendChild(li);
  });

  setControlsLocked(Boolean(pendingConfigChange));

  renderAddCurrentButton();
  renderCooldown();
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

  if (changes.requireHoverTarget) {
    requireHoverTarget = changes.requireHoverTarget.newValue === true;
    hoverTargetToggle.checked = requireHoverTarget;
  }

  if (changes.guardMinutes) {
    guardMinutes = normalizeGuardMinutes(changes.guardMinutes.newValue || 1);
    guardInput.value = guardMinutes;
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

function normalizeGuardMinutes(value) {
  let minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 60) minutes = 60;
  return minutes;
}

function confirmSettingIncrease(label, currentValue, nextValue, unit) {
  const currentUnit = currentValue === 1 ? unit : unit + "s";
  const nextUnit = nextValue === 1 ? unit : unit + "s";
  return window.confirm(
    "Increase " +
      label +
      " from " +
      currentValue +
      " " +
      currentUnit +
      " to " +
      nextValue +
      " " +
      nextUnit +
      "?"
  );
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
  hoverTargetToggle.disabled = locked;
  guardInput.disabled = locked;
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

  if (pending.type === "reduceDelay") {
    const unit = pending.delayMinutes === 1 ? "minute" : "minutes";
    return "Reducing wait to " + pending.delayMinutes + " " + unit;
  }

  if (pending.type === "disableHoverTarget") {
    return "Disabling hover target";
  }

  if (pending.type === "reduceGuardMinutes") {
    const unit = pending.guardMinutes === 1 ? "minute" : "minutes";
    return "Reducing settings hold to " + pending.guardMinutes + " " + unit;
  }

  if (pending.type === "endCooldown") {
    return "Ending cooldown early";
  }

  if (pending.type === "disableDailyLock") {
    return "Turning off daily lock";
  }

  if (pending.type === "changeDailyLockSchedule") {
    return "Shortening daily lock";
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
}, 1000);
