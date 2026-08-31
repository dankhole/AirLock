// Airlock - Content Script
// Injects wait and daily-lock overlays for tracked sites.
// Wait timers only tick while the tab is visible and window is focused.

(async function () {
  const TIMER_TICK_MS = 250;
  const DAILY_USAGE_TICK_MS = 1000;
  const MOVING_TARGET_SPEED_X = 38;
  const MOVING_TARGET_SPEED_Y = 29;
  const MOVING_TARGET_VIEWPORT_PADDING = 16;

  const hostname = window.location.hostname;
  if (!hostname) return;

  let config;
  try {
    config = await browser.storage.local.get([
      "enabled",
      "sites",
      "movingTargetEnabled"
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
    dailyLimitMinutes: null,
    dailyLimitMode: "block",
    dailyUsageRemainingMs: null,
    dailyUsageResetAt: null
  };

  if (initiallyTracked) {
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
  let dailyLimitMode = response && response.dailyLimitMode === "cooldown"
    ? "cooldown"
    : "block";
  let dailyUsageRemainingMs = response && Number.isFinite(response.dailyUsageRemainingMs)
    ? response.dailyUsageRemainingMs
    : null;
  let dailyUsageResetAt = response && Number.isFinite(response.dailyUsageResetAt)
    ? response.dailyUsageResetAt
    : null;
  let backgroundActive = response ? response.active !== false : false;
  let movingTargetEnabled = config.movingTargetEnabled === true;
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
  let dailyUsageTrackingEnabled = initiallyTracked;
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
  let hoverTargetSlot = null;
  let movingTargetFrame = null;
  let movingTargetLastFrameAt = null;
  let movingTargetOffsetX = 0;
  let movingTargetOffsetY = 0;
  let movingTargetVelocityX = MOVING_TARGET_SPEED_X;
  let movingTargetVelocityY = MOVING_TARGET_SPEED_Y;
  const reducedMotionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  let lastTimerText = null;
  let lastMessageText = null;
  let lastPausedLabelText = null;
  let lastTimerPaused = null;
  let lastContinueVisible = null;

  // --- Create Overlay ---

  function createOverlay() {
    // Extension reloads or duplicate content-script injection can leave a host
    // owned by an invalidated script context. Keep the DOM overlay a singleton
    // so a stale, non-interactive layer cannot remain underneath the new one.
    document.querySelectorAll("airlock-overlay").forEach((existingOverlay) => {
      existingOverlay.remove();
    });

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
          contain: layout style;
          user-select: none;
        }
        .hover-target-slot {
          width: 168px;
          height: 168px;
          flex: 0 0 auto;
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
        .hover-target.moving {
          z-index: 1;
          will-change: transform;
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
          <div class="hover-target-slot" id="hover-target-slot">
            <div class="hover-target" id="hover-target" title="Hover to run timer">
              <div class="breathing-circle"></div>
            </div>
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
    hoverTargetSlot = shadowRoot.getElementById("hover-target-slot");
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
    syncMovingTargetAnimation();

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
      const isLimitCooldown = dailyLimitMode === "cooldown";
      setMessageText(isLimitCooldown ? "Site cooldown until" : "Daily limit reached");
      setTimerText(
        isLimitCooldown ? formatClockTime(dailyLockUntil) : formatDailyLimit(dailyLimitMinutes)
      );
      setTimerPaused(false);
      setPausedLabelText(
        isLimitCooldown
          ? "Site usage resets when the cooldown ends"
          : "Access resets at " + formatClockTime(dailyLockUntil)
      );
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
    if (!isHoverTargetSatisfied() && backgroundActive && isPageActive()) {
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
    stopMovingTargetAnimation();
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
    hoverTargetSlot = null;
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

  function showDailyLimit(resetAt, limitMinutes, limitMode = "block") {
    dailyLimitMinutes = Number.isFinite(limitMinutes) ? limitMinutes : dailyLimitMinutes;
    dailyLimitMode = limitMode === "cooldown" ? "cooldown" : "block";
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
    return hoverTargetEngaged;
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

    const hoverRequired = overlayMode === "timer";
    hoverTarget.classList.toggle("hover-target-required", hoverRequired);
    hoverTarget.classList.toggle("hover-target-active", hoverRequired && hoverTargetEngaged);
    hoverTarget.title = overlayMode === "dailyLock"
      ? "Daily lock active"
      : overlayMode === "cooldown"
        ? "Cooldown active"
        : hoverRequired
          ? "Hover to run timer"
          : "";
    syncMovingTargetAnimation();
  }

  function shouldAnimateMovingTarget() {
    return Boolean(
      movingTargetEnabled &&
      (!reducedMotionQuery || !reducedMotionQuery.matches) &&
      overlay &&
      hoverTarget &&
      hoverTargetSlot &&
      overlayMode === "timer" &&
      remainingMs > 0
    );
  }

  function syncMovingTargetAnimation() {
    if (!shouldAnimateMovingTarget()) {
      stopMovingTargetAnimation();
      return;
    }

    if (movingTargetFrame !== null) return;
    hoverTarget.classList.add("moving");
    movingTargetLastFrameAt = null;
    movingTargetFrame = requestAnimationFrame(runMovingTargetFrame);
  }

  function stopMovingTargetAnimation() {
    if (movingTargetFrame !== null) {
      cancelAnimationFrame(movingTargetFrame);
      movingTargetFrame = null;
    }
    movingTargetLastFrameAt = null;
    movingTargetOffsetX = 0;
    movingTargetOffsetY = 0;
    movingTargetVelocityX = MOVING_TARGET_SPEED_X;
    movingTargetVelocityY = MOVING_TARGET_SPEED_Y;
    if (hoverTarget) {
      hoverTarget.classList.remove("moving");
      hoverTarget.style.transform = "";
    }
  }

  function runMovingTargetFrame(timestamp) {
    movingTargetFrame = null;
    if (!shouldAnimateMovingTarget()) {
      stopMovingTargetAnimation();
      return;
    }

    if (movingTargetLastFrameAt !== null) {
      const elapsedSeconds = Math.min(0.1, Math.max(0, timestamp - movingTargetLastFrameAt) / 1000);
      const bounds = getMovingTargetBounds();
      const horizontal = advanceBouncingAxis(
        movingTargetOffsetX,
        movingTargetVelocityX,
        elapsedSeconds,
        bounds.minX,
        bounds.maxX
      );
      const vertical = advanceBouncingAxis(
        movingTargetOffsetY,
        movingTargetVelocityY,
        elapsedSeconds,
        bounds.minY,
        bounds.maxY
      );
      movingTargetOffsetX = horizontal.position;
      movingTargetVelocityX = horizontal.velocity;
      movingTargetOffsetY = vertical.position;
      movingTargetVelocityY = vertical.velocity;
      hoverTarget.style.transform =
        "translate3d(" + movingTargetOffsetX.toFixed(2) + "px, " +
        movingTargetOffsetY.toFixed(2) + "px, 0)";
    }

    movingTargetLastFrameAt = timestamp;
    movingTargetFrame = requestAnimationFrame(runMovingTargetFrame);
  }

  function getMovingTargetBounds() {
    const rect = hoverTargetSlot.getBoundingClientRect();
    const minX = MOVING_TARGET_VIEWPORT_PADDING - rect.left;
    const maxX = window.innerWidth - MOVING_TARGET_VIEWPORT_PADDING - rect.right;
    const minY = MOVING_TARGET_VIEWPORT_PADDING - rect.top;
    const maxY = window.innerHeight - MOVING_TARGET_VIEWPORT_PADDING - rect.bottom;
    const horizontalMidpoint = (minX + maxX) / 2;
    const verticalMidpoint = (minY + maxY) / 2;

    return {
      minX: minX <= maxX ? minX : horizontalMidpoint,
      maxX: minX <= maxX ? maxX : horizontalMidpoint,
      minY: minY <= maxY ? minY : verticalMidpoint,
      maxY: minY <= maxY ? maxY : verticalMidpoint
    };
  }

  function advanceBouncingAxis(position, velocity, elapsedSeconds, min, max) {
    if (max <= min) return { position: min, velocity: velocity };

    let nextPosition = Math.min(max, Math.max(min, position)) + velocity * elapsedSeconds;
    let nextVelocity = velocity;

    while (nextPosition < min || nextPosition > max) {
      if (nextPosition > max) {
        nextPosition = max - (nextPosition - max);
        nextVelocity = -Math.abs(nextVelocity);
      } else {
        nextPosition = min + (min - nextPosition);
        nextVelocity = Math.abs(nextVelocity);
      }
    }

    return { position: nextPosition, velocity: nextVelocity };
  }

  function updateHoverTargetGate() {
    const nextEngaged =
      overlayMode === "timer" &&
      (hoverTargetPointerInside || hoverTargetPressed);
    if (hoverTargetEngaged !== nextEngaged) {
      hoverTargetEngaged = nextEngaged;
      updateHoverTargetState();
    }

    setRunning(canRunTimer(), { persistPaused: true });
    updateDisplay();
  }

  function setHoverTargetPointerInside(nextInside) {
    const normalized = overlayMode === "timer" && nextInside === true;
    if (hoverTargetPointerInside === normalized) return;

    hoverTargetPointerInside = normalized;
    updateHoverTargetGate();
  }

  function setHoverTargetPressed(nextPressed) {
    const normalized = overlayMode === "timer" && nextPressed === true;
    if (hoverTargetPressed === normalized) return;

    hoverTargetPressed = normalized;
    updateHoverTargetGate();
  }

  function resetHoverTargetGate() {
    hoverTargetPointerInside = false;
    hoverTargetPressed = false;
    updateHoverTargetGate();
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
    dailyLimitMode = nextResponse && nextResponse.dailyLimitMode === "cooldown"
      ? "cooldown"
      : "block";
    dailyUsageRemainingMs = nextResponse && Number.isFinite(nextResponse.dailyUsageRemainingMs)
      ? nextResponse.dailyUsageRemainingMs
      : null;
    dailyUsageResetAt = nextResponse && Number.isFinite(nextResponse.dailyUsageResetAt)
      ? nextResponse.dailyUsageResetAt
      : null;
  }

  function startDailyUsageTracking() {
    stopDailyUsageTracking();
    if (!dailyUsageTrackingEnabled || overlayMode !== null) return;

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
      document.visibilityState !== "visible" ||
      document.hidden ||
      !backgroundActive
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
          showDailyLimit(result.resetAt, result.limitMinutes, result.dailyLimitMode);
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
      showDailyLimit(nextResponse.resetAt, nextResponse.limitMinutes, nextResponse.dailyLimitMode);
      return;
    }

    if (nextResponse && nextResponse.type === "SHOW_OVERLAY") {
      configureDailyUsage(nextResponse);
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

  if (reducedMotionQuery) {
    const handleReducedMotionChange = () => {
      resetHoverTargetGate();
      syncMovingTargetAnimation();
    };
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
    } else if (typeof reducedMotionQuery.addListener === "function") {
      reducedMotionQuery.addListener(handleReducedMotionChange);
    }
  }

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
      showOverlay(message.remainingMs, message.active);
    } else if (message.type === "SHOW_DAILY_LOCK") {
      showDailyLock(message.unlockAt);
    } else if (message.type === "SHOW_DAILY_LIMIT") {
      showDailyLimit(message.resetAt, message.limitMinutes, message.dailyLimitMode);
    } else if (message.type === "SHOW_COOLDOWN") {
      showCooldown(message.unlockAt);
    } else if (message.type === "RECHECK_CONFIG") {
      recheckConfig();
    }
  });

  // --- Extension Toggle Listener ---

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.movingTargetEnabled) {
      movingTargetEnabled = changes.movingTargetEnabled.newValue === true;
      resetHoverTargetGate();
      syncMovingTargetAnimation();
    }

    if (areaName === "local" && changes.enabled) {
      recheckConfig();
    }

    if (areaName === "local" && changes.sites) {
      const nextSites = changes.sites.newValue || [];
      const stillTracked = nextSites.some(
        (site) => hostname === site || hostname.endsWith("." + site)
      );
      dailyUsageTrackingEnabled = stillTracked;
      if (!stillTracked) {
        dismissOverlay({ notifyDone: false });
      } else {
        recheckConfig();
      }
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
    showDailyLimit(response.resetAt, response.limitMinutes, response.dailyLimitMode);
  } else {
    startDailyUsageTracking();
  }
})();
