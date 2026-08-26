// Airlock - Content Script
// Injects wait and daily-lock overlays for tracked sites.
// Wait timers only tick while the tab is visible and window is focused.

(async function () {
  const TIMER_TICK_MS = 250;
  const DAILY_USAGE_TICK_MS = 1000;

  const hostname = window.location.hostname;
  if (!hostname) return;

  let config;
  try {
    config = await browser.storage.local.get([
      "enabled",
      "sites",
      "requireHoverTarget",
      "cooldownUntil"
    ]);
  } catch (e) {
    console.warn("[Airlock] Failed to read config:", e);
    return;
  }

  const sites = config.sites || [];
  const initiallyTracked = sites.some(
    (site) => hostname === site || hostname.endsWith("." + site)
  );
  let response = {
    type: "NO_OVERLAY",
    active: false,
    requireHoverTarget: config.requireHoverTarget === true,
    dailyLimitMinutes: null,
    dailyUsageRemainingMs: null,
    dailyUsageResetAt: null
  };

  const initialCooldownActive = Number(config.cooldownUntil) > Date.now();
  if ((config.enabled !== false || initialCooldownActive) && initiallyTracked) {
    try {
      response = await browser.runtime.sendMessage({
        type: "CONTENT_READY",
        domain: hostname
      });
    } catch (e) {
      console.warn("[Airlock] Failed to contact background:", e);
    }
  }

  const shouldShowTimer = response && response.type === "SHOW_OVERLAY";
  const shouldShowDailyLock = response && response.type === "SHOW_DAILY_LOCK";
  const shouldShowDailyLimit = response && response.type === "SHOW_DAILY_LIMIT";
  const shouldShowCooldown = response && response.type === "SHOW_COOLDOWN";

  // --- State ---
  let overlayMode = shouldShowCooldown
    ? "cooldown"
    : shouldShowDailyLock
      ? "dailyLock"
      : shouldShowDailyLimit
        ? "dailyLimit"
        : shouldShowTimer
          ? "timer"
          : null;
  let remainingMs = shouldShowTimer ? response.remainingMs : 0;
  let dailyLockUntil = shouldShowDailyLock || shouldShowCooldown
    ? response.unlockAt
    : shouldShowDailyLimit
      ? response.resetAt
      : null;
  let dailyLimitMinutes = response && Number.isFinite(response.dailyLimitMinutes)
    ? response.dailyLimitMinutes
    : null;
  let dailyUsageRemainingMs = response && Number.isFinite(response.dailyUsageRemainingMs)
    ? response.dailyUsageRemainingMs
    : null;
  let dailyUsageResetAt = response && Number.isFinite(response.dailyUsageResetAt)
    ? response.dailyUsageResetAt
    : null;
  let backgroundActive = response ? response.active !== false : false;
  let requireHoverTarget = shouldShowTimer
    ? response.requireHoverTarget === true
    : config.requireHoverTarget === true;
  let hoverTargetEngaged = false;
  let hoverTargetPointerInside = false;
  let hoverTargetPressed = false;
  let running = false;
  let lastTick = Date.now();
  let timerTimeout = null;
  let dailyLockTimeout = null;
  let activeStateInterval = null;
  let dailyUsageInterval = null;
  let dailyUsageTickAt = null;
  let dailyUsageUpdateInFlight = false;
  let activeStateRefreshInFlight = false;
  let configRecheckInFlight = false;
  let configRecheckPending = false;
  let overlay = null;
  let shadowRoot = null;
  let messageEl = null;
  let timerEl = null;
  let pausedLabel = null;
  let continueBtn = null;
  let backdrop = null;
  let hoverTarget = null;
  let lastTimerText = null;
  let lastMessageText = null;
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
        .backdrop.daily-lock,
        .backdrop.daily-limit {
          background: rgba(24, 14, 10, 0.98);
        }
        .backdrop.cooldown {
          background: rgba(15, 23, 42, 0.985);
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
        .backdrop.daily-lock .breathing-circle,
        .backdrop.daily-limit .breathing-circle {
          background: rgba(249, 115, 22, 0.26);
          border-color: rgba(251, 146, 60, 0.5);
        }
        .backdrop.daily-lock .breathing-circle::after,
        .backdrop.daily-limit .breathing-circle::after {
          background: rgba(249, 115, 22, 0.28);
        }
        .backdrop.cooldown .breathing-circle {
          background: rgba(168, 85, 247, 0.26);
          border-color: rgba(192, 132, 252, 0.5);
        }
        .backdrop.cooldown .breathing-circle::after {
          background: rgba(168, 85, 247, 0.28);
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
          <div class="message" id="overlay-message">Take a moment...</div>
          <div class="timer" id="timer-display">0:00</div>
          <div class="paused-label" id="paused-label"></div>
          <button class="continue-btn" id="continue-btn">Continue</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    overlay = host;

    backdrop = shadowRoot.querySelector(".backdrop");
    messageEl = shadowRoot.getElementById("overlay-message");
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
      if (backdrop && overlayMode !== null) {
        backdrop.classList.add("visible");
      }
    });
  }

  function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ":" + String(seconds).padStart(2, "0");
  }

  function formatClockTime(timestamp) {
    if (typeof timestamp !== "number") return "the scheduled time";
    return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function updateDisplay() {
    if (!timerEl) return;

    const isDailyLock = overlayMode === "dailyLock";
    const isDailyLimit = overlayMode === "dailyLimit";
    const isCooldown = overlayMode === "cooldown";
    backdrop.classList.toggle("daily-lock", isDailyLock);
    backdrop.classList.toggle("daily-limit", isDailyLimit);
    backdrop.classList.toggle("cooldown", isCooldown);

    if (isDailyLock || isCooldown) {
      setMessageText(isCooldown ? "Cooldown until" : "Locked until");
      setTimerText(formatClockTime(dailyLockUntil));
      setTimerPaused(false);
      setPausedLabelText(
        isCooldown
          ? "All tracked sites blocked · access resumes automatically"
          : "Daily lock · access resumes automatically"
      );
      setContinueVisible(false);
      return;
    }

    if (isDailyLimit) {
      setMessageText("Daily limit reached");
      setTimerText(formatDailyLimit(dailyLimitMinutes));
      setTimerPaused(false);
      setPausedLabelText("Access resets at " + formatClockTime(dailyLockUntil));
      setContinueVisible(false);
      return;
    }

    setMessageText("Take a moment...");
    setTimerText(formatTime(remainingMs));

    const paused = remainingMs > 0 && !running;
    setTimerPaused(paused);

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

  function formatDailyLimit(minutes) {
    if (!Number.isFinite(minutes)) return "Limit reached";
    if (minutes < 60) return minutes + " min today";
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
      ? hours + (hours === 1 ? " hour today" : " hours today")
      : hours + "h " + remainingMinutes + "m today";
  }

  function setMessageText(text) {
    if (lastMessageText === text) return;

    lastMessageText = text;
    messageEl.textContent = text;
  }

  function setTimerText(text) {
    if (lastTimerText === text) return;

    lastTimerText = text;
    timerEl.textContent = text;
  }

  function setTimerPaused(paused) {
    if (lastTimerPaused === paused) return;

    lastTimerPaused = paused;
    timerEl.classList.toggle("paused", paused);
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
    const dismissedMode = overlayMode;
    const dismissedOverlay = overlay;

    clearTimerTimeout();
    clearDailyLockTimeout();
    stopActiveStatePolling();
    stopDailyUsageTracking();
    running = false;
    overlayMode = null;
    dailyLockUntil = null;

    const removeDismissedOverlay = () => {
      if (overlay === dismissedOverlay && overlayMode === null) {
        removeOverlayElement();
      }
    };

    if (backdrop) {
      backdrop.classList.remove("visible");
      // Wait for fade-out transition then remove
      backdrop.addEventListener("transitionend", removeDismissedOverlay, { once: true });
      // Fallback if transitionend doesn't fire
      setTimeout(removeDismissedOverlay, 300);
    } else {
      removeDismissedOverlay();
    }

    if (notifyDone && dismissedMode === "timer") {
      try {
        browser.runtime.sendMessage({ type: "TIMER_DONE" });
      } catch {
        // Extension context may be invalidated
      }
      startDailyUsageTracking();
    }
  }

  function removeOverlayElement() {
    if (overlay) overlay.remove();
    overlay = null;
    shadowRoot = null;
    messageEl = null;
    timerEl = null;
    pausedLabel = null;
    continueBtn = null;
    backdrop = null;
    hoverTarget = null;
    lastTimerText = null;
    lastMessageText = null;
    lastPausedLabelText = null;
    lastTimerPaused = null;
    lastContinueVisible = null;
  }

  function showOverlay(nextRemainingMs, active = backgroundActive) {
    clearTimerTimeout();
    clearDailyLockTimeout();
    stopDailyUsageTracking();

    overlayMode = "timer";
    dailyLockUntil = null;
    remainingMs = nextRemainingMs;
    backgroundActive = active !== false;
    running = false;

    if (!overlay) {
      createOverlay();
    } else {
      backdrop.classList.add("visible");
      updateHoverTargetState();
      updateDisplay();
    }

    if (remainingMs > 0) {
      startTimer();
      startActiveStatePolling();
    } else {
      stopActiveStatePolling();
    }
  }

  function showDailyLock(unlockAt) {
    showHardLock("dailyLock", unlockAt);
  }

  function showDailyLimit(resetAt, limitMinutes) {
    dailyLimitMinutes = Number.isFinite(limitMinutes) ? limitMinutes : dailyLimitMinutes;
    showHardLock("dailyLimit", resetAt);
  }

  function showCooldown(unlockAt) {
    showHardLock("cooldown", unlockAt);
  }

  function showHardLock(mode, unlockAt) {
    if (overlayMode === "timer") {
      setRunning(false, { persistPaused: true });
    } else {
      clearTimerTimeout();
    }

    clearDailyLockTimeout();
    stopActiveStatePolling();
    stopDailyUsageTracking();
    overlayMode = mode;
    dailyLockUntil = unlockAt;
    running = false;
    hoverTargetEngaged = false;
    hoverTargetPointerInside = false;
    hoverTargetPressed = false;

    if (!overlay) {
      createOverlay();
    } else {
      backdrop.classList.add("visible");
      updateHoverTargetState();
      updateDisplay();
    }

    scheduleDailyLockRelease();
  }

  function clearDailyLockTimeout() {
    if (dailyLockTimeout) {
      clearTimeout(dailyLockTimeout);
      dailyLockTimeout = null;
    }
  }

  function scheduleDailyLockRelease() {
    clearDailyLockTimeout();
    if (
      !["dailyLock", "dailyLimit", "cooldown"].includes(overlayMode) ||
      typeof dailyLockUntil !== "number"
    ) return;

    const delay = Math.max(0, dailyLockUntil - Date.now()) + 50;
    dailyLockTimeout = setTimeout(() => {
      dailyLockTimeout = null;
      recheckConfig();
    }, delay);
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
      overlayMode === "timer" &&
      remainingMs > 0 &&
      backgroundActive &&
      isPageActive() &&
      isHoverTargetSatisfied()
    );
  }

  function updateHoverTargetState() {
    if (!hoverTarget) return;

    const hoverRequired = overlayMode === "timer" && requireHoverTarget;
    hoverTarget.classList.toggle("hover-target-required", hoverRequired);
    hoverTarget.classList.toggle("hover-target-active", hoverRequired && hoverTargetEngaged);
    hoverTarget.title = overlayMode === "dailyLock"
      ? "Daily lock active"
      : overlayMode === "cooldown"
        ? "Cooldown active"
        : hoverRequired
          ? "Hover to run timer"
          : "";
  }

  function updateHoverTargetGate() {
    const nextEngaged =
      overlayMode === "timer" &&
      requireHoverTarget &&
      (hoverTargetPointerInside || hoverTargetPressed);
    if (hoverTargetEngaged !== nextEngaged) {
      hoverTargetEngaged = nextEngaged;
      updateHoverTargetState();
    }

    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setHoverTargetPointerInside(nextInside) {
    const normalized = overlayMode === "timer" && requireHoverTarget && nextInside === true;
    if (hoverTargetPointerInside === normalized) return;

    hoverTargetPointerInside = normalized;
    updateHoverTargetGate();
  }

  function setHoverTargetPressed(nextPressed) {
    const normalized = overlayMode === "timer" && requireHoverTarget && nextPressed === true;
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
      if (options.persistPaused && overlayMode === "timer") {
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
    if (overlayMode !== "timer") return;
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
    if (
      activeStateRefreshInFlight ||
      !overlay ||
      overlayMode !== "timer" ||
      remainingMs <= 0
    ) return;

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
    if (overlayMode !== "timer") return;

    try {
      browser.runtime.sendMessage({
        type: "TIMER_UPDATE",
        remainingMs: remainingMs
      });
    } catch {
      // Extension context may be invalidated
    }
  }

  // --- Daily Usage Tracking ---

  function configureDailyUsage(nextResponse) {
    dailyLimitMinutes = nextResponse && Number.isFinite(nextResponse.dailyLimitMinutes)
      ? nextResponse.dailyLimitMinutes
      : null;
    dailyUsageRemainingMs = nextResponse && Number.isFinite(nextResponse.dailyUsageRemainingMs)
      ? nextResponse.dailyUsageRemainingMs
      : null;
    dailyUsageResetAt = nextResponse && Number.isFinite(nextResponse.dailyUsageResetAt)
      ? nextResponse.dailyUsageResetAt
      : null;
  }

  function startDailyUsageTracking() {
    stopDailyUsageTracking();
    if (overlayMode !== null || dailyLimitMinutes === null) return;

    dailyUsageTickAt = Date.now();
    dailyUsageInterval = setInterval(reportDailyUsage, DAILY_USAGE_TICK_MS);
  }

  function stopDailyUsageTracking() {
    if (dailyUsageInterval) {
      clearInterval(dailyUsageInterval);
      dailyUsageInterval = null;
    }
    dailyUsageTickAt = null;
  }

  function reportDailyUsage() {
    const now = Date.now();
    const previousTickAt = dailyUsageTickAt || now;

    if (
      overlayMode !== null ||
      dailyLimitMinutes === null ||
      !isPageActive()
    ) {
      dailyUsageTickAt = now;
      return;
    }

    if (dailyUsageUpdateInFlight) return;

    const elapsedMs = Math.max(0, now - previousTickAt);
    if (elapsedMs <= 0) return;

    dailyUsageTickAt = now;
    dailyUsageUpdateInFlight = true;
    browser.runtime
      .sendMessage({
        type: "DAILY_USAGE_UPDATE",
        domain: hostname,
        elapsedMs: elapsedMs
      })
      .then((result) => {
        if (!result || result.ok !== true) return;
        dailyUsageRemainingMs = Number.isFinite(result.remainingMs)
          ? result.remainingMs
          : dailyUsageRemainingMs;
        dailyUsageResetAt = Number.isFinite(result.resetAt)
          ? result.resetAt
          : dailyUsageResetAt;
        if (result.reached) {
          showDailyLimit(result.resetAt, result.limitMinutes);
        }
      })
      .catch(() => {
        // Usage will resume when the background is available again.
      })
      .finally(() => {
        dailyUsageUpdateInFlight = false;
      });
  }

  function applyConfigResponse(nextResponse) {
    if (nextResponse && nextResponse.type === "SHOW_COOLDOWN") {
      showCooldown(nextResponse.unlockAt);
      return;
    }

    if (nextResponse && nextResponse.type === "SHOW_DAILY_LOCK") {
      configureDailyUsage(null);
      showDailyLock(nextResponse.unlockAt);
      return;
    }

    if (nextResponse && nextResponse.type === "SHOW_DAILY_LIMIT") {
      configureDailyUsage(null);
      showDailyLimit(nextResponse.resetAt, nextResponse.limitMinutes);
      return;
    }

    if (nextResponse && nextResponse.type === "SHOW_OVERLAY") {
      configureDailyUsage(nextResponse);
      setRequireHoverTarget(nextResponse.requireHoverTarget);
      showOverlay(nextResponse.remainingMs, nextResponse.active);
      return;
    }

    configureDailyUsage(nextResponse);
    dismissOverlay({ notifyDone: false });
    startDailyUsageTracking();
  }

  function recheckConfig() {
    if (configRecheckInFlight) {
      configRecheckPending = true;
      return;
    }

    configRecheckInFlight = true;
    if (overlayMode === "timer") {
      pauseTimer();
    }

    browser.runtime
      .sendMessage({
        type: "CONTENT_READY",
        domain: hostname
      })
      .then(applyConfigResponse)
      .catch(() => {
        if (["dailyLock", "dailyLimit", "cooldown"].includes(overlayMode)) {
          clearDailyLockTimeout();
          dailyLockTimeout = setTimeout(recheckConfig, 5000);
        }
      })
      .finally(() => {
        configRecheckInFlight = false;
        if (configRecheckPending) {
          configRecheckPending = false;
          recheckConfig();
        }
      });
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
      configureDailyUsage(message);
      setRequireHoverTarget(message.requireHoverTarget);
      showOverlay(message.remainingMs, message.active);
    } else if (message.type === "SHOW_DAILY_LOCK") {
      showDailyLock(message.unlockAt);
    } else if (message.type === "SHOW_DAILY_LIMIT") {
      showDailyLimit(message.resetAt, message.limitMinutes);
    } else if (message.type === "SHOW_COOLDOWN") {
      showCooldown(message.unlockAt);
    } else if (message.type === "RECHECK_CONFIG") {
      recheckConfig();
    }
  });

  // --- Extension Toggle Listener ---

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.enabled) {
      recheckConfig();
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

    if (areaName === "local" && changes.cooldownUntil) {
      recheckConfig();
    }
  });

  // --- Start ---

  if (shouldShowCooldown) {
    showCooldown(response.unlockAt);
  } else if (shouldShowTimer) {
    showOverlay(response.remainingMs, response.active);
  } else if (shouldShowDailyLock) {
    showDailyLock(response.unlockAt);
  } else if (shouldShowDailyLimit) {
    showDailyLimit(response.resetAt, response.limitMinutes);
  } else {
    startDailyUsageTracking();
  }
})();
