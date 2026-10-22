const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const controlsApi = require("../shared/content-controls.js");
const { createPageState } = require("../shared/page-state.js");
const { createRuntime, NAVIGATION_RECOVERY_MS } = require("../content/controls/runtime.js");

function event() {
  const listeners = new Set();
  return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const fn of [...listeners]) fn(...args); }, get size() { return listeners.size; } };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const dom = new JSDOM(options.html || "<!doctype html><main><div data-feature='first'></div><p>ordinary text</p></main>", {
    url: options.url || "https://www.youtube.com/", runScripts: "outside-only"
  });
  const { window } = dom;
  const state = createPageState();
  state.setCore({ ready: true, coreMode: "none" });
  const onChanged = event();
  const onMessage = event();
  let config = { contentControlsEnabled: true, contentControls: controlsApi.getDefaults(), configRevision: 0 };
  config.contentControls.youtube.hideShorts = true;
  const browser = { storage: { local: { get: options.get || (async () => config) }, onChanged }, runtime: { onMessage } };
  const timers = new Map();
  let nextId = 0;
  let observed = 0;
  let disconnected = 0;
  class Observer extends window.MutationObserver {
    observe(...args) { observed += 1; return super.observe(...args); }
    disconnect() { disconnected += 1; return super.disconnect(); }
  }
  const visits = [];
  const runtime = createRuntime({ window, document: window.document, browser, controlsApi, pageState: state,
    MutationObserver: Observer,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    navigate: options.navigate || ((target) => visits.push(target))
  });
  let collects = 0;
  const defaultAdapter = {
    id: "youtube", decideNavigation: () => null,
    collect({ root, controls }) {
      collects += 1;
      const elements = [...root.querySelectorAll("[data-feature]")];
      if (root.nodeType === 1 && root.matches("[data-feature]")) elements.unshift(root);
      return elements.flatMap((element) => {
        const results = [];
        if (controls.hideShorts && element.getAttribute("data-feature") === "first") results.push({
          element, featureId: "youtube.hideShorts", effect: "hide", pauseMedia: element.hasAttribute("data-media")
        });
        if (controls.hideNavigation && element.hasAttribute("data-overlap")) results.push({
          element, featureId: "youtube.hideNavigation", effect: "subdue"
        });
        return results;
      });
    }
  };
  runtime.registerAdapter(options.adapter || defaultAdapter);
  async function flush(delay = 0) {
    await Promise.resolve();
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(id); timer.fn(); }
    }
    await Promise.resolve();
    await Promise.resolve();
  }
  function change(patch) {
    const changes = {};
    for (const [key, value] of Object.entries(patch)) {
      changes[key] = { oldValue: config[key], newValue: value };
      config[key] = value;
    }
    onChanged.emit(changes, "local");
  }
  function dispose() { runtime.dispose(); window.close(); }
  return { dom, window, state, runtime, onChanged, onMessage, visits, timers, flush, change, dispose,
    get config() { return config; }, get collects() { return collects; }, get observed() { return observed; },
    get disconnected() { return disconnected; } };
}
const routeAdapter = {
  id: "youtube", collect: () => [],
  decideNavigation({ url, controls }) {
    return controls.shortsRoute === "watch" && url.pathname.startsWith("/shorts/")
      ? { featureId: "youtube.shortsRoute", targetUrl: url.origin + "/watch?v=abc" } : null;
  }
};

 test("page state snapshots are immutable and shared initializer is idempotent", () => {
  const state = createPageState();
  const seen = [];
  const off = state.subscribe((next) => seen.push(next));
  state.setCore({ ready: true, coreMode: "timer" });
  state.setNavigationPending(true);
  assert.equal(Object.isFrozen(state.get()), true);
  assert.equal(state.get().coreMode, "timer");
  off();
  state.setNavigationPending(false);
  assert.equal(seen.length, 2);
  const context = vm.createContext({});
  const source = fs.readFileSync(path.join(__dirname, "../shared/page-state.js"), "utf8");
  vm.runInContext(source, context);
  const singleton = context.AirlockPageState;
  singleton.setCore({ ready: true, coreMode: "none" });
  vm.runInContext(source, context);
  assert.equal(context.AirlockPageState, singleton);
  assert.equal(context.AirlockPageState.get().ready, true);
});

