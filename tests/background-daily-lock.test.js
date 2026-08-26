const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(rootDir, "shared", "daily-lock.js"), "utf8");
const backgroundSource = fs.readFileSync(
  path.join(rootDir, "background", "background.js"),
  "utf8"
);

function createEvent() {
  const listeners = [];
  return {
    listeners: listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function selectStoredValues(store, keys) {
  if (keys === null) return { ...store };
  const requestedKeys = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    requestedKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(store, key))
      .map((key) => [key, store[key]])
  );
}

function createBrowser(initialConfig, tabs) {
  const localData = { ...initialConfig };
  const sessionData = {};
  const alarms = new Map();
  const tabMessages = [];
  const runtimeOnMessage = createEvent();
  const alarmOnAlarm = createEvent();

  const browser = {
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: runtimeOnMessage
    },
    storage: {
      local: {
        async get(keys) {
          return selectStoredValues(localData, keys);
        },
        async set(values) {
          Object.assign(localData, values);
        },
        async remove(keys) {
          const keysToRemove = Array.isArray(keys) ? keys : [keys];
          keysToRemove.forEach((key) => delete localData[key]);
        }
      },
      session: {
        async get(keys) {
          return selectStoredValues(sessionData, keys);
        },
        async set(values) {
          Object.assign(sessionData, values);
        },
        async remove(keys) {
          const keysToRemove = Array.isArray(keys) ? keys : [keys];
          keysToRemove.forEach((key) => delete sessionData[key]);
        }
      },
      onChanged: createEvent()
    },
    alarms: {
      onAlarm: alarmOnAlarm,
      async create(name, details) {
        alarms.set(name, details);
      },
      async clear(name) {
        return alarms.delete(name);
      }
    },
    tabs: {
      onRemoved: createEvent(),
      onActivated: createEvent(),
      async query(query) {
        if (query.active) return tabs.filter((tab) => tab.active);
        return tabs;
      },
      async get(tabId) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("Unknown tab");
        return tab;
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId: tabId, message: message });
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: createEvent(),
      async get() {
        return { focused: true };
      }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };

  return {
    browser: browser,
    localData: localData,
    sessionData: sessionData,
    alarms: alarms,
    tabMessages: tabMessages
  };
}

async function loadBackground(config) {
  const tabs = [{ id: 7, active: true, windowId: 1 }];
  const state = createBrowser(config, tabs);
  const context = vm.createContext({
    browser: state.browser,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  });

  vm.runInContext(sharedSource, context, { filename: "shared/daily-lock.js" });
  vm.runInContext(backgroundSource, context, { filename: "background/background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return { context: context, state: state };
}

function formatTime(date) {
  return String(date.getHours()).padStart(2, "0") + ":" +
    String(date.getMinutes()).padStart(2, "0");
}

function activeWindowAroundNow() {
  return {
    start: formatTime(new Date(Date.now() - 2 * 60 * 1000)),
    end: formatTime(new Date(Date.now() + 2 * 60 * 1000))
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    sites: ["example.com"],
    delayMinutes: 1,
    resetHours: 24,
    requireHoverTarget: false,
    dailyLimits: {},
    dailyUsage: { date: localDateKey(), sites: {} },
    guardMinutes: 1,
    cooldownUntil: null,
    dailyLockEnabled: false,
    dailyLockStart: "22:00",
    dailyLockEnd: "07:00",
    ...overrides
  };
}

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

test("daily lock overrides session creation and schedules an unlock boundary", async () => {
  const window = activeWindowAroundNow();
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLockEnabled: true,
      dailyLockStart: window.start,
      dailyLockEnd: window.end
    })
  );

  const response = await context.handleContentReady(7, "example.com");

  assert.equal(response.type, "SHOW_DAILY_LOCK");
  assert.ok(response.unlockAt > Date.now());
  assert.deepEqual(state.sessionData, {});
  assert.ok(state.alarms.has("airlock.dailyLockBoundary"));
});

test("unlocking restores the underlying completed or incomplete session state", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const firstResponse = await context.handleContentReady(7, "example.com");

  assert.equal(firstResponse.type, "SHOW_OVERLAY");
  assert.ok(state.sessionData.session_7);

  const window = activeWindowAroundNow();
  state.localData.dailyLockEnabled = true;
  state.localData.dailyLockStart = window.start;
  state.localData.dailyLockEnd = window.end;
  const lockedResponse = await context.handleContentReady(7, "example.com");
  assert.equal(lockedResponse.type, "SHOW_DAILY_LOCK");

  state.localData.dailyLockEnabled = false;
  const resumedResponse = await context.handleContentReady(7, "example.com");
  assert.equal(resumedResponse.type, "SHOW_OVERLAY");

  state.sessionData.session_7.remainingMs = 0;
  state.sessionData.session_7.completed = true;
  state.localData.dailyLockEnabled = true;
  const completedLockResponse = await context.handleContentReady(7, "example.com");
  assert.equal(completedLockResponse.type, "SHOW_DAILY_LOCK");

  state.localData.dailyLockEnabled = false;
  const unlockedResponse = await context.handleContentReady(7, "example.com");
  assert.equal(unlockedResponse.type, "NO_OVERLAY");
});

