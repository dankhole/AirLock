const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const controlsSource = fs.readFileSync(path.join(rootDir, "shared", "content-controls.js"), "utf8");
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

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, reorderObjectKeys(value[key])]));
  return value;
}

function createBrowser(initialConfig, tabs, initialSession = {}, options = {}) {
  const cloneStored = (value) => options.reorderKeys ? reorderObjectKeys(structuredClone(value)) : structuredClone(value);
  const localData = cloneStored(initialConfig);
  const localWrites = [];
  const sessionData = structuredClone(initialSession);
  const alarms = new Map();
  const tabMessages = [];
  const runtimeOnMessage = createEvent();
  const alarmOnAlarm = createEvent();

  const browser = {
    runtime: {
      id: "airlock-test",
      getURL: (entry) => "moz-extension://airlock-test/" + entry,
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: runtimeOnMessage
    },
    storage: {
      local: {
        async get(keys) {
          return cloneStored(selectStoredValues(localData, keys));
        },
        async set(values) {
          localWrites.push(cloneStored(values));
          Object.assign(localData, cloneStored(values));
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
          Object.assign(sessionData, structuredClone(values));
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
        tabMessages.push({ tabId: tabId, message: structuredClone(message) });
      }
    },
    webNavigation: { onCommitted: createEvent(), onHistoryStateUpdated: createEvent() },
    windows: {
      WINDOW_ID_NONE: -1,
      focused: true,
      onFocusChanged: createEvent(),
      async getLastFocused() { return { focused: this.focused }; },
      async get() {
        return { focused: this.focused };
      }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };

  return {
    browser: browser,
    tabs: tabs,
    localWrites,
    localData: localData,
    sessionData: sessionData,
    alarms: alarms,
    tabMessages: tabMessages
  };
}

async function loadBackground(config, initialSession = {}, options = {}) {
  const tabs = [{ id: 7, active: true, windowId: 1, url: "https://example.com/" }];
  const state = createBrowser(config, tabs, initialSession, options);
  const clock = { now: options.now === undefined ? Date.now() : options.now };
  class BackgroundDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: BackgroundDate,
    URL,
    crypto: require("node:crypto").webcrypto,
    browser: state.browser,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  });

  vm.runInContext(controlsSource, context, { filename: "shared/content-controls.js" });
  vm.runInContext(sharedSource, context, { filename: "shared/daily-lock.js" });
  vm.runInContext(backgroundSource, context, { filename: "background/background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  context.testState = state;
  context.testClock = clock;
  context.testUiSender = { id: "airlock-test", url: state.browser.runtime.getURL("popup/popup.html") };
  context.testSequence = 0;
  return { context: context, state: state };
}

function sendUi(context, message, sender = context.testUiSender) {
  return new Promise((resolve) => {
    const listener = context.testState.browser.runtime.onMessage.listeners[0];
    listener(message, sender, (response) => resolve(structuredClone(response)));
  });
}

async function advanceGuard(context, elapsedMs) {
  let pending = await context.readPendingConfigChange();
  if (!pending) return null;
  const progress = (elapsed) => sendUi(context, { type: "ADVANCE_PENDING_CONFIG_CHANGE", pendingId: pending.id,
    clientId: "test-popup", sequence: ++context.testSequence, elapsedMs: elapsed });
  if (context.testPendingId !== pending.id) {
    context.testPendingId = pending.id;
    await progress(0);
  }
  let result;
  for (let elapsed = 0; elapsed < elapsedMs; elapsed += 1000) {
    const tick = Math.min(1000, elapsedMs - elapsed);
    context.testClock.now += tick;
    result = await progress(tick);
    if (result.applied) break;
  }
  return result;
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
    settingsDelayMinutes: 1,
    dailyLimits: {},
    dailyLimitPolicies: {},
    dailyLimitCooldowns: {},
    dailyUsage: { date: localDateKey(), sites: {} },
    usageReminderMilestones: { date: localDateKey(), sites: {} },
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

test("daily usage is recorded without a limit even when Airlock is off", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ enabled: false })
  );

  const response = await context.handleDailyUsageUpdate(7, "news.example.com", 1500);

  assert.equal(response.ok, true);
  assert.equal(response.reached, false);
  assert.equal(response.limitMinutes, null);
  assert.equal(response.remainingMs, null);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 1500);
});

test("daily totals continue past a configured limit while Airlock is off", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      enabled: false,
      dailyLimits: { "example.com": 1 },
      dailyUsage: {
        date: localDateKey(),
        sites: { "example.com": 59 * 1000 }
      }
    })
  );

  const response = await context.handleDailyUsageUpdate(7, "example.com", 2000);

  assert.equal(response.reached, false);
  assert.equal(response.remainingMs, 0);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 61 * 1000);
});

test("focused usage crossing each 20-minute milestone prompts only once", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyUsage: {
        date: localDateKey(),
        sites: { "example.com": 20 * 60 * 1000 - 1000 }
      }
    })
  );

  const first = await context.handleDailyUsageUpdate(7, "news.example.com", 1000);
  const duplicate = await context.handleDailyUsageUpdate(7, "example.com", 1000);

  assert.equal(first.usageReminder.site, "example.com");
  assert.equal(first.usageReminder.milestoneMinutes, 20);
  assert.equal(duplicate.usageReminder, null);
  assert.equal(state.localData.usageReminderMilestones.sites["example.com"], 1);

  state.localData.dailyUsage.sites["example.com"] = 40 * 60 * 1000 - 1000;
  const second = await context.handleDailyUsageUpdate(7, "example.com", 1000);

  assert.equal(second.usageReminder.milestoneMinutes, 40);
  assert.equal(state.localData.usageReminderMilestones.sites["example.com"], 2);
});

test("existing usage is baselined so an upgrade does not show a retroactive reminder", async () => {
  const config = baseConfig({
    dailyUsage: {
      date: localDateKey(),
      sites: { "example.com": 25 * 60 * 1000 }
    }
  });
  delete config.usageReminderMilestones;
  const { context, state } = await loadBackground(config);

  const response = await context.handleDailyUsageUpdate(7, "example.com", 1000);

  assert.equal(response.usageReminder, null);
  assert.equal(state.localData.usageReminderMilestones.sites["example.com"], 1);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 25 * 60 * 1000 + 1000);
});

test("wait sessions always expire at the next local midnight", async () => {
  const { context } = await loadBackground(baseConfig());
  const createdAt = new Date(2026, 7, 31, 10, 15, 0, 0).getTime();
  const expectedMidnight = new Date(2026, 8, 1, 0, 0, 0, 0).getTime();
  const session = context.createTimerSession("example.com", 1, createdAt);

  assert.equal(session.expiresAt, expectedMidnight);
  assert.equal(context.getSessionExpiresAt(session), expectedMidnight);
  assert.equal(context.isSessionExpired(session, expectedMidnight - 1), false);
  assert.equal(context.isSessionExpired(session, expectedMidnight), true);
});

