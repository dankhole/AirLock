const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
const pageStateSource = fs.readFileSync(path.join(__dirname, "../shared/page-state.js"), "utf8");

async function createPage(response) {
  const dom = new JSDOM("<!doctype html><button id='page-action'>Ordinary page action</button>", {
    url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const { window } = dom;
  const roots = new Map();
  const originalAttach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (...args) {
    const root = originalAttach.apply(this, args);
    roots.set(this, root);
    return root;
  };
  const timeouts = new Map();
  let id = 0;
  window.setTimeout = (fn, delay) => { timeouts.set(++id, { fn, delay }); return id; };
  window.clearTimeout = (timer) => timeouts.delete(timer);
  window.setInterval = () => ++id;
  window.clearInterval = () => {};
  window.document.hasFocus = () => true;
  const messages = new Set();
  const events = () => ({ addListener() {}, removeListener() {} });
  window.browser = {
    storage: { local: { get: async () => ({ enabled: true, sites: ["youtube.com"] }) }, onChanged: events() },
    runtime: {
      onMessage: { addListener(fn) { messages.add(fn); }, removeListener(fn) { messages.delete(fn); } },
      async sendMessage(message) {
        if (message.type === "CONTENT_READY") return response;
        if (message.type === "GET_ACTIVE_STATE") return { active: true };
        if (message.type === "TIMER_DONE") return { ok: true };
      }
    }
  };
  const prior = window.document.getElementById("page-action");
  prior.focus();
  window.eval(pageStateSource);
  await window.eval(source);
  const host = window.document.querySelector("airlock-overlay");
  const root = roots.get(host);
  return { window, prior, host, root,
    message(value) { for (const fn of messages) fn(value); },
    flush(delay) {
      for (const [timer, value] of [...timeouts]) {
        if (value.delay === delay) { timeouts.delete(timer); value.fn(); }
      }
    },
    dispose() { window.AirlockCoreController.dispose(); window.close(); }
  };
}

test("blocking overlay contains focus across closed Shadow DOM and restores prior focus on removal", async () => {
  const f = await createPage({ type: "SHOW_OVERLAY", remainingMs: 1000, active: true });
  const target = f.root.getElementById("hover-target");
  const button = f.root.getElementById("continue-btn");
  assert.equal(f.host.shadowRoot, null);
  assert.equal(f.window.document.activeElement, f.host);
  assert.equal(f.root.activeElement, target);
  assert.equal(button.disabled, true);
  f.prior.focus();
  assert.equal(f.window.document.activeElement, f.host);
  assert.equal(f.root.activeElement, target);
  const tab = new f.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(f.root.activeElement, target);
  f.message({ type: "SHOW_COOLDOWN", unlockAt: Date.now() + 60_000 });
  assert.equal(target.disabled, true);
  assert.equal(target.tabIndex, -1);
  assert.equal(f.root.activeElement, f.root.querySelector(".backdrop"));
  f.message({ type: "RESET_TIMER", remainingMs: 0, active: true });
  assert.equal(button.disabled, false);
  assert.equal(f.root.activeElement, button);
  button.click();
  await Promise.resolve();
  f.flush(300);
  assert.equal(f.window.document.querySelector("airlock-overlay"), null);
  assert.equal(f.window.document.activeElement, f.prior);
  f.dispose();
});

test("a hard lock focuses its dialog and exposes no native focusable buttons", async () => {
  const f = await createPage({ type: "SHOW_DAILY_LOCK", unlockAt: Date.now() + 60_000 });
  assert.equal(f.root.activeElement, f.root.querySelector(".backdrop"));
  assert.equal(f.root.getElementById("hover-target").disabled, true);
  assert.equal(f.root.getElementById("continue-btn").disabled, true);
  f.message({ type: "RESET_TIMER", remainingMs: 1000, active: true });
  assert.equal(f.root.getElementById("hover-target").disabled, false);
  assert.equal(f.root.activeElement, f.root.getElementById("hover-target"));
  f.dispose();
});
