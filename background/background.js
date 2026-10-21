// Airlock - Background Service Worker
// Manages timer sessions, focus tracking, badge, and message coordination.

const dailyLockApi = globalThis.AirlockDailyLock;
const controlsApi = globalThis.AirlockControls;
let settingsCommandQueue = Promise.resolve();
let pendingLease = null;
let pendingAlarmCleared = false;
const progressCursors = new Map();
const DEFAULT_CONFIG = {
  enabled: true,
  sites: [],
  siteWaitEnabled: {},
  delayMinutes: 1,
  settingsDelayMinutes: 1,
  movingTargetEnabled: false,
  dailyLimits: {},
  dailyLimitPolicies: {},
  cooldownUntil: null,
  dailyLockEnabled: false,
  dailyLockStart: dailyLockApi.DEFAULT_START,
  dailyLockEnd: dailyLockApi.DEFAULT_END,
  contentControls: controlsApi.getDefaults()
};

const PENDING_CONFIG_CHANGE_KEY = "pendingConfigChange";
const PENDING_CONFIG_CHANGE_ALARM = "airlock.pendingConfigChange";
const MIDNIGHT_RESET_ALARM = "airlock.sessionReset";
const DAILY_LOCK_BOUNDARY_ALARM = "airlock.dailyLockBoundary";
const COOLDOWN_BOUNDARY_ALARM = "airlock.cooldownBoundary";
const CONFIG_REVISION_KEY = "configRevision";
const SETTINGS_LEASE_MS = 2500;
const MAX_SETTINGS_TICK_MS = 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_DAILY_LIMIT_MINUTES = 24 * 60;
const DEFAULT_DAILY_LIMIT_COOLDOWN_MINUTES = 60;
const MAX_DAILY_LIMIT_COOLDOWN_MINUTES = 24 * 60;
const MAX_USAGE_UPDATE_MS = 5 * 1000;
const USAGE_REMINDER_INTERVAL_MS = 20 * MINUTE_MS;

// --- Initialization ---

browser.runtime.onInstalled.addListener(async () => {
  await enqueueSettingsCommand(async () => {
    await expireCooldownInternal();
    await migrateStoredConfig();
  });
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
    await enqueueSettingsCommand(async () => {
      pendingLease = null;
      await expireCooldownInternal();
      await migrateStoredConfig();
    });
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
    "settingsDelayMinutes",
    "delaySeconds",
    "resetHours",
    "movingTargetEnabled",
    "requireHoverTarget",
    "dailyLimits",
    "dailyLimitPolicies",
    "dailyLimitCooldowns",
    "dailyLimitUsageOffsets",
    "dailyUsage",
    "usageReminderMilestones",
    "guardMinutes",
    "cooldownUntil",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd",
    "contentControls",
    CONFIG_REVISION_KEY
  ]);
  const configBeforeMigration = await readConfig();
  const updates = {};
  if (!Number.isSafeInteger(existing.configRevision) || existing.configRevision < 0) updates.configRevision = 0;
  if (controlsApi.isSupported(existing.contentControls)) {
    const contentControls = controlsApi.normalize(existing.contentControls);
    if (!sameData(contentControls, existing.contentControls)) updates.contentControls = contentControls;
  }

  if (existing.enabled === undefined) updates.enabled = DEFAULT_CONFIG.enabled;
  if (existing.sites === undefined) updates.sites = DEFAULT_CONFIG.sites;

  const delayMinutes = clampDelayMinutes(existing.delayMinutes || DEFAULT_CONFIG.delayMinutes);
  if (existing.delayMinutes !== delayMinutes) updates.delayMinutes = delayMinutes;

  const settingsDelayMinutes = existing.settingsDelayMinutes === undefined
    ? (existing.guardMinutes === undefined
        ? delayMinutes
        : clampSettingsDelayMinutes(existing.guardMinutes))
    : clampSettingsDelayMinutes(existing.settingsDelayMinutes);
  if (existing.settingsDelayMinutes !== settingsDelayMinutes) {
    updates.settingsDelayMinutes = settingsDelayMinutes;
  }

  if (typeof existing.movingTargetEnabled !== "boolean") {
    updates.movingTargetEnabled = DEFAULT_CONFIG.movingTargetEnabled;
  }

  const dailyLimits = normalizeDailyLimits(existing.dailyLimits, existing.sites || []);
  if (!sameData(existing.dailyLimits || {}, dailyLimits)) {
    updates.dailyLimits = dailyLimits;
  }

  const dailyLimitPolicies = normalizeDailyLimitPolicies(
    existing.dailyLimitPolicies,
    existing.sites || []
  );
  if (!sameData(existing.dailyLimitPolicies || {}, dailyLimitPolicies)) {
    updates.dailyLimitPolicies = dailyLimitPolicies;
  }

  const dailyLimitCooldowns = normalizeDailyLimitCooldowns(
    existing.dailyLimitCooldowns,
    existing.sites || []
  );
  if (!sameData(existing.dailyLimitCooldowns || {}, dailyLimitCooldowns)) {
    updates.dailyLimitCooldowns = dailyLimitCooldowns;
  }

  if (!existing.dailyUsage || typeof existing.dailyUsage !== "object") {
    updates.dailyUsage = createEmptyDailyUsage();
  }
  if (!existing.dailyLimitUsageOffsets || typeof existing.dailyLimitUsageOffsets !== "object") {
    updates.dailyLimitUsageOffsets = createEmptyDailyUsage();
  }
  if (
    !existing.usageReminderMilestones ||
    typeof existing.usageReminderMilestones !== "object"
  ) {
    updates.usageReminderMilestones = createEmptyUsageReminderMilestones();
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

  if (Number.isSafeInteger(existing.configRevision) && existing.configRevision >= 0 &&
      Object.keys(updates).some((key) => Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key) && !sameData(configBeforeMigration[key], updates[key]))) {
    updates.configRevision = existing.configRevision + 1;
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
    "siteWaitEnabled",
    "delayMinutes",
    "settingsDelayMinutes",
    "movingTargetEnabled",
    "dailyLimits",
    "dailyLimitPolicies",
    "cooldownUntil",
    "dailyLockEnabled",
    "dailyLockStart",
    "dailyLockEnd",
    "contentControls",
    CONFIG_REVISION_KEY
  ]);
  const delayMinutes = clampDelayMinutes(result.delayMinutes || DEFAULT_CONFIG.delayMinutes);
  return {
    enabled: result.enabled !== false,
    sites: result.sites || [],
    siteWaitEnabled: normalizeSiteWaitEnabled(result.siteWaitEnabled, result.sites || []),
    delayMinutes: delayMinutes,
    settingsDelayMinutes: clampSettingsDelayMinutes(
      result.settingsDelayMinutes === undefined ? delayMinutes : result.settingsDelayMinutes
    ),
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
    ),
    contentControls: controlsApi.isSupported(result.contentControls)
      ? controlsApi.normalize(result.contentControls)
      : result.contentControls
  };
}