test("midnight resets daily state even when there are no open sessions", async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0);
  const tomorrowMs = tomorrow.getTime();
  const { context, state } = await loadBackground(
    baseConfig({
      dailyUsage: {
        date: localDateKey(),
        sites: { "example.com": 45 * 60 * 1000 }
      },
      dailyLimitUsageOffsets: {
        date: localDateKey(),
        sites: { "example.com": 15 * 60 * 1000 }
      },
      dailyLimitCooldowns: {
        "example.com": tomorrowMs + 60 * 60 * 1000
      },
      usageReminderMilestones: {
        date: localDateKey(),
        sites: { "example.com": 2 }
      }
    })
  );

  assert.equal(state.sessionData.session_7, undefined);
  assert.ok(state.alarms.has("airlock.sessionReset"));

  const reset = await context.resetDailyStateIfNeeded(tomorrowMs);

  assert.equal(reset, true);
  assert.equal(state.localData.dailyUsage.date, localDateKey(tomorrow));
  assert.equal(Object.keys(state.localData.dailyUsage.sites).length, 0);
  assert.equal(state.localData.dailyLimitUsageOffsets.date, localDateKey(tomorrow));
  assert.equal(Object.keys(state.localData.dailyLimitUsageOffsets.sites).length, 0);
  assert.equal(Object.keys(state.localData.dailyLimitCooldowns).length, 0);
  assert.equal(state.localData.usageReminderMilestones.date, localDateKey(tomorrow));
  assert.equal(Object.keys(state.localData.usageReminderMilestones.sites).length, 0);
});

test("a per-site cooldown starts at the limit and resets usage when it expires", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLimits: { "example.com": 1 },
      dailyLimitPolicies: {
        "example.com": { mode: "cooldown", cooldownMinutes: 5 }
      },
      dailyUsage: {
        date: localDateKey(),
        sites: { "example.com": 59 * 1000 }
      }
    })
  );

  const before = context.testClock.now;
  const usageResponse = await context.handleDailyUsageUpdate(7, "example.com", 1000);
  const cooldownUntil = state.localData.dailyLimitCooldowns["example.com"];

  assert.equal(usageResponse.reached, true);
  assert.equal(usageResponse.dailyLimitMode, "cooldown");
  assert.equal(usageResponse.resetAt, cooldownUntil);
  assert.ok(cooldownUntil >= before + 5 * 60 * 1000);

  const blockedResponse = await context.handleContentReady(7, "example.com");
  assert.equal(blockedResponse.type, "SHOW_DAILY_LIMIT");
  assert.equal(blockedResponse.dailyLimitMode, "cooldown");
  assert.equal(blockedResponse.resetAt, cooldownUntil);

  const config = await context.readConfig();
  const expiredState = await context.getDailyLimitState(
    config,
    "example.com",
    cooldownUntil + 1
  );
  assert.equal(expiredState.reached, false);
  assert.equal(expiredState.remainingMs, 60 * 1000);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 60 * 1000);
  assert.equal(state.localData.dailyLimitUsageOffsets.sites["example.com"], 60 * 1000);
  assert.equal(state.localData.dailyLimitCooldowns["example.com"], undefined);

  await context.handleDailyUsageUpdate(7, "example.com", 1000);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 61 * 1000);
});

test("switching from a hard block to cooldown requires the settings hold", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      delayMinutes: 2,
      settingsDelayMinutes: 2,
      dailyLimits: { "example.com": 30 }
    })
  );

  const response = await requestPatch(context, {
    dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 60 } }
  });

  assert.equal(response.applied, false);
  assert.equal(response.pending.remainingMs, 2 * 60 * 1000);
  assert.equal(state.localData.dailyLimitPolicies["example.com"], undefined);
});

test("making a per-site cooldown longer applies immediately", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLimits: { "example.com": 30 },
      dailyLimitPolicies: {
        "example.com": { mode: "cooldown", cooldownMinutes: 30 }
      }
    })
  );

  const response = await requestPatch(context, {
    dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 60 } }
  });

  assert.equal(response.applied, true);
  assert.equal(state.localData.dailyLimitPolicies["example.com"].cooldownMinutes, 60);
  assert.equal(state.localData.pendingConfigChange, undefined);
});

test("shortening a per-site cooldown requires the settings hold", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      delayMinutes: 2,
      settingsDelayMinutes: 2,
      dailyLimits: { "example.com": 30 },
      dailyLimitPolicies: {
        "example.com": { mode: "cooldown", cooldownMinutes: 60 }
      }
    })
  );

  const response = await requestPatch(context, {
    dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 15 } }
  });

  assert.equal(response.applied, false);
  assert.equal(response.pending.remainingMs, 2 * 60 * 1000);
  assert.equal(state.localData.dailyLimitPolicies["example.com"].cooldownMinutes, 60);
});

test("raising a daily limit uses the guarded settings countdown", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ dailyLimits: { "example.com": 30 } })
  );

  const response = await requestPatch(context, {
    dailyLimits: { "example.com": 60 }
  });

  assert.equal(response.ok, true);
  assert.equal(response.applied, false);
  assert.deepEqual(response.pending.patch, { dailyLimits: { "example.com": 60 } });
  assert.equal(response.pending.remainingMs, 60 * 1000);
  assert.equal(state.localData.dailyLimits["example.com"], 30);
});

test("cooldown blocks tracked sites for an hour even when Airlock is toggled off", async () => {
  const { context, state } = await loadBackground(baseConfig({ enabled: false }));
  const before = context.testClock.now;

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

  const pending = await requestPatch(context, { cooldownUntil: null });
  assert.equal(pending.applied, false);
  assert.equal(pending.pending.remainingMs, 60 * 1000);
  assert.equal(state.localData.cooldownUntil, cooldownUntil);

  await advanceGuard(context, 30 * 1000);
  assert.equal(state.localData.cooldownUntil, cooldownUntil);

  await advanceGuard(context, 30 * 1000);
  assert.equal(state.localData.cooldownUntil, null);
  assert.equal(state.localData.pendingConfigChange, undefined);
});

test("daily lock schedule reductions are guarded and strict expansions apply immediately", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLockEnabled: true,
      dailyLockStart: "22:00",
      dailyLockEnd: "07:00"
    })
  );

  const shorter = await requestPatch(context, {
    dailyLockStart: "23:00",
    dailyLockEnd: "07:00"
  });
  assert.equal(shorter.applied, false);
  assert.equal(state.localData.dailyLockStart, "22:00");

  await advanceGuard(context, 60 * 1000);
  assert.equal(state.localData.dailyLockStart, "23:00");

  const longer = await requestPatch(context, {
    dailyLockStart: "21:00",
    dailyLockEnd: "08:00"
  });
  assert.equal(longer.applied, true);
  assert.equal(state.localData.dailyLockStart, "21:00");
  assert.equal(state.localData.dailyLockEnd, "08:00");
  assert.equal(state.localData.pendingConfigChange, undefined);
});

test("shifting a daily lock is guarded even when its duration does not shrink", async () => {
  const { context, state } = await loadBackground(
    baseConfig({
      dailyLockEnabled: true,
      dailyLockStart: "22:00",
      dailyLockEnd: "07:00"
    })
  );

  const shifted = await requestPatch(context, {
    dailyLockStart: "21:00",
    dailyLockEnd: "06:00"
  });

  assert.equal(shifted.applied, false);
  assert.equal(state.localData.dailyLockStart, "22:00");
  assert.equal(state.localData.dailyLockEnd, "07:00");
});

test("turning off the moving target requires the settings hold", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 7, settingsDelayMinutes: 2, movingTargetEnabled: true })
  );

  const response = await requestPatch(context, { movingTargetEnabled: false });

  assert.equal(response.applied, false);
  assert.equal(response.pending.remainingMs, 2 * 60 * 1000);
  assert.equal(state.localData.movingTargetEnabled, true);

  await advanceGuard(context, 60 * 1000);
  await advanceGuard(context, 60 * 1000);
  assert.equal(state.localData.movingTargetEnabled, false);
});