test("no guesses before authoritative settings, and stale reads cannot re-enable filters", async () => {
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const f = fixture({ get: () => (++reads === 1 ? first.promise : second.promise) });
  await f.flush();
  assert.equal(f.window.document.querySelector("[data-airlock-hidden]"), null);
  assert.equal(f.observed, 0);
  f.onChanged.emit({ contentControlsEnabled: { newValue: false } }, "local");
  second.resolve({ contentControlsEnabled: false, contentControls: f.config.contentControls, configRevision: 2 });
  await f.flush();
  first.resolve({ contentControlsEnabled: true, contentControls: f.config.contentControls, configRevision: 1 });
  await f.flush();
  assert.equal(f.runtime.getStatus().revision, 2);
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(f.observed, 0);
  f.dispose();
});

test("temporary startup settings failure retries authoritatively and hidden or disposed pages stop retries", async () => {
  const saved = {contentControlsEnabled: true, contentControls: controlsApi.getDefaults(), configRevision: 3};
  saved.contentControls.youtube.hideShorts = true;
  let reads = 0;
  const f = fixture({get: async () => {
    if (++reads === 1) throw new Error('temporary storage failure');
    return saved;
  }});
  await f.flush();
  assert.equal(f.runtime.getStatus().initialized, false);
  assert.equal(f.window.document.querySelector('[data-airlock-hidden]'), null);
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 5000).length, 1);
  await f.flush(5000);
  await f.flush();
  assert.equal(reads, 2);
  assert.equal(f.runtime.getStatus().revision, 3);
  assert(f.window.document.querySelector('[data-airlock-hidden]'));
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 5000).length, 0);
  f.dispose();

  const hidden = fixture({get: async () => { throw new Error('still unavailable'); }});
  await hidden.flush();
  assert.equal([...hidden.timers.values()].filter(timer => timer.delay === 5000).length, 1);
  hidden.window.dispatchEvent(new hidden.window.PageTransitionEvent('pagehide', {persisted: true}));
  assert.equal(hidden.timers.size, 0);
  hidden.window.dispatchEvent(new hidden.window.PageTransitionEvent('pageshow', {persisted: true}));
  await hidden.flush();
  assert.equal([...hidden.timers.values()].filter(timer => timer.delay === 5000).length, 1);
  hidden.dispose();
  assert.equal(hidden.timers.size, 0);
});

test("the reported Instagram Reel URL redirects without relying on a DOM match once the core allows it", async () => {
  const saved = {contentControlsEnabled: true, contentControls: controlsApi.getDefaults(), configRevision: 4};
  saved.contentControls.instagram.blockReels = true;
  const f = fixture({url: 'https://www.instagram.com/reels/DcPL-RdxD7v/',
    html: '<!doctype html><main><p>No Reel-specific DOM markers</p></main>',
    adapter: require('../content/controls/sites/instagram.js'), get: async () => saved});
  f.state.setCore({ready: false, coreMode: 'unknown'});
  await f.flush();
  assert.equal(f.runtime.getStatus().active, true);
  assert.equal(f.visits.length, 0);
  f.state.setCore({ready: true, coreMode: 'none'});
  await f.flush();
  assert.deepEqual(f.visits, ['https://www.instagram.com/']);
  assert.equal(f.runtime.getStatus().failure, null);
  f.dispose();
});

test("live disable restores independent marks, and re-enable filters without changing host styles", async () => {
  const f = fixture({ html: "<div data-feature='first' data-overlap style='color:red'></div>" });
  f.config.contentControls.youtube.hideNavigation = true;
  await f.flush();
  const element = f.window.document.querySelector("div");
  assert.equal(element.getAttribute("data-airlock-hidden"), "youtube.hideShorts");
  assert.equal(element.getAttribute("data-airlock-subdued"), "youtube.hideNavigation");
  element.style.color = "blue";
  const next = structuredClone(f.config.contentControls);
  next.youtube.hideShorts = false;
  f.change({ contentControls: next, configRevision: 1 });
  await f.flush();
  assert.equal(element.hasAttribute("data-airlock-hidden"), false);
  assert.equal(element.hasAttribute("data-airlock-subdued"), true);
  assert.equal(element.style.color, "blue");
  f.change({ contentControlsEnabled: false, configRevision: 2 });
  await f.flush();
  assert.equal(element.hasAttribute("data-airlock-subdued"), false);
  assert.equal(f.window.document.querySelector("[data-airlock-controls-style]"), null);
  const observedAtDisable = f.observed;
  element.setAttribute("data-feature", "other");
  await f.flush();
  assert.equal(f.observed, observedAtDisable);
  next.youtube.hideShorts = true;
  element.setAttribute("data-feature", "first");
  f.change({ contentControlsEnabled: true, contentControls: next, configRevision: 3 });
  await f.flush();
  assert.equal(element.hasAttribute("data-airlock-hidden"), true);
  f.dispose();
  assert.equal(element.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.onChanged.size, 0);
  assert.equal(f.onMessage.size, 0);
  assert.equal(f.timers.size, 0);
});

