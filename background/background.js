// Airlock - Background Service Worker
// Manages timer sessions, focus tracking, badge, and message coordination.

const DEFAULT_CONFIG = {
  enabled: true,
  sites: [],
  delaySeconds: 30
};

const PENDING_CONFIG_CHANGE_KEY = "pendingConfigChange";
const PENDING_CONFIG_CHANGE_ALARM = "airlock.pendingConfigChange";
const SESSION_RESET_ALARM = "airlock.sessionReset";
const SESSION_RESET_MS = 24 * 60 * 60 * 1000;

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
  await reconcilePendingConfigChange();
  await reconcileExpiredSessions();
});

browser.runtime.onStartup.addListener(() => {
  reconcilePendingConfigChange().catch((error) => {
    console.warn("[Airlock] Failed to reconcile pending config change:", error);
  });
  reconcileExpiredSessions().catch((error) => {
    console.warn("[Airlock] Failed to reconcile expired sessions:", error);
  });
});

reconcilePendingConfigChange().catch((error) => {
  console.warn("[Airlock] Failed to reconcile pending config change:", error);
});
reconcileExpiredSessions().catch((error) => {
  console.warn("[Airlock] Failed to reconcile expired sessions:", error);
});

// --- Helpers ---

function getSessionKey(tabId) {
  return "session_" + tabId;
}

async function readConfig() {
  const result = await browser.storage.local.get(["enabled", "sites", "delaySeconds"]);
  return {
    enabled: result.enabled !== false,
    sites: result.sites || [],
    delaySeconds: clampDelaySeconds(result.delaySeconds || DEFAULT_CONFIG.delaySeconds)
  };
}

async function getConfig() {
  await reconcilePendingConfigChange();
  return readConfig();
}

function isDomainTracked(hostname, sites) {
  return sites.some((site) => hostname === site || hostname.endsWith("." + site));
}

function clampDelaySeconds(value) {
  let seconds = parseInt(value, 10);
  if (isNaN(seconds) || seconds < 1) seconds = 1;
  if (seconds > 600) seconds = 600;
  return seconds;
}

async function getSession(tabId) {
  const key = getSessionKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] || null;
}

async function setSession(tabId, session) {
  const key = getSessionKey(tabId);
  await browser.storage.session.set({ [key]: session });
  await scheduleSessionResetAlarm();
}

async function removeSession(tabId) {
  const key = getSessionKey(tabId);
  await browser.storage.session.remove(key);
  await scheduleSessionResetAlarm();
}

