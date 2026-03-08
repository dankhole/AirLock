// Airlock - Background Service Worker
// Manages timer sessions, focus tracking, badge, and message coordination.

const DEFAULT_CONFIG = {
  enabled: true,
  sites: [],
  delaySeconds: 30
};

// --- Initialization ---

browser.runtime.onInstalled.addListener(async () => {
  const existing = await browser.storage.local.get(["enabled", "sites", "delaySeconds"]);
  const defaults = {};
  if (existing.enabled === undefined) defaults.enabled = DEFAULT_CONFIG.enabled;
  if (existing.sites === undefined) defaults.sites = DEFAULT_CONFIG.sites;
  if (existing.delaySeconds === undefined) defaults.delaySeconds = DEFAULT_CONFIG.delaySeconds;
  if (Object.keys(defaults).length > 0) {
    await browser.storage.local.set(defaults);
  }
});

// --- Helpers ---

function getSessionKey(tabId) {
  return "session_" + tabId;
}

async function getConfig() {
  const result = await browser.storage.local.get(["enabled", "sites", "delaySeconds"]);
  return {
    enabled: result.enabled !== false,
    sites: result.sites || [],
    delaySeconds: result.delaySeconds || 30
  };
}

function isDomainTracked(hostname, sites) {
  return sites.some((site) => hostname === site || hostname.endsWith("." + site));
}

async function getSession(tabId) {
  const key = getSessionKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] || null;
}

async function setSession(tabId, session) {
  const key = getSessionKey(tabId);
  await browser.storage.session.set({ [key]: session });
}

async function removeSession(tabId) {
  const key = getSessionKey(tabId);
  await browser.storage.session.remove(key);
}

// --- Badge ---

async function updateBadge() {
  const allSession = await browser.storage.session.get(null);
  const activeCount = Object.values(allSession).filter(
    (s) => s && s.domain && !s.completed && s.remainingMs > 0
  ).length;

  if (activeCount > 0) {
    await browser.action.setBadgeText({ text: String(activeCount) });
    await browser.action.setBadgeBackgroundColor({ color: "#5b8def" });
  } else {
    await browser.action.setBadgeText({ text: "" });
  }
}

// --- Tab Cleanup ---

browser.tabs.onRemoved.addListener((tabId) => {
  removeSession(tabId).then(updateBadge);
});

// --- Focus / Activation Tracking ---

let currentActiveTabId = null;
let windowFocused = true;

browser.tabs.onActivated.addListener(async (activeInfo) => {
  const prevTabId = currentActiveTabId;
  currentActiveTabId = activeInfo.tabId;

  if (prevTabId !== null && prevTabId !== currentActiveTabId) {
    try {
      await browser.tabs.sendMessage(prevTabId, { type: "PAUSE" });
    } catch {
      // Tab may not have content script
    }
  }

  if (windowFocused) {
    try {
      await browser.tabs.sendMessage(currentActiveTabId, { type: "RESUME" });
    } catch {
      // Tab may not have content script
    }
  }
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  const wasFocused = windowFocused;
  windowFocused = windowId !== browser.windows.WINDOW_ID_NONE;

  if (currentActiveTabId === null) return;

  await new Promise((r) => setTimeout(r, 150));

  if (!windowFocused && wasFocused) {
    try {
      await browser.tabs.sendMessage(currentActiveTabId, { type: "PAUSE" });
    } catch {
      // Tab may not have content script
    }
  } else if (windowFocused && !wasFocused) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentActiveTabId = tab.id;
        await browser.tabs.sendMessage(currentActiveTabId, { type: "RESUME" });
      }
    } catch {
      // Ignore
    }
  }
});

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab) currentActiveTabId = tab.id;
});

// --- Message Handling ---

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (message.type === "CONTENT_READY") {
    handleContentReady(tabId, message.domain).then((response) => {
      updateBadge();
      sendResponse(response);
    });
    return true;
  }

  if (message.type === "TIMER_UPDATE") {
    handleTimerUpdate(tabId, message.remainingMs);
  }

  if (message.type === "TIMER_DONE") {
    handleTimerDone(tabId).then(updateBadge);
  }
});

async function handleContentReady(tabId, domain) {
  const config = await getConfig();

  if (!config.enabled || !isDomainTracked(domain, config.sites)) {
    return { type: "NO_OVERLAY" };
  }

  let session = await getSession(tabId);

  if (session && session.domain === domain) {
    if (session.completed) {
      return { type: "NO_OVERLAY" };
    }
    if (session.remainingMs <= 0) {
      return { type: "NO_OVERLAY" };
    }
    return { type: "SHOW_OVERLAY", remainingMs: session.remainingMs };
  }

  const remainingMs = config.delaySeconds * 1000;
  await setSession(tabId, {
    domain: domain,
    remainingMs: remainingMs
  });
  return { type: "SHOW_OVERLAY", remainingMs: remainingMs };
}

async function handleTimerDone(tabId) {
  const session = await getSession(tabId);
  if (session) {
    session.remainingMs = 0;
    session.completed = true;
    await setSession(tabId, session);
  }
}

async function handleTimerUpdate(tabId, remainingMs) {
  const session = await getSession(tabId);
  if (session) {
    session.remainingMs = remainingMs;
    await setSession(tabId, session);
  }
}
