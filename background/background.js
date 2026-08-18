// Airlock - Background Service Worker
// Manages timer sessions, focus tracking, badge, and message coordination.

const dailyLockApi = globalThis.AirlockDailyLock;
const DEFAULT_CONFIG = {
  enabled: true,
  sites: [],
  delayMinutes: 1,
  resetHours: 24,
  requireHoverTarget: false,
  dailyLockEnabled: false,
  dailyLockStart: dailyLockApi.DEFAULT_START,
  dailyLockEnd: dailyLockApi.DEFAULT_END
};

const PENDING_CONFIG_CHANGE_KEY = "pendingConfigChange";
const PENDING_CONFIG_CHANGE_ALARM = "airlock.pendingConfigChange";
const SESSION_RESET_ALARM = "airlock.sessionReset";
const DAILY_LOCK_BOUNDARY_ALARM = "airlock.dailyLockBoundary";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// --- Initialization ---

browser.runtime.onInstalled.addListener(async () => {
  await migrateStoredConfig();
  await reconcilePendingConfigChange();
  await reconcileExpiredSessions();
  await scheduleDailyLockBoundaryAlarm();
});

browser.runtime.onStartup.addListener(() => {
  reconcileStartupState();
});

reconcileStartupState();

// --- Helpers ---

function getSessionKey(tabId) {
  return "session_" + tabId;
}

async function reconcileStartupState() {
  try {
    await migrateStoredConfig();
    await reconcilePendingConfigChange();
    await reconcileExpiredSessions();
    await scheduleDailyLockBoundaryAlarm();
    await broadcastConfigRecheck();
  } catch (error) {
    console.warn("[Airlock] Failed to reconcile startup state:", error);
  }
}

async function migrateStoredConfig() {
  const existing = await browser.storage.local.get([
    "enabled",
    "sites",
    "delayMinutes",
    "delaySeconds",
    "resetHours",
    "requireHoverTarget",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd"
  ]);
  const updates = {};

  if (existing.enabled === undefined) updates.enabled = DEFAULT_CONFIG.enabled;
  if (existing.sites === undefined) updates.sites = DEFAULT_CONFIG.sites;

  if (existing.delayMinutes === undefined) {
    updates.delayMinutes = DEFAULT_CONFIG.delayMinutes;
  } else {
    const delayMinutes = clampDelayMinutes(existing.delayMinutes);
    if (delayMinutes !== existing.delayMinutes) updates.delayMinutes = delayMinutes;
  }

  if (existing.resetHours === undefined) {
    updates.resetHours = DEFAULT_CONFIG.resetHours;
  } else {
    const resetHours = clampResetHours(existing.resetHours);
    if (resetHours !== existing.resetHours) updates.resetHours = resetHours;
  }

  if (existing.requireHoverTarget === undefined) {
    updates.requireHoverTarget = DEFAULT_CONFIG.requireHoverTarget;
  } else {
    const requireHoverTarget = normalizeRequireHoverTarget(existing.requireHoverTarget);
    if (requireHoverTarget !== existing.requireHoverTarget) {
      updates.requireHoverTarget = requireHoverTarget;
    }
  }

  const dailyLockStart = dailyLockApi.normalizeTimeOfDay(
    existing.dailyLockStart,
    DEFAULT_CONFIG.dailyLockStart
  );
  const dailyLockEnd = dailyLockApi.normalizeTimeOfDay(
    existing.dailyLockEnd,
    DEFAULT_CONFIG.dailyLockEnd
  );

  if (existing.dailyLockStart !== dailyLockStart) {
    updates.dailyLockStart = dailyLockStart;
  }
  if (existing.dailyLockEnd !== dailyLockEnd) {
    updates.dailyLockEnd = dailyLockEnd;
  }

  const dailyLockEnabled = existing.dailyLockEnabled === true && dailyLockStart !== dailyLockEnd;
  if (existing.dailyLockEnabled !== dailyLockEnabled) {
    updates.dailyLockEnabled = dailyLockEnabled;
  }

  if (Object.keys(updates).length > 0) {
    await browser.storage.local.set(updates);
  }

  if (existing.delaySeconds !== undefined) {
    await browser.storage.local.remove("delaySeconds");
  }
}

