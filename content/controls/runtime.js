// Runtime-owned presentation and lifecycle for pure, host-specific adapters.
(function (root, factory) {
  const library = factory();
  if (typeof module === "object" && module.exports) module.exports = library;
  if (root.window && root.document && root.browser && root.AirlockControls && root.AirlockPageState) {
    // Overlapping content-script entries may initialize this file more than once.
    if (!root.AirlockContentRuntime || root.AirlockContentRuntime.getStatus().disposed) {
      root.AirlockContentRuntime = library.createRuntime({
        window: root.window, document: root.document, browser: root.browser,
        controlsApi: root.AirlockControls, pageState: root.AirlockPageState
      });
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const HIDDEN_ATTRIBUTE = "data-airlock-hidden";
  const SUBDUED_ATTRIBUTE = "data-airlock-subdued";
  const NAVIGATION_RECOVERY_MS = 4000;

  function createRuntime(env) {
    const { window, document, browser, controlsApi, pageState } = env;
    const setTimer = env.setTimeout || window.setTimeout.bind(window);
    const clearTimer = env.clearTimeout || window.clearTimeout.bind(window);
    const Observer = env.MutationObserver || window.MutationObserver;
    const navigate = env.navigate || ((target) => window.location.replace(target));
    const adapters = new Map();
    const marks = new Map();
    const pausedMedia = new Set();
    const cleanup = [];
    let disposed = false;
    let pageHidden = false;
    let settings = null;
    let revision = 0;
    let readSequence = 0;
    let generation = 0;
    let observer = null;
    let style = null;
    let scheduled = null;
    let navigationTimer = null;
    let navigation = null;
    let attemptedNavigation = null;
    let fullPass = false;
    let dirtyRoots = new Set();
    let failure = null;
    let activeAdapter = null;

    function currentUrl() {
      try { return new URL(window.location.href); } catch { return null; }
    }

    const initialUrl = currentUrl();
    const platform = initialUrl && controlsApi.getPlatform(initialUrl.hostname);
    let topFrame = true;
    try { topFrame = window.top === window; } catch { topFrame = false; }
    const supported = Boolean(topFrame && platform && /^(https?:)$/.test(initialUrl.protocol));

    function listen(target, name, callback, options) {
      target.addEventListener(name, callback, options);
      cleanup.push(() => target.removeEventListener(name, callback, options));
    }

    function getControls() {
      return settings && settings.enabled !== false ? settings.contentControls[platform] : null;
    }

    function isActive() {
      const controls = getControls();
      return Boolean(supported && !disposed && !pageHidden && !failure && activeAdapter &&
        controls && controlsApi.isActive(platform, controls));
    }

    function clearNavigation(expectedNavigation) {
      if (expectedNavigation && navigation !== expectedNavigation) return;
      if (navigationTimer !== null) clearTimer(navigationTimer);
      navigationTimer = null;
      navigation = null;
      pageState.setNavigationPending(false);
    }

    function cancelScheduled() {
      if (scheduled !== null) clearTimer(scheduled);
      scheduled = null;
      dirtyRoots.clear();
      fullPass = false;
    }

    function ownedNode(node) {
      const element = node && (node.nodeType === 1 ? node : node.parentElement);
      return Boolean(element && (element === style ||
        element.closest("airlock-overlay, airlock-usage-reminder, [data-airlock-controls-style]")));
    }

    function ensureStyle() {
      if (style || !document.documentElement) return;
      style = document.createElement("style");
      style.setAttribute("data-airlock-controls-style", "");
      style.textContent = `[${HIDDEN_ATTRIBUTE}] { display: none !important; }
[${SUBDUED_ATTRIBUTE}] { opacity: 0.3 !important; filter: grayscale(1) !important; }`;
      (document.head || document.documentElement).appendChild(style);
    }

    function tokens(element, attribute, ownedTokens, nextTokens) {
      const existing = (element.getAttribute(attribute) || "").split(/\s+/).filter(Boolean);
      const values = new Set(existing.filter((value) => !ownedTokens.has(value)));
      for (const value of nextTokens) values.add(value);
      const nextValue = [...values].join(" ");
      if (nextValue) {
        if (element.getAttribute(attribute) !== nextValue) element.setAttribute(attribute, nextValue);
      } else if (element.hasAttribute(attribute)) element.removeAttribute(attribute);
    }

    function syncElement(element, previous, next) {
      const oldHidden = new Set();
      const oldSubdued = new Set();
      const nextHidden = new Set();
      const nextSubdued = new Set();
      for (const [featureId, value] of previous || []) {
        (value.effect === "hide" ? oldHidden : oldSubdued).add(featureId);
      }
      for (const [featureId, value] of next || []) {
        (value.effect === "hide" ? nextHidden : nextSubdued).add(featureId);
      }
      tokens(element, HIDDEN_ATTRIBUTE, oldHidden, nextHidden);
      tokens(element, SUBDUED_ATTRIBUTE, oldSubdued, nextSubdued);
    }

    function syncMedia() {
      pausedMedia.clear();
      for (const [element, features] of marks) {
        if (![...features.values()].some((value) => value.pauseMedia)) continue;
        if (element.matches("video, audio")) pausedMedia.add(element);
        for (const media of element.querySelectorAll("video, audio")) pausedMedia.add(media);
      }
      for (const media of pausedMedia) {
        try { media.pause(); } catch { /* A detached or unsupported media element is harmless. */ }
      }
    }

    function commitMarks(next) {
      for (const [element, previous] of marks) syncElement(element, previous, next.get(element));
      for (const [element, features] of next) {
        if (!marks.has(element)) syncElement(element, null, features);
      }
      marks.clear();
      for (const [element, features] of next) marks.set(element, features);
      syncMedia();
    }

    function clearEffects() {
      commitMarks(new Map());
      if (style) style.remove();
      style = null;
    }

    function stopObserver() {
      if (observer) observer.disconnect();
      observer = null;
    }

    function fail(error) {
      failure = error instanceof Error ? error.message : String(error);
      generation += 1;
      cancelScheduled();
      stopObserver();
      clearEffects();
      clearNavigation();
    }

    function affected(element, roots) {
      return roots.some((root) => root === document || root === element ||
        root.contains(element) || element.contains(root));
    }

    function compactRoots(roots) {
      return roots.filter((root, index) => !roots.some((other, otherIndex) =>
        index !== otherIndex && other.contains(root)));
    }

    function validMatch(match) {
      return match && match.element && match.element.nodeType === 1 &&
        match.element.ownerDocument === document && match.element.isConnected &&
        !ownedNode(match.element) && typeof match.featureId === "string" &&
        new RegExp("^" + platform + "\\.[A-Za-z][A-Za-z0-9]*$").test(match.featureId) &&
        (match.effect === "hide" || match.effect === "subdue");
    }

    function reconcile(roots, expectedGeneration) {
      if (!isActive() || expectedGeneration !== generation) return;
      const url = currentUrl();
      if (!url || controlsApi.getPlatform(url.hostname) !== platform) return;
      const controls = getControls();
      const next = new Map(marks);
      for (const [element] of next) {
        if (!element.isConnected || affected(element, roots)) next.delete(element);
      }
      for (const root of roots) {
        const matches = activeAdapter.collect({ document, root, url, controls });
        if (!Array.isArray(matches)) throw new TypeError("Adapter collect must return an array");
        for (const match of matches) {
          if (!validMatch(match)) continue;
          if (!next.has(match.element)) next.set(match.element, new Map());
          next.get(match.element).set(match.featureId, {
            effect: match.effect, pauseMedia: match.pauseMedia === true
          });
        }
      }
      if (expectedGeneration !== generation || !isActive()) return;
      ensureStyle();
      commitMarks(next);
      evaluateNavigation();
    }

    function schedule(root = document) {
      if (!isActive()) return;
      if (root === document) fullPass = true;
      else if (root && root.isConnected && !ownedNode(root)) dirtyRoots.add(root);
      if (scheduled !== null) return;
      const expectedGeneration = generation;
      scheduled = setTimer(() => {
        scheduled = null;
        const roots = fullPass ? [document] : compactRoots([...dirtyRoots]);
        fullPass = false;
        dirtyRoots.clear();
        try { if (roots.length) reconcile(roots, expectedGeneration); } catch (error) { fail(error); }
      }, 0);
    }

    function startObserver() {
      if (observer || !Observer || !document.documentElement || !isActive()) return;
      observer = new Observer((records) => {
        let relevant = false;
        const namingIds = new Set();
        function namingAncestors(node) {
          let element = node && (node.nodeType === 1 ? node : node.parentElement);
          while (element) {
            if (element.id) namingIds.add(element.id);
            element = element.parentElement;
          }
        }
        function namingSubtree(node) {
          if (!node || node.nodeType !== 1) return;
          if (node.id) namingIds.add(node.id);
          for (const element of node.querySelectorAll("[id]")) namingIds.add(element.id);
        }
        for (const record of records) {
          if (ownedNode(record.target) || (record.type === "attributes" &&
            [HIDDEN_ATTRIBUTE, SUBDUED_ATTRIBUTE].includes(record.attributeName))) continue;
          const root = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (!root || !root.isConnected) continue;
          if (record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
            .every(ownedNode)) continue;
          relevant = true;
          if (record.type === "childList" || record.type === "characterData" ||
              (record.type === "attributes" && record.attributeName === "id")) namingAncestors(root);
          if (record.type === "attributes" && record.attributeName === "id" && record.oldValue) namingIds.add(record.oldValue);
          if (record.type === "childList") {
            for (const node of [...record.addedNodes, ...record.removedNodes]) namingSubtree(node);
          }
          schedule(root);
          // Recycled containers must shed features when their descendants change.
          for (const [element] of marks) {
            if (element.contains(root)) schedule(element);
          }
        }
        // A semantic label can live outside the surface it names. Invalidate those
        // dependent surfaces together rather than retaining stale Notes/Stories marks.
        if (namingIds.size) {
          for (const element of document.querySelectorAll("[aria-labelledby]")) {
            if ((element.getAttribute("aria-labelledby") || "").split(/\s+/)
              .some((id) => namingIds.has(id))) schedule(element);
          }
        }
        // Detached marks still need cleanup even if their parent has vanished.
        if (relevant && [...marks.keys()].some((element) => !element.isConnected)) schedule(document);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true,
        attributes: true, attributeOldValue: true, characterData: true });
    }

    function validateDecision(decision, url, controls) {
      if (!decision || typeof decision.targetUrl !== "string" ||
          typeof decision.featureId !== "string" || !decision.featureId.startsWith(platform + ".")) return null;
      let target;
      try { target = new URL(decision.targetUrl, url.href); } catch { return null; }
      if (!/^(https?:)$/.test(target.protocol) || target.origin !== url.origin ||
          target.username || target.password || target.href === url.href ||
          controlsApi.getPlatform(target.hostname) !== platform) return null;
      // Adapters resolve directly to their final allowed destination.
      if (activeAdapter.decideNavigation({ url: target, controls, document })) return null;
      return target;
    }

    function evaluateNavigation() {
      if (!isActive()) { clearNavigation(); return; }
      const url = currentUrl();
      const controls = getControls();
      if (!url) { clearNavigation(); return; }
      let target;
      try {
        target = validateDecision(activeAdapter.decideNavigation({ url, controls, document }), url, controls);
      } catch (error) { fail(error); return; }
      if (!target) { clearNavigation(); return; }
      const state = pageState.get();
      if (!state.ready || state.coreMode !== "none") { clearNavigation(); return; }
      const signature = [generation, revision, url.href, target.href].join("\n");
      if (attemptedNavigation === signature || navigation) return;
      const expectedGeneration = generation;
      const sourceHref = url.href;
      const expectedRevision = revision;
      const transition = { sourceHref, targetHref: target.href };
      navigation = transition;
      pageState.setNavigationPending(true);
      Promise.resolve().then(() => {
        if (navigation !== transition) return;
        const latest = currentUrl();
        const gate = pageState.get();
        if (!isActive() || generation !== expectedGeneration || revision !== expectedRevision ||
            !latest || latest.href !== sourceHref || !gate.ready || gate.coreMode !== "none") {
          clearNavigation(transition);
          return;
        }
        let valid;
        try {
          valid = validateDecision(activeAdapter.decideNavigation({
            url: latest, controls: getControls(), document
          }), latest, getControls());
        } catch (error) { fail(error); return; }
        if (!valid || valid.href !== target.href) { clearNavigation(transition); return; }
        attemptedNavigation = signature;
        navigationTimer = setTimer(() => clearNavigation(transition), NAVIGATION_RECOVERY_MS);
        try {
          const result = navigate(valid.href);
          if (result && typeof result.catch === "function") result.catch(() => clearNavigation(transition));
        } catch { clearNavigation(transition); }
      });
    }

    function activate() {
      activeAdapter = adapters.get(platform) || null;
      if (!isActive()) {
        stopObserver(); cancelScheduled(); clearEffects(); clearNavigation();
        return;
      }
      startObserver();
      schedule(document);
    }

    async function readSettings() {
      if (!supported || disposed) return;
      const sequence = ++readSequence;
      try {
        const saved = await browser.storage.local.get(["enabled", "contentControls", "configRevision"]);
        if (disposed || sequence !== readSequence) return;
        settings = { enabled: saved.enabled !== false, contentControls: controlsApi.normalize(saved.contentControls) };
        revision = Number.isSafeInteger(saved.configRevision) && saved.configRevision >= 0 ? saved.configRevision : 0;
        generation += 1;
        cancelScheduled();
        clearNavigation();
        attemptedNavigation = null;
        activate();
      } catch {
        if (disposed || sequence !== readSequence) return;
        // Do not apply guessed defaults before an authoritative read succeeds.
        if (!settings) activate();
      }
    }

    function refreshSettings() {
      if (disposed || !supported) return;
      // Restored documents may have missed settings events while suspended.
      // Remove cached effects before waiting for a fresh authoritative read.
      generation += 1;
      settings = null;
      stopObserver(); cancelScheduled(); clearEffects(); clearNavigation();
      attemptedNavigation = null;
      readSettings();
    }

    function routeChanged() {
      if (disposed || !supported) return;
      generation += 1;
      cancelScheduled();
      clearNavigation();
      attemptedNavigation = null;
      if (!settings) readSettings();
      else activate();
    }

    function registerAdapter(adapter) {
      if (disposed) return false;
      if (!adapter || adapter.id !== platform || typeof adapter.collect !== "function" ||
          typeof adapter.decideNavigation !== "function") return false;
      if (adapters.get(adapter.id) === adapter) return true;
      adapters.set(adapter.id, adapter);
      failure = null;
      generation += 1;
      attemptedNavigation = null;
      cancelScheduled(); clearNavigation(); clearEffects();
      activate();
      return true;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      readSequence += 1;
      cancelScheduled(); stopObserver(); clearEffects(); clearNavigation();
      for (const callback of cleanup.splice(0)) callback();
      adapters.clear();
    }

    if (supported) {
      const onStorage = (changes, area) => {
        if (area !== "local" || !["enabled", "contentControls", "configRevision"].some((key) => key in changes)) return;
        refreshSettings();
      };
      const onMessage = (message) => {
        if (message && message.type === "AIRLOCK_ROUTE_CHANGED") routeChanged();
      };
      browser.storage.onChanged.addListener(onStorage);
      browser.runtime.onMessage.addListener(onMessage);
      cleanup.push(() => browser.storage.onChanged.removeListener(onStorage));
      cleanup.push(() => browser.runtime.onMessage.removeListener(onMessage));
      listen(window, "popstate", routeChanged);
      listen(window, "pageshow", () => {
        pageHidden = false;
        refreshSettings();
      });
      listen(window, "pagehide", () => {
        pageHidden = true;
        generation += 1;
        readSequence += 1;
        stopObserver(); cancelScheduled(); clearNavigation();
      });
      listen(document, "DOMContentLoaded", activate);
      listen(document, "play", (event) => {
        if (pausedMedia.has(event.target)) {
          try { event.target.pause(); } catch { /* Best effort. */ }
        }
      }, true);
      cleanup.push(pageState.subscribe(() => {
        if (!disposed) evaluateNavigation();
      }));
      readSettings();
    }

    return Object.freeze({
      registerAdapter, dispose,
      getStatus() {
        return Object.freeze({ platform: supported ? platform : null,
          initialized: settings !== null, active: isActive(), revision,
          failure, disposed, navigationPending: pageState.get().navigationPending });
      }
    });
  }

  return Object.freeze({ createRuntime, HIDDEN_ATTRIBUTE, SUBDUED_ATTRIBUTE, NAVIGATION_RECOVERY_MS });
});
