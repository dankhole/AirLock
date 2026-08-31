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
  return {
    style: {},
    classList: createClassList(),
    textContent: "",
    addEventListener() {},
    remove: onRemove,
    getBoundingClientRect() {
      return rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
  };
}

function createDocument() {
  const overlayHosts = [];

  return {
    visibilityState: "visible",
    hidden: false,
    hasFocus() {
      return true;
    },
    addEventListener() {},
    querySelectorAll(selector) {
      return selector === "airlock-overlay" ? [...overlayHosts] : [];
    },
    createElement(tagName) {
      assert.equal(tagName, "airlock-overlay");
      const host = createElement(() => {
        const index = overlayHosts.indexOf(host);
        if (index !== -1) overlayHosts.splice(index, 1);
      });
      const elements = {
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
      };
      this.latestElements = elements;
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
        overlayHosts.push(host);
      }
    },
    overlayHosts: overlayHosts
  };
}

function createContext(document, options = {}) {
  let timerId = 0;
  let animationFrameId = 0;
  let now = options.now || Date.now();
  const animationFrames = new Map();
  const intervals = new Map();
  const sentMessages = [];
  const event = { addListener() {} };
  const browser = {
    storage: {
      local: {
        async get() {
          return {
            enabled: options.enabled !== false,
            sites: ["example.com"],
            movingTargetEnabled: options.movingTargetEnabled === true
          };
        }
      },
      onChanged: event
    },
    runtime: {
      onMessage: event,
      async sendMessage(message) {
        sentMessages.push(message);
        if (message.type === "CONTENT_READY") {
          return options.contentReadyResponse || {
            type: "SHOW_OVERLAY",
            remainingMs: 60_000,
            active: true,
            dailyLimitMinutes: null
          };
        }
        if (message.type === "GET_ACTIVE_STATE") return { active: true };
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
      addEventListener() {}
    },
    requestAnimationFrame(callback) {
      animationFrameId += 1;
      animationFrames.set(animationFrameId, callback);
      return animationFrameId;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    setTimeout() {
      timerId += 1;
      return timerId;
    },
    clearTimeout() {},
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
