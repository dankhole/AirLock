// Airlock - Background Service Worker
// Manages timer sessions, focus tracking, badge, and message coordination.

const dailyLockApi = globalThis.AirlockDailyLock;
const DEFAULT_CONFIG = {
  enabled: true,
  sites: [],
  delayMinutes: 1,
  movingTargetEnabled: false,
  dailyLimits: {},
  dailyLimitPolicies: {},
  cooldownUntil: null,
  dailyLockEnabled: false,
  dailyLockStart: dailyLockApi.DEFAULT_START,
  dailyLockEnd: dailyLockApi.DEFAULT_END
};

const PENDING_CONFIG_CHANGE_KEY = "pendingConfigChange";
const PENDING_CONFIG_CHANGE_ALARM = "airlock.pendingConfigChange";
const MIDNIGHT_RESET_ALARM = "airlock.sessionReset";
const DAILY_LOCK_BOUNDARY_ALARM = "airlock.dailyLockBoundary";
const COOLDOWN_BOUNDARY_ALARM = "airlock.cooldownBoundary";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_DAILY_LIMIT_MINUTES = 24 * 60;
const DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES = 60;
const MAX_DAILY_LIMIT_COOLDOWN_MINUTES = 24 * 60;
const MAX_USAGE_UPDATE_MS = 5 * 1000;

// --- Initialization ---

browser.runtime.onInstalled.addListener(async () => {
  await migrateStoredConfig();
  await resetDailyStateIfNeeded();
  await reconcilePendingConfigChange();
  await reconcileExpiredSessions();
  await scheduleDailyLockBoundaryAlarm();
  await scheduleCooldownBoundaryAlarm();
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
    await resetDailyStateIfNeeded();
    await reconcilePendingConfigChange();
    await reconcileExpiredSessions();
    await scheduleDailyLockBoundaryAlarm();
    await scheduleCooldownBoundaryAlarm();
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
    "movingTargetEnabled",
    "requireHoverTarget",
    "dailyLimits",
    "dailyLimitPolicies",
    "dailyLimitCooldowns",
    "dailyLimitUsageOffsets",
    "dailyUsage",
    "guardMinutes",
    "cooldownUntil",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd"
  ]);
  const updates = {};

  if (existing.enabled === undefined) updates.enabled = DEFAULT_CONFIG.enabled;
  if (existing.sites === undefined) updates.sites = DEFAULT_CONFIG.sites;

  const delayMinutes = clampDelayMinutes(existing.delayMinutes || DEFAULT_CONFIG.delayMinutes);
  const legacyGuardMinutes = existing.guardMinutes === undefined
    ? delayMinutes
    : clampDelayMinutes(existing.guardMinutes);
  const unifiedWaitMinutes = Math.max(delayMinutes, legacyGuardMinutes);
  if (existing.delayMinutes !== unifiedWaitMinutes) updates.delayMinutes = unifiedWaitMinutes;

  if (typeof existing.movingTargetEnabled !== "boolean") {
    updates.movingTargetEnabled = DEFAULT_CONFIG.movingTargetEnabled;
  }

  const dailyLimits = normalizeDailyLimits(existing.dailyLimits, existing.sites || []);
  if (JSON.stringify(existing.dailyLimits || {}) !== JSON.stringify(dailyLimits)) {
    updates.dailyLimits = dailyLimits;
  }

  const dailyLimitPolicies = normalizeDailyLimitPolicies(
    existing.dailyLimitPolicies,
    existing.sites || []
  );
  if (JSON.stringify(existing.dailyLimitPolicies || {}) !== JSON.stringify(dailyLimitPolicies)) {
    updates.dailyLimitPolicies = dailyLimitPolicies;
  }

  const dailyLimitCooldowns = normalizeDailyLimitCooldowns(
    existing.dailyLimitCooldowns,
    existing.sites || []
  );
  if (JSON.stringify(existing.dailyLimitCooldowns || {}) !== JSON.stringify(dailyLimitCooldowns)) {
    updates.dailyLimitCooldowns = dailyLimitCooldowns;
  }

  if (!existing.dailyUsage || typeof existing.dailyUsage !== "object") {
    updates.dailyUsage = createEmptyDailyUsage();
  }
  if (!existing.dailyLimitUsageOffsets || typeof existing.dailyLimitUsageOffsets !== "object") {
    updates.dailyLimitUsageOffsets = createEmptyDailyUsage();
  }

  const cooldownUntil = normalizeCooldownUntil(existing.cooldownUntil);
  if (existing.cooldownUntil !== cooldownUntil) {
    updates.cooldownUntil = cooldownUntil;
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
  if (existing.requireHoverTarget !== undefined || existing.guardMinutes !== undefined) {
    await browser.storage.local.remove(["requireHoverTarget", "guardMinutes"]);
  }
  if (existing.resetHours !== undefined) {
    await browser.storage.local.remove("resetHours");
  }
}