async function getConfig() {
  await reconcilePendingConfigChange();
  return readConfig();
}

function isDomainTracked(hostname, sites) {
  return getTrackedSite(hostname, sites) !== null;
}

function normalizeSiteWaitEnabled(value, sites) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(sites.filter((site) => value[site] === false).map((site) => [site, false]));
}

function requiresSiteWait(domain, config) {
  const site = getTrackedSite(domain, config.sites);
  return site !== null && config.siteWaitEnabled[site] !== false;
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

function clampSettingsDelayMinutes(value) {
  // Preserve an explicitly disabled hold without weakening invalid stored values.
  return value === 0 ? 0 : clampDelayMinutes(value);
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

function createEmptyUsageReminderMilestones(now = Date.now()) {
  return { date: getLocalDateKey(now), sites: {} };
}

async function resetDailyStateIfNeeded(now = Date.now()) {
  const today = getLocalDateKey(now);
  const stored = await browser.storage.local.get([
    "dailyUsage",
    "dailyLimitUsageOffsets",
    "usageReminderMilestones"
  ]);
  const usageIsCurrent = stored.dailyUsage && stored.dailyUsage.date === today;
  const offsetsAreCurrent =
    stored.dailyLimitUsageOffsets && stored.dailyLimitUsageOffsets.date === today;
  const remindersAreCurrent =
    stored.usageReminderMilestones && stored.usageReminderMilestones.date === today;

  if (usageIsCurrent && offsetsAreCurrent && remindersAreCurrent) return false;

  const updates = {};
  if (!usageIsCurrent) updates.dailyUsage = createEmptyDailyUsage(now);
  if (!offsetsAreCurrent) updates.dailyLimitUsageOffsets = createEmptyDailyUsage(now);
  if (!remindersAreCurrent) {
    updates.usageReminderMilestones = createEmptyUsageReminderMilestones(now);
  }
  if (!usageIsCurrent || !offsetsAreCurrent) updates.dailyLimitCooldowns = {};

  await browser.storage.local.set(updates);
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

async function readUsageReminderMilestones(now = Date.now()) {
  const result = await browser.storage.local.get("usageReminderMilestones");
  const stored = result.usageReminderMilestones;
  const today = getLocalDateKey(now);

  if (!stored || stored.date !== today || !stored.sites || typeof stored.sites !== "object") {
    return createEmptyUsageReminderMilestones(now);
  }

  return {
    date: today,
    sites: Object.fromEntries(
      Object.entries(stored.sites)
        .map(([site, milestone]) => [site, Math.max(0, Math.floor(Number(milestone) || 0))])
    )
  };
}

async function recordUsageReminderMilestone(site, previousUsedMs, nextUsedMs, now = Date.now()) {
  const reminders = await readUsageReminderMilestones(now);
  const previousMilestone = Math.floor(previousUsedMs / USAGE_REMINDER_INTERVAL_MS);
  const nextMilestone = Math.floor(nextUsedMs / USAGE_REMINDER_INTERVAL_MS);
  const storedMilestone = Object.prototype.hasOwnProperty.call(reminders.sites, site)
    ? reminders.sites[site]
    : previousMilestone;
  const lastMilestone = Math.max(storedMilestone, previousMilestone);

  if (nextMilestone <= lastMilestone) {
    if (!Object.prototype.hasOwnProperty.call(reminders.sites, site)) {
      reminders.sites[site] = lastMilestone;
      await browser.storage.local.set({ usageReminderMilestones: reminders });
    }
    return null;
  }

  reminders.sites[site] = nextMilestone;
  await browser.storage.local.set({ usageReminderMilestones: reminders });
  return {
    site: site,
    milestoneMinutes: nextMilestone * (USAGE_REMINDER_INTERVAL_MS / MINUTE_MS)
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

async function expireCooldownInternal() {
  const stored = await browser.storage.local.get("cooldownUntil");
  if (stored.cooldownUntil === null || stored.cooldownUntil === undefined || normalizeCooldownUntil(stored.cooldownUntil)) return false;
  const previousUntil = Number(stored.cooldownUntil);
  const naturalExpiry = Number.isFinite(previousUntil) && previousUntil > 0;
  const config = await readConfig();
  const previousConfig = { ...config, cooldownUntil: previousUntil };
  const revision = await readConfigRevision();
  let pending = await readPendingConfigChange();
  if (pending && naturalExpiry && !pending.patch && legacyPendingMatches(pending, previousConfig)) {
    const patch = legacyChangePatch(pending, previousConfig);
    if (patch) pending = { ...pending, id: pending.id || createPendingId(), patch, baseRevision: revision,
      baseConfig: previousConfig, remainingMs: getPendingRemainingMs(pending) };
  }
  const matchesPrevious = pending && naturalExpiry && pending.baseRevision === revision && sameData(pending.baseConfig, previousConfig);
  let rebased = null;
  if (matchesPrevious) {
    const validated = validateConfigPatch(config, pending.patch);
    // An end-only request is already satisfied. Other patches keep the exact
    // proposed values and remaining engagement time across this system change.
    if (!validated.reason && !sameData(config, validated.next)) rebased = { ...pending, baseRevision: revision + 1, baseConfig: config };
  }
  const updates = { cooldownUntil: null, configRevision: revision + 1 };
  if (pending) updates[PENDING_CONFIG_CHANGE_KEY] = rebased;
  await browser.storage.local.set(updates);
  if (pending && !rebased) await clearPendingConfigChange();
  return true;
}

async function reconcileCooldownBoundary() {
  return enqueueSettingsCommand(async () => {
    await expireCooldownInternal();
    await reconcilePendingConfigChangeInternal();
    await scheduleCooldownBoundaryAlarm();
    await broadcastConfigRecheck();
    await updateBadge();
  });
}

async function startCooldown(sender) {
  if (sender && !isSettingsSender(sender) && !isContentSender(sender)) return { ok: false, reason: "untrusted-sender" };
  return enqueueSettingsCommand(async () => {
    const config = await readConfig();
    const cooldownUntil = Date.now() + HOUR_MS;
    await commitConfig(config, { ...config, cooldownUntil });
    await reconcilePendingConfigChangeInternal();
    return { ...(await getSettingsSnapshot()), cooldownUntil };
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
      requiresSiteWait(s.domain, config)
  ).length;

  if (activeCount > 0) {
    await browser.action.setBadgeText({ text: String(activeCount) });
    await browser.action.setBadgeBackgroundColor({ color: "#5b8def" });
  } else {
    await browser.action.setBadgeText({ text: "" });
  }
}

// --- Guarded Config Changes ---
// A command owns all reads and writes through completion; internal helpers never
// enqueue another command, so reconciliation cannot deadlock its caller.
function enqueueSettingsCommand(operation) {
  const result = settingsCommandQueue.then(operation);
  settingsCommandQueue = result.catch(() => {});
  return result;
}

function isSettingsSender(sender) {
  if (!sender || (browser.runtime.id && sender.id !== browser.runtime.id)) return false;
  const senderUrl = sender.url || (sender.tab && sender.tab.url);
  if (typeof senderUrl !== "string") return false;
  try {
    const url = new URL(senderUrl);
    url.search = "";
    url.hash = "";
    return ["popup/popup.html", "options/options.html"].some((path) => url.href === browser.runtime.getURL(path));
  } catch { return false; }
}

function isContentSender(sender) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id) || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  if (browser.runtime.id && sender.id !== browser.runtime.id) return false;
  try {
    const url = new URL(sender.url || sender.tab.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function isPlainMap(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalData(value) {
  if (Array.isArray(value)) return value.map(canonicalData);
  if (isPlainMap(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalData(value[key])]));
  return value;
}

function sameData(left, right) {
  return JSON.stringify(canonicalData(left)) === JSON.stringify(canonicalData(right));
}

function normalizeSite(value) {
  if (typeof value !== "string") return null;
  const site = value.trim().toLowerCase();
  if (!site || site.length > 253 || site.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return site;
}

async function readConfigRevision() {
  const stored = await browser.storage.local.get(CONFIG_REVISION_KEY);
  return Number.isSafeInteger(stored.configRevision) && stored.configRevision >= 0 ? stored.configRevision : 0;
}

async function readPendingConfigChange() {
  const result = await browser.storage.local.get(PENDING_CONFIG_CHANGE_KEY);
  return isPlainMap(result[PENDING_CONFIG_CHANGE_KEY]) ? result[PENDING_CONFIG_CHANGE_KEY] : null;
}

function createPendingId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint32Array(4));
    return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("");
  }
  // Older extension test environments may lack Web Crypto; product browsers have it.
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}

async function clearPendingConfigChange() {
  await browser.storage.local.remove(PENDING_CONFIG_CHANGE_KEY);
  progressCursors.clear();
  pendingLease = null;
  await schedulePendingConfigChange(null);
}

async function schedulePendingConfigChange() {
  // Active engagement, never a wall-clock alarm, completes a hold. Legacy
  // unlockAt records are normalized to a fixed remaining duration on startup.
  if (browser.alarms && !pendingAlarmCleared) {
    await browser.alarms.clear(PENDING_CONFIG_CHANGE_ALARM);
    pendingAlarmCleared = true;
  }
}

function getPendingRemainingMs(pending) {
  if (typeof pending.remainingMs === "number" && Number.isFinite(pending.remainingMs)) return Math.max(0, pending.remainingMs);
  if (typeof pending.unlockAt === "number" && Number.isFinite(pending.unlockAt)) return Math.max(0, pending.unlockAt - Date.now());
  return clampSettingsDelayMinutes(pending.waitMinutes === undefined ? DEFAULT_CONFIG.settingsDelayMinutes : pending.waitMinutes) * MINUTE_MS;
}

function legacyChangePatch(change, config) {
  const site = normalizeSite(change.site);
  switch (change.type) {
    case "disableAirlock": return { enabled: false };
    case "disableMovingTarget": return { movingTargetEnabled: false };
    case "disableSiteWait": return site && config.sites.includes(site) ? { siteWaitEnabled: { [site]: false } } : null;
    case "removeSite": return site && config.sites.includes(site) ? { sites: config.sites.filter((entry) => entry !== site) } : null;
    case "reduceDelay": return { delayMinutes: clampDelayMinutes(change.delayMinutes) };
    case "reduceSettingsDelay": return { settingsDelayMinutes: clampSettingsDelayMinutes(change.settingsDelayMinutes) };
    case "changeDailyLimit": return site && config.sites.includes(site) ? { dailyLimits: { [site]: change.dailyLimitMinutes === null ? null : clampDailyLimitMinutes(change.dailyLimitMinutes) } } : null;
    case "changeDailyLimitPolicy": return site && config.sites.includes(site) && config.dailyLimits[site] ? { dailyLimitPolicies: { [site]: normalizeDailyLimitPolicy(change.dailyLimitPolicy) } } : null;
    case "endCooldown": return { cooldownUntil: null };
    case "disableDailyLock": return { dailyLockEnabled: false };
    case "changeDailyLockSchedule": return { dailyLockStart: change.dailyLockStart, dailyLockEnd: change.dailyLockEnd };
    default: return null;
  }
}

function validateConfigPatch(config, patch) {
  if (!isPlainMap(patch)) return { reason: "invalid-patch" };
  const allowed = Object.keys(DEFAULT_CONFIG);
  if (Object.keys(patch).some((key) => !allowed.includes(key))) return { reason: "unknown-setting" };
  const next = { ...config, siteWaitEnabled: { ...config.siteWaitEnabled }, dailyLimits: { ...config.dailyLimits }, dailyLimitPolicies: { ...config.dailyLimitPolicies } };
  const booleans = ["enabled", "movingTargetEnabled", "dailyLockEnabled"];
  for (const key of booleans) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== "boolean") return { reason: "invalid-" + key };
    next[key] = patch[key];
  }
  for (const key of ["delayMinutes", "settingsDelayMinutes"]) {
    if (patch[key] === undefined) continue;
    const minimum = key === "settingsDelayMinutes" ? 0 : 1;
    if (!Number.isInteger(patch[key]) || patch[key] < minimum || patch[key] > 600) return { reason: "invalid-" + key };
    next[key] = patch[key];
  }
  if (patch.sites !== undefined) {
    if (!Array.isArray(patch.sites) || patch.sites.length > 1000 || patch.sites.some((site) => !normalizeSite(site))) return { reason: "invalid-sites" };
    next.sites = [...new Set(patch.sites.map(normalizeSite))];
  }
  for (const key of ["siteWaitEnabled", "dailyLimits", "dailyLimitPolicies"]) {
    if (patch[key] === undefined) continue;
    if (!isPlainMap(patch[key])) return { reason: "invalid-" + key };
    for (const [site, value] of Object.entries(patch[key])) {
      if (normalizeSite(site) !== site || (!next.sites.includes(site) && !(value === null && config.sites.includes(site)))) return { reason: "site-not-tracked" };
      if (value === null) { delete next[key][site]; continue; }
      if (key === "siteWaitEnabled") {
        if (typeof value !== "boolean") return { reason: "invalid-site-wait" };
        if (value) delete next[key][site]; else next[key][site] = false;
      } else if (key === "dailyLimits") {
        if (!Number.isInteger(value) || value < 1 || value > MAX_DAILY_LIMIT_MINUTES) return { reason: "invalid-daily-limit" };
        next[key][site] = value;
      } else {
        if (!isPlainMap(value) || !["block", "cooldown"].includes(value.mode) ||
            Object.keys(value).some((field) => !["mode", "cooldownMinutes"].includes(field)) ||
            (value.cooldownMinutes !== undefined && (!Number.isInteger(value.cooldownMinutes) || value.cooldownMinutes < 1 || value.cooldownMinutes > MAX_DAILY_LIMIT_COOLDOWN_MINUTES))) return { reason: "invalid-daily-limit-policy" };
        if (value.mode === "block") delete next[key][site]; else next[key][site] = normalizeDailyLimitPolicy(value);
      }
    }
  }
  next.siteWaitEnabled = normalizeSiteWaitEnabled(next.siteWaitEnabled, next.sites);
  next.dailyLimits = normalizeDailyLimits(next.dailyLimits, next.sites);
  next.dailyLimitPolicies = normalizeDailyLimitPolicies(next.dailyLimitPolicies, next.sites);
  for (const site of Object.keys(next.dailyLimitPolicies)) {
    if (!next.dailyLimits[site]) {
      if (patch.dailyLimitPolicies && patch.dailyLimitPolicies[site] !== undefined && patch.dailyLimitPolicies[site] !== null && patch.dailyLimitPolicies[site].mode !== "block") return { reason: "invalid-daily-limit-policy" };
      delete next.dailyLimitPolicies[site];
    }
  }
  for (const key of ["dailyLockStart", "dailyLockEnd"]) {
    if (patch[key] === undefined) continue;
    if (!dailyLockApi.parseTimeOfDay(patch[key])) return { reason: "invalid-schedule" };
    next[key] = patch[key];
  }
  if ((next.dailyLockEnabled || patch.dailyLockStart !== undefined || patch.dailyLockEnd !== undefined) && next.dailyLockStart === next.dailyLockEnd) return { reason: "invalid-schedule" };
  if (Object.prototype.hasOwnProperty.call(patch, "cooldownUntil")) {
    if (patch.cooldownUntil !== null) return { reason: "invalid-cooldown" };
    next.cooldownUntil = null;
  }
  if (patch.contentControls !== undefined) {
    if (!controlsApi.isSupported(config.contentControls)) return { reason: "unsupported-controls-version" };
    if (!controlsApi.validatePatch(patch.contentControls)) return { reason: "invalid-content-controls" };
    next.contentControls = controlsApi.mergePatch(config.contentControls, patch.contentControls);
  }
  return { next };
}

function isConfigWeaker(config, next, patch) {
  if ((config.enabled && !next.enabled) || (config.movingTargetEnabled && !next.movingTargetEnabled) ||
      next.delayMinutes < config.delayMinutes || next.settingsDelayMinutes < config.settingsDelayMinutes ||
      (config.cooldownUntil && !next.cooldownUntil) || (config.dailyLockEnabled && !next.dailyLockEnabled) ||
      config.sites.some((site) => !next.sites.includes(site))) return true;
  if (config.dailyLockEnabled && dailyLockApi.classifyScheduleChange(config.dailyLockStart, config.dailyLockEnd, next.dailyLockStart, next.dailyLockEnd) === "weaker") return true;
  for (const site of config.sites) {
    if (config.siteWaitEnabled[site] !== false && next.siteWaitEnabled[site] === false) return true;
    const previousLimit = config.dailyLimits[site];
    if (previousLimit && (!next.dailyLimits[site] || next.dailyLimits[site] > previousLimit)) return true;
    if (isDailyLimitPolicyWeaker(config.dailyLimitPolicies[site], next.dailyLimitPolicies[site])) return true;
  }
  return patch.contentControls !== undefined && controlsApi.classifyPatch(config.contentControls, patch.contentControls) === "weaker";
}

async function commitConfig(config, next) {
  const revision = await readConfigRevision();
  const updates = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!sameData(config[key], next[key])) updates[key] = next[key];
  }
  if (!Object.keys(updates).length) return false;
  const stored = await browser.storage.local.get("dailyLimitCooldowns");
  const cooldowns = { ...(stored.dailyLimitCooldowns || {}) };
  const usageOffsets = await readDailyLimitUsageOffsets();
  let cooldownsChanged = false;
  let offsetsChanged = false;
  for (const site of config.sites) {
    if (!next.sites.includes(site) || (config.dailyLimits[site] && !next.dailyLimits[site])) {
      delete cooldowns[site]; delete usageOffsets.sites[site]; cooldownsChanged = true; offsetsChanged = true;
    } else if (!sameData(config.dailyLimitPolicies[site], next.dailyLimitPolicies[site])) {
      const from = normalizeDailyLimitPolicy(config.dailyLimitPolicies[site]);
      const to = normalizeDailyLimitPolicy(next.dailyLimitPolicies[site]);
      if (to.mode === "block") delete cooldowns[site];
      else if (from.mode === "cooldown" && Number.isFinite(Number(cooldowns[site]))) cooldowns[site] = Number(cooldowns[site]) + (to.cooldownMinutes - from.cooldownMinutes) * MINUTE_MS;
      cooldownsChanged = true;
    }
  }
  if (cooldownsChanged) updates.dailyLimitCooldowns = cooldowns;
  if (offsetsChanged) updates.dailyLimitUsageOffsets = usageOffsets;
  updates.configRevision = revision + 1;
  await browser.storage.local.set(updates);
  await reconcileExpiredSessions();
  await scheduleMidnightResetAlarm();
  await scheduleDailyLockBoundaryAlarm();
  await scheduleCooldownBoundaryAlarm();
  await broadcastConfigRecheck();
  await updateBadge();
  return true;
}

async function getSettingsSnapshot(tabId) {
  const config = await readConfig();
  const [revision, pending, usage, stored, usageOffsets] = await Promise.all([
    readConfigRevision(), readPendingConfigChange(), readDailyUsage(),
    browser.storage.local.get("dailyLimitCooldowns"), readDailyLimitUsageOffsets()
  ]);
  const snapshot = { ok: true, config: { ...config, contentControls: controlsApi.normalize(config.contentControls) },
    contentControlsSupported: controlsApi.isSupported(config.contentControls),
    storedContentControlsVersion: config.contentControls && config.contentControls.version, revision, pending, usage,
    dailyLimitCooldowns: normalizeDailyLimitCooldowns(stored.dailyLimitCooldowns, config.sites), dailyLimitUsageOffsets: usageOffsets };
  if (Number.isInteger(tabId)) snapshot.currentSiteStatus = await getCurrentSiteStatus(tabId, snapshot);
  return snapshot;
}

async function getCurrentSiteStatus(tabId, snapshot) {
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch { return null; }
  let domain;
  try { domain = new URL(tab.url).hostname; } catch { return null; }
  const { config, usage, dailyLimitCooldowns, dailyLimitUsageOffsets } = snapshot;
  const site = getTrackedSite(domain, config.sites);
  const active = await isTabActiveAndFocused(tabId);
  const now = Date.now();
  const todayUsedMs = site ? usage.sites[site] || 0 : 0;
  const limit = site ? config.dailyLimits[site] || null : null;
  const policy = normalizeDailyLimitPolicy(site && config.dailyLimitPolicies[site]);
  const siteCooldown = site ? dailyLimitCooldowns[site] : null;
  const expiredBudget = Number.isFinite(siteCooldown) && siteCooldown <= now;
  const allowanceUsedMs = expiredBudget ? 0 : Math.max(0, todayUsedMs - (site ? dailyLimitUsageOffsets.sites[site] || 0 : 0));
  const status = { domain, site, tracked: site !== null, active, paused: !active, reason: "allowed", remainingMs: null,
    unlockAt: null, resetAt: getNextLocalMidnight(now), todayUsedMs, allowanceUsedMs, dailyLimitMinutes: limit, dailyLimitMode: policy.mode };
  if (!site) status.reason = "untracked";
  else if (config.cooldownUntil) { status.reason = "cooldown"; status.unlockAt = config.cooldownUntil; }
  else if (!config.enabled) status.reason = "disabled";
  else if (getDailyLockState(config, now).locked) { status.reason = "daily-lock"; status.unlockAt = getDailyLockState(config, now).unlockAt; }
  else if (limit && allowanceUsedMs >= limit * MINUTE_MS) { status.reason = "daily-limit"; status.resetAt = siteCooldown > now ? siteCooldown : getNextLocalMidnight(now); }
  else if (requiresSiteWait(domain, config)) {
    const session = await getSession(tabId);
    if (!session || session.domain !== domain || isSessionExpired(session, now) || (!session.completed && session.remainingMs > 0)) {
      status.reason = "wait";
      status.remainingMs = session && session.domain === domain && !isSessionExpired(session, now) ? session.remainingMs : config.delayMinutes * MINUTE_MS;
    }
  }
  return status;
}

function getSettingsState(message, sender) {
  if (!isSettingsSender(sender)) return Promise.resolve({ ok: false, reason: "untrusted-sender" });
  return enqueueSettingsCommand(async () => {
    await reconcilePendingConfigChangeInternal();
    return getSettingsSnapshot(message.tabId);
  });
}

async function settingsFailure(reason, tabId) {
  return { ...(await getSettingsSnapshot(tabId)), ok: false, reason };
}

function requestConfigChange(message, sender) {
  if (!isSettingsSender(sender)) return Promise.resolve({ ok: false, reason: "untrusted-sender" });
  return enqueueSettingsCommand(() => requestConfigChangeInternal(message));
}

async function requestConfigChangeInternal(message) {
  await reconcilePendingConfigChangeInternal();
  const config = await readConfig();
  const revision = await readConfigRevision();
  if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision !== revision) return settingsFailure("stale-revision", message.tabId);
  if (await readPendingConfigChange()) return settingsFailure("pending-exists", message.tabId);
  const validated = validateConfigPatch(config, message.patch);
  if (validated.reason) return settingsFailure(validated.reason, message.tabId);
  const next = validated.next;
  if (sameData(config, next)) return { ...(await getSettingsSnapshot(message.tabId)), applied: true };
  if (config.settingsDelayMinutes === 0 || !isConfigWeaker(config, next, message.patch)) {
    await commitConfig(config, next);
    return { ...(await getSettingsSnapshot(message.tabId)), applied: true };
  }
  const pending = {
    id: createPendingId(), type: "configPatch",
    patch: message.patch, baseRevision: revision, baseConfig: config, createdAt: Date.now(),
    waitMinutes: config.settingsDelayMinutes, remainingMs: config.settingsDelayMinutes * MINUTE_MS,
    description: "Changing Airlock settings"
  };
  pendingLease = null;
  await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: pending });
  await schedulePendingConfigChange(pending);
  return { ...(await getSettingsSnapshot(message.tabId)), applied: false };
}