test("site removal, wait reduction, daily-limit removal, and daily-lock disabling are guarded", async () => {
  const cases = [
    {
      config: baseConfig(),
      patch: { sites: [] },
      assertUnchanged(state) {
        assert.deepEqual(state.localData.sites, ["example.com"]);
      }
    },
    {
      config: baseConfig({ delayMinutes: 2 }),
      patch: { delayMinutes: 1 },
      assertUnchanged(state) {
        assert.equal(state.localData.delayMinutes, 2);
      }
    },
    {
      config: baseConfig({ dailyLimits: { "example.com": 30 } }),
      patch: { dailyLimits: { "example.com": null } },
      assertUnchanged(state) {
        assert.equal(state.localData.dailyLimits["example.com"], 30);
      }
    },
    {
      config: baseConfig({ dailyLockEnabled: true }),
      patch: { dailyLockEnabled: false },
      assertUnchanged(state) {
        assert.equal(state.localData.dailyLockEnabled, true);
      }
    }
  ];

  for (const testCase of cases) {
    const { context, state } = await loadBackground(testCase.config);
    const response = await requestPatch(context, testCase.patch);

    assert.equal(response.applied, false, JSON.stringify(testCase.patch));
    assert.ok(response.pending.remainingMs > 0, JSON.stringify(testCase.patch));
    testCase.assertUnchanged(state);
  }
});

test("the settings hold is independent from the site wait", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 3, settingsDelayMinutes: 4 })
  );

  const siteWait = await context.handleContentReady(7, "example.com");
  const disable = await requestPatch(context, { enabled: false });
  assert.equal(siteWait.remainingMs, 3 * 60 * 1000);
  assert.equal(disable.pending.remainingMs, 4 * 60 * 1000);
  assert.equal(state.localData.enabled, true);
});

test("reducing the settings hold uses its previous duration without changing the site wait", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 8, settingsDelayMinutes: 2 })
  );

  const response = await requestPatch(context, { settingsDelayMinutes: 1 });

  assert.equal(response.applied, false);
  assert.equal(response.pending.remainingMs, 2 * 60 * 1000);
  assert.equal(state.localData.settingsDelayMinutes, 2);
  assert.equal(state.localData.delayMinutes, 8);

  await advanceGuard(context, 60 * 1000);
  await advanceGuard(context, 60 * 1000);
  assert.equal(state.localData.settingsDelayMinutes, 1);
  assert.equal(state.localData.delayMinutes, 8);
});

test("a zero-minute settings hold survives normalization and applies mixed changes immediately", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 8, settingsDelayMinutes: 0 })
  );

  assert.equal(state.localData.settingsDelayMinutes, 0);
  assert.equal((await context.readConfig()).settingsDelayMinutes, 0);
  await context.migrateStoredConfig();
  assert.equal(state.localData.settingsDelayMinutes, 0);

  const response = await requestPatch(context, { enabled: false, delayMinutes: 9 });
  assert.equal(response.applied, true);
  assert.equal(response.pending, null);
  assert.equal(response.revision, 1);
  assert.equal(state.localData.enabled, false);
  assert.equal(state.localData.delayMinutes, 9);
  assert.equal(state.localData.settingsDelayMinutes, 0);
  assert.equal(state.localData.pendingConfigChange, undefined);

  const restarted = await loadBackground(state.localData);
  assert.equal((await restarted.context.readConfig()).settingsDelayMinutes, 0);
  assert.equal(restarted.state.localData.settingsDelayMinutes, 0);
});

test("reducing the settings hold to zero still requires the previous hold", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 8, settingsDelayMinutes: 2 })
  );

  const response = await requestPatch(context, { settingsDelayMinutes: 0 });
  assert.equal(response.applied, false);
  assert.equal(response.pending.remainingMs, 2 * 60 * 1000);
  assert.equal(state.localData.settingsDelayMinutes, 2);

  await advanceGuard(context, 60 * 1000);
  assert.equal(state.localData.settingsDelayMinutes, 2);
  await advanceGuard(context, 60 * 1000);
  assert.equal(state.localData.settingsDelayMinutes, 0);
  assert.equal(state.localData.delayMinutes, 8);

  const disabled = await requestPatch(context, { enabled: false });
  assert.equal(disabled.applied, true);
  assert.equal(disabled.pending, null);
  assert.equal(state.localData.enabled, false);
});

test("the unified wait migrates to both settings when no legacy guard remains", async () => {
  const { context, state } = await loadBackground(
    baseConfig({ delayMinutes: 4, settingsDelayMinutes: undefined })
  );

  assert.equal(state.localData.delayMinutes, 4);
  assert.equal(state.localData.settingsDelayMinutes, 4);

  delete state.localData.settingsDelayMinutes;
  const configBeforeMigrationCompletes = await context.readConfig();
  assert.equal(configBeforeMigrationCompletes.settingsDelayMinutes, 4);
});

test("legacy settings migrate into separate site and settings waits", async () => {
  const { state } = await loadBackground(
    baseConfig({
      delayMinutes: 2,
      settingsDelayMinutes: undefined,
      guardMinutes: 5,
      requireHoverTarget: false,
      resetHours: 48
    })
  );

  assert.equal(state.localData.delayMinutes, 2);
  assert.equal(state.localData.settingsDelayMinutes, 5);
  assert.equal(state.localData.movingTargetEnabled, false);
  assert.equal(state.localData.guardMinutes, undefined);
  assert.equal(state.localData.requireHoverTarget, undefined);
  assert.equal(state.localData.resetHours, undefined);
});

test("sites with wait disabled track usage across visits and subdomains without timer sessions", async () => {
  const { context, state } = await loadBackground(baseConfig({
    siteWaitEnabled: { "example.com": false }
  }));
  for (const [tabId, domain] of [[7, "example.com"], [7, "example.com"], [8, "news.example.com"]]) {
    assert.equal((await context.handleContentReady(tabId, domain)).type, "NO_OVERLAY");
  }
  assert.deepEqual(state.sessionData, {});
  const usage = await context.handleDailyUsageUpdate(7, "news.example.com", 1000);
  assert.equal(usage.ok, true);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 1000);
});

test("sites with wait disabled still enforce locks, cooldowns, and daily limits", async () => {
  const window = activeWindowAroundNow();
  const { context, state } = await loadBackground(baseConfig({
    siteWaitEnabled: { "example.com": false },
    dailyLockEnabled: true,
    dailyLockStart: window.start,
    dailyLockEnd: window.end,
    dailyLimits: { "example.com": 1 }
  }));
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_DAILY_LOCK");
  state.localData.dailyLockEnabled = false;
  const open = await context.handleContentReady(7, "example.com");
  assert.equal(open.type, "NO_OVERLAY");
  assert.equal(open.dailyLimitMinutes, 1);
  state.localData.dailyUsage.sites["example.com"] = 59000;
  assert.equal((await context.handleDailyUsageUpdate(7, "example.com", 1000)).reached, true);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_DAILY_LIMIT");
  await context.startCooldown();
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_COOLDOWN");
  state.localData.cooldownUntil = null;
  state.localData.dailyUsage.sites = {};
  assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
});

test("disabling a site's wait is guarded and enabling it again creates a fresh wait", async () => {
  const { context, state } = await loadBackground(baseConfig());
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY");
  const pending = await requestPatch(context, { siteWaitEnabled: { "example.com": false } });
  assert.equal(pending.applied, false);
  await advanceGuard(context, 30000);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY");
  await advanceGuard(context, 30000);
  assert.equal(state.localData.siteWaitEnabled["example.com"], false);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
  assert.deepEqual(state.sessionData, {});
  assert.ok(state.tabMessages.some(({ message }) => message.type === "RECHECK_CONFIG"));
  state.localData.siteWaitEnabled = {};
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY");
});

