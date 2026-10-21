const test = require("node:test");
const assert = require("node:assert/strict");
const controls = require("../shared/content-controls.js");

test("catalog has stable unique rules and independent all-off defaults", () => {
  const defaults = controls.getDefaults();
  assert.equal(defaults.version, 1);
  assert.equal(controls.catalog.length, 19);
  assert.equal(new Set(controls.catalog.map((item) => item.id)).size, 19);
  for (const item of controls.catalog) {
    assert.equal(item.id, `${item.platform}.${item.key}`);
    assert.equal(defaults[item.platform][item.key], item.default);
    assert.equal(item.type, typeof item.default === "boolean" ? "boolean" : "enum");
    assert.equal(Object.isFrozen(item), true);
  }
  defaults.youtube.hideShorts = true;
  assert.equal(controls.getDefaults().youtube.hideShorts, false);
  for (const platform of ["youtube", "instagram", "facebook"]) assert.equal(controls.isActive(platform, controls.getDefaults()), false);
});

test("normalization accepts only strict known values and safely disables unsupported schemas", () => {
  const raw = { version: 1, youtube: { hideShorts: "true", hideNavigation: true, shortsRoute: "WATCH", unknown: true },
    instagram: { blockReels: 1, stories: "blocked", unreadBadges: null }, facebook: { hideReels: false } };
  const normalized = controls.normalize(raw);
  assert.equal(normalized.youtube.hideShorts, false);
  assert.equal(normalized.youtube.hideNavigation, true);
  assert.equal(normalized.youtube.shortsRoute, "allow");
  assert.equal(normalized.youtube.unknown, undefined);
  assert.equal(normalized.instagram.blockReels, false);
  assert.equal(normalized.instagram.stories, "blocked");
  assert.equal(normalized.instagram.unreadBadges, "normal");
  const future = { version: 99, youtube: { hideShorts: true }, newControl: { enabled: true } };
  assert.deepEqual(controls.normalize(future), controls.getDefaults());
  assert.equal(controls.isSupported(future), false);
  assert.equal(future.version, 99);
  assert.deepEqual(controls.normalize({ version: "1", youtube: { hideShorts: true } }), controls.getDefaults());
  assert.equal(controls.isSupported({ version: "1" }), true);
});

test("platform detection requires exact hostname boundaries", () => {
  for (const [host, platform] of [["youtube.com", "youtube"], ["www.youtube.com", "youtube"], ["m.facebook.com", "facebook"], ["www.instagram.com", "instagram"]]) assert.equal(controls.getPlatform(host), platform);
  for (const host of ["youtube.com.evil.test", "evilyoutube.com", "youtube.com:443", "instagram", "https://facebook.com"]) assert.equal(controls.getPlatform(host), null);
  assert.equal(controls.isActive("youtube", { hideShorts: true }), true);
});

test("restriction ordering classifies every weakening and neutral badge appearance", () => {
  for (const item of controls.catalog.filter((entry) => entry.type === "boolean")) {
    assert.equal(controls.classifyPatch({ [item.platform]: { [item.key]: true } }, { [item.platform]: { [item.key]: false } }), "weaker", item.id);
    assert.equal(controls.classifyPatch(controls.getDefaults(), { [item.platform]: { [item.key]: true } }), "stronger", item.id);
  }
  for (const [from, to, expected] of [["show", "home-hidden", "stronger"], ["home-hidden", "blocked", "stronger"], ["blocked", "home-hidden", "weaker"], ["home-hidden", "show", "weaker"]]) assert.equal(controls.classifyPatch({ instagram: { stories: from } }, { instagram: { stories: to } }), expected);
  for (const [from, to, expected] of [["normal", "subdued", "same"], ["subdued", "normal", "same"], ["subdued", "hidden", "stronger"], ["hidden", "subdued", "weaker"], ["following", "messages", "weaker"], ["messages", "following", "weaker"]]) {
    const key = ["following", "messages"].includes(from) ? "homeDestination" : "unreadBadges";
    assert.equal(controls.classifyPatch({ instagram: { [key]: from } }, { instagram: { [key]: to } }), expected);
  }
});

test("catalog validation rejects arbitrary fields and presets contain exactly their stated changes", () => {
  assert.equal(controls.validatePatch({ youtube: { hideShorts: true } }), true);
  for (const patch of [[], { youtube: { hideShorts: "true" } }, { instagram: { stories: "no" } }, { fake: {} }, { youtube: { enabled: false } }, { version: 99 }]) assert.equal(controls.validatePatch(patch), false);
  const preset = controls.getPreset("short-form");
  assert.deepEqual(preset, { contentControls: { youtube: { hideShorts: true, hideNavigation: true, shortsRoute: "watch" }, instagram: { blockReels: true }, facebook: { hideReels: true, reelsRoute: "home" } } });
  preset.contentControls.youtube.hideShorts = false;
  assert.equal(controls.getPreset("short-form").contentControls.youtube.hideShorts, true);
  assert.deepEqual(controls.getPreset("instagram-inbox"), { contentControls: { instagram: { homeDestination: "messages", blockReels: true, blockExplore: true } } });
  assert.equal(controls.getPreset("unknown"), null);
});