test("mutation bursts coalesce and recycled nodes lose old marks", async () => {
  const f = fixture();
  await f.flush();
  const count = f.collects;
  const main = f.window.document.querySelector("main");
  const original = main.querySelector("div");
  original.setAttribute("data-feature", "ordinary");
  for (let index = 0; index < 50; index += 1) {
    const node = f.window.document.createElement("div");
    node.setAttribute("data-feature", "first");
    main.appendChild(node);
  }
  await f.flush();
  assert.equal(f.collects, count + 1);
  assert.equal(original.hasAttribute("data-airlock-hidden"), false);
  assert.equal(main.querySelectorAll("[data-airlock-hidden]").length, 50);
  // Runtime-owned attribute/style changes cannot schedule another collection.
  await f.flush();
  assert.equal(f.collects, count + 1);
  f.dispose();
});

test("media hiding pauses initial and renewed playback, and never restarts on cleanup", async () => {
  const f = fixture({ html: "<div data-feature='first' data-media><video></video></div>" });
  let pauses = 0;
  let plays = 0;
  const video = f.window.document.querySelector("video");
  video.pause = () => { pauses += 1; };
  video.play = () => { plays += 1; };
  await f.flush();
  assert.ok(pauses > 0);
  const baseline = pauses;
  video.dispatchEvent(new f.window.Event("play"));
  assert.equal(pauses, baseline + 1);
  f.change({ contentControlsEnabled: false });
  await f.flush();
  video.dispatchEvent(new f.window.Event("play"));
  assert.equal(pauses, baseline + 1);
  assert.equal(plays, 0);
  f.dispose();
});

test("redirects wait for the core gate and cancellation before dispatch can retry after unlock", async () => {
  const f = fixture({ url: "https://www.youtube.com/shorts/abc", adapter: routeAdapter });
  f.config.contentControls.youtube.shortsRoute = "watch";
  f.state.setCore({ ready: true, coreMode: "timer" });
  await f.flush();
  assert.deepEqual(f.visits, []);
  f.state.setCore({ ready: true, coreMode: "none" });
  assert.equal(f.state.get().navigationPending, true);
  f.state.setCore({ ready: true, coreMode: "timer" });
  await f.flush();
  assert.equal(f.state.get().navigationPending, false);
  assert.deepEqual(f.visits, []);
  f.state.setCore({ ready: true, coreMode: "none" });
  await f.flush();
  assert.deepEqual(f.visits, ["https://www.youtube.com/watch?v=abc"]);
  assert.equal(f.state.get().navigationPending, true);
  f.dom.reconfigure({ url: f.visits[0] });
  f.onMessage.emit({ type: "AIRLOCK_ROUTE_CHANGED", url: "https://www.youtube.com/shorts/obsolete" });
  await f.flush();
  assert.equal(f.state.get().navigationPending, false);
  assert.equal(f.visits.length, 1);
  f.dispose();
});

test("stale URL and disabled changes cancel queued redirects", async () => {
  const f = fixture({ url: "https://www.youtube.com/shorts/abc", adapter: routeAdapter });
  f.config.contentControls.youtube.shortsRoute = "watch";
  f.state.setCore({ ready: false, coreMode: "unknown" });
  await f.flush();
  f.state.setCore({ ready: true, coreMode: "none" });
  f.dom.reconfigure({ url: "https://www.youtube.com/watch?v=intentional" });
  await f.flush();
  assert.equal(f.visits.length, 0);
  assert.equal(f.state.get().navigationPending, false);
  f.dom.reconfigure({ url: "https://www.youtube.com/shorts/abc" });
  f.state.setCore({ ready: false, coreMode: "unknown" });
  f.onMessage.emit({ type: "AIRLOCK_ROUTE_CHANGED" });
  await f.flush();
  f.state.setCore({ ready: true, coreMode: "none" });
  f.change({ contentControlsEnabled: false });
  await f.flush();
  assert.equal(f.visits.length, 0);
  assert.equal(f.state.get().navigationPending, false);
  f.dispose();
});

