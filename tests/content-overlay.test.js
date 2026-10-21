const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "..", "content", "content.js"),
  "utf8"
);

function createClassList() {
  const values = new Set();
  return {
    add(value) {
      values.add(value);
    },
    remove(value) {
      values.delete(value);
    },
    toggle(value, force) {
      if (force) values.add(value);
      else values.delete(value);
    },
    contains(value) {
      return values.has(value);
    }
  };
}

function createElement(onRemove = () => {}, rect = null) {
  const listeners = new Map();
  return {
    style: {},
    classList: createClassList(),
    textContent: "",
    disabled: false,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const next = (listeners.get(type) || []).filter((value) => value !== listener);
      listeners.set(type, next);
    },
    dispatch(type, event = {}) {
      const value = { type, preventDefault() {}, ...event };
      (listeners.get(type) || []).forEach((listener) => listener(value));
    },
    click() {
      if (!this.disabled) this.dispatch("click");
    },
    remove: onRemove,
    getBoundingClientRect() {
      return rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
  };
}

function createDocument() {
  const documentEvents = new Map();
  const overlayHosts = [];
  const reminderHosts = [];

  return {
    visibilityState: "visible",
    hidden: false,
    hasFocus() {
      return true;
    },
    addEventListener(type, listener) {
      if (!documentEvents.has(type)) documentEvents.set(type, new Set());
      documentEvents.get(type).add(listener);
    },
    removeEventListener(type, listener) { documentEvents.get(type)?.delete(listener); },
    dispatch(type, value = {}) {
      for (const listener of documentEvents.get(type) || []) listener({ type, ...value });
    },
    querySelectorAll(selector) {
      if (selector === "airlock-overlay") return [...overlayHosts];
      if (selector === "airlock-usage-reminder") return [...reminderHosts];
      return [];
    },
    createElement(tagName) {
      assert.ok(["airlock-overlay", "airlock-usage-reminder"].includes(tagName));
      const hosts = tagName === "airlock-overlay" ? overlayHosts : reminderHosts;
      const host = createElement(() => {
        const index = hosts.indexOf(host);
        if (index !== -1) hosts.splice(index, 1);
      });
      host.tagName = tagName;
      const elements = tagName === "airlock-overlay"
        ? {
            backdrop: createElement(),
            "overlay-message": createElement(),
            "timer-display": createElement(),
            "paused-label": createElement(),
            "continue-btn": createElement(),
            "hover-target": createElement(),
            "hover-target-slot": createElement(
              () => {},
              { left: 116, top: 116, right: 284, bottom: 284, width: 168, height: 168 }
            )
          }
        : {
            "usage-reminder-message": createElement(),
            "usage-reminder-dismiss": createElement(),
            "usage-reminder-start": createElement()
          };
      if (tagName === "airlock-overlay") this.latestElements = elements;
      else this.latestReminderElements = elements;
      host.attachShadow = () => ({
        innerHTML: "",
        querySelector(selector) {
          return selector === ".backdrop" ? elements.backdrop : null;
        },
        getElementById(id) {
          return elements[id] || null;
        }
      });
      return host;
    },
    documentElement: {
      appendChild(host) {
        if (host.tagName === "airlock-overlay") overlayHosts.push(host);
        else reminderHosts.push(host);
      }
    },
    overlayHosts: overlayHosts,
    reminderHosts: reminderHosts
  };
}