test("midnight never resets a timer for a site whose wait is disabled", async () => {
  const { context, state } = await loadBackground(baseConfig({ siteWaitEnabled: { "example.com": false } }));
  state.sessionData.session_7 = context.createTimerSession("example.com", 1, Date.now() - 86400000);
  state.tabMessages.length = 0;
  await context.reconcileMidnightReset();
  assert.deepEqual(state.sessionData, {});
  assert.equal(state.tabMessages.some(({ message }) => message.type === "RESET_TIMER"), false);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
});

test("wait preferences default on and follow the most specific tracked domain", async () => {
  const { context } = await loadBackground(baseConfig({
    sites: ["example.com", "news.example.com", "other.example"],
    siteWaitEnabled: { "example.com": false, "other.example": "false" }
  }));
  assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
  assert.equal((await context.handleContentReady(7, "news.example.com")).type, "SHOW_OVERLAY");
  assert.equal((await context.handleContentReady(7, "other.example")).type, "SHOW_OVERLAY");
});

test("removing a site clears its wait preference", async () => {
  const { context, state } = await loadBackground(baseConfig({ siteWaitEnabled: { "example.com": false } }));
  await requestPatch(context, { sites: [] });
  await advanceGuard(context, 60000);
  assert.equal(state.localData.siteWaitEnabled["example.com"], undefined);
});

function requestPatch(context, patch, extra = {}) {
  return sendUi(context, { type: "REQUEST_CONFIG_CHANGE", expectedRevision: context.testState.localData.configRevision, patch, ...extra });
}

function advanceMessage(context, pending, clientId, sequence, elapsedMs, sender) {
  return sendUi(context, { type: "ADVANCE_PENDING_CONFIG_CHANGE", pendingId: pending.id, clientId, sequence, elapsedMs }, sender);
}

test("all settings commands reject content origins, wrong extension UI paths, and anonymous holds", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const pending = await requestPatch(context, { enabled: false });
  const commands = [
    { type: "GET_SETTINGS_STATE" },
    { type: "REQUEST_CONFIG_CHANGE", expectedRevision: 0, patch: { enabled: false } },
    { type: "ADVANCE_PENDING_CONFIG_CHANGE", pendingId: pending.pending.id, clientId: "page", sequence: 1, elapsedMs: 60000 },
    { type: "CANCEL_PENDING_CONFIG_CHANGE", pendingId: pending.pending.id },
    { type: "RELEASE_PENDING_CONFIG_CHANGE", pendingId: pending.pending.id, clientId: "page" }
  ];
  const senders = [{}, { id: "airlock-test", url: "https://example.com/", tab: state.tabs[0] },
    { id: "airlock-test", url: state.browser.runtime.getURL("popup/other.html") },
    { id: "another-extension", url: state.browser.runtime.getURL("popup/popup.html") }];
  for (const sender of senders) for (const command of commands) {
    assert.deepEqual(await sendUi(context, command, sender), { ok: false, reason: "untrusted-sender" }, command.type);
  }
  assert.equal((await context.advancePendingConfigChange(60000)).reason, "untrusted-sender");
  assert.equal(state.localData.enabled, true);
  assert.equal(state.localData.pendingConfigChange.remainingMs, 60000);
});

test("exact options senders with tab metadata and harmless URL fragments are accepted", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const sender = { id: "airlock-test", url: state.browser.runtime.getURL("options/options.html") + "?source=popup#youtube", tab: state.tabs[0] };
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE", tabId: 7 }, sender);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.currentSiteStatus.reason, "wait");
  assert.deepEqual(state.sessionData, {});
  const applied = await sendUi(context, { type: "REQUEST_CONFIG_CHANGE", expectedRevision: snapshot.revision, patch: { delayMinutes: 2 } }, sender);
  assert.equal(applied.applied, true);
  assert.equal(applied.revision, snapshot.revision + 1);
});

test("concurrent edits serialize and stale revisions refresh without overwriting", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const [first, second] = await Promise.all([
    requestPatch(context, { contentControls: { youtube: { hideShorts: true } } }),
    requestPatch(context, { contentControls: { facebook: { hideReels: true } } })
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.applied, true);
  assert.equal(first.revision, 1);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "stale-revision");
  assert.equal(second.revision, 1);
  assert.equal(second.config.contentControls.youtube.hideShorts, true);
  assert.equal(state.localData.contentControls.facebook.hideReels, false);
  assert.deepEqual(state.localData.sites, ["example.com"]);
});

test("mixed preset-style patches apply atomically after the full existing hold", async () => {
  const { context, state } = await loadBackground(baseConfig({ contentControls: { version: 1, youtube: { hideShorts: true } } }));
  const started = await requestPatch(context, { contentControls: { youtube: { hideShorts: false }, facebook: { hideReels: true } } });
  assert.equal(started.applied, false);
  assert.equal(started.revision, 0);
  assert.equal(state.localData.contentControls.youtube.hideShorts, true);
  assert.equal(state.localData.contentControls.facebook.hideReels, false);
  const competing = await requestPatch(context, { delayMinutes: 2 });
  assert.equal(competing.reason, "pending-exists");
  await advanceGuard(context, 59000);
  assert.equal(state.localData.contentControls.youtube.hideShorts, true);
  assert.equal(state.localData.contentControls.facebook.hideReels, false);
  const completed = await advanceGuard(context, 1000);
  assert.equal(completed.applied, true);
  assert.equal(completed.revision, 1);
  assert.equal(state.localData.contentControls.youtube.hideShorts, false);
  assert.equal(state.localData.contentControls.facebook.hideReels, true);
});

test("per-site maps merge while deliberate site removal cleans maps and retains content preferences and totals", async () => {
  const { context, state } = await loadBackground(baseConfig({ sites: ["example.com", "other.example"],
    dailyLimits: { "example.com": 30, "other.example": 20 },
    siteWaitEnabled: { "example.com": false },
    dailyUsage: { date: localDateKey(), sites: { "example.com": 10000, "other.example": 5000 } },
    contentControls: { version: 1, youtube: { hideShorts: true } } }));
  const strengthened = await requestPatch(context, { dailyLimits: { "example.com": 15 }, siteWaitEnabled: { "example.com": null } });
  assert.equal(strengthened.applied, true);
  assert.deepEqual(state.localData.dailyLimits, { "example.com": 15, "other.example": 20 });
  assert.deepEqual(state.localData.siteWaitEnabled, {});
  const removal = await requestPatch(context, { sites: ["other.example"] });
  assert.equal(removal.applied, false);
  await advanceGuard(context, 60000);
  assert.deepEqual(state.localData.sites, ["other.example"]);
  assert.deepEqual(state.localData.dailyLimits, { "other.example": 20 });
  assert.equal(state.localData.contentControls.youtube.hideShorts, true);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 10000);
});

