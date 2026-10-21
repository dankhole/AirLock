// Shared only inside the extension's isolated content-script world.
(function (root, factory) {
  const api = root.AirlockPageState || factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AirlockPageState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CORE_MODES = new Set(["unknown", "none", "timer", "dailyLock", "dailyLimit", "cooldown"]);

  function createPageState() {
    let state = Object.freeze({ ready: false, coreMode: "unknown", navigationPending: false });
    const listeners = new Set();

    function update(patch) {
      const next = Object.freeze({ ...state, ...patch });
      if (next.ready === state.ready && next.coreMode === state.coreMode &&
          next.navigationPending === state.navigationPending) return state;
      const previous = state;
      state = next;
      for (const listener of [...listeners]) {
        try { listener(next, previous); } catch { /* Isolate independent subscribers. */ }
      }
      return state;
    }

    return Object.freeze({
      get() { return state; },
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Page-state listener must be a function");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // Only the core controller publishes gate readiness and mode.
      setCore(value) {
        if (!value || !CORE_MODES.has(value.coreMode)) throw new TypeError("Invalid core mode");
        return update({ ready: value.ready === true, coreMode: value.coreMode });
      },
      // Only the platform runtime publishes route-transition state.
      setNavigationPending(pending) { return update({ navigationPending: pending === true }); }
    });
  }

  return Object.freeze({ ...createPageState(), createPageState });
});