function createContext(document, options = {}) {
  let timerId = 0;
  let animationFrameId = 0;
  let now = options.now || Date.now();
  const animationFrames = new Map();
  const timeouts = new Map();
  const windowEvents = new Map();
  const intervals = new Map();
  const sentMessages = [];
  function createEvent() {
    const listeners = new Set();
    return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
      emit(...args) { return [...listeners].map((fn) => fn(...args)); },
      get size() { return listeners.size; } };
  }
  const storageEvent = createEvent();
  const runtimeEvent = createEvent();
  const browser = {
    storage: {
      local: {
        async get() {
          if (options.storageGet) return options.storageGet();
          return {
            enabled: options.enabled !== false,
            sites: options.sites || ["example.com"],
            movingTargetEnabled: options.movingTargetEnabled === true
          };
        }
      },
      onChanged: storageEvent
    },
    runtime: {
      onMessage: runtimeEvent,
      async sendMessage(message) {
        sentMessages.push(message);
        if (message.type === "CONTENT_READY") {
          if (options.contentReady) return options.contentReady(message);
          return options.contentReadyResponse || {
            type: "SHOW_OVERLAY",
            remainingMs: 60_000,
            active: true,
            dailyLimitMinutes: null
          };
        }
        if (message.type === "TIMER_DONE") return options.timerDoneResponse || { ok: true };
        if (message.type === "GET_ACTIVE_STATE") return { active: true };
        if (message.type === "DAILY_USAGE_UPDATE") {
          return options.dailyUsageResponse;
        }
        if (message.type === "START_COOLDOWN") {
          return options.startCooldownResponse || {
            ok: true,
            cooldownUntil: now + 60 * 60 * 1000
          };
        }
        return undefined;
      }
    }
  };

  const context = vm.createContext({
    browser: browser,
    console: console,
    document: document,
    window: {
      location: { hostname: "example.com" },
      innerWidth: 400,
      innerHeight: 400,
      matchMedia() {
        return { matches: options.reducedMotion === true, addEventListener() {} };
      },
      addEventListener(type, listener) {
        if (!windowEvents.has(type)) windowEvents.set(type, new Set());
        windowEvents.get(type).add(listener);
      },
      removeEventListener(type, listener) { windowEvents.get(type)?.delete(listener); }
    },
    requestAnimationFrame(callback) {
      animationFrameId += 1;
      animationFrames.set(animationFrameId, callback);
      return animationFrameId;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    setTimeout(callback, delay) {
      timerId += 1;
      timeouts.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback) {
      timerId += 1;
      intervals.set(timerId, callback);
      return timerId;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    }
  });

  if (options.pageState) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "shared", "page-state.js"), "utf8"), context);
  }
  context.storageListenerCount = () => storageEvent.size;
  context.timeoutCount = () => timeouts.size;
  context.emitRuntime = (value) => runtimeEvent.emit(value);
  context.emitStorage = (changes) => storageEvent.emit(changes, "local");
  context.emitWindow = (type, value = {}) => {
    for (const listener of windowEvents.get(type) || []) listener({ type, ...value });
  };
  context.runTimeouts = (delay) => {
    for (const [id, timer] of [...timeouts]) {
      if (delay === undefined || timer.delay === delay) { timeouts.delete(id); timer.callback(); }
    }
  };
  context.runAnimationFrames = (timestamp) => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    callbacks.forEach((callback) => callback(timestamp));
  };
  context.advanceTime = (elapsedMs) => {
    now += elapsedMs;
  };
  context.runIntervals = () => {
    [...intervals.values()].forEach((callback) => callback());
  };
  context.sentMessages = sentMessages;
  return context;
}

test("duplicate content-script injection replaces an orphaned overlay", async () => {
  const document = createDocument();
  const context = createContext(document);

  await vm.runInContext(contentSource, context);
  const firstHost = document.overlayHosts[0];
  assert.ok(firstHost);

  await vm.runInContext(contentSource, context);

  assert.equal(document.overlayHosts.length, 1);
  assert.notEqual(document.overlayHosts[0], firstHost);
});

