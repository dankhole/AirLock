const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const popupSource = fs.readFileSync(path.join(rootDir, "popup", "popup.js"), "utf8");
const dailyLockApi = require("../shared/daily-lock.js");

function createClassList() {
  const values = new Set();
  return {
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    toggle(name, force) {
      if (force === true || (force === undefined && !values.has(name))) values.add(name);
      else if (force === false || force === undefined) values.delete(name);
      return values.has(name);
    },
    contains(name) {
      return values.has(name);
    },
    replaceFrom(value) {
      values.clear();
      String(value || "").split(/\s+/).filter(Boolean).forEach((name) => values.add(name));
    }
  };
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = createClassList();
    this.style = {};
    this.dataset = {};
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.returnValue = "";
    this.validationMessage = "";
    this._innerHTML = "";
  }

  set className(value) {
    this.classList.replaceFrom(value);
  }

  get className() {
    return "";
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener: listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  async dispatch(type, extra = {}) {
    const event = {
      target: this,
      pointerType: "mouse",
      pointerId: 1,
      preventDefault() {},
      stopPropagation() {},
      ...extra
    };
    const listeners = [...(this.listeners.get(type) || [])];
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => !item.once));
    await Promise.all(listeners.map((item) => item.listener(event)));
  }

  showModal() {
    this.open = true;
  }

  async close(returnValue = "") {
    this.returnValue = returnValue;
    this.open = false;
    await this.dispatch("close");
  }

  setCustomValidity(message) {
    this.validationMessage = message;
  }

  reportValidity() {}

  setPointerCapture() {}

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const matchesSelector = (element) => {
      if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (element) => {
      element.children.forEach((child) => {
        if (matchesSelector(child)) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }
}

function createEventTarget() {
  const listeners = [];
  return {
    listeners: listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createDocument() {
  const tagById = {
    "enabled-toggle": "input",
    "delay-input": "input",
    "moving-target-toggle": "input",
    "cooldown-btn": "button",
    "daily-lock-toggle": "input",
    "daily-lock-start": "input",
    "daily-lock-end": "input",
    "site-list": "ul",
    "add-site-form": "form",
    "site-input": "input",
    "add-current-btn": "button",
    "add-site-btn": "button",
    "pending-config-section": "section",
    "pending-config-hover-target": "div",
    "pending-config-cancel": "button",
    "confirm-dialog": "dialog",
    "confirm-dialog-submit": "button"
  };
  const ids = [
    "enabled-toggle", "delay-input", "moving-target-toggle",
    "cooldown-status", "cooldown-btn", "daily-lock-toggle", "daily-lock-start",
    "daily-lock-end", "daily-lock-status", "site-list", "add-site-form",
    "site-input", "add-current-btn", "add-site-btn", "pending-config-section",
    "pending-config-title", "pending-config-timer", "pending-config-hover-target",
    "pending-config-cancel", "confirm-dialog", "confirm-dialog-title",
    "confirm-dialog-message", "confirm-dialog-submit"
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(tagById[id] || "div", id)])
  );
  const cooldownSection = new FakeElement("section");
  cooldownSection.className = "cooldown-section";

  return {
    visibilityState: "visible",
    elements: elements,
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      return selector === ".cooldown-section" ? cooldownSection : null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener() {}
  };
}

function localDateKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadPopup(overrides = {}, options = {}) {
  const document = createDocument();
  const localData = {
    enabled: true,
    sites: ["example.com"],
    delayMinutes: 2,
    movingTargetEnabled: false,
    dailyLimits: {},
    dailyLimitPolicies: {},
    dailyLimitCooldowns: {},
    dailyUsage: { date: localDateKey(), sites: {} },
    cooldownUntil: null,
    dailyLockEnabled: false,
    dailyLockStart: "22:00",
    dailyLockEnd: "07:00",
    ...overrides
  };
  const storageSets = [];
  const runtimeMessages = [];
  const storageOnChanged = createEventTarget();
  const browser = {
    storage: {
      local: {
        async get() {
          return { ...localData };
        },
        async set(values) {
          storageSets.push(values);
          Object.assign(localData, values);
        }
      },
      onChanged: storageOnChanged
    },
    tabs: {
      async query() {
        return [{ url: "https://current.example/path" }];
      }
    },
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === "GET_PENDING_CONFIG_CHANGE") return { pending: null };
        if (message.type === "START_COOLDOWN") {
          return { cooldownUntil: Date.now() + 60 * 60 * 1000 };
        }
        if (message.type === "START_PENDING_CONFIG_CHANGE") {
          if (options.applyPendingImmediately === true) {
            return { ok: true, applied: true, pending: null };
          }
          return {
            ok: true,
            applied: false,
            pending: {
              ...message.change,
              description: message.change.type,
              remainingMs: 60 * 1000
            }
          };
        }
        return { pending: null };
      }
    }
  };
  const context = vm.createContext({
    AirlockDailyLock: dailyLockApi,
    browser: browser,
    console: console,
    document: document,
    window: { addEventListener() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {}
  });

  vm.runInContext(popupSource, context, { filename: "popup/popup.js" });
  await settle();

  return {
    document: document,
    elements: document.elements,
    localData: localData,
    storageSets: storageSets,
    runtimeMessages: runtimeMessages
  };
}