test("failed or aborted navigation clears its usage pause within a bounded interval", async () => {
  for (const throws of [true, false]) {
    const f = fixture({ url: "https://www.youtube.com/shorts/abc", adapter: routeAdapter,
      navigate: () => { if (throws) throw new Error("blocked"); } });
    f.config.contentControls.youtube.shortsRoute = "watch";
    await f.flush();
    if (!throws) {
      assert.equal(f.state.get().navigationPending, true);
      await f.flush(NAVIGATION_RECOVERY_MS);
    }
    assert.equal(f.state.get().navigationPending, false);
    assert.equal(f.timers.size, 0);
    f.dispose();
  }
});

test("invalid, same-route and still-denied destinations cannot navigate or pause usage", async () => {
  for (const target of ["javascript:alert(1)", "https://www.youtube.com.evil.test/", "/", "https://m.youtube.com/watch?v=a", "/denied"]) {
    const f = fixture({ adapter: { id: "youtube", collect: () => [],
      decideNavigation({ url }) {
        if (url.pathname === "/denied") return { featureId: "youtube.shortsRoute", targetUrl: "/" };
        return { featureId: "youtube.shortsRoute", targetUrl: target };
      } } });
    await f.flush();
    assert.equal(f.visits.length, 0, target);
    assert.equal(f.state.get().navigationPending, false, target);
    f.dispose();
  }
});

test("adapter failure removes its effects and leaves the core lock intact", async () => {
  const f = fixture();
  f.state.setCore({ ready: true, coreMode: "cooldown" });
  await f.flush();
  assert.ok(f.window.document.querySelector("[data-airlock-hidden]"));
  f.runtime.registerAdapter({ id: "youtube", collect() { throw new Error("layout changed"); }, decideNavigation: () => null });
  await f.flush();
  assert.equal(f.runtime.getStatus().failure, "layout changed");
  assert.equal(f.window.document.querySelector("[data-airlock-hidden]"), null);
  assert.equal(f.state.get().coreMode, "cooldown");
  assert.equal(f.state.get().navigationPending, false);
  f.dispose();
});

test("unsupported hosts and future schemas do not activate observers", async () => {
  const f = fixture({ url: "https://www.youtube.com.evil.test/" });
  await f.flush();
  assert.equal(f.observed, 0);
  assert.equal(f.onChanged.size, 0);
  assert.equal(f.runtime.getStatus().platform, null);
  f.dispose();
  const future = fixture();
  future.config.contentControls.version = 999;
  await future.flush();
  assert.equal(future.observed, 0);
  assert.equal(future.runtime.getStatus().active, false);
  assert.equal([...future.timers.values()].some(timer => timer.delay === 5000), false,
    'An authoritative unsupported schema is not a transient storage failure');
  future.dispose();
});

test("external accessible naming changes reclassify dependent surfaces without discarding their content", async () => {
  const f = fixture({ html: "<span id='external-label'>Notes</span><section aria-labelledby='external-label'><p>Conversation text</p></section>",
    adapter: { id: "youtube", decideNavigation: () => null,
      collect({ document, root, controls }) {
        const surfaces = [...root.querySelectorAll("[aria-labelledby]")];
        if (root.nodeType === 1 && root.matches("[aria-labelledby]")) surfaces.unshift(root);
        return surfaces.filter((element) => controls.hideShorts &&
          document.getElementById(element.getAttribute("aria-labelledby"))?.textContent === "Notes")
          .map((element) => ({ element, effect: "hide", featureId: "youtube.hideShorts" }));
      }
    } });
  await f.flush();
  const label = f.window.document.getElementById("external-label");
  const region = f.window.document.querySelector("section");
  assert.equal(region.hasAttribute("data-airlock-hidden"), true);
  label.textContent = "Conversations";
  await f.flush();
  assert.equal(region.hasAttribute("data-airlock-hidden"), false);
  assert.equal(region.textContent, "Conversation text");
  label.textContent = "Notes";
  await f.flush();
  assert.equal(region.hasAttribute("data-airlock-hidden"), true);
  label.id = "different-label";
  await f.flush();
  assert.equal(region.hasAttribute("data-airlock-hidden"), false);
  f.dispose();
});

