// Airlock - Content Script
// Injects delay overlay with countdown timer and breathing animation.
// Timer only ticks while tab is visible and window is focused.

(async function () {
  const hostname = window.location.hostname;
  if (!hostname) return;

  let config;
  try {
    config = await browser.storage.local.get(["enabled", "sites"]);
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

  if (!response || response.type !== "SHOW_OVERLAY") return;

  // --- State ---
  let remainingMs = response.remainingMs;
  let running = true;
  let lastTick = Date.now();
  let timerInterval = null;
  let overlay = null;
  let shadowRoot = null;
  let timerEl = null;
  let pausedLabel = null;
  let continueBtn = null;
  let backdrop = null;

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
          background: rgba(10, 15, 30, 0.92);
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
          border-radius: 50%;
          background: radial-gradient(circle, rgba(91, 141, 239, 0.4), rgba(91, 141, 239, 0.1));
          border: 2px solid rgba(91, 141, 239, 0.3);
          animation: breathe 8s ease-in-out infinite;
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
          <div class="breathing-circle"></div>
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
    continueBtn.addEventListener("click", dismissOverlay);

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
      pausedLabel.textContent = "Paused";
    } else {
      timerEl.classList.remove("paused");
      pausedLabel.textContent = "";
    }
  }

  function dismissOverlay() {
    if (timerInterval) clearInterval(timerInterval);

    if (backdrop) {
      backdrop.classList.remove("visible");
      // Wait for fade-out transition then remove
      backdrop.addEventListener("transitionend", removeOverlayElement, { once: true });
      // Fallback if transitionend doesn't fire
      setTimeout(removeOverlayElement, 300);
    } else {
      removeOverlayElement();
    }

    try {
      browser.runtime.sendMessage({ type: "TIMER_DONE" });
    } catch {
      // Extension context may be invalidated
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
  }

  // --- Timer Logic ---

  function startTimer() {
    lastTick = Date.now();
    timerInterval = setInterval(() => {
      if (!running || remainingMs <= 0) return;

      const now = Date.now();
      const elapsed = now - lastTick;
      lastTick = now;
      remainingMs = Math.max(0, remainingMs - elapsed);

      updateDisplay();

      if (remainingMs <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        persistState();
      }
    }, 250);
  }

  function pauseTimer() {
    if (!running) return;
    running = false;
    persistState();
    updateDisplay();
  }

  function resumeTimer() {
    if (running || remainingMs <= 0) return;
    running = true;
    lastTick = Date.now();
    updateDisplay();
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
      pauseTimer();
    } else {
      resumeTimer();
    }
  });

  window.addEventListener("blur", () => pauseTimer());
  window.addEventListener("focus", () => resumeTimer());

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "PAUSE") {
      pauseTimer();
    } else if (message.type === "RESUME") {
      resumeTimer();
    }
  });

  // --- Extension Toggle Listener ---

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.enabled && changes.enabled.newValue === false) {
      dismissOverlay();
    }
  });

  // --- Start ---

  createOverlay();

  if (document.hidden) {
    running = false;
    updateDisplay();
  }

  startTimer();
})();
