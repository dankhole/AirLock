// Public, logged-out smoke checks only. These do not establish authenticated-site compatibility.
// Run after `npm run build`; every run creates and removes its own Chromium profile.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "store/test-artifacts/public-sites");

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "airlock-public-sites-"));
  fs.mkdirSync(artifacts, { recursive: true });
  let context;
  const results = [];
  try {
    const extension = path.join(root, "dist/chrome");
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const workerUrl = new URL(worker.url());
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;
    const options = await context.newPage();
    await options.goto(`${extensionOrigin}/options/options.html`);
    await options.locator("#short-form-preset").click();
    await options.locator("#confirm-dialog-submit").click();
    await options.waitForFunction(async () => {
      const state = await browser.runtime.sendMessage({ type: "GET_SETTINGS_STATE" });
      return state.ok && state.config.contentControls.youtube.hideShorts && state.config.contentControls.instagram.blockReels;
    });
    const sites = [
      ["youtube", "https://www.youtube.com/"],
      ["facebook", "https://www.facebook.com/"],
      ["instagram", "https://www.instagram.com/"],
    ];
    for (const [site, url] of sites) {
      const page = await context.newPage();
      const extensionErrors = [];
      page.on("pageerror", error => { if (/airlock|chrome-extension:/i.test(error.stack || error.message)) extensionErrors.push(error.message); });
      const result = { site, requestedUrl: url, browser: context.browser().version(), loggedIn: false, compatibilityScope: "public logged-out page only" };
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
        result.status = response && response.status();
        await page.waitForTimeout(4000);
        Object.assign(result, await page.evaluate(() => ({
          url: location.href, title: document.title,
          bodyTextLength: document.body?.innerText.length || 0,
          mainCount: document.querySelectorAll("main,[role=main]").length,
          loginControlCount: [...document.querySelectorAll("a,button,input")].filter(element => /log ?in|sign ?in/i.test(element.getAttribute("aria-label") || element.textContent || element.getAttribute("placeholder") || "")).length,
          hiddenCount: document.querySelectorAll("[data-airlock-hidden]").length,
          overlayCount: document.querySelectorAll("airlock-overlay").length,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        })));
        result.extensionErrors = extensionErrors;
        assert.equal(result.overlayCount, 0, "untracked public site must have no core wait gate");
        assert.ok(result.bodyTextLength > 0, "public response has readable page content");
        assert.deepEqual(extensionErrors, [], "no observed Airlock page errors");
        result.outcome = result.status >= 400 ? "limited-http-response" : "passed-public-smoke";
        await page.screenshot({ path: path.join(artifacts, `${site}-logged-out.png`), fullPage: false });
      } catch (error) {
        result.outcome = "blocked-or-failed";
        result.error = error.message.split("\n")[0];
      } finally {
        results.push(result);
        await page.close();
      }
    }
    fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(results, null, 2));
    if (results.some(result => result.outcome === "blocked-or-failed")) process.exitCode = 1;
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