function getTabIdFromSessionKey(key) {
  const match = /^session_(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

async function getAllSessions() {
  const result = await browser.storage.session.get(null);
  return Object.entries(result)
    .map(([key, session]) => ({
      key: key,
      tabId: getTabIdFromSessionKey(key),
      session: session
    }))
    .filter((entry) => entry.tabId !== null && entry.session && entry.session.domain);
}

function createTimerSession(domain, delaySeconds, now = Date.now()) {
  const remainingMs = delaySeconds * 1000;
  return {
    domain: domain,
    createdAt: now,
    expiresAt: now + SESSION_RESET_MS,
    remainingMs: remainingMs
  };
}

function isSessionExpired(session, now = Date.now()) {
  return Boolean(session.expiresAt && session.expiresAt <= now);
}

async function scheduleSessionResetAlarm() {
  if (!browser.alarms) return;

  const config = await readConfig();
  const sessions = await getAllSessions();
  const nextExpiresAt = sessions
    .filter((entry) => config.enabled && isDomainTracked(entry.session.domain, config.sites))
    .map((entry) => entry.session.expiresAt)
    .filter((expiresAt) => typeof expiresAt === "number" && expiresAt > Date.now())
    .sort((a, b) => a - b)[0];

  if (!nextExpiresAt) {
    await browser.alarms.clear(SESSION_RESET_ALARM);
    return;
  }

  await browser.alarms.create(SESSION_RESET_ALARM, {
    when: nextExpiresAt
  });
}

// --- Badge ---

async function updateBadge() {
  const config = await readConfig();
  const allSession = await browser.storage.session.get(null);
  const activeCount = Object.values(allSession).filter(
    (s) =>
      s &&
      s.domain &&
      !s.completed &&
      s.remainingMs > 0 &&
      config.enabled &&
      isDomainTracked(s.domain, config.sites)
  ).length;

  if (activeCount > 0) {
    await browser.action.setBadgeText({ text: String(activeCount) });
    await browser.action.setBadgeBackgroundColor({ color: "#5b8def" });
  } else {
    await browser.action.setBadgeText({ text: "" });
  }
}

// --- Guarded Config Changes ---

async function readPendingConfigChange() {
  const result = await browser.storage.local.get(PENDING_CONFIG_CHANGE_KEY);
  return result[PENDING_CONFIG_CHANGE_KEY] || null;
}

async function schedulePendingConfigChange(pending) {
  if (!browser.alarms) return;

  if (!pending) {
    await browser.alarms.clear(PENDING_CONFIG_CHANGE_ALARM);
    return;
  }

  await browser.alarms.create(PENDING_CONFIG_CHANGE_ALARM, {
    when: pending.unlockAt
  });
}

function describePendingConfigChange(pending) {
  if (pending.type === "removeSite") {
    return "Removing " + pending.site;
  }

  if (pending.type === "reduceDelay") {
    return "Reducing delay to " + pending.delaySeconds + " seconds";
  }

  return "Updating settings";
}

async function startPendingConfigChange(change) {
  await reconcilePendingConfigChange();

  const existing = await readPendingConfigChange();
  if (existing) {
    return { ok: false, reason: "pending-exists", pending: existing };
  }

  const config = await readConfig();
  const startedAt = Date.now();
  const waitSeconds = clampDelaySeconds(config.delaySeconds);
  const pendingBase = {
    id: String(startedAt),
    startedAt: startedAt,
    unlockAt: startedAt + waitSeconds * 1000,
    waitSeconds: waitSeconds
  };

  let pending = null;

  if (change.type === "removeSite") {
    const site = String(change.site || "").trim().toLowerCase();
    if (!site || !config.sites.includes(site)) {
      return { ok: false, reason: "site-not-tracked", pending: null };
    }

    pending = {
      ...pendingBase,
      type: "removeSite",
      site: site
    };
  } else if (change.type === "reduceDelay") {
    const delaySeconds = clampDelaySeconds(change.delaySeconds);

    if (delaySeconds >= config.delaySeconds) {
      await browser.storage.local.set({ delaySeconds: delaySeconds });
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "reduceDelay",
      delaySeconds: delaySeconds
    };
  } else {
    return { ok: false, reason: "unknown-change", pending: null };
  }

  pending.description = describePendingConfigChange(pending);
  await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: pending });
  await schedulePendingConfigChange(pending);

  return { ok: true, applied: false, pending: pending };
}

async function cancelPendingConfigChange() {
  await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
  await schedulePendingConfigChange(null);
  return { ok: true, pending: null };
}

async function reconcilePendingConfigChange() {
  const pending = await readPendingConfigChange();
  if (!pending) {
    await schedulePendingConfigChange(null);
    return null;
  }

  if (!pending.type || !pending.unlockAt) {
    await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
    await schedulePendingConfigChange(null);
    return null;
  }

  if (pending.unlockAt > Date.now()) {
    await schedulePendingConfigChange(pending);
    return pending;
  }

  const config = await readConfig();

  if (pending.type === "removeSite") {
    const nextSites = config.sites.filter((site) => site !== pending.site);
    await browser.storage.local.set({ sites: nextSites });
  } else if (pending.type === "reduceDelay") {
    const delaySeconds = clampDelaySeconds(pending.delaySeconds);
    if (delaySeconds < config.delaySeconds && config.delaySeconds <= pending.waitSeconds) {
      await browser.storage.local.set({ delaySeconds: delaySeconds });
    }
  }

  await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
  await schedulePendingConfigChange(null);
  await scheduleSessionResetAlarm();
  await updateBadge();

  return null;
}

