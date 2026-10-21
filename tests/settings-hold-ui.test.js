const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { createHold } = require("../shared/settings-ui.js");
const { create } = require("../shared/settings-client.js");
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

function harness(t) {
  const dom = new JSDOM("<button id='hold'>Hold</button>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let focused = true;
  let visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { get() { return visibility; } });
  dom.window.document.hasFocus = () => focused;
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const clock = { now: () => now, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const target = dom.window.document.getElementById("hold");
  const client = { async advance(id, elapsed) { calls.push({ kind: "advance", id, elapsed }); return { ok: true }; }, async release(id) { calls.push({ kind: "release", id }); return { ok: true }; } };
  const hold = createHold(target, client, { document: dom.window.document, window: dom.window, clock }); hold.update({ id: "pending-one" });
  function dispatch(type, data = {}) { const event = new dom.window.Event(type, { bubbles: true, cancelable: true }); Object.entries(data).forEach(([key, value]) => Object.defineProperty(event, key, { value })); target.dispatchEvent(event); }
  return {
    hold, target, calls, dispatch,
    async tick(ms) { now += ms; const due = [...timers.entries()].filter(([, item]) => item.at <= now); due.forEach(([id, item]) => { timers.delete(id); item.fn(); }); await settle(); },
    hide() { visibility = "hidden"; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); },
    show() { visibility = "visible"; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); },
    blur() { focused = false; dom.window.dispatchEvent(new dom.window.Event("blur")); },
    pagehide() { dom.window.dispatchEvent(new dom.window.Event("pagehide")); }
  };
}

test("hover, held Space, held Enter, and touch credit the same elapsed engagement after a zero-credit lease tick", async (t) => {
  const interactions = [
    { start: ["pointerenter", { pointerType: "mouse" }], stop: ["pointerleave", {}] },
    { start: ["keydown", { key: " ", repeat: false }], stop: ["keyup", { key: " " }] },
    { start: ["keydown", { key: "Enter", repeat: false }], stop: ["keyup", { key: "Enter" }] },
    { start: ["pointerdown", { pointerType: "touch", pointerId: 1 }], stop: ["pointerup", { pointerType: "touch" }] }
  ];
  for (const input of interactions) {
    const env = harness(t); env.dispatch(...input.start); await settle();
    assert.deepEqual(env.calls[0], { kind: "advance", id: "pending-one", elapsed: 0 });
    await env.tick(250); await env.tick(250);
    assert.deepEqual(env.calls.filter((call) => call.kind === "advance").map((call) => call.elapsed), [0, 250, 250]);
    env.dispatch(...input.stop); await settle();
    assert.equal(env.calls.at(-1).kind, "release");
    const count = env.calls.length; await env.tick(60_000); assert.equal(env.calls.length, count);
  }
});

test("focus alone and repeated keys add no engagement, key release and blur pause", async (t) => {
  const env = harness(t); env.target.focus(); await env.tick(1000); assert.equal(env.calls.length, 0);
  env.dispatch("keydown", { key: " ", repeat: false }); await settle();
  env.dispatch("keydown", { key: " ", repeat: true }); await settle(); assert.equal(env.calls.length, 1);
  await env.tick(250);
  env.dispatch("blur"); await settle(); assert.equal(env.calls.at(-1).kind, "release");
  const count = env.calls.length; await env.tick(1000); assert.equal(env.calls.length, count);
});

test("hidden, unfocused, and closed views release ownership and never credit hidden time on return", async (t) => {
  for (const event of ["hide", "blur", "pagehide"]) {
    const env = harness(t); env.dispatch("pointerenter", { pointerType: "mouse" }); await settle(); await env.tick(250);
    env[event](); await settle(); assert.equal(env.calls.at(-1).kind, "release");
    const count = env.calls.length; await env.tick(60_000); assert.equal(env.calls.length, count);
    if (event === "hide") {
      env.show(); await env.tick(1000); assert.equal(env.calls.length, count);
      env.dispatch("pointerenter", { pointerType: "mouse" }); await settle();
      assert.equal(env.calls.at(-1).elapsed, 0);
    }
  }
});

test("changing or cancelling a pending ID cannot keep engaging the earlier request", async (t) => {
  const env = harness(t); env.dispatch("keydown", { key: "Enter", repeat: false }); await settle(); await env.tick(250);
  env.hold.update({ id: "pending-two" }); await settle();
  assert.deepEqual(env.calls.at(-1), { kind: "release", id: "pending-one" });
  await env.tick(1000);
  env.dispatch("keydown", { key: "Enter", repeat: false }); await settle();
  assert.deepEqual(env.calls.at(-1), { kind: "advance", id: "pending-two", elapsed: 0 });
  env.hold.update(null); await settle(); const count = env.calls.length; await env.tick(1000); assert.equal(env.calls.length, count);
});

test("independent views use distinct progress identities and cancel names only the current pending request", async () => {
  const messages = [];
  const browser = { runtime: { async sendMessage(message) { messages.push(message); return { ok: true }; } } };
  const one = create(browser, { clientId: "popup" }); const two = create(browser, { clientId: "options" });
  await one.advance("same-pending", 0); await two.advance("same-pending", 0); await two.cancel("same-pending");
  assert.equal(messages[0].clientId, "popup"); assert.equal(messages[1].clientId, "options");
  assert.deepEqual(messages[2], { type: "CANCEL_PENDING_CONFIG_CHANGE", pendingId: "same-pending" });
});

test("the default timer clock invokes browser timer methods with their native window receiver", async (t) => {
  const dom = new JSDOM("<button id='hold'>Hold</button>", { pretendToBeVisual: true }); t.after(() => dom.window.close());
  const { window } = dom; window.document.hasFocus = () => true;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const receivers = [];
  window.setTimeout = function (fn, ms) { receivers.push(this); assert.equal(this, window); return nativeSetTimeout.call(window, fn, ms); };
  window.clearTimeout = function (id) { assert.equal(this, window); return nativeClearTimeout.call(window, id); };
  const calls = [];
  const client = { async advance(id, elapsed) { calls.push(elapsed); return { ok: true }; }, async release() { return { ok: true }; } };
  const target = window.document.getElementById("hold");
  const hold = createHold(target, client, { document: window.document, window }); hold.update({ id: "p" });
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 290));
  assert.ok(receivers.length >= 2); assert.ok(calls.length >= 2); assert.ok(calls[1] > 0);
  hold.dispose();
});