test("moving target bounces within the padded viewport", async () => {
  const document = createDocument();
  const context = createContext(document, { movingTargetEnabled: true });

  await vm.runInContext(contentSource, context);
  const target = document.latestElements["hover-target"];
  const positions = [];

  for (let frame = 0; frame < 80; frame += 1) {
    context.runAnimationFrames(frame * 100);
    const match = /translate3d\((-?[\d.]+)px,/.exec(target.style.transform || "");
    if (match) positions.push(Number(match[1]));
  }

  assert.equal(target.classList.contains("moving"), true);
  assert.ok(positions.length > 0);
  assert.ok(Math.max(...positions) <= 100);
  assert.ok(Math.min(...positions) >= -100);
  assert.ok(positions.some((position, index) => index > 0 && position < positions[index - 1]));
});

test("reduced motion keeps an enabled moving target stationary", async () => {
  const document = createDocument();
  const context = createContext(document, {
    movingTargetEnabled: true,
    reducedMotion: true
  });

  await vm.runInContext(contentSource, context);
  context.runAnimationFrames(0);

  const target = document.latestElements["hover-target"];
  assert.equal(target.classList.contains("moving"), false);
  assert.equal(target.style.transform, "");
});

test("usage tracking runs without a daily limit or enabled wait setting", async () => {
  const document = createDocument();
  const context = createContext(document, {
    enabled: false,
    contentReadyResponse: {
      type: "NO_OVERLAY",
      active: true
    }
  });

  await vm.runInContext(contentSource, context);
  context.advanceTime(1000);
  context.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));

  const usageMessage = context.sentMessages.find(
    (message) => message.type === "DAILY_USAGE_UPDATE"
  );
  assert.ok(usageMessage);
  assert.equal(usageMessage.domain, "example.com");
  assert.equal(usageMessage.elapsedMs, 1000);
});

test("a usage milestone shows an unobtrusive reminder with a one-hour cooldown action", async () => {
  const document = createDocument();
  const context = createContext(document, {
    enabled: false,
    contentReadyResponse: {
      type: "NO_OVERLAY",
      active: true
    },
    dailyUsageResponse: {
      ok: true,
      reached: false,
      usageReminder: {
        site: "example.com",
        milestoneMinutes: 20
      }
    }
  });

  await vm.runInContext(contentSource, context);
  context.advanceTime(1000);
  context.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.reminderHosts.length, 1);
  assert.equal(
    document.latestReminderElements["usage-reminder-message"].textContent,
    "You've spent 20 minutes on example.com today. Want to step away for an hour?"
  );

  document.latestReminderElements["usage-reminder-start"].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(context.sentMessages.some((message) => message.type === "START_COOLDOWN"));
  assert.equal(document.reminderHosts.length, 0);
  assert.equal(document.overlayHosts.length, 1);
});

