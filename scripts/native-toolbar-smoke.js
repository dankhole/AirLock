// Open the real Firefox browser-action popup using a trusted toolbar pointer click.
// WebDriver cannot select Firefox's XUL popup browser as a content frame; this
// bounded check verifies native panel creation/size and records that limitation.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Builder, By } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const { createFixtureProxy } = require("../browser-tests/fixture-proxy");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "store/test-artifacts/native-firefox");

async function main() {
  const { download } = await import("geckodriver");
  const executable = await download("0.36.0");
  const proxy = await createFixtureProxy();
  fs.mkdirSync(artifacts, { recursive: true });
  let driver;
  try {
    const options = new firefox.Options().setBinary(process.env.AIRLOCK_FIREFOX_BINARY || "/Applications/Firefox.app/Contents/MacOS/firefox")
      .addArguments("-headless", "-remote-allow-system-access").setAcceptInsecureCerts(true)
      .setPreference("network.proxy.type", 1).setPreference("network.proxy.http", "127.0.0.1").setPreference("network.proxy.http_port", proxy.port)
      .setPreference("network.proxy.ssl", "127.0.0.1").setPreference("network.proxy.ssl_port", proxy.port).setPreference("network.proxy.no_proxies_on", "");
    // Selenium creates and removes a fresh Firefox profile; no personal profile is opened.
    driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder(executable)).build();
    await driver.manage().window().setRect({ width: 1280, height: 1000 });
    const addon = await driver.installAddon(process.env.AIRLOCK_FIREFOX_ADDON || path.join(root, "dist/firefox"), true);
    await driver.get("https://www.youtube.com/");
    await driver.setContext(firefox.Context.CHROME);
    const widget = addon.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";
    await driver.executeScript("window.CustomizableUI.addWidgetToArea(arguments[0],window.CustomizableUI.AREA_NAVBAR)", widget);
    await driver.sleep(700);
    const button = await driver.findElement(By.css(`#${widget} .webextension-browser-action`));
    await driver.actions().move({ origin: button }).press().release().perform();
    await driver.wait(async () => driver.executeScript('return document.getElementById("customizationui-widget-panel")?.state === "open"'), 10000);
    await driver.sleep(600);
    const bounds = await driver.executeScript(`
      const panel=document.getElementById("customizationui-widget-panel"),browser=panel.querySelector("browser");
      const size=element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height});
      return {state:panel.state,panel:size(panel),popupBrowser:size(browser),popupUrl:browser.currentURI.spec,remote:browser.isRemoteBrowser};
    `);
    assert.equal(bounds.state, "open");
    assert.match(bounds.popupUrl, /^moz-extension:\/\/[^/]+\/popup\/popup\.html$/, "native browser loaded Airlock popup");
    assert.ok(bounds.popupBrowser.width > 0 && bounds.popupBrowser.width <= 800);
    assert.ok(bounds.popupBrowser.height > 0 && bounds.popupBrowser.height <= 600, "native popup respects Firefox's 600px height cap");
    let limitation;
    try {
      await driver.switchTo().frame(await driver.findElement(By.css("#customizationui-widget-panel browser")));
      throw new Error("Popup frame unexpectedly became addressable; extend this check with content assertions.");
    } catch (error) {
      if (!/Unable to locate frame/.test(error.message)) throw error;
      limitation = error.message.split("\n")[0];
    }
    const report = {
      browser: `Firefox ${(await driver.getCapabilities()).get("browserVersion")}`,
      addon, fixture: "synthetic HTTPS www.youtube.com", nativeToolbarPointerClick: true, ...bounds,
      outcome: "passed-native-panel-geometry-only",
      unavailableChecks: ["popup DOM/current-site status", "Track confirmation", "Settings link", "popup scrolling/keyboard", "activeTab URL access assertion"],
      limitation,
      screenshotLimitation: "Headless Firefox's window screenshot omits the separate native popup; no popup screenshot is claimed.",
    };
    fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (driver) await driver.quit();
    await proxy.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