test("browser runtime reinjection shares one live singleton and replaces a disposed instance", async () => {
  const dom = new JSDOM("<!doctype html><main></main>", { url: "https://www.youtube.com/", runScripts: "outside-only" });
  const { window } = dom;
  const storageEvent = event();
  const runtimeEvent = event();
  window.browser = { storage: { local: { get: async () => ({ contentControlsEnabled: false }) }, onChanged: storageEvent },
    runtime: { onMessage: runtimeEvent } };
  window.AirlockControls = controlsApi;
  window.AirlockPageState = createPageState();
  const source = fs.readFileSync(path.join(__dirname, "../content/controls/runtime.js"), "utf8");
  window.eval(source);
  const first = window.AirlockContentRuntime;
  window.eval(source);
  assert.equal(window.AirlockContentRuntime, first);
  assert.equal(storageEvent.size, 1);
  assert.equal(runtimeEvent.size, 1);
  first.dispose();
  assert.equal(storageEvent.size, 0);
  assert.equal(runtimeEvent.size, 0);
  window.eval(source);
  assert.notEqual(window.AirlockContentRuntime, first);
  assert.equal(storageEvent.size, 1);
  window.AirlockContentRuntime.dispose();
  window.close();
});

test("back/forward page restoration and popstate reevaluate current URL and settings", async () => {
  const f = fixture({ adapter: routeAdapter });
  f.config.contentControls.youtube.shortsRoute = "watch";
  await f.flush();
  assert.equal(f.visits.length, 0);
  f.dom.reconfigure({ url: "https://www.youtube.com/shorts/abc" });
  f.window.dispatchEvent(new f.window.PopStateEvent("popstate"));
  await f.flush();
  assert.equal(f.visits.length, 1);
  assert.equal(f.state.get().navigationPending, true);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(f.state.get().navigationPending, false);
  assert.equal(f.runtime.getStatus().active, false);
  const observed = f.observed;
  f.config.contentControlsEnabled = false;
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await f.flush();
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(f.visits.length, 1);
  // The restoration uses authoritative saved preferences even without a storage event.
  f.config.contentControlsEnabled = true;
  f.dom.reconfigure({ url: "https://www.youtube.com/watch?v=abc" });
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await f.flush();
  assert.equal(f.runtime.getStatus().active, true);
  assert.ok(f.observed > observed);
  assert.equal(f.visits.length, 1);
  f.dispose();
});

function restorationFixture() {
  const saved = { contentControlsEnabled: true, contentControls: controlsApi.getDefaults(), configRevision: 0 };
  saved.contentControls.youtube.hideShorts = true;
  saved.contentControls.youtube.shortsRoute = "watch";
  let pendingRead = null;
  const f = fixture({
    html: "<main><ytd-rich-item-renderer id='short-card'><ytd-thumbnail><a href='/shorts/abcdefghijk'>Short</a></ytd-thumbnail></ytd-rich-item-renderer><p>Ordinary text</p></main>",
    adapter: require("../content/controls/sites/youtube.js"),
    get: () => pendingRead ? pendingRead.promise : Promise.resolve(structuredClone(saved))
  });
  return { f, saved, deferRead() { pendingRead = deferred(); return pendingRead; } };
}