test("strict allowlisted patches reject private state, invalid values, and arbitrary cooldown timestamps", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const patches = [ { configRevision: 100 }, { pendingConfigChange: null }, { dailyUsage: {} }, { enabled: "false" },
    { delayMinutes: 0 }, { delayMinutes: 1.5 }, { settingsDelayMinutes: -1 },
    { settingsDelayMinutes: 0.5 }, { settingsDelayMinutes: 601 }, { sites: ["https://youtube.com/"] },
    { siteWaitEnabled: { "other.example": false } }, { dailyLimits: { "example.com": "30" } },
    { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 0 } } },
    { cooldownUntil: context.testClock.now + 1000 }, { contentControls: { instagram: { stories: "off" } } },
    { contentControls: { youtube: { futureRule: true } } }, { dailyLockStart: "25:00" } ];
  for (const patch of patches) {
    const response = await requestPatch(context, patch);
    assert.equal(response.ok, false, JSON.stringify(patch));
    assert.equal(response.revision, 0);
  }
  assert.equal(state.localData.enabled, true);
  assert.equal(state.localData.pendingConfigChange, undefined);
});

test("single-client leases cap actual time, reject replay, and avoid crediting hidden gaps", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const { pending } = await requestPatch(context, { enabled: false });
  assert.equal((await advanceMessage(context, pending, "popup-a", 1, 60000)).pending.remainingMs, 60000);
  assert.equal((await advanceMessage(context, pending, "options-b", 1, 1000)).reason, "lease-held");
  context.testClock.now += 1000;
  const tick = await advanceMessage(context, pending, "popup-a", 2, 60000);
  assert.equal(tick.pending.remainingMs, 59000);
  assert.equal((await advanceMessage(context, pending, "popup-a", 2, 60000)).reason, "stale-sequence");
  assert.equal((await advanceMessage(context, pending, "popup-a", 3, 60000)).pending.remainingMs, 59000);
  context.testClock.now += 10000;
  const expired = await advanceMessage(context, pending, "options-b", 2, 10000);
  assert.equal(expired.pending.remainingMs, 59000);
  context.testClock.now += 250;
  assert.equal((await advanceMessage(context, pending, "options-b", 3, 250)).pending.remainingMs, 58750);
  assert.equal(state.localData.enabled, true);
});

test("release preserves hold time and client sequences; non-owner views cannot release another lease", async () => {
  const { context } = await loadBackground(baseConfig());
  const { pending } = await requestPatch(context, { enabled: false });
  await advanceMessage(context, pending, "popup-a", 1, 0);
  await sendUi(context, { type: "RELEASE_PENDING_CONFIG_CHANGE", pendingId: pending.id, clientId: "options-b" });
  assert.equal((await advanceMessage(context, pending, "options-b", 1, 0)).reason, "lease-held");
  await sendUi(context, { type: "RELEASE_PENDING_CONFIG_CHANGE", pendingId: pending.id, clientId: "popup-a" });
  context.testClock.now += 1000;
  assert.equal((await advanceMessage(context, pending, "popup-a", 1, 1000)).reason, "stale-sequence");
  assert.equal((await advanceMessage(context, pending, "popup-a", 2, 1000)).pending.remainingMs, 60000);
});

test("blurred or inactive settings views cannot advance a hold", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const { pending } = await requestPatch(context, { enabled: false });
  state.browser.windows.focused = false;
  assert.equal((await advanceMessage(context, pending, "popup-a", 1, 0)).reason, "inactive-view");
  state.browser.windows.focused = true;
  state.tabs[0].active = false;
  const sender = { ...context.testUiSender, url: state.browser.runtime.getURL("options/options.html"), tab: state.tabs[0] };
  assert.equal((await advanceMessage(context, pending, "options-b", 1, 1000, sender)).reason, "inactive-view");
  assert.equal(state.localData.pendingConfigChange.remainingMs, 60000);
});

test("cancel targets the current pending ID from either view and never cancels a newer request", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const first = await requestPatch(context, { enabled: false });
  const sender = { ...context.testUiSender, url: state.browser.runtime.getURL("options/options.html"), tab: state.tabs[0] };
  const cancelled = await sendUi(context, { type: "CANCEL_PENDING_CONFIG_CHANGE", pendingId: first.pending.id }, sender);
  assert.equal(cancelled.pending, null);
  const next = await requestPatch(context, { enabled: false });
  assert.notEqual(first.pending.id, next.pending.id);
  const staleCancel = await sendUi(context, { type: "CANCEL_PENDING_CONFIG_CHANGE", pendingId: first.pending.id });
  assert.equal(staleCancel.reason, "stale-pending");
  assert.equal(state.localData.pendingConfigChange.id, next.pending.id);
});

test("future content schemas survive migration and unrelated changes while effective snapshots are disabled", async () => {
  const future = { version: 99, youtube: { hideShorts: true }, futureRules: { layout: "new" } };
  const { context, state } = await loadBackground(baseConfig({ contentControls: structuredClone(future) }));
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.equal(snapshot.contentControlsSupported, false);
  assert.equal(snapshot.storedContentControlsVersion, 99);
  assert.equal(snapshot.config.contentControls.youtube.hideShorts, false);
  assert.deepEqual(state.localData.contentControls, future);
  assert.equal((await requestPatch(context, { delayMinutes: 2 })).applied, true);
  assert.deepEqual(state.localData.contentControls, future);
  assert.equal((await requestPatch(context, { contentControls: { youtube: { hideShorts: false } } })).reason, "unsupported-controls-version");
  assert.deepEqual(state.localData.contentControls, future);
});

test("legacy pending changes retain exact remaining time and complete through the guarded lease", async () => {
  const { context, state } = await loadBackground(baseConfig({ pendingConfigChange: {
    type: "disableAirlock", remainingMs: 42000, waitMinutes: 1, createdAt: Date.now() - 18000, description: "Turning off Airlock"
  } }));
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.ok(snapshot.pending.id);
  assert.equal(snapshot.pending.remainingMs, 42000);
  assert.equal(snapshot.pending.description, "Turning off Airlock");
  await advanceGuard(context, 41000);
  assert.equal(state.localData.enabled, true);
  await advanceGuard(context, 1000);
  assert.equal(state.localData.enabled, false);
  assert.equal(state.localData.configRevision, 1);
});

test("legacy wall-clock pending records become paused remaining time and never auto-complete in a hidden gap", async () => {
  const { context, state } = await loadBackground(baseConfig({ pendingConfigChange: {
    type: "disableAirlock", unlockAt: Date.now() + 60000, waitMinutes: 1
  } }));
  const before = state.localData.pendingConfigChange.remainingMs;
  assert.ok(before > 58000 && before <= 60000);
  assert.equal(state.localData.pendingConfigChange.unlockAt, undefined);
  context.testClock.now += 120000;
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.equal(snapshot.pending.remainingMs, before);
  assert.equal(state.localData.enabled, true);
});

test("worker restart retains pending progress and invalidates its old view lease", async () => {
  const first = await loadBackground(baseConfig());
  const { pending } = await requestPatch(first.context, { enabled: false });
  await advanceMessage(first.context, pending, "popup-a", 1, 0);
  first.context.testClock.now += 1000;
  await advanceMessage(first.context, pending, "popup-a", 2, 1000);
  const restarted = await loadBackground(structuredClone(first.state.localData), structuredClone(first.state.sessionData));
  restarted.context.testClock.now += 10000;
  const resumed = await advanceMessage(restarted.context, pending, "popup-a", 3, 10000);
  assert.equal(resumed.pending.remainingMs, 59000);
  restarted.context.testClock.now += 1000;
  assert.equal((await advanceMessage(restarted.context, pending, "popup-a", 4, 1000)).pending.remainingMs, 58000);
});

