// Airlock - Popup Configuration UI

const enabledToggle = document.getElementById("enabled-toggle");
const delayInput = document.getElementById("delay-input");
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
let delaySeconds = 30;
let currentDomain = null;
let pendingRemove = null;
let pendingConfigChange = null;
let pendingConfigInterval = null;
let pendingConfigRefreshInFlight = false;

// --- Load config from storage ---

browser.storage.local.get(["enabled", "sites", "delaySeconds"]).then((result) => {
  enabledToggle.checked = result.enabled !== false;

  delaySeconds = normalizeDelaySeconds(result.delaySeconds || 30);
  delayInput.value = delaySeconds;

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
  const val = normalizeDelaySeconds(delayInput.value);

  if (pendingConfigChange) {
    delayInput.value = delaySeconds;
    return;
  }

  if (val >= delaySeconds) {
    delaySeconds = val;
    delayInput.value = delaySeconds;
    browser.storage.local.set({ delaySeconds: delaySeconds });
    return;
  }

  delayInput.value = delaySeconds;
  startPendingConfigChange({
    type: "reduceDelay",
    delaySeconds: val
  });
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

  if (changes.delaySeconds) {
    delaySeconds = normalizeDelaySeconds(changes.delaySeconds.newValue || 30);
    delayInput.value = delaySeconds;
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

function normalizeDelaySeconds(value) {
  let seconds = parseInt(value, 10);
  if (isNaN(seconds) || seconds < 1) seconds = 1;
  if (seconds > 600) seconds = 600;
  return seconds;
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
  updatePendingConfigTimer();
  pendingConfigInterval = setInterval(updatePendingConfigTimer, 250);
}

function getPendingConfigTitle(pending) {
  if (pending.type === "removeSite") {
    return "Removing " + pending.site;
  }

  if (pending.type === "reduceDelay") {
    return "Reducing delay to " + pending.delaySeconds + " seconds";
  }

  return "Updating settings";
}

function updatePendingConfigTimer() {
  if (!pendingConfigChange) return;

  const remainingMs = Math.max(0, pendingConfigChange.unlockAt - Date.now());
  pendingConfigTimer.textContent = formatTime(remainingMs);

  if (remainingMs <= 0 && !pendingConfigRefreshInFlight) {
    pendingConfigRefreshInFlight = true;
    refreshPendingConfigChange().finally(() => {
      pendingConfigRefreshInFlight = false;
    });
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