async function reconcileExpiredSessions() {
  const config = await readConfig();
  const sessions = await getAllSessions();
  const now = Date.now();

  for (const { key, tabId, session } of sessions) {
    let currentSession = session;

    if (!currentSession.expiresAt) {
      const createdAt = currentSession.createdAt || now;
      currentSession = {
        ...currentSession,
        createdAt: createdAt,
        expiresAt: createdAt + SESSION_RESET_MS
      };
      await browser.storage.session.set({ [key]: currentSession });
    }

    if (!isSessionExpired(currentSession, now)) continue;
    if (!config.enabled || !isDomainTracked(currentSession.domain, config.sites)) continue;

    const nextSession = createTimerSession(currentSession.domain, config.delaySeconds, now);
    await browser.storage.session.set({ [key]: nextSession });

    try {
      await browser.tabs.sendMessage(tabId, {
        type: "RESET_TIMER",
        remainingMs: nextSession.remainingMs
      });
    } catch {
      // Tab may not have an active content script. The next page load will read the reset session.
    }
  }

  await scheduleSessionResetAlarm();
  await updateBadge();
}

if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PENDING_CONFIG_CHANGE_ALARM) {
      reconcilePendingConfigChange().catch((error) => {
        console.warn("[Airlock] Failed to apply pending config change:", error);
      });
    } else if (alarm.name === SESSION_RESET_ALARM) {
      reconcileExpiredSessions().catch((error) => {
        console.warn("[Airlock] Failed to reset expired sessions:", error);
      });
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled || changes.sites || changes.delaySeconds) {
    reconcileExpiredSessions().catch((error) => {
      console.warn("[Airlock] Failed to reconcile expired sessions:", error);
    });
  }
});

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
  if (message.type === "GET_PENDING_CONFIG_CHANGE") {
    reconcilePendingConfigChange().then((pending) => {
      sendResponse({ pending: pending });
    });
    return true;
  }

  if (message.type === "START_PENDING_CONFIG_CHANGE") {
    startPendingConfigChange(message.change || {}).then(sendResponse);
    return true;
  }

  if (message.type === "CANCEL_PENDING_CONFIG_CHANGE") {
    cancelPendingConfigChange().then(sendResponse);
    return true;
  }

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
  const now = Date.now();

  if (session && session.domain === domain) {
    if (!session.expiresAt) {
      const createdAt = session.createdAt || now;
      session = {
        ...session,
        createdAt: createdAt,
        expiresAt: createdAt + SESSION_RESET_MS
      };
      await setSession(tabId, session);
    }

    if (isSessionExpired(session, now)) {
      const nextSession = createTimerSession(domain, config.delaySeconds, now);
      await setSession(tabId, nextSession);
      return {
        type: "SHOW_OVERLAY",
        remainingMs: nextSession.remainingMs,
        resetAt: nextSession.expiresAt
      };
    }

    if (session.completed) {
      return { type: "NO_OVERLAY", resetAt: session.expiresAt };
    }
    if (session.remainingMs <= 0) {
      return { type: "NO_OVERLAY", resetAt: session.expiresAt };
    }
    return {
      type: "SHOW_OVERLAY",
      remainingMs: session.remainingMs,
      resetAt: session.expiresAt
    };
  }

  const nextSession = createTimerSession(domain, config.delaySeconds, now);
  await setSession(tabId, nextSession);
  return {
    type: "SHOW_OVERLAY",
    remainingMs: nextSession.remainingMs,
    resetAt: nextSession.expiresAt
  };
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