async function runConfirmedAction(environment, element, eventType, prepare) {
  const setCount = environment.storageSets.length;
  const messageCount = environment.runtimeMessages.length;
  prepare();
  const action = element.dispatch(eventType);
  await Promise.resolve();

  assert.equal(environment.elements["confirm-dialog"].open, true);
  assert.equal(environment.storageSets.length, setCount);
  assert.equal(environment.runtimeMessages.length, messageCount);

  await environment.elements["confirm-dialog"].close("confirm");
  await action;
  await settle();
}

function lastPendingChange(environment) {
  return environment.runtimeMessages
    .filter((message) => message.type === "START_PENDING_CONFIG_CHANGE")
    .at(-1)?.change;
}

test("security-increasing settings require confirmation and then apply without a hover hold", async () => {
  const enable = await loadPopup({ enabled: false });
  await runConfirmedAction(enable, enable.elements["enabled-toggle"], "change", () => {
    enable.elements["enabled-toggle"].checked = true;
  });
  assert.equal(enable.localData.enabled, true);
  assert.equal(lastPendingChange(enable), undefined);

  const delay = await loadPopup({ delayMinutes: 2 });
  await runConfirmedAction(delay, delay.elements["delay-input"], "change", () => {
    delay.elements["delay-input"].value = "5";
  });
  assert.equal(delay.localData.delayMinutes, 5);
  assert.equal(lastPendingChange(delay), undefined);

  const moving = await loadPopup({ movingTargetEnabled: false });
  await runConfirmedAction(moving, moving.elements["moving-target-toggle"], "change", () => {
    moving.elements["moving-target-toggle"].checked = true;
  });
  assert.equal(moving.localData.movingTargetEnabled, true);
  assert.equal(lastPendingChange(moving), undefined);

  const currentSite = await loadPopup({ sites: ["example.com"] });
  await runConfirmedAction(currentSite, currentSite.elements["add-current-btn"], "click", () => {});
  assert.deepEqual(currentSite.localData.sites, ["current.example", "example.com"]);
  assert.equal(lastPendingChange(currentSite), undefined);

  const manualSite = await loadPopup({ sites: ["example.com"] });
  await runConfirmedAction(manualSite, manualSite.elements["add-site-form"], "submit", () => {
    manualSite.elements["site-input"].value = "social.example";
  });
  assert.deepEqual(manualSite.localData.sites, ["example.com", "social.example"]);
  assert.equal(lastPendingChange(manualSite), undefined);

  const cooldown = await loadPopup();
  await runConfirmedAction(cooldown, cooldown.elements["cooldown-btn"], "click", () => {});
  assert.equal(
    cooldown.runtimeMessages.some((message) => message.type === "START_COOLDOWN"),
    true
  );
  assert.equal(lastPendingChange(cooldown), undefined);

  const dailyLock = await loadPopup({ dailyLockEnabled: false });
  await runConfirmedAction(dailyLock, dailyLock.elements["daily-lock-toggle"], "change", () => {
    dailyLock.elements["daily-lock-toggle"].checked = true;
  });
  assert.equal(dailyLock.localData.dailyLockEnabled, true);
  assert.equal(lastPendingChange(dailyLock), undefined);

  const dailyLimit = await loadPopup({ dailyLimits: {} });
  const limitInput = dailyLimit.elements["site-list"].querySelector(".site-limit-input");
  await runConfirmedAction(dailyLimit, limitInput, "change", () => {
    limitInput.value = "30";
  });
  assert.equal(dailyLimit.localData.dailyLimits["example.com"], 30);
  assert.equal(lastPendingChange(dailyLimit), undefined);
});