test("current-site snapshots disclose manual cooldown while master is off without changing sessions", async () => {
  const { context, state } = await loadBackground(baseConfig({ enabled: false, cooldownUntil: Date.now() + 600000,
    dailyUsage: { date: localDateKey(), sites: { "example.com": 90000 } } }));
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE", tabId: 7 });
  assert.equal(snapshot.currentSiteStatus.reason, "cooldown");
  assert.equal(snapshot.currentSiteStatus.todayUsedMs, 90000);
  assert.equal(snapshot.currentSiteStatus.tracked, true);
  assert.deepEqual(state.sessionData, {});
});

test("manual cooldown start and expiration revise config through the serialized authority", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const started = await sendUi(context, { type: "START_COOLDOWN" });
  assert.equal(started.revision, 1);
  assert.equal(started.cooldownUntil, context.testClock.now + 3600000);
  context.testClock.now = started.cooldownUntil + 1;
  await context.reconcileCooldownBoundary();
  assert.equal(state.localData.cooldownUntil, null);
  assert.equal(state.localData.configRevision, 2);
});

test("route notifications only target supported committed/history top-level pages and omit stale URLs", async () => {
  const { state } = await loadBackground(baseConfig());
  state.tabMessages.length = 0;
  for (const event of [state.browser.webNavigation.onCommitted, state.browser.webNavigation.onHistoryStateUpdated]) {
    const notify = event.listeners[0];
    notify({ tabId: 7, frameId: 1, url: "https://www.youtube.com/shorts/a" });
    notify({ tabId: 7, frameId: 0, url: "https://evilyoutube.com/shorts/a" });
    notify({ tabId: 7, frameId: 0, url: "https://youtube.com.evil.test/" });
    notify({ tabId: 7, frameId: 0, url: "https://example.com/" });
    notify({ tabId: 7, frameId: 0, url: "https://www.youtube.com/shorts/abc" });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.tabMessages, [
    { tabId: 7, message: { type: "AIRLOCK_ROUTE_CHANGED" } },
    { tabId: 7, message: { type: "AIRLOCK_ROUTE_CHANGED" } }
  ]);
});

test("timer completion acknowledges its durable session before a same-host redirect can recheck", async () => {
  const { context, state } = await loadBackground(baseConfig());
  await context.handleContentReady(7, "example.com");
  const result = await sendUi(context, { type: "TIMER_DONE" }, { id: "airlock-test", url: "https://example.com/", tab: state.tabs[0], frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(state.sessionData.session_7.completed, true);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
});

test("recursive storage key reordering preserves holds and idempotent migration revisions", async () => {
  const { context, state } = await loadBackground(baseConfig({ sites: ["z.example", "a.example"],
    contentControls: { version: 1, instagram: { hideComments: true }, youtube: { hideShorts: true } },
    dailyLimits: { "z.example": 20, "a.example": 15 }, dailyLimitPolicies: { "z.example": { mode: "cooldown", cooldownMinutes: 10 } } }), {}, { reorderKeys: true });
  const started = await requestPatch(context, { contentControls: { youtube: { hideShorts: false } } });
  assert.equal(started.applied, false);
  const refreshed = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.equal(refreshed.pending.id, started.pending.id);
  assert.equal(refreshed.revision, started.revision);
  await context.reconcileStartupState();
  const afterMigration = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.equal(afterMigration.pending.id, started.pending.id);
  assert.equal(afterMigration.revision, started.revision);
  await advanceGuard(context, 60000);
  assert.equal(state.localData.contentControls.youtube.hideShorts, false);
  assert.equal(state.localData.configRevision, started.revision + 1);
  const completedRevision = state.localData.configRevision;
  await context.reconcileStartupState();
  assert.equal(state.localData.configRevision, completedRevision);
});

test("natural cooldown expiry atomically rebases unrelated holds without granting progress", async () => {
  const { context, state } = await loadBackground(baseConfig({ cooldownUntil: Date.now() + 10000 }));
  const started = await requestPatch(context, { enabled: false });
  await advanceGuard(context, 1000);
  const previous = structuredClone(state.localData.pendingConfigChange);
  context.testClock.now = state.localData.cooldownUntil + 1;
  state.localWrites.length = 0;
  await context.reconcileCooldownBoundary();
  const current = state.localData.pendingConfigChange;
  assert.equal(state.localData.cooldownUntil, null);
  assert.equal(state.localData.configRevision, started.revision + 1);
  assert.equal(current.id, previous.id);
  assert.deepEqual(current.patch, previous.patch);
  assert.equal(current.remainingMs, previous.remainingMs);
  assert.equal(current.baseRevision, started.revision + 1);
  assert.equal(current.baseConfig.cooldownUntil, null);
  const expiryWrite = state.localWrites.find((write) => write.cooldownUntil === null && write.configRevision === started.revision + 1);
  assert.equal(expiryWrite.pendingConfigChange.id, previous.id);
  const resumed = await advanceMessage(context, current, "test-popup", ++context.testSequence, 10000);
  assert.equal(resumed.pending.remainingMs, previous.remainingMs);
});

test("natural cooldown expiry never revives a stale revision or changed value fingerprint", async () => {
  for (const staleKind of ["revision", "fingerprint"]) {
    const { context, state } = await loadBackground(baseConfig({ cooldownUntil: Date.now() + 10000 }));
    await requestPatch(context, { enabled: false });
    if (staleKind === "revision") state.localData.configRevision += 1;
    else state.localData.delayMinutes = 2;
    context.testClock.now = state.localData.cooldownUntil + 1;
    await context.reconcileCooldownBoundary();
    assert.equal(state.localData.pendingConfigChange, undefined, staleKind);
    assert.equal(state.localData.enabled, true, staleKind);
    assert.equal(state.localData.cooldownUntil, null, staleKind);
  }
});

test("natural expiry clears satisfied end-only holds and retains mixed pending changes", async () => {
  const onlyEnd = await loadBackground(baseConfig({ cooldownUntil: Date.now() + 10000 }));
  await requestPatch(onlyEnd.context, { cooldownUntil: null });
  onlyEnd.context.testClock.now = onlyEnd.state.localData.cooldownUntil + 1;
  await onlyEnd.context.reconcileCooldownBoundary();
  assert.equal(onlyEnd.state.localData.pendingConfigChange, undefined);
  assert.equal(onlyEnd.state.localData.configRevision, 1);
  const mixed = await loadBackground(baseConfig({ cooldownUntil: Date.now() + 10000 }));
  const started = await requestPatch(mixed.context, { cooldownUntil: null, enabled: false });
  mixed.context.testClock.now = mixed.state.localData.cooldownUntil + 1;
  await mixed.context.reconcileCooldownBoundary();
  assert.equal(mixed.state.localData.pendingConfigChange.id, started.pending.id);
  assert.equal(mixed.state.localData.pendingConfigChange.remainingMs, 60000);
  assert.equal(mixed.state.localData.enabled, true);
});

test("worker startup after cooldown expiry preserves unrelated holds and old-format pending time", async () => {
  const original = await loadBackground(baseConfig({ cooldownUntil: Date.now() + 10000 }));
  const { pending } = await requestPatch(original.context, { enabled: false });
  await advanceGuard(original.context, 1000);
  const restarted = await loadBackground(structuredClone(original.state.localData), structuredClone(original.state.sessionData),
    { now: original.state.localData.cooldownUntil + 1, reorderKeys: true });
  assert.equal(restarted.state.localData.pendingConfigChange.id, pending.id);
  assert.equal(restarted.state.localData.pendingConfigChange.remainingMs, 59000);
  assert.equal(restarted.state.localData.pendingConfigChange.baseRevision, 1);
  assert.equal(restarted.state.localData.cooldownUntil, null);
  const legacy = await loadBackground(baseConfig({ cooldownUntil: Date.now() - 10000,
    pendingConfigChange: { type: "disableAirlock", remainingMs: 42000, waitMinutes: 1 } }));
  assert.equal(legacy.state.localData.pendingConfigChange.remainingMs, 42000);
  assert.equal(legacy.state.localData.enabled, true);
});

test("inactive daily-limit preferences persist independently and are reused after adding or removing a limit", async () => {
  const { context, state } = await loadBackground(baseConfig());
  let result = await requestPatch(context, { dailyLimitPolicies: { "example.com": { mode: "block", cooldownMinutes: 17 } } });
  assert.equal(result.applied, true);
  assert.deepEqual(state.localData.dailyLimitPolicies["example.com"], { mode: "block", cooldownMinutes: 17 });
  assert.equal(state.localData.dailyLimits["example.com"], undefined);
  result = await requestPatch(context, { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 17 } } });
  assert.equal(result.applied, true, "changing an inactive policy does not require a hold");
  result = await requestPatch(context, { dailyLimits: { "example.com": 1 } });
  assert.equal(result.applied, true);
  await context.handleDailyUsageUpdate(7, "example.com", 1000);
  state.localData.dailyUsage.sites["example.com"] = 60000;
  const limited = await context.handleContentReady(7, "example.com");
  assert.equal(limited.type, "SHOW_DAILY_LIMIT");
  assert.equal(limited.dailyLimitMode, "cooldown");
  assert.equal(state.localData.dailyLimitCooldowns["example.com"], context.testClock.now + 17 * 60000);
  result = await requestPatch(context, { dailyLimits: { "example.com": null } });
  assert.equal(result.applied, false);
  await advanceGuard(context, 60000);
  assert.deepEqual(state.localData.dailyLimitPolicies["example.com"], { mode: "cooldown", cooldownMinutes: 17 });
  assert.equal(state.localData.dailyLimits["example.com"], undefined);
  result = await requestPatch(context, { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 5 } } });
  assert.equal(result.applied, true);
});

