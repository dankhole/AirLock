// Airlock - Content Script
// Injects delay overlay with countdown timer and breathing animation.
// Timer only ticks while tab is visible and window is focused.

(async function () {
  const hostname = window.location.hostname;
  if (!hostname) return;

  let config;
  try {
    config = await browser.storage.local.get(["enabled", "sites", "requireHoverTarget"]);
  } catch (e) {
    console.warn("[Airlock] Failed to read config:", e);
    return;
  }

  if (config.enabled === false) return;

  const sites = config.sites || [];
  const isTracked = sites.some(
    (site) => hostname === site || hostname.endsWith("." + site)
  );
  if (!isTracked) return;

  let response;
  try {
    response = await browser.runtime.sendMessage({
      type: "CONTENT_READY",
      domain: hostname
    });
  } catch (e) {
    console.warn("[Airlock] Failed to contact background:", e);
    return;
  }

  const shouldShowOverlay = response && response.type === "SHOW_OVERLAY";

  // --- State ---
  let remainingMs = shouldShowOverlay ? response.remainingMs : 0;
  let backgroundActive = response ? response.active !== false : false;
  let requireHoverTarget = shouldShowOverlay
    ? response.requireHoverTarget === true
    : config.requireHoverTarget === true;
  let hoverTargetEngaged = false;
  let hoverTargetPressed = false;
  let running = false;
  let lastTick = Date.now();
  let timerInterval = null;
  let activeStateInterval = null;
  let activeStateRefreshInFlight = false;
  let overlay = null;
  let shadowRoot = null;
  let timerEl = null;
  let pausedLabel = null;
  let continueBtn = null;
  let backdrop = null;
  let hoverTarget = null;

  // --- Create Overlay ---

  function createOverlay() {
    const host = document.createElement("airlock-overlay");
    host.style.cssText = "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; pointer-events: auto !important;";
    shadowRoot = host.attachShadow({ mode: "closed" });

    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        .backdrop {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(10, 15, 30, 0.97);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          opacity: 0;
          transition: opacity 0.25s ease-out;
        }
        .backdrop.visible {
          opacity: 1;
        }
        .card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 32px;
          user-select: none;
        }
        .breathing-circle {
          width: 120px;
          height: 120px;
          position: relative;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(91, 141, 239, 0.4), rgba(91, 141, 239, 0.1));
          border: 2px solid rgba(91, 141, 239, 0.3);
          animation: breathe 8s ease-in-out infinite;
          transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
        }
        .breathing-circle.hover-target-required {
          cursor: pointer;
          box-shadow: 0 0 0 8px rgba(255, 255, 255, 0.08);
        }
        .breathing-circle.hover-target-active {
          background: radial-gradient(circle, rgba(91, 141, 239, 0.65), rgba(91, 141, 239, 0.22));
          border-color: rgba(255, 255, 255, 0.72);
          box-shadow: 0 0 0 10px rgba(91, 141, 239, 0.22);
        }
        @keyframes breathe {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.3); opacity: 1; }
        }
        .message {
          font-size: 18px;
          color: rgba(255, 255, 255, 0.6);
          letter-spacing: 0.5px;
        }
        .timer {
          font-size: 48px;
          font-weight: 300;
          color: rgba(255, 255, 255, 0.9);
          font-variant-numeric: tabular-nums;
          min-width: 120px;
          text-align: center;
        }
        .paused-label {
          font-size: 14px;
          color: rgba(255, 255, 255, 0.35);
          height: 20px;
        }
        .continue-btn {
          padding: 12px 32px;
          background: rgba(91, 141, 239, 0.8);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s, background 0.15s;
        }
        .continue-btn.visible {
          opacity: 1;
          pointer-events: auto;
        }
        .continue-btn:hover {
          background: rgba(91, 141, 239, 1);
        }
        .timer.paused {
          opacity: 0.4;
        }
      </style>
      <div class="backdrop">
        <div class="card">
          <div class="breathing-circle" id="hover-target" title="Hover to run timer"></div>
          <div class="message">Take a moment...</div>
          <div class="timer" id="timer-display">0:00</div>
          <div class="paused-label" id="paused-label"></div>
          <button class="continue-btn" id="continue-btn">Continue</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    overlay = host;

    backdrop = shadowRoot.querySelector(".backdrop");
    timerEl = shadowRoot.getElementById("timer-display");
    pausedLabel = shadowRoot.getElementById("paused-label");
    continueBtn = shadowRoot.getElementById("continue-btn");
    hoverTarget = shadowRoot.getElementById("hover-target");
    continueBtn.addEventListener("click", () => dismissOverlay());
    hoverTarget.addEventListener("pointerenter", () => refreshHoverTargetGate());
    hoverTarget.addEventListener("pointerleave", () => refreshHoverTargetGate());
    hoverTarget.addEventListener("pointerdown", () => setHoverTargetPressed(true));
    hoverTarget.addEventListener("pointerup", () => setHoverTargetPressed(false));
    hoverTarget.addEventListener("pointercancel", () => setHoverTargetPressed(false));

    updateHoverTargetState();
    updateDisplay();

    // Trigger fade-in on next frame
    requestAnimationFrame(() => {
      backdrop.classList.add("visible");
    });
  }

  function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ":" + String(seconds).padStart(2, "0");
  }

  function updateDisplay() {
    if (!timerEl) return;

    timerEl.textContent = formatTime(remainingMs);

    if (remainingMs <= 0) {
      timerEl.classList.remove("paused");
      pausedLabel.textContent = "";
      continueBtn.classList.add("visible");
    } else if (!running) {
      timerEl.classList.add("paused");
      pausedLabel.textContent = getPausedLabel();
    } else {
      timerEl.classList.remove("paused");
      pausedLabel.textContent = "";
    }
  }

  function getPausedLabel() {
    if (requireHoverTarget && !isHoverTargetSatisfied() && backgroundActive && isPageActive()) {
      return "Hover the circle";
    }

    return "Paused";
  }

  function dismissOverlay(options = {}) {
    const notifyDone = options.notifyDone !== false;

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    stopActiveStatePolling();
    running = false;

    if (backdrop) {
      backdrop.classList.remove("visible");
      // Wait for fade-out transition then remove
      backdrop.addEventListener("transitionend", removeOverlayElement, { once: true });
      // Fallback if transitionend doesn't fire
      setTimeout(removeOverlayElement, 300);
    } else {
      removeOverlayElement();
    }

    if (notifyDone) {
      try {
        browser.runtime.sendMessage({ type: "TIMER_DONE" });
      } catch {
        // Extension context may be invalidated
      }
    }
  }

  function removeOverlayElement() {
    if (overlay) overlay.remove();
    overlay = null;
    shadowRoot = null;
    timerEl = null;
    pausedLabel = null;
    continueBtn = null;
    backdrop = null;
    hoverTarget = null;
  }

  function showOverlay(nextRemainingMs, active = backgroundActive) {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    remainingMs = nextRemainingMs;
    backgroundActive = active !== false;
    running = false;

    if (!overlay) {
      createOverlay();
    } else {
      updateDisplay();
    }

    if (remainingMs > 0) {
      startTimer();
      startActiveStatePolling();
    }
  }

  // --- Timer Logic ---

  function isPageActive() {
    return document.visibilityState === "visible" && !document.hidden && document.hasFocus();
  }

  function syncHoverTargetEngagement() {
    if (!requireHoverTarget) {
      hoverTargetEngaged = false;
      hoverTargetPressed = false;
      updateHoverTargetState();
      return;
    }

    if (!hoverTarget || typeof hoverTarget.matches !== "function") return;

    const nextEngaged = hoverTarget.matches(":hover") || hoverTargetPressed;
    if (hoverTargetEngaged === nextEngaged) return;

    hoverTargetEngaged = nextEngaged;
    updateHoverTargetState();
  }

  function isHoverTargetSatisfied() {
    syncHoverTargetEngagement();
    return !requireHoverTarget || hoverTargetEngaged;
  }

  function canRunTimer() {
    return Boolean(
      overlay &&
      remainingMs > 0 &&
      backgroundActive &&
      isPageActive() &&
      isHoverTargetSatisfied()
    );
  }

  function updateHoverTargetState() {
    if (!hoverTarget) return;

    hoverTarget.classList.toggle("hover-target-required", requireHoverTarget);
    hoverTarget.classList.toggle("hover-target-active", requireHoverTarget && hoverTargetEngaged);
  }

  function refreshHoverTargetGate() {
    syncHoverTargetEngagement();
    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setHoverTargetPressed(nextPressed) {
    hoverTargetPressed = requireHoverTarget && nextPressed === true;
    refreshHoverTargetGate();
  }

  function setRequireHoverTarget(nextRequired) {
    const normalized = nextRequired === true;
    if (requireHoverTarget === normalized) return;

    requireHoverTarget = normalized;
    if (!requireHoverTarget) {
      hoverTargetEngaged = false;
      hoverTargetPressed = false;
    }
    updateHoverTargetState();
    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setRunning(nextRunning, options = {}) {
    if (running === nextRunning) return;

    running = nextRunning;
    lastTick = Date.now();

    if (!running && options.persistPaused) {
      persistState();
    }

    updateDisplay();
  }

  function startTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
    }

    lastTick = Date.now();
    timerInterval = setInterval(() => {
      const now = Date.now();

      if (remainingMs <= 0) return;

      if (!canRunTimer()) {
        setRunning(false, { persistPaused: true });
        lastTick = now;
        return;
      }

      if (!running) {
        setRunning(true);
        lastTick = now;
        return;
      }

      const elapsed = now - lastTick;
      lastTick = now;
      remainingMs = Math.max(0, remainingMs - elapsed);

      updateDisplay();

      if (remainingMs <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        stopActiveStatePolling();
        running = false;
        persistState();
      }
    }, 250);
  }

  function pauseTimer() {
    setRunning(false, { persistPaused: true });
  }

  function resumeTimer() {
    refreshBackgroundActiveState();
    setRunning(canRunTimer());
  }

  function setBackgroundActive(active) {
    backgroundActive = active === true;
    setRunning(canRunTimer(), { persistPaused: true });
  }

  function startActiveStatePolling() {
    stopActiveStatePolling();
    refreshBackgroundActiveState();
    activeStateInterval = setInterval(refreshBackgroundActiveState, 1000);
  }

  function stopActiveStatePolling() {
    if (activeStateInterval) {
      clearInterval(activeStateInterval);
      activeStateInterval = null;
    }
  }

  function refreshBackgroundActiveState() {
    if (activeStateRefreshInFlight || !overlay || remainingMs <= 0) return;

    activeStateRefreshInFlight = true;
    browser.runtime
      .sendMessage({ type: "GET_ACTIVE_STATE" })
      .then((state) => {
        if (state && typeof state.active === "boolean") {
          setBackgroundActive(state.active);
        }
      })
      .catch(() => {
        setBackgroundActive(false);
      })
      .finally(() => {
        activeStateRefreshInFlight = false;
      });
  }

  function persistState() {
    try {
      browser.runtime.sendMessage({
        type: "TIMER_UPDATE",
        remainingMs: remainingMs
      });
    } catch {
      // Extension context may be invalidated
    }
  }

  // --- Visibility / Focus Handling ---

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      setHoverTargetPressed(false);
      pauseTimer();
    } else {
      resumeTimer();
    }
  });

  window.addEventListener("blur", () => pauseTimer());
  window.addEventListener("focus", () => resumeTimer());

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "PAUSE") {
      setBackgroundActive(false);
      pauseTimer();
    } else if (message.type === "RESUME") {
      setBackgroundActive(true);
      resumeTimer();
    } else if (message.type === "ACTIVE_STATE") {
      setBackgroundActive(message.active);
    } else if (message.type === "RESET_TIMER") {
      setRequireHoverTarget(message.requireHoverTarget);
      showOverlay(message.remainingMs, message.active);
    }
  });

  // --- Extension Toggle Listener ---

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.enabled && changes.enabled.newValue === false) {
      dismissOverlay({ notifyDone: false });
    }

    if (areaName === "local" && changes.sites) {
      const nextSites = changes.sites.newValue || [];
      const stillTracked = nextSites.some(
        (site) => hostname === site || hostname.endsWith("." + site)
      );
      if (!stillTracked) {
        dismissOverlay({ notifyDone: false });
      }
    }

    if (areaName === "local" && changes.requireHoverTarget) {
      setRequireHoverTarget(changes.requireHoverTarget.newValue);
    }
  });

  // --- Start ---

  if (shouldShowOverlay) {
    showOverlay(response.remainingMs, response.active);
  }
})();
