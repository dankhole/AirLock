// Airlock - Popup Configuration UI

const enabledToggle = document.getElementById("enabled-toggle");
const delayInput = document.getElementById("delay-input");
const siteList = document.getElementById("site-list");
const addSiteForm = document.getElementById("add-site-form");
const siteInput = document.getElementById("site-input");
const addCurrentBtn = document.getElementById("add-current-btn");

let sites = [];
let pendingRemove = null;

// --- Load config from storage ---

browser.storage.local.get(["enabled", "sites", "delaySeconds"]).then((result) => {
  const enabled = result.enabled !== false;
  enabledToggle.checked = enabled;

  delayInput.value = result.delaySeconds || 30;

  sites = result.sites || [];
  renderSites();
});

// --- "Add current site" button ---

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab || !tab.url) return;
  const domain = cleanDomain(tab.url);
  if (!domain || domain.length < 3 || !domain.includes(".")) return;
  addCurrentBtn.textContent = "Track " + domain;
  addCurrentBtn.style.display = "block";
  addCurrentBtn.addEventListener("click", () => {
    if (sites.includes(domain)) return;
    sites.push(domain);
    sites.sort();
    browser.storage.local.set({ sites: sites });
    renderSites();
    addCurrentBtn.style.display = "none";
  });
});

// --- Toggle ---

enabledToggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: enabledToggle.checked });
});

// --- Delay ---

delayInput.addEventListener("change", () => {
  let val = parseInt(delayInput.value, 10);
  if (isNaN(val) || val < 1) val = 1;
  if (val > 600) val = 600;
  delayInput.value = val;
  browser.storage.local.set({ delaySeconds: val });
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
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pendingRemove === site) {
        removeSite(site);
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

  // Hide "add current site" if the domain is already tracked
  if (addCurrentBtn.style.display !== "none") {
    const btnDomain = addCurrentBtn.textContent.replace("Track ", "");
    if (sites.includes(btnDomain)) {
      addCurrentBtn.style.display = "none";
    }
  }
}

function clearPendingRemove() {
  if (pendingRemove === null) return;
  pendingRemove = null;
  siteList.querySelectorAll(".confirm-remove").forEach((el) => {
    el.classList.remove("confirm-remove");
    el.querySelector("button").textContent = "\u00d7";
  });
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

function removeSite(site) {
  sites = sites.filter((s) => s !== site);
  browser.storage.local.set({ sites: sites });
  renderSites();
}