async function readConfig() {
  const result = await browser.storage.local.get([
    "enabled",
    "sites",
    "delayMinutes",
    "resetHours",
    "requireHoverTarget",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd"
  ]);
  return {
    enabled: result.enabled !== false,
    sites: result.sites || [],
    delayMinutes: clampDelayMinutes(result.delayMinutes || DEFAULT_CONFIG.delayMinutes),
    resetHours: clampResetHours(result.resetHours || DEFAULT_CONFIG.resetHours),
    requireHoverTarget: normalizeRequireHoverTarget(result.requireHoverTarget),
    dailyLockEnabled: result.dailyLockEnabled === true,
    dailyLockStart: dailyLockApi.normalizeTimeOfDay(
      result.dailyLockStart,
      DEFAULT_CONFIG.dailyLockStart
    ),
    dailyLockEnd: dailyLockApi.normalizeTimeOfDay(
      result.dailyLockEnd,
      DEFAULT_CONFIG.dailyLockEnd
    )
  };
}

async function getConfig() {
  await reconcilePendingConfigChange();
  return readConfig();
}

function isDomainTracked(hostname, sites) {
  return sites.some((site) => hostname === site || hostname.endsWith("." + site));
}

function clampDelayMinutes(value) {
  let minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 600) minutes = 600;
  return minutes;
}

function clampResetHours(value) {
  let hours = parseInt(value, 10);
  if (isNaN(hours) || hours < 1) hours = 1;
  if (hours > 8760) hours = 8760;
  return hours;
}

function normalizeRequireHoverTarget(value) {
  return value === true;
}

function getDailyLockState(config, now = Date.now()) {
  return dailyLockApi.getState(
    {
      enabled: config.enabled && config.dailyLockEnabled,
      start: config.dailyLockStart,
      end: config.dailyLockEnd
    },
    now
  );
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

async function isTabActiveAndFocused(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab || !tab.active) return false;

    const window = await browser.windows.get(tab.windowId);
    return Boolean(window && window.focused);
  } catch {
    return false;
  }
}

async function sendTabMessage(tabId, message) {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch {
    // Tab may not have content script
  }
}

async function sendActiveState(tabId, active) {
  await sendTabMessage(tabId, {
    type: "ACTIVE_STATE",
    active: active
  });
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

function createTimerSession(domain, delayMinutes, resetHours, now = Date.now()) {
  const remainingMs = delayMinutes * MINUTE_MS;
  return {
    domain: domain,
    createdAt: now,
    expiresAt: now + resetHours * HOUR_MS,
    remainingMs: remainingMs
  };
}

function getSessionExpiresAt(session, resetHours) {
  return (session.createdAt || Date.now()) + resetHours * HOUR_MS;
}

function isSessionExpired(session, resetHours, now = Date.now()) {
  return getSessionExpiresAt(session, resetHours) <= now;
}

async function scheduleSessionResetAlarm() {
  if (!browser.alarms) return;

  const config = await readConfig();
  const sessions = await getAllSessions();
  const nextExpiresAt = sessions
    .filter((entry) => config.enabled && isDomainTracked(entry.session.domain, config.sites))
    .map((entry) => getSessionExpiresAt(entry.session, config.resetHours))
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

async function scheduleDailyLockBoundaryAlarm() {
  if (!browser.alarms) return;

  const config = await readConfig();
  const state = getDailyLockState(config);

  if (!state.nextBoundaryAt) {
    await browser.alarms.clear(DAILY_LOCK_BOUNDARY_ALARM);
    return;
  }

  await browser.alarms.create(DAILY_LOCK_BOUNDARY_ALARM, {
    when: state.nextBoundaryAt
  });
}

async function broadcastConfigRecheck() {
  let tabs = [];

  try {
    tabs = await browser.tabs.query({});
  } catch {
    return;
  }

  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) => sendTabMessage(tab.id, { type: "RECHECK_CONFIG" }))
  );
}

