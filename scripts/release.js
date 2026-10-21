const fs = require("node:fs");
const path = require("node:path");
const { collectPackageFiles, copyPackageFiles } = require("./package-files.js");

const rootDir = path.resolve(__dirname, "..");
const versionFiles = ["package.json", "package-lock.json", "manifest.json", "firefox/manifest.json"];

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(root, file, value) {
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
}

function checkVersion(root, tag) {
  const version = readJson(root, "package.json").version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable major.minor.patch version, received ${version}`);
  }
  for (const file of versionFiles) {
    const data = readJson(root, file);
    if (data.version !== version || (file === "package-lock.json" && data.packages[""].version !== version)) {
      throw new Error(`${file} does not match package.json version ${version}`);
    }
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must match v${version}`);
  }
  return version;
}

function bumpVersion(root, increment) {
  const version = checkVersion(root);
  const index = ["major", "minor", "patch"].indexOf(increment);
  if (index === -1) throw new Error("Use release:version -- patch, minor, or major");
  const parts = version.split(".").map(Number);
  parts[index] += 1;
  for (let i = index + 1; i < parts.length; i += 1) parts[i] = 0;
  const next = parts.join(".");
  for (const file of versionFiles) {
    const data = readJson(root, file);
    data.version = next;
    if (file === "package-lock.json") data.packages[""].version = next;
    writeJson(root, file, data);
  }
  return next;
}

function prepareFirefox(root, tag, notes = "") {
  const version = checkVersion(root, tag);
  const manifest = readJson(root, "firefox/manifest.json");
  if (manifest.browser_specific_settings?.gecko?.id !== "airlock@dankhole") {
    throw new Error("Firefox manifest must target the existing airlock@dankhole add-on");
  }
  const files = collectPackageFiles(root, manifest);
  const staging = path.join(root, "store", "firefox-source");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // Preserve authored files byte-for-byte, including the Firefox manifest.
  fs.copyFileSync(path.join(root, "firefox/manifest.json"), path.join(staging, "manifest.json"));
  copyPackageFiles(root, staging, files);
  writeJson(root, "store/amo-metadata.json", {
    version: notes.trim() ? { release_notes: { "en-US": notes } } : {},
  });
  return version;
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    let version;
    if (command === "bump") {
      version = bumpVersion(rootDir, process.argv[3]);
    } else if (command === "prepare") {
      version = prepareFirefox(rootDir, process.env.RELEASE_TAG, process.env.RELEASE_NOTES);
    } else {
      throw new Error("Expected bump or prepare");
    }
    console.log(`Airlock ${version}: ${command} complete`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkVersion, bumpVersion, prepareFirefox };
