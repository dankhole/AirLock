const assert = require("node:assert/strict");
const { poll } = require("./driver");

async function runContentSwitchChecks(browser, options, page, t) {
  const read = () => browser.evaluate(options, async () => browser.runtime.sendMessage({ type: "GET_SETTINGS_STATE" }));
  const before = await read();
  assert.equal(before.config.settingsDelayMinutes, 0);
  const site = "youtube.com";
  const fixtureUrl = "https://www.youtube.com/";
  async function request(patch) {
    const state = await read();
    const result = await browser.evaluate(options, async message => browser.runtime.sendMessage(message), {
      type: "REQUEST_CONFIG_CHANGE", expectedRevision: state.revision, patch
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    return result;
  }
  async function toggle(id, key, value) {
    await browser.focus(options);
    await browser.click(options, '.settings-nav a[href="#general"]');
    await poll(() => browser.evaluate(options, () => !document.getElementById("general").hidden), Boolean, "General panel visible");
    assert.equal(await browser.evaluate(options, id => document.getElementById(id).checked, id), !value);
    await browser.click(options, "#" + id);
    await poll(() => browser.evaluate(options, () => document.getElementById("confirm-dialog").open), Boolean, key + " confirmation");
    const unchanged = await read();
    assert.equal(unchanged.config[key], !value, "switch waits for its own confirmation");
    await browser.click(options, "#confirm-dialog-submit");
    return poll(read, state => state.config[key] === value && !state.pending, key + " saved");
  }
  const hidden = value => poll(() => browser.evaluate(page, () => getComputedStyle(document.getElementById("short-card")).display === "none"), state => state === value, "content visibility " + value);
  try {
    await browser.goto(page, fixtureUrl);
    await request({ enabled: true, contentControlsEnabled: true, contentControls: { youtube: { hideShorts: true, shortsRoute: "watch" } } });
    await hidden(true);
    await toggle("enabled-toggle", "enabled", false);
    await hidden(true);
    assert.equal((await read()).config.contentControlsEnabled, true, "site switch leaves content switch on");
    await browser.goto(page, fixtureUrl + "shorts/abcdefghijk");
    await poll(() => browser.evaluate(page, () => location.pathname), path => path === "/watch", "content redirect works with site restrictions off");
    await toggle("content-controls-toggle", "contentControlsEnabled", false);
    await hidden(false);
    assert.equal((await read()).config.contentControls.youtube.hideShorts, true, "content off preserves saved rules");
    await toggle("enabled-toggle", "enabled", true);
    await hidden(false);
    await request({ siteWaitEnabled: { [site]: true } });
    await browser.goto(page, fixtureUrl + "shorts/abcdefghijk");
    await poll(() => browser.evaluate(page, () => Boolean(document.querySelector("airlock-overlay"))), Boolean, "site wait still enforces with content off");
    assert.equal(await browser.evaluate(page, () => location.pathname), "/shorts/abcdefghijk");
    await toggle("content-controls-toggle", "contentControlsEnabled", true);
    await hidden(true);
    assert.equal(await browser.evaluate(page, () => location.pathname), "/shorts/abcdefghijk", "content redirect still respects active core wait");
    await toggle("enabled-toggle", "enabled", false);
    await poll(() => browser.evaluate(page, () => location.pathname), path => path === "/watch", "separate site switch clears wait and allows content redirect");
    t.diagnostic("Independent masters: site off preserves filters/routes, content off restores saved rules without disabling site waits, and restored content redirects respect core gates");
  } finally {
    await request({ enabled: before.config.enabled, contentControlsEnabled: before.config.contentControlsEnabled,
      siteWaitEnabled: { [site]: before.config.siteWaitEnabled[site] ?? null },
      contentControls: { youtube: before.config.contentControls.youtube } });
    await browser.goto(page, fixtureUrl);
  }
}
module.exports = { runContentSwitchChecks };