async function reconcileDailyLockBoundary() {
  await scheduleDailyLockBoundaryAlarm();
  await broadcastConfigRecheck();
  await updateBadge();
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

  if (!pending || !pending.unlockAt) {
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
    const unit = pending.delayMinutes === 1 ? "minute" : "minutes";
    return "Reducing wait to " + pending.delayMinutes + " " + unit;
  }

  if (pending.type === "disableHoverTarget") {
    return "Disabling hover target";
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
  const waitMinutes = clampDelayMinutes(config.delayMinutes);
  const pendingBase = {
    id: String(startedAt),
    startedAt: startedAt,
    waitMinutes: waitMinutes
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
      site: site,
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "reduceDelay") {
    const delayMinutes = clampDelayMinutes(change.delayMinutes || DEFAULT_CONFIG.delayMinutes);

    if (delayMinutes >= config.delayMinutes) {
      await browser.storage.local.set({ delayMinutes: delayMinutes });
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "reduceDelay",
      remainingMs: waitMinutes * MINUTE_MS,
      delayMinutes: delayMinutes
    };
  } else if (change.type === "disableHoverTarget") {
    if (!config.requireHoverTarget) {
      await browser.storage.local.set({ requireHoverTarget: false });
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "disableHoverTarget",
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else {
    return { ok: false, reason: "unknown-change", pending: null };
  }

  pending.description = describePendingConfigChange(pending);
  await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: pending });
  await schedulePendingConfigChange(pending);

  return { ok: true, applied: false, pending: pending };
}

async function advancePendingConfigChange(elapsedMs) {
  const pending = await readPendingConfigChange();
  if (!pending) return { ok: true, applied: false, pending: null };

  const elapsed = Math.max(0, Math.min(parseInt(elapsedMs, 10) || 0, MINUTE_MS));
  const remainingMs = Math.max(0, getPendingRemainingMs(pending) - elapsed);
  const nextPending = {
    ...pending,
    remainingMs: remainingMs
  };

  if (remainingMs > 0) {
    await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: nextPending });
    if (typeof nextPending.unlockAt === "number") {
      await schedulePendingConfigChange(nextPending);
    }
    return { ok: true, applied: false, pending: nextPending };
  }

  await applyPendingConfigChange(nextPending);
  return { ok: true, applied: true, pending: null };
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

  if (!pending.type) {
    await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
    await schedulePendingConfigChange(null);
    return null;
  }

  if (typeof pending.remainingMs === "number") {
    const remainingMs = getPendingRemainingMs(pending);
    if (remainingMs > 0) {
      if (pending.remainingMs !== remainingMs) {
        const nextPending = {
          ...pending,
          remainingMs: remainingMs
        };
        await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: nextPending });
        await schedulePendingConfigChange(nextPending);
        return nextPending;
      }

      await schedulePendingConfigChange(pending);
      return pending;
    }

    await applyPendingConfigChange(pending);
    return null;
  }

  if (!pending.unlockAt) {
    await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
    await schedulePendingConfigChange(null);
    return null;
  }

  if (pending.unlockAt > Date.now()) {
    await schedulePendingConfigChange(pending);
    return pending;
  }

  await applyPendingConfigChange(pending);
  return null;
}

function getPendingRemainingMs(pending) {
  if (typeof pending.remainingMs === "number") {
    return Math.max(0, pending.remainingMs);
  }

  if (typeof pending.unlockAt === "number") {
    return Math.max(0, pending.unlockAt - Date.now());
  }

  const waitMinutes = clampDelayMinutes(pending.waitMinutes || DEFAULT_CONFIG.delayMinutes);
  return waitMinutes * MINUTE_MS;
}

async function applyPendingConfigChange(pending) {
  const config = await readConfig();

  if (pending.type === "removeSite") {
    const nextSites = config.sites.filter((site) => site !== pending.site);
    await browser.storage.local.set({ sites: nextSites });
  } else if (pending.type === "reduceDelay") {
    const delayMinutes = clampDelayMinutes(pending.delayMinutes || DEFAULT_CONFIG.delayMinutes);
    if (delayMinutes < config.delayMinutes && config.delayMinutes <= pending.waitMinutes) {
      await browser.storage.local.set({ delayMinutes: delayMinutes });
    }
  } else if (pending.type === "disableHoverTarget") {
    await browser.storage.local.set({ requireHoverTarget: false });
  }

  await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
  await schedulePendingConfigChange(null);
  await scheduleSessionResetAlarm();
  await updateBadge();
}

