// Render the authored popup at native panel sizes with an explicitly mocked
// browser authority. This verifies layout and UI commands, not live-site behavior.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const controls = require("../shared/content-controls");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "store/test-artifacts/popup-layout");
const origin = "http://airlock.test";

function snapshot(name) {
  const tracked = !name.includes("untracked");
  const domain = name.includes("long") ? "a-very-long-subdomain.for-a-carefully-configured.example.com" : "youtube.com";
  const config = { enabled: true, sites: tracked ? [domain] : [], siteWaitEnabled: {}, siteTrackingEnabled: {},
    settingsDelayMinutes: 1, delayMinutes: 2, dailyLimits: { [domain]: 45 }, dailyLimitPolicies: {},
    cooldownUntil: name === "cooldown" ? Date.now() + 3600000 : null, contentControls: controls.getDefaults() };
  if (name === "paused") config.siteTrackingEnabled[domain] = false;
  if (name === "rules-on" || /runtime|settings-loading|gated/.test(name)) config.contentControls.youtube.hideShorts = true;
  const result = { ok: true, revision: 1, config, pending: null, contentControlsSupported: true,
    usage: { sites: { [domain]: 720000 } }, domain,
    currentSiteStatus: { domain, site: tracked ? domain : null, reason: name === "paused" ? "paused" : tracked ? "allowed" : "untracked", dailyLimitMode: "cooldown", dailyLimitMinutes: tracked ? 45 : null, allowanceUsedMs: 720000 } };
  if (name.includes("pending")) result.pending = { id: "layout-pending", remainingMs: 60000,
    description: "Turn off Restrictions and update site settings",
    patch: { enabled: false, contentControls: { instagram: { blockReels: true, blockExplore: true, hideHomeFeed: true, hideComments: true, hideMetrics: true, hideVideos: true, hideImages: true, hideThreads: true } } } };
  if (name === "cooldown") Object.assign(result.currentSiteStatus, { reason: "cooldown", unlockAt: config.cooldownUntil });
  return result;
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const results = [];
  try {
    for (const width of [300, 360, 400]) {
      for (const name of ["tracked", "untracked", "pending-tracked", "pending-untracked", "paused", "cooldown", "long", "unavailable", "untracked-unavailable", "pending-long", "rules-on", "runtime-missing", "runtime-failed", "settings-loading", "gated", "pending-runtime-missing", "pending-runtime-failed"]) {
        const page = await browser.newPage({ viewport: { width, height: 600 } });
        await page.route(`${origin}/**`, async route => {
          const relative = new URL(route.request().url()).pathname.replace(/^\//, "");
          const file = path.resolve(root, relative);
          if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "Missing fixture asset" });
          const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : "text/html";
          await route.fulfill({ contentType, body: fs.readFileSync(file) });
        });
        await page.addInitScript(({ initial, name, origin }) => {
          window.__state = initial;
          window.__commands = [];
          const listeners = new Set();
          window.browser = {
            runtime: { getURL: file => origin + "/" + file, async sendMessage(message) {
              window.__commands.push(message);
              if (message.type === "REQUEST_CONFIG_CHANGE") {
                for (const [key, value] of Object.entries(message.patch)) {
                  if (key === "siteTrackingEnabled") Object.entries(value).forEach(([site, enabled]) => { if (enabled === null) delete initial.config[key][site]; else initial.config[key][site] = enabled; });
                  else initial.config[key] = value;
                }
                initial.revision++;
                initial.applied = true;
                initial.currentSiteStatus.reason = initial.config.siteTrackingEnabled[initial.domain] === false ? "paused" : "allowed";
              }
              if (message.type === "CANCEL_PENDING_CONFIG_CHANGE") initial.pending = null;
              return structuredClone(initial);
            } },
            tabs: { async query() { return [{ id: 7, url: "https://" + initial.domain + "/" }]; }, async sendMessage() {
              if (name.includes("unavailable")) return null;
              const state = { ok: true, ready: true, coreMode: name === "cooldown" ? "cooldown" : name === "gated" ? "timer" : "none" };
              if (name.includes("runtime-missing")) state.runtimeStatus = null;
              if (name.includes("runtime-failed")) state.runtimeStatus = { initialized: true, active: false, failure: "Adapter failed" };
              if (name === "settings-loading") state.runtimeStatus = { initialized: false, active: false, failure: null };
              if (name === "gated") state.runtimeStatus = { initialized: true, active: true, failure: null, navigationPending: false };
              return state;
            } },
            permissions: { async contains() { return true; } },
            storage: { onChanged: { addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); } } },
          };
        }, { initial: snapshot(name), name, origin });
        await page.goto(`${origin}/popup/popup.html`);
        await page.waitForFunction(() => document.getElementById("current-site-title").textContent !== "Checking this tab…");
        await page.waitForTimeout(100);
        async function assertFits(label) {
          const geometry = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, contentHeight: document.querySelector(".popup").getBoundingClientRect().height, width: document.documentElement.scrollWidth, viewportWidth: innerWidth,
            holdBottom: document.getElementById("pending-config-section").hidden ? null : document.getElementById("pending-config-hover-target").getBoundingClientRect().bottom,
            cooldownBottom: document.getElementById("cooldown-btn").getBoundingClientRect().bottom }));
          assert.ok(geometry.height <= 600, `${label} vertical overflow: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.width <= width, `${label} horizontal overflow: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.cooldownBottom <= 600 && (geometry.holdBottom === null || geometry.holdBottom <= 600), `${label} quick actions remain visible`);
          results.push({ name: label, width, ...geometry });
        }
        await assertFits(name);
        await page.locator("#current-rules-status").waitFor({ state: "visible" });
        if (name === "tracked") assert.equal(await page.locator("#current-rules-status").textContent(), "Content rules: Off · none enabled");
        if (name.includes("runtime-missing")) assert.equal(await page.locator("#current-rules-status").textContent(), "Content rules: reload to connect");
        if (name.includes("runtime-failed")) assert.equal(await page.locator("#current-rules-status").textContent(), "Content rules: error · reload this site");
        if (name === "settings-loading") assert.match(await page.locator("#current-rules-status").textContent(), /loading settings/);
        if (name === "gated") assert.equal(await page.locator("#current-rules-status").textContent(), "Content rules: 1 enabled");
        if (name === "rules-on") assert.equal(await page.locator("#current-rules-status").textContent(), "Content rules: 1 enabled");
        await page.screenshot({ path: path.join(artifacts, `${name}-${width}.png`) });
        if (!name.includes("pending")) {
          await page.locator(".site-details summary").click();
          await assertFits(name + "-site-details");
        }
        if (name.includes("pending")) {
          await page.locator(".pending-details summary").click();
          assert.equal(await page.locator(".site-details").getAttribute("open"), null, "detail disclosures are exclusive");
          await assertFits(name + "-pending-details");
          await page.screenshot({ path: path.join(artifacts, `${name}-details-${width}.png`) });
          await page.locator("#pending-config-hover-target").focus();
          await page.keyboard.down("Space");
          await page.waitForFunction(() => window.__commands.some(message => message.type === "ADVANCE_PENDING_CONFIG_CHANGE"));
          await page.keyboard.up("Space");
          await page.locator("#pending-config-cancel").click();
          await page.waitForFunction(() => document.getElementById("pending-config-section").hidden);
          await assertFits(name + "-cancelled");
        } else if (name === "tracked" || name === "paused") {
          await page.locator("#current-tracking-btn").click();
          await page.waitForFunction(() => document.getElementById("confirm-dialog").open);
          assert.equal(await page.locator("#confirm-dialog-cancel").evaluate(element => element === document.activeElement), true);
          await page.screenshot({ path: path.join(artifacts, `${name}-confirm-${width}.png`) });
          await page.locator("#confirm-dialog-submit").click();
          const request = await page.waitForFunction(() => window.__commands.find(message => message.type === "REQUEST_CONFIG_CHANGE"));
          assert.deepEqual((await request.jsonValue()).patch, { siteTrackingEnabled: { "youtube.com": name === "paused" ? null : false } });
          await page.waitForFunction(() => document.activeElement.id === "current-tracking-btn");
          assert.equal(await page.locator("#current-tracking-btn").textContent(), name === "paused" ? "Pause tracking" : "Resume tracking");
        }
        await page.close();
      }
    }
    fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`${results.length} popup layout states passed at 300/360/400 × 600; pause/resume confirmation and pending keyboard/cancel passed.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