test("security-reducing settings require confirmation before starting the hover hold", async () => {
  const cases = [
    {
      config: { enabled: true },
      id: "enabled-toggle",
      event: "change",
      prepare(environment) { environment.elements[this.id].checked = false; },
      type: "disableAirlock"
    },
    {
      config: { delayMinutes: 5 },
      id: "delay-input",
      event: "change",
      prepare(environment) { environment.elements[this.id].value = "2"; },
      type: "reduceDelay"
    },
    {
      config: { movingTargetEnabled: true },
      id: "moving-target-toggle",
      event: "change",
      prepare(environment) { environment.elements[this.id].checked = false; },
      type: "disableMovingTarget"
    },
    {
      config: { cooldownUntil: Date.now() + 60 * 60 * 1000 },
      id: "cooldown-btn",
      event: "click",
      prepare() {},
      type: "endCooldown"
    },
    {
      config: { dailyLockEnabled: true },
      id: "daily-lock-toggle",
      event: "change",
      prepare(environment) { environment.elements[this.id].checked = false; },
      type: "disableDailyLock"
    }
  ];

  for (const testCase of cases) {
    const environment = await loadPopup(testCase.config);
    await runConfirmedAction(
      environment,
      environment.elements[testCase.id],
      testCase.event,
      () => testCase.prepare(environment)
    );
    assert.equal(lastPendingChange(environment)?.type, testCase.type);
    assert.equal(environment.elements["pending-config-section"].hidden, false);
  }

  const removeSite = await loadPopup();
  const removeButton = removeSite.elements["site-list"].querySelector(".site-remove");
  await runConfirmedAction(removeSite, removeButton, "click", () => {});
  assert.equal(lastPendingChange(removeSite)?.type, "removeSite");

  const dailyLimit = await loadPopup({ dailyLimits: { "example.com": 30 } });
  const limitInput = dailyLimit.elements["site-list"].querySelector(".site-limit-input");
  await runConfirmedAction(dailyLimit, limitInput, "change", () => {
    limitInput.value = "";
  });
  assert.equal(lastPendingChange(dailyLimit)?.type, "changeDailyLimit");
  assert.equal(lastPendingChange(dailyLimit)?.dailyLimitMinutes, null);
});

test("daily-limit policies and lock schedules use their security direction after confirmation", async () => {
  const strongerPolicy = await loadPopup(
    {
      dailyLimits: { "example.com": 30 },
      dailyLimitPolicies: {
        "example.com": { mode: "cooldown", cooldownMinutes: 30 }
      }
    },
    { applyPendingImmediately: true }
  );
  const strongerSelect = strongerPolicy.elements["site-list"].querySelector("select");
  await runConfirmedAction(strongerPolicy, strongerSelect, "change", () => {
    strongerSelect.value = "block";
  });
  assert.equal(lastPendingChange(strongerPolicy)?.type, "changeDailyLimitPolicy");
  assert.equal(strongerPolicy.elements["pending-config-section"].hidden, true);

  const weakerPolicy = await loadPopup({ dailyLimits: { "example.com": 30 } });
  const weakerSelect = weakerPolicy.elements["site-list"].querySelector("select");
  await runConfirmedAction(weakerPolicy, weakerSelect, "change", () => {
    weakerSelect.value = "cooldown";
  });
  assert.equal(lastPendingChange(weakerPolicy)?.type, "changeDailyLimitPolicy");
  assert.equal(weakerPolicy.elements["pending-config-section"].hidden, false);

  const strongerSchedule = await loadPopup(
    { dailyLockEnabled: true },
    { applyPendingImmediately: true }
  );
  await runConfirmedAction(
    strongerSchedule,
    strongerSchedule.elements["daily-lock-start"],
    "change",
    () => { strongerSchedule.elements["daily-lock-start"].value = "21:00"; }
  );
  assert.equal(lastPendingChange(strongerSchedule)?.type, "changeDailyLockSchedule");
  assert.equal(strongerSchedule.elements["pending-config-section"].hidden, true);

  const weakerSchedule = await loadPopup({ dailyLockEnabled: true });
  await runConfirmedAction(
    weakerSchedule,
    weakerSchedule.elements["daily-lock-start"],
    "change",
    () => { weakerSchedule.elements["daily-lock-start"].value = "23:00"; }
  );
  assert.equal(lastPendingChange(weakerSchedule)?.type, "changeDailyLockSchedule");
  assert.equal(weakerSchedule.elements["pending-config-section"].hidden, false);
});