test("saved block duration survives normalization, restart, and legacy policy changes without a limit", async () => {
  const { context, state } = await loadBackground(baseConfig({ dailyLimitPolicies: { "example.com": { mode: "block", cooldownMinutes: 23 } } }));
  assert.deepEqual(structuredClone((await context.readConfig()).dailyLimitPolicies["example.com"]), { mode: "block", cooldownMinutes: 23 });
  const legacy = context.legacyChangePatch({ type: "changeDailyLimitPolicy", site: "example.com", dailyLimitPolicy: { mode: "cooldown", cooldownMinutes: 23 } }, await context.readConfig());
  const changed = await requestPatch(context, structuredClone(legacy));
  assert.equal(changed.applied, true);
  const restarted = await loadBackground(state.localData);
  assert.deepEqual(structuredClone((await restarted.context.readConfig()).dailyLimitPolicies["example.com"]), { mode: "cooldown", cooldownMinutes: 23 });
});

test("policy validation rejects malformed inactive preferences without changing state", async () => {
  const { context } = await loadBackground(baseConfig());
  for (const value of [{ mode: "other", cooldownMinutes: 3 }, { mode: "block", cooldownMinutes: 0 },
    { mode: "block", cooldownMinutes: 1441 }, { mode: "cooldown", cooldownMinutes: "3" },
    { mode: "cooldown", cooldownMinutes: 1.5 }, { mode: "block", cooldownMinutes: 5, enabled: true }]) {
    const result = await requestPatch(context, { dailyLimitPolicies: { "example.com": value } });
    assert.equal(result.reason, "invalid-daily-limit-policy", JSON.stringify(value));
    assert.equal(result.revision, 0);
  }
});

test("active policy weakening stays guarded in atomic patches while inactive policy edits apply", async () => {
  for (const extra of [{ dailyLimits: { "example.com": null } }, { siteTrackingEnabled: { "example.com": false } }, { enabled: false }]) {
    const { context, state } = await loadBackground(baseConfig({ dailyLimits: { "example.com": 10 } }));
    const result = await requestPatch(context, { ...extra, dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 4 } } });
    assert.equal(result.applied, false);
    assert.equal(state.localData.dailyLimitPolicies["example.com"], undefined);
  }
  for (const extra of [{ enabled: false }, { siteTrackingEnabled: { "example.com": false } }]) {
    const { context } = await loadBackground(baseConfig({ ...extra, dailyLimits: { "example.com": 10 } }));
    const result = await requestPatch(context, { dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 4 } } });
    assert.equal(result.applied, true);
  }
});

test("pausing is guarded, removes live restrictions, retains settings and timestamps, and rejects usage", async () => {
  const now = Date.now();
  const window = activeWindowAroundNow();
  const { context, state } = await loadBackground(baseConfig({
    dailyLimits: { "example.com": 1 }, dailyLimitPolicies: { "example.com": { mode: "cooldown", cooldownMinutes: 30 } },
    dailyUsage: { date: localDateKey(), sites: { "example.com": 60000 } },
    dailyLimitCooldowns: { "example.com": now + 30 * 60000 },
    dailyLockEnabled: true, dailyLockStart: window.start, dailyLockEnd: window.end
  }), {}, { now });
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_DAILY_LOCK");
  const pause = await requestPatch(context, { siteTrackingEnabled: { "example.com": false } });
  assert.equal(pause.applied, false);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_DAILY_LOCK");
  await advanceGuard(context, 60000);
  const ready = await context.handleContentReady(7, "example.com");
  assert.equal(ready.type, "NO_OVERLAY");
  assert.equal(ready.tracked, true);
  assert.equal(ready.trackingEnabled, false);
  assert.equal(state.localData.dailyLimits["example.com"], 1);
  assert.equal(state.localData.dailyLimitCooldowns["example.com"], now + 30 * 60000);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 60000);
  assert.ok(state.tabMessages.some(({ message }) => message.type === "RECHECK_CONFIG"));
  const forged = await sendUi(context, { type: "DAILY_USAGE_UPDATE", domain: "example.com", elapsedMs: 5000 },
    { id: "airlock-test", tab: state.tabs[0], frameId: 0, url: "https://example.com/" });
  assert.equal(forged.ok, false);
  assert.equal(state.localData.dailyUsage.sites["example.com"], 60000);
  const status = (await sendUi(context, { type: "GET_SETTINGS_STATE", tabId: 7 })).currentSiteStatus;
  assert.equal(status.reason, "paused");
  assert.equal(status.tracked, true);
  assert.equal(status.trackingEnabled, false);
  await context.getDailyLimitState(await context.readConfig(), "example.com", now + 40 * 60000);
  assert.equal(state.localData.dailyLimitCooldowns["example.com"], now + 30 * 60000, "paused reads do not expire cooldown timestamps");
});

test("pause and resume preserve earned or unfinished waits and never grant an untouched tab access", async () => {
  for (const completed of [true, false]) {
    const now = Date.now();
    const session = { domain: "example.com", remainingMs: completed ? 0 : 42000, completed, createdAt: now };
    const { context, state } = await loadBackground(baseConfig(), { session_7: session }, { now });
    await requestPatch(context, { siteTrackingEnabled: { "example.com": false } });
    await advanceGuard(context, 60000);
    await context.handleTimerDone(7);
    await context.handleTimerUpdate(7, 0);
    assert.equal(state.sessionData.session_7.completed, completed);
    assert.equal(state.sessionData.session_7.remainingMs, session.remainingMs);
    assert.equal((await context.handleContentReady(7, "example.com")).type, "NO_OVERLAY");
    assert.equal((await requestPatch(context, { siteTrackingEnabled: { "example.com": true } })).applied, true);
    const resumed = await context.handleContentReady(7, "example.com");
    assert.equal(resumed.type, completed ? "NO_OVERLAY" : "SHOW_OVERLAY");
    if (!completed) assert.equal(resumed.remainingMs, 42000);
  }
  const { context, state } = await loadBackground(baseConfig({ siteTrackingEnabled: { "example.com": false } }));
  await context.handleContentReady(7, "example.com");
  assert.equal(state.sessionData.session_7, undefined);
  await requestPatch(context, { siteTrackingEnabled: { "example.com": null } });
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY");
});