test("a usage reminder can be dismissed without interrupting the page", async () => {
  const document = createDocument();
  const context = createContext(document, {
    enabled: false,
    contentReadyResponse: { type: "NO_OVERLAY", active: true },
    dailyUsageResponse: {
      ok: true,
      reached: false,
      usageReminder: { site: "example.com", milestoneMinutes: 20 }
    }
  });

  await vm.runInContext(contentSource, context);
  context.advanceTime(1000);
  context.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));

  document.latestReminderElements["usage-reminder-dismiss"].click();

  assert.equal(document.reminderHosts.length, 0);
  assert.equal(document.overlayHosts.length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("unfinished waits and hard locks have no accessible Continue, including gate mode changes", async () => {
  const document = createDocument();
  const context = createContext(document);
  await vm.runInContext(contentSource, context);
  const elements = document.latestElements;
  assert.equal(elements["continue-btn"].disabled, true);
  assert.equal(elements["continue-btn"].tabIndex, -1);
  elements["continue-btn"].click();
  assert.equal(context.sentMessages.some((message) => message.type === "TIMER_DONE"), false);
  assert.equal(elements["hover-target"].disabled, false);
  context.emitRuntime({ type: "SHOW_COOLDOWN", unlockAt: Date.now() + 60_000 });
  assert.equal(elements["hover-target"].disabled, true);
  assert.equal(elements["hover-target"].tabIndex, -1);
  context.emitRuntime({ type: "RESET_TIMER", remainingMs: 1000, active: true });
  assert.equal(elements["hover-target"].disabled, false);
  assert.equal(elements["hover-target"].tabIndex, 0);
  assert.equal(elements["continue-btn"].disabled, true);
});

test("keyboard and touch holds use the same wait duration, release pauses, and keyboard holds are stationary", async () => {
  for (const mode of ["keyboard", "touch"]) {
    const document = createDocument();
    const context = createContext(document, { movingTargetEnabled: true,
      contentReadyResponse: { type: "SHOW_OVERLAY", remainingMs: 1000, active: true } });
    await vm.runInContext(contentSource, context);
    const target = document.latestElements["hover-target"];
    context.advanceTime(500);
    context.runTimeouts(250);
    assert.equal(document.latestElements["timer-display"].textContent, "0:01");
    const press = () => target.dispatch(mode === "keyboard" ? "keydown" : "pointerdown",
      mode === "keyboard" ? { key: " " } : { pointerType: "touch", pointerId: 1 });
    const release = () => target.dispatch(mode === "keyboard" ? "keyup" : "pointerup",
      mode === "keyboard" ? { key: " " } : { pointerType: "touch", pointerId: 1 });
    press();
    if (mode === "keyboard") {
      target.dispatch("keydown", { key: " ", repeat: true });
      context.runAnimationFrames(0);
      assert.equal(target.classList.contains("moving"), false);
      assert.equal(target.style.transform, "");
    }
    context.advanceTime(500);
    context.runTimeouts(250);
    release();
    context.advanceTime(2000);
    context.runTimeouts(250);
    assert.equal(document.latestElements["continue-btn"].disabled, true);
    press();
    context.advanceTime(500);
    context.runTimeouts(250);
    assert.equal(document.latestElements["continue-btn"].disabled, false, mode);
    assert.equal(document.latestElements["continue-btn"].tabIndex, 0);
    assert.ok(context.sentMessages.some((message) => message.type === "TIMER_UPDATE" && message.remainingMs === 0));
  }
});

test("route transitions pause the existing usage clock and resume without backfilling time", async () => {
  const document = createDocument();
  const context = createContext(document, { pageState: true, enabled: false,
    contentReadyResponse: { type: "NO_OVERLAY", active: true } });
  await vm.runInContext(contentSource, context);
  assert.equal(context.AirlockPageState.get().coreMode, "none");
  context.advanceTime(1000);
  context.runIntervals();
  await settle();
  context.AirlockPageState.setNavigationPending(true);
  context.advanceTime(9000);
  context.runIntervals();
  await settle();
  context.AirlockPageState.setNavigationPending(false);
  context.advanceTime(1000);
  context.runIntervals();
  await settle();
  const ticks = context.sentMessages.filter((message) => message.type === "DAILY_USAGE_UPDATE");
  assert.equal(ticks.length, 2);
  assert.deepEqual(ticks.map((message) => message.elapsedMs), [1000, 1000]);
});

test("an untracked page publishes core readiness without starting a usage clock", async () => {
  const document = createDocument();
  const context = createContext(document, { pageState: true, sites: [] });
  await vm.runInContext(contentSource, context);
  assert.equal(context.AirlockPageState.get().ready, true);
  assert.equal(context.AirlockPageState.get().coreMode, "none");
  context.advanceTime(1000);
  context.runIntervals();
  assert.equal(context.sentMessages.length, 0);
});

test("completed waits open navigation only after the background acknowledges their session", async () => {
  const done = deferred();
  const document = createDocument();
  const context = createContext(document, { pageState: true, timerDoneResponse: done.promise,
    contentReadyResponse: { type: "SHOW_OVERLAY", remainingMs: 0, active: true } });
  await vm.runInContext(contentSource, context);
  document.latestElements["continue-btn"].click();
  assert.equal(context.AirlockPageState.get().coreMode, "timer");
  done.resolve({ ok: true });
  await settle();
  assert.equal(context.AirlockPageState.get().coreMode, "none");
});

test("settings rechecks close the route gate and skip obsolete allow responses", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const document = createDocument();
  const context = createContext(document, { pageState: true,
    contentReady: () => {
      calls += 1;
      return calls === 1 ? { type: "NO_OVERLAY", active: true } : calls === 2 ? first.promise : second.promise;
    } });
  await vm.runInContext(contentSource, context);
  const transitions = [];
  context.AirlockPageState.subscribe((value) => transitions.push(value.coreMode));
  context.emitStorage({ enabled: { newValue: true } });
  assert.equal(context.AirlockPageState.get().ready, false);
  context.emitRuntime({ type: "RECHECK_CONFIG" });
  first.resolve({ type: "NO_OVERLAY", active: true });
  await settle();
  assert.equal(calls, 3);
  assert.equal(transitions.includes("none"), false);
  second.resolve({ type: "SHOW_OVERLAY", remainingMs: 1000, active: true });
  await settle();
  assert.equal(context.AirlockPageState.get().coreMode, "timer");
  assert.equal(context.AirlockPageState.get().ready, true);
});