test("page restoration waits for fresh settings and never restores cached effects after a failed read", async () => {
  const { f, saved, deferRead } = restorationFixture();
  await f.flush();
  const card = f.window.document.getElementById("short-card");
  assert.equal(card.hasAttribute("data-airlock-hidden"), true);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  saved.contentControlsEnabled = false;
  saved.configRevision = 1;
  const failedRead = deferRead();
  f.dom.reconfigure({ url: "https://www.youtube.com/shorts/abcdefghijk" });
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await f.flush();
  assert.equal(f.runtime.getStatus().initialized, false);
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.window.document.querySelector("[data-airlock-controls-style]"), null);
  assert.equal(f.visits.length, 0);
  assert.equal(f.state.get().navigationPending, false);
  failedRead.reject(new Error("storage temporarily unavailable"));
  await f.flush();
  assert.equal(f.runtime.getStatus().initialized, false);
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.visits.length, 0);

  const disabledRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  disabledRead.resolve(structuredClone(saved));
  await f.flush();
  assert.equal(f.runtime.getStatus().initialized, true);
  assert.equal(f.runtime.getStatus().revision, 1);
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.visits.length, 0);

  saved.contentControlsEnabled = true;
  saved.configRevision = 2;
  const enabledRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await f.flush();
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.visits.length, 0);
  enabledRead.resolve(structuredClone(saved));
  await f.flush();
  assert.equal(f.runtime.getStatus().revision, 2);
  assert.equal(card.hasAttribute("data-airlock-hidden"), true);
  assert.deepEqual(f.visits, ["https://www.youtube.com/watch?v=abcdefghijk"]);
  f.dispose();
});

test("restoration ignores older settings reads and reads that finish after pagehide or disposal", async () => {
  const { f, saved, deferRead } = restorationFixture();
  await f.flush();
  const card = f.window.document.getElementById("short-card");
  const activeSettings = structuredClone(saved);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  f.dom.reconfigure({ url: "https://www.youtube.com/shorts/abcdefghijk" });
  const olderRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  const newerRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  saved.contentControlsEnabled = false;
  saved.configRevision = 2;
  newerRead.resolve(structuredClone(saved));
  await f.flush();
  olderRead.resolve(activeSettings);
  await f.flush();
  assert.equal(f.runtime.getStatus().revision, 2);
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.visits.length, 0);

  const hiddenRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  hiddenRead.resolve(activeSettings);
  await f.flush();
  assert.equal(f.runtime.getStatus().initialized, false);
  assert.equal(f.runtime.getStatus().active, false);
  assert.equal(f.visits.length, 0);

  const disposedRead = deferRead();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  f.runtime.dispose();
  disposedRead.resolve(activeSettings);
  await f.flush();
  assert.equal(f.runtime.getStatus().disposed, true);
  assert.equal(card.hasAttribute("data-airlock-hidden"), false);
  assert.equal(f.visits.length, 0);
  assert.equal(f.onChanged.size, 0);
  assert.equal(f.onMessage.size, 0);
  assert.equal(f.timers.size, 0);
  f.dispose();
});

test("site restrictions and content blocking masters are independent and reversible", async () => {
  const f = fixture();
  try {
    await f.flush();
    const card = f.window.document.querySelector("[data-feature]");
    assert(card.hasAttribute("data-airlock-hidden"));
    f.change({ enabled: false }); await f.flush();
    assert(card.hasAttribute("data-airlock-hidden"), "site restrictions off preserves filtering");
    f.change({ contentControlsEnabled: false }); await f.flush();
    assert.equal(card.hasAttribute("data-airlock-hidden"), false);
    assert.equal(f.runtime.getStatus().active, false);
    f.change({ enabled: true }); await f.flush();
    assert.equal(card.hasAttribute("data-airlock-hidden"), false, "site restrictions on cannot enable content blocking");
    f.change({ enabled: false, contentControlsEnabled: true }); await f.flush();
    assert(card.hasAttribute("data-airlock-hidden"), "saved content rules resume with site restrictions off");
  } finally { f.dispose(); }
});

test("runtime uses the legacy master only until an explicit content switch is stored", async () => {
  const config = { enabled: false, contentControls: controlsApi.getDefaults(), configRevision: 1 };
  config.contentControls.youtube.hideShorts = true;
  const f = fixture({ get: async () => structuredClone(config) });
  try {
    await f.flush();
    assert.equal(f.runtime.getStatus().active, false);
    config.enabled = true; f.onChanged.emit({ enabled: { newValue: true } }, "local"); await f.flush();
    assert.equal(f.runtime.getStatus().active, true);
    config.enabled = false; config.contentControlsEnabled = true;
    f.onChanged.emit({ enabled: { newValue: false }, contentControlsEnabled: { newValue: true } }, "local"); await f.flush();
    assert.equal(f.runtime.getStatus().active, true, "explicit content state takes precedence over legacy switch");
  } finally { f.dispose(); }
});
