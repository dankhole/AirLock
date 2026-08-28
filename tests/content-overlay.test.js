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
    }
  };
}

function createElement(onRemove = () => {}) {
  return {
    style: {},
    classList: createClassList(),
    textContent: "",
    addEventListener() {},
    remove: onRemove
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
        "hover-target": createElement()
      };
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

function createContext(document) {
  let timerId = 0;
  const event = { addListener() {} };
  const browser = {
    storage: {
      local: {
        async get() {
          return { enabled: true, sites: ["example.com"] };
        }
      },
      onChanged: event
    },
    runtime: {
      onMessage: event,
      async sendMessage(message) {
        if (message.type === "CONTENT_READY") {
          return {
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

  return vm.createContext({
    browser: browser,
    console: console,
    document: document,
    window: {
      location: { hostname: "example.com" },
      addEventListener() {}
    },
    requestAnimationFrame(callback) {
      callback();
    },
    setTimeout() {
      timerId += 1;
      return timerId;
    },
    clearTimeout() {},
    setInterval() {
      timerId += 1;
      return timerId;
    },
    clearInterval() {}
  });
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