test("late usage responses cannot recreate UI after controller disposal", async () => {
  for (const response of [
    { ok: true, reached: true, resetAt: Date.now() + 60_000, limitMinutes: 10 },
    { ok: true, reached: false, usageReminder: { site: "example.com", milestoneMinutes: 20 } }
  ]) {
    const usage = deferred();
    const document = createDocument();
    const context = createContext(document, { dailyUsageResponse: usage.promise,
      contentReadyResponse: { type: "NO_OVERLAY", active: true } });
    await vm.runInContext(contentSource, context);
    context.advanceTime(1000);
    context.runIntervals();
    context.AirlockCoreController.dispose();
    usage.resolve(response);
    await settle();
    assert.equal(document.overlayHosts.length, 0);
    assert.equal(document.reminderHosts.length, 0);
  }
});

test("startup settings changes cannot publish a stale allowed core gate", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const document = createDocument();
  const context = createContext(document, { pageState: true,
    contentReady: () => (++calls === 1 ? first.promise : second.promise) });
  const initializing = vm.runInContext(contentSource, context);
  await settle();
  context.emitStorage({ configRevision: { newValue: 1 }, enabled: { newValue: true } });
  first.resolve({ type: "NO_OVERLAY", active: true });
  await settle();
  assert.equal(calls, 2);
  assert.equal(context.AirlockPageState.get().ready, false);
  second.resolve({ type: "SHOW_DAILY_LOCK", unlockAt: Date.now() + 60_000 });
  await initializing;
  assert.equal(context.AirlockPageState.get().coreMode, "dailyLock");
  assert.equal(context.AirlockPageState.get().ready, true);
});

test("initial storage failure retries safely and early disposal releases the bootstrap listener", async () => {
  let reads = 0;
  const document = createDocument();
  const context = createContext(document, { pageState: true, storageGet: async () => {
    if (++reads === 1) throw new Error("temporarily unavailable");
    return { enabled: true, sites: [], movingTargetEnabled: false };
  } });
  context.console = { warn() {} };
  const initializing = vm.runInContext(contentSource, context);
  await settle();
  assert.equal(context.AirlockPageState.get().ready, false);
  context.runTimeouts(5000);
  await initializing;
  assert.equal(context.AirlockPageState.get().ready, true);
  context.AirlockCoreController.dispose();
  assert.equal(context.storageListenerCount(), 0);

  const waiting = deferred();
  const next = createContext(createDocument(), { pageState: true, storageGet: () => waiting.promise });
  const boot = vm.runInContext(contentSource, next);
  assert.equal(next.storageListenerCount(), 1);
  next.AirlockCoreController.dispose();
  assert.equal(next.storageListenerCount(), 0);
  waiting.resolve({ enabled: true, sites: [] });
  await boot;
  assert.equal(next.AirlockPageState.get().ready, false);
});

test("page status query reports the actual core gate without changing it", async () => {
  const context = createContext(createDocument(), { pageState: true });
  await vm.runInContext(contentSource, context);
  const [response] = context.emitRuntime({ type: "AIRLOCK_GET_PAGE_STATE" });
  const status = await response;
  assert.equal(status.ok, true);
  assert.equal(status.ready, true);
  assert.equal(status.coreMode, "timer");
  assert.equal(status.navigationPending, false);
  assert.equal(status.runtimeStatus, null);
  assert.equal(context.AirlockPageState.get().coreMode, "timer");
});

test("a rejected startup read after disposal cannot schedule a retry", async () => {
  let reject;
  const pendingRead = new Promise((resolve, no) => { reject = no; });
  const context = createContext(createDocument(), { pageState: true, storageGet: () => pendingRead });
  const initializing = vm.runInContext(contentSource, context);
  context.AirlockCoreController.dispose();
  reject(new Error("extension context closed"));
  await initializing;
  assert.equal(context.storageListenerCount(), 0);
  assert.equal(context.timeoutCount(), 0);
  assert.equal(context.AirlockPageState.get().ready, false);
});