async function readConfig() {
  const result = await browser.storage.local.get([
    "enabled",
    "sites",
    "delayMinutes",
    "movingTargetEnabled",
    "dailyLimits",
    "dailyLimitPolicies",
    "cooldownUntil",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd"
  ]);
  return {
    enabled: result.enabled !== false,
    sites: result.sites || [],
    delayMinutes: clampDelayMinutes(result.delayMinutes || DEFAULT_CONFIG.delayMinutes),
    movingTargetEnabled: result.movingTargetEnabled === true,
    dailyLimits: normalizeDailyLimits(result.dailyLimits, result.sites || []),
    dailyLimitPolicies: normalizeDailyLimitPolicies(
      result.dailyLimitPolicies,
      result.sites || []
    ),
    cooldownUntil: normalizeCooldownUntil(result.cooldownUntil),
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
  return getTrackedSite(hostname, sites) !== null;
}

function getTrackedSite(hostname, sites) {
  return sites
    .filter((site) => hostname === site || hostname.endsWith("." + site))
    .sort((a, b) => b.length - a.length)[0] || null;
}

function clampDelayMinutes(value) {
  let minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 600) minutes = 600;
  return minutes;
}

function normalizeCooldownUntil(value, now = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : null;
}

function clampDailyLimitMinutes(value) {
  const minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) return null;
  return Math.min(minutes, MAX_DAILY_LIMIT_MINUTES);
}

function clampDailyLimitCooldownMinutes(value) {
  const minutes = parseInt(value, 10);
  if (isNaN(minutes) || minutes < 1) return DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES;
  return Math.min(minutes, MAX_DAILY_LIMIT_COOLDOWN_MINUTES);
}

function normalizeDailyLimitPolicy(value) {
  if (!value || value.mode !== "cooldown") {
    return { mode: "block", cooldownMinutes: DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES };
  }

  return {
    mode: "cooldown",
    cooldownMinutes: clampDailyLimitCooldownMinutes(value.cooldownMinutes)
  };
}

function normalizeDailyLimitPolicies(value, sites) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const trackedSites = new Set(sites || []);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([site, policy]) => trackedSites.has(site) && policy && policy.mode === "cooldown")
      .map(([site, policy]) => [site, normalizeDailyLimitPolicy(policy)])
  );
}

function isDailyLimitPolicyWeaker(currentPolicy, nextPolicy) {
  const current = normalizeDailyLimitPolicy(currentPolicy);
  const next = normalizeDailyLimitPolicy(nextPolicy);

  if (current.mode === "block") return next.mode === "cooldown";
  if (next.mode === "block") return false;
  return next.cooldownMinutes < current.cooldownMinutes;
}

function normalizeDailyLimitCooldowns(value, sites) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const trackedSites = new Set(sites || []);

  return Object.fromEntries(
    Object.entries(value)
      .map(([site, until]) => [site, Number(until)])
      .filter(([site, until]) => trackedSites.has(site) && Number.isFinite(until) && until > 0)
  );
}

async function setDailyLimitPolicy(config, site, policy) {
  const normalized = normalizeDailyLimitPolicy(policy);
  const current = normalizeDailyLimitPolicy(config.dailyLimitPolicies[site]);
  const nextPolicies = { ...config.dailyLimitPolicies };
  const storedCooldowns = await browser.storage.local.get("dailyLimitCooldowns");
  const nextCooldowns = { ...(storedCooldowns.dailyLimitCooldowns || {}) };

  if (normalized.mode === "cooldown") {
    nextPolicies[site] = normalized;
    const activeCooldownUntil = Number(nextCooldowns[site]);
    if (current.mode === "cooldown" && Number.isFinite(activeCooldownUntil)) {
      const cooldownStartedAt = activeCooldownUntil - current.cooldownMinutes * MINUTE_MS;
      nextCooldowns[site] = cooldownStartedAt + normalized.cooldownMinutes * MINUTE_MS;
    }
  } else {
    delete nextPolicies[site];
    delete nextCooldowns[site];
  }

  await browser.storage.local.set({
    dailyLimitPolicies: nextPolicies,
    dailyLimitCooldowns: nextCooldowns
  });
}