test("paused tracking still enforces a global cooldown and preserves independent platform controls", async () => {
  const until = Date.now() + 3600000;
  const { context, state } = await loadBackground(baseConfig({ enabled: false, cooldownUntil: until,
    siteTrackingEnabled: { "example.com": false }, contentControls: { version: 1, youtube: { hideShorts: true } } }));
  const ready = await context.handleContentReady(7, "example.com");
  assert.equal(ready.type, "SHOW_COOLDOWN");
  assert.equal(ready.trackingEnabled, false);
  const status = (await sendUi(context, { type: "GET_SETTINGS_STATE", tabId: 7 })).currentSiteStatus;
  assert.equal(status.reason, "cooldown");
  assert.equal(state.localData.contentControls.youtube.hideShorts, true);
});

test("tracking pause maps validate, use the most specific site, and clean up on site removal", async () => {
  const { context, state } = await loadBackground(baseConfig({ sites: ["example.com", "sub.example.com"],
    siteTrackingEnabled: { "example.com": false, "sub.example.com": true, "untracked.example": false } }));
  assert.deepEqual(structuredClone((await context.readConfig()).siteTrackingEnabled), { "example.com": false });
  assert.equal((await context.handleContentReady(7, "www.example.com")).trackingEnabled, false);
  assert.equal((await context.handleContentReady(7, "child.sub.example.com")).trackingEnabled, true);
  for (const patch of [{ siteTrackingEnabled: [] }, { siteTrackingEnabled: { "unknown.com": false } }, { siteTrackingEnabled: { "example.com": "false" } }]) {
    assert.equal((await requestPatch(context, patch)).ok, false);
  }
  await requestPatch(context, { sites: ["sub.example.com"] });
  await advanceGuard(context, 60000);
  assert.deepEqual(state.localData.siteTrackingEnabled, {});
  assert.equal(state.localData.sites.includes("example.com"), false);
});

test("existing pending holds survive adding the default tracking map on upgrade", async () => {
  const { context, state } = await loadBackground(baseConfig());
  const started = await requestPatch(context, { enabled: false });
  await advanceGuard(context, 1000);
  delete state.localData.pendingConfigChange.baseConfig.siteTrackingEnabled;
  const restarted = await loadBackground(state.localData);
  const snapshot = await sendUi(restarted.context, { type: "GET_SETTINGS_STATE" });
  assert.equal(snapshot.pending.id, started.pending.id);
  assert.equal(snapshot.pending.remainingMs, 59000);
  assert.deepEqual(snapshot.pending.baseConfig.siteTrackingEnabled, {});
});

test("explicit wait-setting changes still reset access while tracking is paused", async () => {
  const now = Date.now();
  const { context, state } = await loadBackground(baseConfig({ settingsDelayMinutes: 0, siteTrackingEnabled: { "example.com": false } }),
    { session_7: { domain: "example.com", remainingMs: 0, completed: true, createdAt: now } });
  await requestPatch(context, { siteWaitEnabled: { "example.com": false } });
  assert.equal(state.sessionData.session_7, undefined);
  await requestPatch(context, { siteWaitEnabled: { "example.com": true }, siteTrackingEnabled: { "example.com": true } });
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY");
});

test("content master migrates from the old switch once and remains independent on restart", async () => {
  for (const enabled of [true, false]) {
    const { context, state } = await loadBackground(baseConfig({ enabled, contentControls: { version: 1, youtube: { hideShorts: true } } }));
    assert.equal(state.localData.contentControlsEnabled, enabled);
    const revision = state.localData.configRevision;
    await context.reconcileStartupState();
    assert.equal(state.localData.configRevision, revision, "repeat migration is idempotent");
    const result = await requestPatch(context, { contentControlsEnabled: !enabled });
    if (enabled) await advanceGuard(context, 60000);
    else assert.equal(result.applied, true);
    assert.equal(state.localData.enabled, enabled, "content master never changes site restrictions");
    assert.equal(state.localData.contentControlsEnabled, !enabled);
    await context.reconcileStartupState();
    assert.equal(state.localData.contentControlsEnabled, !enabled, "explicit independent state survives startup");
    assert.equal(state.localData.contentControls.youtube.hideShorts, true, "saved rules survive both switches");
  }
});

test("each master has its own guarded off action without changing the other", async () => {
  const { context, state } = await loadBackground(baseConfig({ contentControlsEnabled: true }));
  const siteOff = await requestPatch(context, { enabled: false });
  assert.equal(siteOff.applied, false);
  assert.deepEqual(siteOff.pending.patch, { enabled: false });
  await advanceGuard(context, 60000);
  assert.equal(state.localData.enabled, false);
  assert.equal(state.localData.contentControlsEnabled, true);
  const contentOff = await requestPatch(context, { contentControlsEnabled: false });
  assert.equal(contentOff.applied, false, "content off waits even with site restrictions off");
  assert.equal(state.localData.contentControlsEnabled, true);
  await advanceGuard(context, 60000);
  assert.equal(state.localData.contentControlsEnabled, false);
  assert.equal(state.localData.enabled, false);
  assert.equal((await requestPatch(context, { contentControlsEnabled: true })).applied, true);
  assert.equal(state.localData.enabled, false);
  assert.equal((await requestPatch(context, { contentControlsEnabled: "false" })).reason, "invalid-contentControlsEnabled");
});

test("content master never disables site gates or an active manual cooldown", async () => {
  const { context, state } = await loadBackground(baseConfig({ contentControlsEnabled: false }));
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_OVERLAY", "site wait remains active");
  const cooldown = await sendUi(context, { type: "START_COOLDOWN" });
  assert.equal(cooldown.ok, true);
  assert.equal((await context.handleContentReady(7, "example.com")).type, "SHOW_COOLDOWN");
  assert.equal(state.localData.contentControlsEnabled, false);
});

test("pre-split pending master off keeps its remaining hold and combined intent", async () => {
  const old = await loadBackground(baseConfig({ contentControlsEnabled: true }));
  await requestPatch(old.context, { enabled: false });
  await advanceGuard(old.context, 12000);
  const stored = structuredClone(old.state.localData);
  delete stored.contentControlsEnabled;
  delete stored.pendingConfigChange.baseConfig.contentControlsEnabled;
  const previous = structuredClone(stored.pendingConfigChange);
  const { context, state } = await loadBackground(stored);
  const snapshot = await sendUi(context, { type: "GET_SETTINGS_STATE" });
  assert.equal(snapshot.revision, previous.baseRevision);
  assert.equal(snapshot.pending.id, previous.id);
  assert.equal(snapshot.pending.remainingMs, previous.remainingMs);
  assert.deepEqual(snapshot.pending.patch, { enabled: false, contentControlsEnabled: false });
  await advanceGuard(context, previous.remainingMs);
  assert.equal(state.localData.enabled, false);
  assert.equal(state.localData.contentControlsEnabled, false);
});
