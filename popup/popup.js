// Airlock - Popup Configuration UI

const enabledToggle = document.getElementById("enabled-toggle");
const delayInput = document.getElementById("delay-input");
const resetInput = document.getElementById("reset-input");
const siteList = document.getElementById("site-list");
const addSiteForm = document.getElementById("add-site-form");
const siteInput = document.getElementById("site-input");
const addCurrentBtn = document.getElementById("add-current-btn");
const addSiteBtn = document.getElementById("add-site-btn");
const pendingConfigSection = document.getElementById("pending-config-section");
const pendingConfigTitle = document.getElementById("pending-config-title");
const pendingConfigTimer = document.getElementById("pending-config-timer");
const pendingConfigCancel = document.getElementById("pending-config-cancel");

let sites = [];
let delayMinutes = 1;
let resetHours = 24;
let currentDomain = null;
let pendingRemove = null;
let pendingConfigChange = null;
let pendingConfigInterval = null;
let pendingConfigTickAt = null;
let pendingConfigAdvanceInFlight = false;
let pendingConfigRefreshInFlight = false;

// --- Load config from storage ---

browser.storage.local.get(["enabled", "sites", "delayMinutes", "resetHours"]).then((result) => {
  enabledToggle.checked = result.enabled !== false;

  delayMinutes = normalizeDelayMinutes(result.delayMinutes || 1);
  resetHours = normalizeResetHours(result.resetHours || 24);
  delayInput.value = delayMinutes;
  resetInput.value = resetHours;

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

  resetHours = val;
  resetInput.value = resetHours;
  browser.storage.local.set({ resetHours: resetHours });
});

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

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled) {
    enabledToggle.checked = changes.enabled.newValue !== false;
  }

  if (changes.delayMinutes) {
    delayMinutes = normalizeDelayMinutes(changes.delayMinutes.newValue || 1);
    delayInput.value = delayMinutes;
  }

  if (changes.resetHours) {
    resetHours = normalizeResetHours(changes.resetHours.newValue || 24);
    resetInput.value = resetHours;
  }

  if (changes.sites) {
    sites = changes.sites.newValue || [];
    renderSites();
  }

  if (changes.pendingConfigChange) {
    pendingConfigChange = changes.pendingConfigChange.newValue || null;
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
  siteInput.disabled = locked;
  addSiteBtn.disabled = locked;
  addCurrentBtn.disabled = locked;

  siteList.querySelectorAll("button").forEach((btn) => {
    btn.disabled = locked;
  });
}

function renderPendingConfigChange() {
  if (pendingConfigInterval) {
    clearInterval(pendingConfigInterval);
    pendingConfigInterval = null;
  }
  pendingConfigTickAt = null;
  pendingConfigAdvanceInFlight = false;

  if (!pendingConfigChange) {
    pendingConfigSection.hidden = true;
    pendingConfigTitle.textContent = "";
    pendingConfigTimer.textContent = "0:00";
    setControlsLocked(false);
    return;
  }

  clearPendingRemove();
  pendingConfigSection.hidden = false;
  pendingConfigTitle.textContent = pendingConfigChange.description || getPendingConfigTitle(pendingConfigChange);
  setControlsLocked(true);
  pendingConfigTickAt = Date.now();
  updatePendingConfigTimer();
  pendingConfigInterval = setInterval(updatePendingConfigTimer, 250);
}

function getPendingConfigTitle(pending) {
  if (pending.type === "removeSite") {
    return "Removing " + pending.site;
  }

  if (pending.type === "reduceDelay") {
    const unit = pending.delayMinutes === 1 ? "minute" : "minutes";
    return "Reducing wait to " + pending.delayMinutes + " " + unit;
  }

  return "Updating settings";
}

function updatePendingConfigTimer() {
  if (!pendingConfigChange) return;

  const remainingMs = getPendingConfigRemainingMs();
  pendingConfigTimer.textContent = formatTime(remainingMs);

  if (pendingConfigChange.type === "removeSite") {
    advanceRemoveSitePendingChange(remainingMs);
    return;
  }

  if (remainingMs <= 0 && !pendingConfigRefreshInFlight) {
    pendingConfigRefreshInFlight = true;
    refreshPendingConfigChange().finally(() => {
      pendingConfigRefreshInFlight = false;
    });
  }
}

function getPendingConfigRemainingMs() {
  if (pendingConfigChange.type === "removeSite") {
    const tickAt = pendingConfigTickAt || Date.now();
    const elapsedMs = Math.max(0, Date.now() - tickAt);
    return Math.max(0, (pendingConfigChange.remainingMs || 0) - elapsedMs);
  }

  return Math.max(0, pendingConfigChange.unlockAt - Date.now());
}

function advanceRemoveSitePendingChange(remainingMs) {
  if (pendingConfigAdvanceInFlight || !pendingConfigTickAt) return;

  const now = Date.now();
  const elapsedMs = Math.max(0, now - pendingConfigTickAt);
  if (elapsedMs < 250 && remainingMs > 0) return;

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
      pendingConfigTimer.textContent = formatTime(getPendingConfigRemainingMs());
    })
    .catch(() => {
      // Background may be unavailable while the popup is closing.
    })
    .finally(() => {
      pendingConfigAdvanceInFlight = false;
    });
}

function flushRemoveSitePendingChange() {
  if (!pendingConfigChange || pendingConfigChange.type !== "removeSite" || !pendingConfigTickAt) return;

  const now = Date.now();
  const elapsedMs = Math.max(0, now - pendingConfigTickAt);
  if (elapsedMs <= 0) return;

  pendingConfigTickAt = now;
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
    });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushRemoveSitePendingChange();
  }
});

window.addEventListener("pagehide", flushRemoveSitePendingChange);
