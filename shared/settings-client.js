(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AirlockSettingsClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function create(browserApi, options = {}) {
    let snapshot = null;
    let context = options.tabId === undefined ? {} : { tabId: options.tabId };
    const listeners = new Set();
    const clientId = options.clientId || "view-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    let sequence = 0;
    let messageOrder = 0;
    let acceptedOrder = 0;
    let refreshInFlight = null;
    let refreshAgain = false;
    let disposed = false;

    function accept(response, order) {
      if (response && response.config && Number.isInteger(response.revision) &&
          (!snapshot || response.revision > snapshot.revision ||
            (response.revision === snapshot.revision && order >= acceptedOrder))) {
        snapshot = response;
        acceptedOrder = Math.max(acceptedOrder, order);
        if (!disposed) listeners.forEach((listener) => listener(snapshot));
      }
      return response;
    }

    async function send(message) {
      const order = ++messageOrder;
      const response = await browserApi.runtime.sendMessage({ ...context, ...message });
      if (!response || typeof response !== "object") throw new Error("Airlock did not respond. Try again.");
      return accept(response, order);
    }

    function refresh() {
      if (!refreshInFlight) {
        refreshInFlight = send({ type: "GET_SETTINGS_STATE" }).finally(() => {
          refreshInFlight = null;
          if (refreshAgain && !disposed) { refreshAgain = false; refresh().catch(() => {}); }
        });
      }
      return refreshInFlight;
    }

    function storageChanged(changes, area) {
      if (area === "local" && !disposed) {
        if (refreshInFlight) refreshAgain = true;
        else refresh().catch(() => {});
      }
    }
    if (browserApi.storage && browserApi.storage.onChanged) browserApi.storage.onChanged.addListener(storageChanged);

    return {
      get snapshot() { return snapshot; },
      clientId,
      subscribe(listener) {
        listeners.add(listener);
        if (snapshot) listener(snapshot);
        return () => listeners.delete(listener);
      },
      setContext(next) { context = { ...next }; },
      refresh,
      request(patch, expectedRevision = snapshot && snapshot.revision) {
        return send({ type: "REQUEST_CONFIG_CHANGE", expectedRevision, patch });
      },
      startCooldown() { return send({ type: "START_COOLDOWN" }); },
      advance(pendingId, elapsedMs) {
        return send({ type: "ADVANCE_PENDING_CONFIG_CHANGE", pendingId, clientId, sequence: ++sequence, elapsedMs });
      },
      release(pendingId) { return send({ type: "RELEASE_PENDING_CONFIG_CHANGE", pendingId, clientId }); },
      cancel(pendingId) { return send({ type: "CANCEL_PENDING_CONFIG_CHANGE", pendingId }); },
      dispose() {
        disposed = true;
        listeners.clear();
        if (browserApi.storage && browserApi.storage.onChanged && browserApi.storage.onChanged.removeListener) {
          browserApi.storage.onChanged.removeListener(storageChanged);
        }
      }
    };
  }

  return { create };
});