test("a site is blocked after its daily usage reaches its configured limit", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLimits: { "example.com": 1 },
      dailyUsage: {
        date: localDateKey(),
        sites: { "example.com": 59 * 1000 }
      }
    })
  );

  const usageResponse = await context.handleDailyUsageUpdate(7, "news.example.com", 1000);
  const contentResponse = await context.handleContentReady(7, "news.example.com");

  assert.equal(usageResponse.reached, true);
  assert.equal(usageResponse.remainingMs, 0);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 60 * 1000);
  assert.equal(contentResponse.type, "SHOW_DAILY_LIMIT");
  assert.equal(contentResponse.limitMinutes, 1);
  assert.ok(contentResponse.resetAt > Date.now());
  assert.ok(
    state.tabMessages.some((entry) => entry.message.type === "RECHECK_CONFIG")
  );
});

test("daily usage from a previous local day does not block the site", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { context } = await loadBackground(
    baseConfig({
      dailyLimits: { "example.com": 1 },
      dailyUsage: {
        date: localDateKey(yesterday),
        sites: { "example.com": 60 * 1000 }
      }
    })
  );

  const response = await context.handleContentReady(7, "example.com");

  assert.equal(response.type, "SHOW_OVERLAY");
  assert.equal(response.dailyUsageRemainingMs, 60 * 1000);
});

test("raising a daily limit uses the guarded settings countdown", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ dailyLimits: { "example.com": 30 } })
  );

  const response = await context.startPendingConfigChange({
    type: "changeDailyLimit",
    site: "example.com",
    dailyLimitMinutes: 60
  });

  assert.equal(response.ok, true);
  assert.equal(response.applied, false);
  assert.equal(response.pending.type, "changeDailyLimit");
  assert.equal(response.pending.remainingMs, 60 * 1000);
  assert.equal(state.localData.dailyLimits["example.com"], 30);
});

test("cooldown blocks tracked sites for an hour even when Airlock is toggled off", async () => {
  const { context, state } = await loadBackground(baseConfig({ enabled: false }));
  const before = Date.now();

  const started = await context.startCooldown();
  const response = await context.handleContentReady(7, "example.com");

  assert.equal(started.ok, true);
  assert.ok(started.cooldownUntil >= before + 60 * 60 * 1000);
  assert.equal(response.type, "SHOW_COOLDOWN");
  assert.equal(response.unlockAt, state.localData.cooldownUntil);
  assert.ok(state.alarms.has("airlock.cooldownBoundary"));
});

test("ending a cooldown early requires the full settings hold", async () => {
  const cooldownUntil = Date.now() + 60 * 60 * 1000;
  const { context, state } = await loadBackground(baseConfig({ cooldownUntil: cooldownUntil }));

  const pending = await context.startPendingConfigChange({ type: "endCooldown" });
  assert.equal(pending.applied, false);
  assert.equal(pending.pending.remainingMs, 60 * 1000);
  assert.equal(state.localData.cooldownUntil, cooldownUntil);

  await context.advancePendingConfigChange(30 * 1000);
  assert.equal(state.localData.cooldownUntil, cooldownUntil);

  await context.advancePendingConfigChange(30 * 1000);
  assert.equal(state.localData.cooldownUntil, null);
  assert.equal(state.localData.pendingConfigChange, undefined);
});

test("shortening a daily lock is guarded while lengthening it applies immediately", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLockEnabled: true,
      dailyLockStart: "22:00",
      dailyLockEnd: "07:00"
    })
  );

  const shorter = await context.startPendingConfigChange({
    type: "changeDailyLockSchedule",
    dailyLockStart: "23:00",
    dailyLockEnd: "07:00"
  });
  assert.equal(shorter.applied, false);
  assert.equal(state.localData.dailyLockStart, "22:00");

  await context.advancePendingConfigChange(60 * 1000);
  assert.equal(state.localData.dailyLockStart, "23:00");

  const longer = await context.startPendingConfigChange({
    type: "changeDailyLockSchedule",
    dailyLockStart: "21:00",
    dailyLockEnd: "07:00"
  });
  assert.equal(longer.applied, true);
  assert.equal(state.localData.dailyLockStart, "21:00");
  assert.equal(state.localData.pendingConfigChange, undefined);
});