function normalizeDailyLimits(value, sites) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([site]) => sites.includes(site))
      .map(([site, minutes]) => [site, clampDailyLimitMinutes(minutes)])
      .filter(([, minutes]) => minutes !== null)
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

function getNextLocalMidnight(now = Date.now()) {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function getCurrentLocalMidnight(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function createEmptyDailyUsage(now = Date.now()) {
  return { date: getLocalDateKey(now), sites: {} };
}

async function resetDailyStateIfNeeded(now = Date.now()) {
  const today = getLocalDateKey(now);
  const stored = await browser.storage.local.get([
    "dailyUsage",
    "dailyLimitUsageOffsets"
  ]);
  const usageIsCurrent = stored.dailyUsage && stored.dailyUsage.date === today;
  const offsetsAreCurrent =
    stored.dailyLimitUsageOffsets && stored.dailyLimitUsageOffsets.date === today;

  if (usageIsCurrent && offsetsAreCurrent) return false;

  await browser.storage.local.set({
    dailyUsage: createEmptyDailyUsage(now),
    dailyLimitUsageOffsets: createEmptyDailyUsage(now),
    dailyLimitCooldowns: {}
  });
  return true;
}

async function readDailyUsage(now = Date.now()) {
  const result = await browser.storage.local.get("dailyUsage");
  const stored = result.dailyUsage;
  const today = getLocalDateKey(now);

  if (!stored || stored.date !== today || !stored.sites || typeof stored.sites !== "object") {
    return createEmptyDailyUsage(now);
  }

  return {
    date: today,
    sites: Object.fromEntries(
      Object.entries(stored.sites)
        .map(([site, usedMs]) => [site, Math.max(0, Number(usedMs) || 0)])
    )
  };
}

async function readDailyLimitUsageOffsets(now = Date.now()) {
  const result = await browser.storage.local.get("dailyLimitUsageOffsets");
  const stored = result.dailyLimitUsageOffsets;
  const today = getLocalDateKey(now);

  if (!stored || stored.date !== today || !stored.sites || typeof stored.sites !== "object") {
    return createEmptyDailyUsage(now);
  }

  return {
    date: today,
    sites: Object.fromEntries(
      Object.entries(stored.sites)
        .map(([site, usedMs]) => [site, Math.max(0, Number(usedMs) || 0)])
    )
  };
}

async function getDailyLimitState(config, hostname, now = Date.now(), allowCooldownStart = true) {
  const site = getTrackedSite(hostname, config.sites);
  const limitMinutes = site ? clampDailyLimitMinutes(config.dailyLimits[site]) : null;
  const policy = site
    ? normalizeDailyLimitPolicy(config.dailyLimitPolicies[site])
    : normalizeDailyLimitPolicy(null);

  if (!site) {
    return {
      site: site,
      limitMinutes: null,
      limitMode: policy.mode,
      usedMs: 0,
      remainingMs: null,
      reached: false,
      resetAt: getNextLocalMidnight(now)
    };
  }

  const usage = await readDailyUsage(now);
  if (limitMinutes === null) {
    return {
      site: site,
      limitMinutes: null,
      limitMode: policy.mode,
      usedMs: usage.sites[site] || 0,
      remainingMs: null,
      reached: false,
      resetAt: getNextLocalMidnight(now)
    };
  }

  const storedCooldowns = await browser.storage.local.get("dailyLimitCooldowns");
  const usageOffsets = await readDailyLimitUsageOffsets(now);
  const rawCooldowns = storedCooldowns.dailyLimitCooldowns;
  const cooldowns = rawCooldowns && typeof rawCooldowns === "object" && !Array.isArray(rawCooldowns)
    ? { ...rawCooldowns }
    : {};
  const cooldownUntil = Number(cooldowns[site]);
  const limitMs = limitMinutes * MINUTE_MS;
  const totalUsedMs = usage.sites[site] || 0;
  let usedMs = Math.max(0, totalUsedMs - (usageOffsets.sites[site] || 0));

  if (Number.isFinite(cooldownUntil) && cooldownUntil > now) {
    if (policy.mode === "cooldown" && usedMs >= limitMs) {
      return {
        site: site,
        limitMinutes: limitMinutes,
        limitMode: "cooldown",
        usedMs: usedMs,
        remainingMs: 0,
        reached: true,
        resetAt: cooldownUntil
      };
    }

    delete cooldowns[site];
    await browser.storage.local.set({ dailyLimitCooldowns: cooldowns });
  } else if (Number.isFinite(cooldownUntil)) {
    delete cooldowns[site];
    usageOffsets.sites[site] = totalUsedMs;
    usedMs = 0;
    await browser.storage.local.set({
      dailyLimitCooldowns: cooldowns,
      dailyLimitUsageOffsets: usageOffsets
    });
  }

  if (usedMs >= limitMs && policy.mode === "cooldown" && allowCooldownStart) {
    const nextCooldownUntil = now + policy.cooldownMinutes * MINUTE_MS;
    cooldowns[site] = nextCooldownUntil;
    await browser.storage.local.set({ dailyLimitCooldowns: cooldowns });
    return {
      site: site,
      limitMinutes: limitMinutes,
      limitMode: "cooldown",
      usedMs: usedMs,
      remainingMs: 0,
      reached: true,
      resetAt: nextCooldownUntil
    };
  }

  return {
    site: site,
    limitMinutes: limitMinutes,
    limitMode: policy.mode,
    usedMs: usedMs,
    remainingMs: Math.max(0, limitMs - usedMs),
    reached: usedMs >= limitMs,
    resetAt: getNextLocalMidnight(now)
  };
}

function addDailyLimitMetadata(response, state) {
  return {
    ...response,
    dailyLimitMinutes: state.limitMinutes,
    dailyLimitMode: state.limitMode,
    dailyUsageRemainingMs: state.remainingMs,
    dailyUsageResetAt: state.resetAt
  };
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
  await scheduleMidnightResetAlarm();
}

async function removeSession(tabId) {
  const key = getSessionKey(tabId);
  await browser.storage.session.remove(key);
  await scheduleMidnightResetAlarm();
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

function createTimerSession(domain, delayMinutes, now = Date.now()) {
  const remainingMs = delayMinutes * MINUTE_MS;
  return {
    domain: domain,
    createdAt: now,
    expiresAt: getNextLocalMidnight(now),
    remainingMs: remainingMs
  };
}

function getSessionExpiresAt(session) {
  return getNextLocalMidnight(session.createdAt || Date.now());
}

function isSessionExpired(session, now = Date.now()) {
  return getSessionExpiresAt(session) <= now;
}

async function scheduleMidnightResetAlarm() {
  if (!browser.alarms) return;

  await browser.alarms.create(MIDNIGHT_RESET_ALARM, {
    when: getNextLocalMidnight()
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

async function scheduleCooldownBoundaryAlarm() {
  if (!browser.alarms) return;

  const config = await readConfig();
  if (!config.cooldownUntil) {
    await browser.alarms.clear(COOLDOWN_BOUNDARY_ALARM);
    return;
  }

  await browser.alarms.create(COOLDOWN_BOUNDARY_ALARM, {
    when: config.cooldownUntil
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

async function reconcileCooldownBoundary() {
  const config = await readConfig();
  if (!config.cooldownUntil) {
    const stored = await browser.storage.local.get("cooldownUntil");
    if (stored.cooldownUntil !== null && stored.cooldownUntil !== undefined) {
      await browser.storage.local.set({ cooldownUntil: null });
    }
  }

  await reconcilePendingConfigChange();
  await scheduleCooldownBoundaryAlarm();
  await broadcastConfigRecheck();
  await updateBadge();
}

async function startCooldown() {
  const cooldownUntil = Date.now() + HOUR_MS;
  await browser.storage.local.set({ cooldownUntil: cooldownUntil });
  await scheduleCooldownBoundaryAlarm();
  await broadcastConfigRecheck();
  await updateBadge();
  return { ok: true, cooldownUntil: cooldownUntil };
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

  if (pending.type === "disableAirlock") {
    return "Turning off Airlock";
  }

  if (pending.type === "disableMovingTarget") {
    return "Turning off the moving target";
  }

  if (pending.type === "reduceDelay") {
    const unit = pending.delayMinutes === 1 ? "minute" : "minutes";
    return "Reducing wait to " + pending.delayMinutes + " " + unit;
  }

  if (pending.type === "changeDailyLimit") {
    if (pending.dailyLimitMinutes === null) {
      return "Removing daily limit for " + pending.site;
    }
    return "Increasing daily limit for " + pending.site;
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

async function startPendingConfigChange(change) {
  await reconcilePendingConfigChange();

  const existing = await readPendingConfigChange();
  if (existing) {
    return { ok: false, reason: "pending-exists", pending: existing };
  }

  const config = await readConfig();
  const startedAt = Date.now();
  const waitMinutes = config.delayMinutes;
  const pendingBase = {
    id: String(startedAt),
    startedAt: startedAt,
    waitMinutes: waitMinutes
  };

  let pending = null;

  if (change.type === "disableAirlock") {
    if (!config.enabled) {
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "disableAirlock",
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "disableMovingTarget") {
    if (!config.movingTargetEnabled) {
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "disableMovingTarget",
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "removeSite") {
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
  } else if (change.type === "changeDailyLimit") {
    const site = String(change.site || "").trim().toLowerCase();
    const dailyLimitMinutes = change.dailyLimitMinutes === null
      ? null
      : clampDailyLimitMinutes(change.dailyLimitMinutes);
    const currentLimitMinutes = clampDailyLimitMinutes(config.dailyLimits[site]);

    if (
      !site ||
      !config.sites.includes(site) ||
      (change.dailyLimitMinutes !== null && dailyLimitMinutes === null)
    ) {
      return { ok: false, reason: "invalid-daily-limit", pending: null };
    }

    if (
      dailyLimitMinutes !== null &&
      (currentLimitMinutes === null || dailyLimitMinutes <= currentLimitMinutes)
    ) {
      await browser.storage.local.set({
        dailyLimits: { ...config.dailyLimits, [site]: dailyLimitMinutes }
      });
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "changeDailyLimit",
      site: site,
      dailyLimitMinutes: dailyLimitMinutes,
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "changeDailyLimitPolicy") {
    const site = String(change.site || "").trim().toLowerCase();
    const currentPolicy = normalizeDailyLimitPolicy(config.dailyLimitPolicies[site]);
    const dailyLimitPolicy = normalizeDailyLimitPolicy(change.dailyLimitPolicy);

    if (!site || !config.sites.includes(site) || !config.dailyLimits[site]) {
      return { ok: false, reason: "invalid-daily-limit-policy", pending: null };
    }

    if (!isDailyLimitPolicyWeaker(currentPolicy, dailyLimitPolicy)) {
      await setDailyLimitPolicy(config, site, dailyLimitPolicy);
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "changeDailyLimitPolicy",
      site: site,
      dailyLimitPolicy: dailyLimitPolicy,
      previousDailyLimitPolicy: currentPolicy,
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "endCooldown") {
    if (!config.cooldownUntil) {
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "endCooldown",
      remainingMs: waitMinutes * MINUTE_MS,
      cooldownUntil: config.cooldownUntil
    };
  } else if (change.type === "disableDailyLock") {
    if (!config.dailyLockEnabled) {
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "disableDailyLock",
      remainingMs: waitMinutes * MINUTE_MS
    };
  } else if (change.type === "changeDailyLockSchedule") {
    const dailyLockStart = dailyLockApi.normalizeTimeOfDay(change.dailyLockStart, null);
    const dailyLockEnd = dailyLockApi.normalizeTimeOfDay(change.dailyLockEnd, null);
    const nextDuration = dailyLockApi.getDurationMinutes(dailyLockStart, dailyLockEnd);

    if (!dailyLockStart || !dailyLockEnd || nextDuration === 0) {
      return { ok: false, reason: "invalid-schedule", pending: null };
    }

    const direction = dailyLockApi.classifyScheduleChange(
      config.dailyLockStart,
      config.dailyLockEnd,
      dailyLockStart,
      dailyLockEnd
    );

    if (!config.dailyLockEnabled || direction === "same" || direction === "stronger") {
      await browser.storage.local.set({
        dailyLockStart: dailyLockStart,
        dailyLockEnd: dailyLockEnd
      });
      return { ok: true, applied: true, pending: null };
    }

    pending = {
      ...pendingBase,
      type: "changeDailyLockSchedule",
      remainingMs: waitMinutes * MINUTE_MS,
      dailyLockStart: dailyLockStart,
      dailyLockEnd: dailyLockEnd,
      previousDailyLockStart: config.dailyLockStart,
      previousDailyLockEnd: config.dailyLockEnd
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

  if (pending.type === "increaseResetHours") {
    await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
    await schedulePendingConfigChange(null);
    return null;
  }

  if (pending.type === "endCooldown") {
    const stored = await browser.storage.local.get("cooldownUntil");
    const activeCooldownUntil = normalizeCooldownUntil(stored.cooldownUntil);
    if (!activeCooldownUntil || activeCooldownUntil !== pending.cooldownUntil) {
      await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
      await schedulePendingConfigChange(null);
      return null;
    }
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

  if (pending.type === "disableAirlock") {
    if (config.enabled) {
      await browser.storage.local.set({ enabled: false });
    }
  } else if (pending.type === "disableMovingTarget") {
    if (config.movingTargetEnabled) {
      await browser.storage.local.set({ movingTargetEnabled: false });
    }
  } else if (pending.type === "removeSite") {
    const nextSites = config.sites.filter((site) => site !== pending.site);
    const nextDailyLimits = { ...config.dailyLimits };
    const nextPolicies = { ...config.dailyLimitPolicies };
    const storedCooldowns = await browser.storage.local.get("dailyLimitCooldowns");
    const usageOffsets = await readDailyLimitUsageOffsets();
    const nextCooldowns = { ...(storedCooldowns.dailyLimitCooldowns || {}) };
    delete nextDailyLimits[pending.site];
    delete nextPolicies[pending.site];
    delete nextCooldowns[pending.site];
    delete usageOffsets.sites[pending.site];
    await browser.storage.local.set({
      sites: nextSites,
      dailyLimits: nextDailyLimits,
      dailyLimitPolicies: nextPolicies,
      dailyLimitCooldowns: nextCooldowns,
      dailyLimitUsageOffsets: usageOffsets
    });
  } else if (pending.type === "reduceDelay") {
    const delayMinutes = clampDelayMinutes(pending.delayMinutes || DEFAULT_CONFIG.delayMinutes);
    if (delayMinutes < config.delayMinutes && config.delayMinutes <= pending.waitMinutes) {
      await browser.storage.local.set({ delayMinutes: delayMinutes });
    }
  } else if (pending.type === "changeDailyLimit" && config.sites.includes(pending.site)) {
    const nextDailyLimits = { ...config.dailyLimits };
    if (pending.dailyLimitMinutes === null) {
      delete nextDailyLimits[pending.site];
    } else {
      nextDailyLimits[pending.site] = clampDailyLimitMinutes(pending.dailyLimitMinutes);
    }
    const updates = { dailyLimits: nextDailyLimits };
    if (pending.dailyLimitMinutes === null) {
      const nextPolicies = { ...config.dailyLimitPolicies };
      const storedCooldowns = await browser.storage.local.get("dailyLimitCooldowns");
      const usageOffsets = await readDailyLimitUsageOffsets();
      const nextCooldowns = { ...(storedCooldowns.dailyLimitCooldowns || {}) };
      delete nextPolicies[pending.site];
      delete nextCooldowns[pending.site];
      delete usageOffsets.sites[pending.site];
      updates.dailyLimitPolicies = nextPolicies;
      updates.dailyLimitCooldowns = nextCooldowns;
      updates.dailyLimitUsageOffsets = usageOffsets;
    }
    await browser.storage.local.set(updates);
  } else if (pending.type === "changeDailyLimitPolicy" && config.sites.includes(pending.site)) {
    const currentPolicy = normalizeDailyLimitPolicy(config.dailyLimitPolicies[pending.site]);
    if (
      JSON.stringify(currentPolicy) === JSON.stringify(pending.previousDailyLimitPolicy)
    ) {
      await setDailyLimitPolicy(config, pending.site, pending.dailyLimitPolicy);
    }
  } else if (pending.type === "endCooldown") {
    if (config.cooldownUntil && config.cooldownUntil === pending.cooldownUntil) {
      await browser.storage.local.set({ cooldownUntil: null });
    }
  } else if (pending.type === "disableDailyLock") {
    if (config.dailyLockEnabled) {
      await browser.storage.local.set({ dailyLockEnabled: false });
    }
  } else if (pending.type === "changeDailyLockSchedule") {
    if (
      config.dailyLockEnabled &&
      config.dailyLockStart === pending.previousDailyLockStart &&
      config.dailyLockEnd === pending.previousDailyLockEnd
    ) {
      await browser.storage.local.set({
        dailyLockStart: pending.dailyLockStart,
        dailyLockEnd: pending.dailyLockEnd
      });
    }
  }

  await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
  await schedulePendingConfigChange(null);
  await scheduleMidnightResetAlarm();
  await scheduleDailyLockBoundaryAlarm();
  await scheduleCooldownBoundaryAlarm();
  await broadcastConfigRecheck();
  await updateBadge();
}

async function reconcileExpiredSessions() {
  const config = await readConfig();
  const dailyLockState = getDailyLockState(config);
  const sessions = await getAllSessions();
  const now = Date.now();

  for (const { key, tabId, session } of sessions) {
    let currentSession = session;

    const createdAt = currentSession.createdAt || now;
    const expiresAt = getNextLocalMidnight(createdAt);
    if (currentSession.createdAt !== createdAt || currentSession.expiresAt !== expiresAt) {
      currentSession = {
        ...currentSession,
        createdAt: createdAt,
        expiresAt: expiresAt
      };
      await browser.storage.session.set({ [key]: currentSession });
    }

    if (!isSessionExpired(currentSession, now)) continue;
    if (!config.enabled || !isDomainTracked(currentSession.domain, config.sites)) continue;

    const nextSession = createTimerSession(
      currentSession.domain,
      config.delayMinutes,
      now
    );
    await browser.storage.session.set({ [key]: nextSession });

    const dailyLimitState = await getDailyLimitState(config, currentSession.domain, now);
    if (config.cooldownUntil) {
      await sendTabMessage(tabId, {
        type: "SHOW_COOLDOWN",
        unlockAt: config.cooldownUntil
      });
    } else if (dailyLockState.locked) {
      await sendTabMessage(tabId, {
        type: "SHOW_DAILY_LOCK",
        unlockAt: dailyLockState.unlockAt
      });
    } else if (dailyLimitState.reached) {
      await sendTabMessage(tabId, {
        type: "SHOW_DAILY_LIMIT",
        resetAt: dailyLimitState.resetAt,
        limitMinutes: dailyLimitState.limitMinutes,
        dailyLimitMode: dailyLimitState.limitMode,
        usedMs: dailyLimitState.usedMs
      });
    } else {
      await sendTabMessage(tabId, {
        type: "RESET_TIMER",
        remainingMs: nextSession.remainingMs,
        active: await isTabActiveAndFocused(tabId),
        dailyLimitMinutes: dailyLimitState.limitMinutes,
        dailyUsageRemainingMs: dailyLimitState.remainingMs,
        dailyUsageResetAt: dailyLimitState.resetAt
      });
    }
  }

  await scheduleMidnightResetAlarm();
  await updateBadge();
}

async function reconcileMidnightReset() {
  await resetDailyStateIfNeeded();
  await reconcileExpiredSessions();
  await broadcastConfigRecheck();
}

if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PENDING_CONFIG_CHANGE_ALARM) {
      reconcilePendingConfigChange().catch((error) => {
        console.warn("[Airlock] Failed to apply pending config change:", error);
      });
    } else if (alarm.name === MIDNIGHT_RESET_ALARM) {
      reconcileMidnightReset().catch((error) => {
        console.warn("[Airlock] Failed to apply midnight reset:", error);
      });
    } else if (alarm.name === DAILY_LOCK_BOUNDARY_ALARM) {
      reconcileDailyLockBoundary().catch((error) => {
        console.warn("[Airlock] Failed to apply daily lock boundary:", error);
      });
    } else if (alarm.name === COOLDOWN_BOUNDARY_ALARM) {
      reconcileCooldownBoundary().catch((error) => {
        console.warn("[Airlock] Failed to apply cooldown boundary:", error);
      });
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled || changes.sites || changes.delayMinutes) {
    reconcileExpiredSessions().catch((error) => {
      console.warn("[Airlock] Failed to reconcile expired sessions:", error);
    });
  }

  if (
    changes.enabled ||
    changes.sites ||
    changes.dailyLimits ||
    changes.dailyLimitPolicies ||
    changes.dailyLimitCooldowns ||
    changes.dailyLockEnabled ||
    changes.dailyLockStart ||
    changes.dailyLockEnd
  ) {
    reconcileDailyLockBoundary().catch((error) => {
      console.warn("[Airlock] Failed to reconcile daily lock settings:", error);
    });
  }

  if (changes.cooldownUntil || changes.sites) {
    reconcileCooldownBoundary().catch((error) => {
      console.warn("[Airlock] Failed to reconcile cooldown:", error);
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

let dailyUsageUpdateQueue = Promise.resolve();

function enqueueDailyUsageUpdate(tabId, domain, elapsedMs) {
  const update = dailyUsageUpdateQueue.then(() =>
    handleDailyUsageUpdate(tabId, domain, elapsedMs)
  );
  dailyUsageUpdateQueue = update.catch(() => {});
  return update;
}

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

  if (message.type === "START_COOLDOWN") {
    startCooldown().then(sendResponse);
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

  if (message.type === "DAILY_USAGE_UPDATE") {
    enqueueDailyUsageUpdate(tabId, message.domain, message.elapsedMs).then(sendResponse);
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

  if (!isDomainTracked(domain, config.sites)) {
    return {
      type: "NO_OVERLAY",
      active: active
    };
  }

  if (config.cooldownUntil) {
    return {
      type: "SHOW_COOLDOWN",
      unlockAt: config.cooldownUntil,
      active: active
    };
  }

  if (!config.enabled) {
    return {
      type: "NO_OVERLAY",
      active: active
    };
  }

  const dailyLockState = getDailyLockState(config);
  if (dailyLockState.locked) {
    return {
      type: "SHOW_DAILY_LOCK",
      unlockAt: dailyLockState.unlockAt,
      active: active
    };
  }

  const dailyLimitState = await getDailyLimitState(config, domain);
  if (dailyLimitState.reached) {
    return {
      type: "SHOW_DAILY_LIMIT",
      resetAt: dailyLimitState.resetAt,
      limitMinutes: dailyLimitState.limitMinutes,
      dailyLimitMode: dailyLimitState.limitMode,
      usedMs: dailyLimitState.usedMs,
      active: active
    };
  }

  let session = await getSession(tabId);
  const now = Date.now();

  if (session && session.domain === domain) {
    const createdAt = session.createdAt || now;
    const expiresAt = getNextLocalMidnight(createdAt);
    if (session.createdAt !== createdAt || session.expiresAt !== expiresAt) {
      session = {
        ...session,
        createdAt: createdAt,
        expiresAt: expiresAt
      };
      await setSession(tabId, session);
    }

    const resetAt = getSessionExpiresAt(session);

    if (isSessionExpired(session, now)) {
      const nextSession = createTimerSession(domain, config.delayMinutes, now);
      await setSession(tabId, nextSession);
      return addDailyLimitMetadata({
        type: "SHOW_OVERLAY",
        remainingMs: nextSession.remainingMs,
        resetAt: nextSession.expiresAt,
        active: active
      }, dailyLimitState);
    }

    if (session.completed) {
      return addDailyLimitMetadata({
        type: "NO_OVERLAY",
        resetAt: resetAt,
        active: active
      }, dailyLimitState);
    }
    if (session.remainingMs <= 0) {
      return addDailyLimitMetadata({
        type: "NO_OVERLAY",
        resetAt: resetAt,
        active: active
      }, dailyLimitState);
    }
    return addDailyLimitMetadata({
      type: "SHOW_OVERLAY",
      remainingMs: session.remainingMs,
      resetAt: resetAt,
      active: active
    }, dailyLimitState);
  }

  const nextSession = createTimerSession(domain, config.delayMinutes, now);
  await setSession(tabId, nextSession);
  return addDailyLimitMetadata({
    type: "SHOW_OVERLAY",
    remainingMs: nextSession.remainingMs,
    resetAt: nextSession.expiresAt,
    active: active
  }, dailyLimitState);
}

async function handleDailyUsageUpdate(tabId, domain, elapsedMs) {
  const config = await getConfig();
  const now = Date.now();
  const requestedElapsed = Math.max(
    0,
    Math.min(Number(elapsedMs) || 0, MAX_USAGE_UPDATE_MS)
  );
  const elapsed = Math.min(requestedElapsed, Math.max(0, now - getCurrentLocalMidnight(now)));
  const active = await isTabActiveAndFocused(tabId);

  if (!active || elapsed <= 0 || !isDomainTracked(domain, config.sites)) {
    return { ok: false, reached: false };
  }

  const dailyLockState = getDailyLockState(config, now);
  if (dailyLockState.locked) {
    return { ok: false, reached: false };
  }

  const usage = await readDailyUsage(now);
  const site = getTrackedSite(domain, config.sites);
  usage.sites[site] = (usage.sites[site] || 0) + elapsed;
  await browser.storage.local.set({ dailyUsage: usage });

  const state = await getDailyLimitState(config, domain, now, config.enabled);
  const reached = config.enabled && state.reached;
  if (reached) {
    await broadcastConfigRecheck();
    return {
      ok: true,
      reached: true,
      resetAt: state.resetAt,
      limitMinutes: state.limitMinutes,
      dailyLimitMode: state.limitMode,
      remainingMs: 0
    };
  }

  return {
    ok: true,
    reached: false,
    resetAt: state.resetAt,
    limitMinutes: state.limitMinutes,
    dailyLimitMode: state.limitMode,
    remainingMs: state.remainingMs
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
