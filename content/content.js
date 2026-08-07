// Airlock - Content Script
// Injects delay overlay with countdown timer and focus target.
// Timer only ticks while tab is visible and window is focused.

(async function () {
  const TIMER_TICK_MS = 250;

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
  let hoverTargetPointerInside = false;
  let hoverTargetPressed = false;
  let running = false;
  let lastTick = Date.now();
  let timerTimeout = null;
  let activeStateInterval = null;
  let activeStateRefreshInFlight = false;
  let overlay = null;
  let shadowRoot = null;
  let timerEl = null;
  let pausedLabel = null;
  let continueBtn = null;
  let backdrop = null;
  let hoverTarget = null;
  let lastTimerText = null;
  let lastPausedLabelText = null;
  let lastTimerPaused = null;
  let lastContinueVisible = null;

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
          contain: layout style paint;
          user-select: none;
        }
        .hover-target {
          width: 168px;
          height: 168px;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          border-radius: 50%;
          contain: layout style paint;
          touch-action: none;
        }
        .hover-target::before {
          content: "";
          position: absolute;
          inset: 16px;
          border: 2px solid rgba(255, 255, 255, 0.18);
          border-radius: 50%;
          opacity: 0;
          pointer-events: none;
        }
        .hover-target.hover-target-required {
          cursor: pointer;
        }
        .hover-target.hover-target-required::before {
          opacity: 1;
        }
        .hover-target.hover-target-active::before {
          border-color: rgba(255, 255, 255, 0.72);
        }
        .breathing-circle {
          width: 120px;
          height: 120px;
          flex: 0 0 auto;
          position: relative;
          pointer-events: none;
          border-radius: 50%;
          background: rgba(91, 141, 239, 0.28);
          border: 2px solid rgba(91, 141, 239, 0.36);
        }
        .breathing-circle::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: rgba(91, 141, 239, 0.24);
          opacity: 0.38;
          transform: scale(0.92) translateZ(0);
          transform-origin: center;
          animation: airlock-breathe 7s ease-in-out infinite;
          will-change: transform, opacity;
        }
        .hover-target.hover-target-active .breathing-circle {
          background: rgba(91, 141, 239, 0.46);
          border-color: rgba(255, 255, 255, 0.72);
        }
        @keyframes airlock-breathe {
          0%, 100% {
            opacity: 0.34;
            transform: scale(0.92) translateZ(0);
          }
          50% {
            opacity: 0.68;
            transform: scale(1.28) translateZ(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .breathing-circle::after {
            animation: none;
            opacity: 0.45;
            transform: scale(1) translateZ(0);
          }
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
          <div class="hover-target" id="hover-target" title="Hover to run timer">
            <div class="breathing-circle"></div>
          </div>
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
    hoverTarget.addEventListener("pointerenter", (event) => {
      setHoverTargetPointerInside(event.pointerType !== "touch");
    });
    hoverTarget.addEventListener("pointerleave", resetHoverTargetGate);
    hoverTarget.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" && typeof hoverTarget.setPointerCapture === "function") {
        try {
          hoverTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort for touch press-and-hold.
        }
      }
      setHoverTargetPressed(true);
    });
    hoverTarget.addEventListener("pointerup", (event) => {
      setHoverTargetPressed(false);
      if (event.pointerType === "touch") setHoverTargetPointerInside(false);
    });
    hoverTarget.addEventListener("pointercancel", resetHoverTargetGate);
    hoverTarget.addEventListener("lostpointercapture", () => setHoverTargetPressed(false));

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

    const timerText = formatTime(remainingMs);
    if (lastTimerText !== timerText) {
      lastTimerText = timerText;
      timerEl.textContent = timerText;
    }

    const paused = remainingMs > 0 && !running;
    if (lastTimerPaused !== paused) {
      lastTimerPaused = paused;
      timerEl.classList.toggle("paused", paused);
    }

    if (remainingMs <= 0) {
      setPausedLabelText("");
      setContinueVisible(true);
    } else if (!running) {
      setPausedLabelText(getPausedLabel());
      setContinueVisible(false);
    } else {
      setPausedLabelText("");
      setContinueVisible(false);
    }
  }

  function setPausedLabelText(text) {
    if (lastPausedLabelText === text) return;

    lastPausedLabelText = text;
    pausedLabel.textContent = text;
  }

  function setContinueVisible(visible) {
    if (lastContinueVisible === visible) return;

    lastContinueVisible = visible;
    continueBtn.classList.toggle("visible", visible);
  }

  function getPausedLabel() {
    if (requireHoverTarget && !isHoverTargetSatisfied() && backgroundActive && isPageActive()) {
      return "Hover the circle";
    }

    return "Paused";
  }

  function dismissOverlay(options = {}) {
    const notifyDone = options.notifyDone !== false;

    clearTimerTimeout();
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
    lastTimerText = null;
    lastPausedLabelText = null;
    lastTimerPaused = null;
    lastContinueVisible = null;
  }

  function showOverlay(nextRemainingMs, active = backgroundActive) {
    clearTimerTimeout();

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

  function isHoverTargetSatisfied() {
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

  function updateHoverTargetGate() {
    const nextEngaged = requireHoverTarget && (hoverTargetPointerInside || hoverTargetPressed);
    if (hoverTargetEngaged !== nextEngaged) {
      hoverTargetEngaged = nextEngaged;
      updateHoverTargetState();
    }

    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setHoverTargetPointerInside(nextInside) {
    const normalized = requireHoverTarget && nextInside === true;
    if (hoverTargetPointerInside === normalized) return;

    hoverTargetPointerInside = normalized;
    updateHoverTargetGate();
  }

  function setHoverTargetPressed(nextPressed) {
    const normalized = requireHoverTarget && nextPressed === true;
    if (hoverTargetPressed === normalized) return;

    hoverTargetPressed = normalized;
    updateHoverTargetGate();
  }

  function resetHoverTargetGate() {
    hoverTargetPointerInside = false;
    hoverTargetPressed = false;
    updateHoverTargetGate();
  }

  function setRequireHoverTarget(nextRequired) {
    const normalized = nextRequired === true;
    if (requireHoverTarget === normalized) return;

    requireHoverTarget = normalized;
    if (!requireHoverTarget) {
      hoverTargetEngaged = false;
      hoverTargetPointerInside = false;
      hoverTargetPressed = false;
    } else {
      hoverTargetEngaged = hoverTargetPointerInside || hoverTargetPressed;
    }
    updateHoverTargetState();
    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setRunning(nextRunning, options = {}) {
    if (running === nextRunning) {
      if (running) scheduleTimerTick();
      return;
    }

    running = nextRunning;
    lastTick = Date.now();

    if (running) {
      scheduleTimerTick();
    } else {
      clearTimerTimeout();
      if (options.persistPaused) {
        persistState();
      }
    }

    updateDisplay();
  }

  function clearTimerTimeout() {
    if (timerTimeout) {
      clearTimeout(timerTimeout);
      timerTimeout = null;
    }
  }

  function scheduleTimerTick() {
    if (timerTimeout || !running) return;

    timerTimeout = setTimeout(runTimerTick, TIMER_TICK_MS);
  }

  function runTimerTick() {
    timerTimeout = null;
    const now = Date.now();

    if (remainingMs <= 0) return;

    if (!canRunTimer()) {
      setRunning(false, { persistPaused: true });
      lastTick = now;
      return;
    }

    const elapsed = now - lastTick;
    lastTick = now;
    remainingMs = Math.max(0, remainingMs - elapsed);

    updateDisplay();

    if (remainingMs <= 0) {
      clearTimerTimeout();
      stopActiveStatePolling();
      running = false;
      persistState();
      updateDisplay();
      return;
    }

    scheduleTimerTick();
  }

  function startTimer() {
    clearTimerTimeout();
    lastTick = Date.now();
    setRunning(canRunTimer());
    updateDisplay();
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
    if (!backgroundActive) {
      hoverTargetEngaged = false;
      hoverTargetPointerInside = false;
      hoverTargetPressed = false;
      updateHoverTargetState();
    }
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
      resetHoverTargetGate();
      pauseTimer();
    } else {
      resumeTimer();
    }
  });

  window.addEventListener("blur", () => {
    resetHoverTargetGate();
    pauseTimer();
  });
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
