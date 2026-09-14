const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkVersion, bumpVersion, prepareFirefox } = require("../scripts/release.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airlock-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "firefox"));
  const files = {
    "package.json": { version: "1.0.12" },
    "package-lock.json": { version: "1.0.12", packages: { "": { version: "1.0.12" } } },
    "manifest.json": { version: "1.0.12" },
    "firefox/manifest.json": {
      version: "1.0.12",
      browser_specific_settings: { gecko: { id: "airlock@dankhole" } },
    },
  };
  for (const [file, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  }
  for (const directory of ["background", "content", "popup", "shared", "icons"]) {
    fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, directory, "source.txt"), `authored ${directory}\n`);
  }
  return root;
}

test("version bumps keep both browser manifests and npm metadata synchronized", (t) => {
  for (const [increment, expected] of [["patch", "1.0.13"], ["minor", "1.1.0"], ["major", "2.0.0"]]) {
    const root = fixture(t);
    assert.equal(bumpVersion(root, increment), expected);
    assert.equal(checkVersion(root, `v${expected}`), expected);
  }
});

test("release tags and mismatched version files fail before packaging", (t) => {
  const root = fixture(t);
  for (const tag of ["v1.0.11", "1.0.12", "v1.0.12-beta", ""]) {
    assert.throws(() => prepareFirefox(root, tag), /Release tag/);
  }
  assert.equal(fs.existsSync(path.join(root, "store")), false);
  fs.writeFileSync(path.join(root, "manifest.json"), '{"version":"1.0.11"}');
  assert.throws(() => bumpVersion(root, "patch"), /manifest.json does not match/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version, "1.0.12");
});

test("lockfile root package version must also match", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    version: "1.0.12", packages: { "": { version: "1.0.11" } },
  }));
  assert.throws(() => checkVersion(root), /package-lock.json does not match/);
});

test("Firefox staging preserves authored files and drops hidden and stale files", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "popup", ".DS_Store"), "exclude");
  const staging = path.join(root, "store", "firefox-source");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "stale.js"), "exclude");
  const notes = 'Fix "pause" behavior.\nSecond line with `code` and $literal.';
  prepareFirefox(root, "v1.0.12", notes);
  assert.deepEqual(fs.readdirSync(staging).sort(), ["background", "content", "icons", "manifest.json", "popup", "shared"]);
  assert.deepEqual(fs.readFileSync(path.join(staging, "manifest.json")), fs.readFileSync(path.join(root, "firefox", "manifest.json")));
  assert.deepEqual(fs.readdirSync(path.join(staging, "popup")), ["source.txt"]);
  assert.equal(fs.readFileSync(path.join(staging, "popup", "source.txt"), "utf8"), "authored popup\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "store", "amo-metadata.json"))), {
    version: { release_notes: { "en-US": notes } },
  });
});

test("a different add-on ID is rejected before preparing a submission", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "firefox", "manifest.json"), '{"version":"1.0.12"}');
  assert.throws(() => prepareFirefox(root), /existing airlock@dankhole/);
  assert.equal(fs.existsSync(path.join(root, "store")), false);
});