function legacyPendingMatches(pending, config) {
  if (pending.type === "reduceDelay") return pending.previousDelayMinutes === undefined ? config.delayMinutes <= pending.waitMinutes : config.delayMinutes === pending.previousDelayMinutes;
  if (pending.type === "reduceSettingsDelay") return config.settingsDelayMinutes === pending.previousSettingsDelayMinutes;
  if (pending.type === "changeDailyLimitPolicy") return sameData(normalizeDailyLimitPolicy(config.dailyLimitPolicies[pending.site]), pending.previousDailyLimitPolicy);
  if (pending.type === "changeDailyLockSchedule") return config.dailyLockEnabled && config.dailyLockStart === pending.previousDailyLockStart && config.dailyLockEnd === pending.previousDailyLockEnd;
  if (pending.type === "endCooldown") return config.cooldownUntil === pending.cooldownUntil;
  return true;
}

async function reconcilePendingConfigChangeInternal() {
  await expireCooldownInternal();
  let pending = await readPendingConfigChange();
  const storedPending = pending;
  if (!pending) { await schedulePendingConfigChange(null); return null; }
  if (!pending.type || pending.type === "increaseResetHours") { await clearPendingConfigChange(); return null; }
  const config = await readConfig();
  if (pending.type === "endCooldown" && (!config.cooldownUntil || config.cooldownUntil !== pending.cooldownUntil)) { await clearPendingConfigChange(); return null; }
  if (!pending.patch) {
    if (!legacyPendingMatches(pending, config)) { await clearPendingConfigChange(); return null; }
    const patch = legacyChangePatch(pending, config);
    if (!patch) { await clearPendingConfigChange(); return null; }
    pending = { ...pending, patch, baseRevision: await readConfigRevision(), baseConfig: config };
  }
  if (pending.baseRevision !== await readConfigRevision() || !sameData(config, pending.baseConfig)) { await clearPendingConfigChange(); return null; }
  const remainingMs = getPendingRemainingMs(pending);
  pending = { ...pending, id: pending.id || createPendingId(), remainingMs };
  delete pending.unlockAt;
  if (!pending.description) pending.description = "Changing Airlock settings";
  if (!sameData(pending, storedPending)) await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: pending });
  await schedulePendingConfigChange(pending);
  if (remainingMs <= 0) { await applyPendingConfigChangeInternal(pending); return null; }
  return pending;
}