async function reconcileExpiredSessions() {
  const config = await readConfig();
  const dailyLockState = getDailyLockState(config);
  const sessions = await getAllSessions();
  const now = Date.now();

  for (const { key, tabId, session } of sessions) {
    let currentSession = session;

    if (!currentSession.createdAt || !currentSession.expiresAt) {
      const createdAt = currentSession.createdAt || now;
      currentSession = {
        ...currentSession,
        createdAt: createdAt,
        expiresAt: createdAt + config.resetHours * HOUR_MS
      };
      await browser.storage.session.set({ [key]: currentSession });
    }

    if (!isSessionExpired(currentSession, config.resetHours, now)) continue;
    if (!config.enabled || !isDomainTracked(currentSession.domain, config.sites)) continue;

    const nextSession = createTimerSession(
      currentSession.domain,
      config.delayMinutes,
      config.resetHours,
      now
    );
    await browser.storage.session.set({ [key]: nextSession });

    if (dailyLockState.locked) {
      await sendTabMessage(tabId, {
        type: "SHOW_DAILY_LOCK",
        unlockAt: dailyLockState.unlockAt
      });
    } else {
      await sendTabMessage(tabId, {
        type: "RESET_TIMER",
        remainingMs: nextSession.remainingMs,
        active: await isTabActiveAndFocused(tabId),
        requireHoverTarget: config.requireHoverTarget
      });
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
    } else if (alarm.name === DAILY_LOCK_BOUNDARY_ALARM) {
      reconcileDailyLockBoundary().catch((error) => {
        console.warn("[Airlock] Failed to apply daily lock boundary:", error);
      });
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled || changes.sites || changes.delayMinutes || changes.resetHours) {
    reconcileExpiredSessions().catch((error) => {
      console.warn("[Airlock] Failed to reconcile expired sessions:", error);
    });
  }

  if (
    changes.enabled ||
    changes.sites ||
    changes.dailyLockEnabled ||
    changes.dailyLockStart ||
    changes.dailyLockEnd
  ) {
    reconcileDailyLockBoundary().catch((error) => {
      console.warn("[Airlock] Failed to reconcile daily lock settings:", error);
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
    await sendActiveState(prevTabId, false);
    await sendTabMessage(prevTabId, { type: "PAUSE" });
  }

  if (windowFocused) {
    const active = await isTabActiveAndFocused(currentActiveTabId);
    await sendActiveState(currentActiveTabId, active);
    await sendTabMessage(currentActiveTabId, { type: active ? "RESUME" : "PAUSE" });
  }
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  const wasFocused = windowFocused;
  windowFocused = windowId !== browser.windows.WINDOW_ID_NONE;

  if (currentActiveTabId === null) return;

  await new Promise((r) => setTimeout(r, 150));

  if (!windowFocused && wasFocused) {
    await sendActiveState(currentActiveTabId, false);
    await sendTabMessage(currentActiveTabId, { type: "PAUSE" });
  } else if (windowFocused && !wasFocused) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentActiveTabId = tab.id;
        const active = await isTabActiveAndFocused(currentActiveTabId);
        await sendActiveState(currentActiveTabId, active);
        await sendTabMessage(currentActiveTabId, { type: active ? "RESUME" : "PAUSE" });
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

  if (message.type === "ADVANCE_PENDING_CONFIG_CHANGE") {
    advancePendingConfigChange(message.elapsedMs).then(sendResponse);
    return true;
  }

  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (message.type === "GET_ACTIVE_STATE") {
    isTabActiveAndFocused(tabId).then((active) => {
      sendResponse({ active: active });
    });
    return true;
  }

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
  const active = await isTabActiveAndFocused(tabId);

  if (!config.enabled || !isDomainTracked(domain, config.sites)) {
    return {
      type: "NO_OVERLAY",
      active: active,
      requireHoverTarget: config.requireHoverTarget
    };
  }

  const dailyLockState = getDailyLockState(config);
  if (dailyLockState.locked) {
    return {
      type: "SHOW_DAILY_LOCK",
      unlockAt: dailyLockState.unlockAt,
      active: active,
      requireHoverTarget: config.requireHoverTarget
    };
  }

  let session = await getSession(tabId);
  const now = Date.now();

  if (session && session.domain === domain) {
    if (!session.createdAt || !session.expiresAt) {
      const createdAt = session.createdAt || now;
      session = {
        ...session,
        createdAt: createdAt,
        expiresAt: createdAt + config.resetHours * HOUR_MS
      };
      await setSession(tabId, session);
    }

    const resetAt = getSessionExpiresAt(session, config.resetHours);

    if (isSessionExpired(session, config.resetHours, now)) {
      const nextSession = createTimerSession(domain, config.delayMinutes, config.resetHours, now);
      await setSession(tabId, nextSession);
      return {
        type: "SHOW_OVERLAY",
        remainingMs: nextSession.remainingMs,
        resetAt: nextSession.expiresAt,
        active: active,
        requireHoverTarget: config.requireHoverTarget
      };
    }

    if (session.completed) {
      return {
        type: "NO_OVERLAY",
        resetAt: resetAt,
        active: active,
        requireHoverTarget: config.requireHoverTarget
      };
    }
    if (session.remainingMs <= 0) {
      return {
        type: "NO_OVERLAY",
        resetAt: resetAt,
        active: active,
        requireHoverTarget: config.requireHoverTarget
      };
    }
    return {
      type: "SHOW_OVERLAY",
      remainingMs: session.remainingMs,
      resetAt: resetAt,
      active: active,
      requireHoverTarget: config.requireHoverTarget
    };
  }

  const nextSession = createTimerSession(domain, config.delayMinutes, config.resetHours, now);
  await setSession(tabId, nextSession);
  return {
    type: "SHOW_OVERLAY",
    remainingMs: nextSession.remainingMs,
    resetAt: nextSession.expiresAt,
    active: active,
    requireHoverTarget: config.requireHoverTarget
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