function reconcilePendingConfigChange() {
  return enqueueSettingsCommand(reconcilePendingConfigChangeInternal);
}

async function applyPendingConfigChangeInternal(pending) {
  const config = await readConfig();
  if (pending.baseRevision !== await readConfigRevision() || !sameData(config, pending.baseConfig)) {
    await clearPendingConfigChange(); return false;
  }
  const validated = validateConfigPatch(config, pending.patch);
  if (validated.reason) { await clearPendingConfigChange(); return false; }
  await commitConfig(config, validated.next);
  await clearPendingConfigChange();
  return true;
}

async function isSettingsViewActive(sender) {
  if (sender.tab) return isTabActiveAndFocused(sender.tab.id);
  if (browser.windows.getLastFocused) {
    try { return (await browser.windows.getLastFocused()).focused === true; } catch { return false; }
  }
  return windowFocused;
}

function leaseOwner(sender) {
  return (sender.documentId || "") + "|" + (sender.tab ? sender.tab.id : "popup") + "|" + (sender.url || "");
}

function advancePendingConfigChange(message, sender) {
  if (!isSettingsSender(sender)) return Promise.resolve({ ok: false, reason: "untrusted-sender" });
  return enqueueSettingsCommand(async () => {
    await reconcilePendingConfigChangeInternal();
    const pending = await readPendingConfigChange();
    if (!pending || message.pendingId !== pending.id) return settingsFailure("stale-pending", message.tabId);
    if (typeof message.clientId !== "string" || message.clientId.length < 1 || message.clientId.length > 200 ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 0 || !Number.isFinite(message.elapsedMs) || message.elapsedMs < 0) return settingsFailure("invalid-progress", message.tabId);
    if (!await isSettingsViewActive(sender)) {
      if (pendingLease && pendingLease.clientId === message.clientId && pendingLease.owner === leaseOwner(sender)) pendingLease = null;
      return settingsFailure("inactive-view", message.tabId);
    }
    const now = Date.now();
    const owner = leaseOwner(sender);
    const cursorKey = pending.id + "|" + message.clientId + "|" + owner;
    if (progressCursors.has(cursorKey) && message.sequence <= progressCursors.get(cursorKey)) return settingsFailure("stale-sequence", message.tabId);
    if (pendingLease && pendingLease.pendingId === pending.id && now - pendingLease.lastAt <= SETTINGS_LEASE_MS) {
      if (pendingLease.clientId !== message.clientId || pendingLease.owner !== owner) return settingsFailure("lease-held", message.tabId);
      if (message.sequence <= pendingLease.sequence) return settingsFailure("stale-sequence", message.tabId);
      const elapsed = Math.min(message.elapsedMs, Math.max(0, now - pendingLease.lastAt), MAX_SETTINGS_TICK_MS);
      const next = { ...pending, remainingMs: Math.max(0, pending.remainingMs - elapsed) };
      progressCursors.set(cursorKey, message.sequence);
      pendingLease = { ...pendingLease, sequence: message.sequence, lastAt: now };
      if (next.remainingMs <= 0) {
        const applied = await applyPendingConfigChangeInternal(next);
        return { ...(await getSettingsSnapshot(message.tabId)), applied };
      }
      await browser.storage.local.set({ [PENDING_CONFIG_CHANGE_KEY]: next });
    } else {
      progressCursors.set(cursorKey, message.sequence);
      pendingLease = { pendingId: pending.id, clientId: message.clientId, owner, sequence: message.sequence, lastAt: now };
    }
    return { ...(await getSettingsSnapshot(message.tabId)), applied: false };
  });
}

function releasePendingConfigChange(message, sender) {
  if (!isSettingsSender(sender)) return Promise.resolve({ ok: false, reason: "untrusted-sender" });
  return enqueueSettingsCommand(async () => {
    const pending = await readPendingConfigChange();
    if (!pending || message.pendingId !== pending.id) return settingsFailure("stale-pending", message.tabId);
    if (pendingLease && pendingLease.clientId === message.clientId && pendingLease.owner === leaseOwner(sender)) pendingLease = null;
    return getSettingsSnapshot(message.tabId);
  });
}

function cancelPendingConfigChange(message, sender) {
  if (!isSettingsSender(sender)) return Promise.resolve({ ok: false, reason: "untrusted-sender" });
  return enqueueSettingsCommand(async () => {
    const pending = await readPendingConfigChange();
    if (!pending || message.pendingId !== pending.id) return settingsFailure("stale-pending", message.tabId);
    await clearPendingConfigChange();
    return getSettingsSnapshot(message.tabId);
  });
}


async function reconcileExpiredSessions() {
  const config = await readConfig();
  const dailyLockState = getDailyLockState(config);
  const sessions = await getAllSessions();
  const now = Date.now();

  for (const { key, tabId, session } of sessions) {
    if (!requiresSiteWait(session.domain, config)) {
      await removeSession(tabId);
      continue;
    }
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

  if (changes.contentControls || changes.configRevision) broadcastConfigRecheck();

  if (changes.enabled || changes.sites || changes.siteWaitEnabled || changes.delayMinutes) {
    reconcileExpiredSessions().catch((error) => {
      console.warn("[Airlock] Failed to reconcile expired sessions:", error);
    });
  }

  if (
    changes.enabled ||
    changes.sites ||
    changes.siteWaitEnabled ||
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
  if (!message || typeof message.type !== "string") return;
  const settingsCommands = {
    GET_SETTINGS_STATE: () => getSettingsState(message, sender),
    REQUEST_CONFIG_CHANGE: () => requestConfigChange(message, sender),
    CANCEL_PENDING_CONFIG_CHANGE: () => cancelPendingConfigChange(message, sender),
    ADVANCE_PENDING_CONFIG_CHANGE: () => advancePendingConfigChange(message, sender),
    RELEASE_PENDING_CONFIG_CHANGE: () => releasePendingConfigChange(message, sender)
  };
  if (Object.prototype.hasOwnProperty.call(settingsCommands, message.type)) {
    settingsCommands[message.type]().then(sendResponse).catch(() => sendResponse({ ok: false, reason: "settings-unavailable" }));
    return true;
  }
  if (message.type === "START_COOLDOWN") {
    if (!isSettingsSender(sender) && !isContentSender(sender)) {
      sendResponse({ ok: false, reason: "untrusted-sender" });
    } else startCooldown(sender).then(sendResponse).catch(() => sendResponse({ ok: false, reason: "settings-unavailable" }));
    return true;
  }

  if (!isContentSender(sender)) return;
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
    handleTimerDone(tabId).then(async () => {
      await updateBadge();
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false, reason: "timer-unavailable" }));
    return true;
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

  if (!requiresSiteWait(domain, config)) {
    await removeSession(tabId);
    return addDailyLimitMetadata({ type: "NO_OVERLAY", active: active }, dailyLimitState);
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
  const previousUsedMs = usage.sites[site] || 0;
  usage.sites[site] = previousUsedMs + elapsed;
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

  const usageReminder = await recordUsageReminderMilestone(
    site,
    previousUsedMs,
    usage.sites[site],
    now
  );

  return {
    ok: true,
    reached: false,
    resetAt: state.resetAt,
    limitMinutes: state.limitMinutes,
    dailyLimitMode: state.limitMode,
    remainingMs: state.remainingMs,
    usageReminder: usageReminder
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

// Notify supported top-level pages to evaluate their current URL. Event URLs are
// never forwarded: an older event must not replay an obsolete route decision.
if (browser.webNavigation) {
  const notifyRouteChange = (details) => {
    if (!details || details.frameId !== 0 || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    try {
      const url = new URL(details.url);
      if ((url.protocol === "https:" || url.protocol === "http:") && controlsApi.getPlatform(url.hostname)) {
        sendTabMessage(details.tabId, { type: "AIRLOCK_ROUTE_CHANGED" });
      }
    } catch { /* Invalid/unsupported navigation. */ }
  };
  const routeFilter = { url: ["youtube.com", "instagram.com", "facebook.com"].map((hostSuffix) => ({ hostSuffix })) };
  browser.webNavigation.onCommitted.addListener(notifyRouteChange, routeFilter);
  browser.webNavigation.onHistoryStateUpdated.addListener(notifyRouteChange, routeFilter);
}
