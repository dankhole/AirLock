const fs = require("node:fs");
const path = require("node:path");

const noticeFiles = [
  "LICENSE", "THIRD_PARTY_NOTICES.md",
  "licenses/youtube-shorts-block-MIT.txt",
  "licenses/facebook-reels-blocker-MIT.txt",
  "licenses/webextension-polyfill-MPL-2.0.txt",
];

function manifestFiles(manifest) {
  const result = [...Object.values(manifest.icons || {}), ...(manifest.background?.scripts || [])];
  if (manifest.background?.service_worker) result.push(manifest.background.service_worker);
  for (const entry of manifest.content_scripts || []) result.push(...(entry.js || []), ...(entry.css || []));
  for (const key of ["action", "browser_action", "page_action"]) {
    const action = manifest[key];
    if (action?.default_popup) result.push(action.default_popup);
    if (typeof action?.default_icon === "string") result.push(action.default_icon);
    else result.push(...Object.values(action?.default_icon || {}));
  }
  if (manifest.options_ui?.page) result.push(manifest.options_ui.page);
  if (manifest.options_page) result.push(manifest.options_page);
  for (const entry of manifest.web_accessible_resources || []) {
    result.push(...(typeof entry === "string" ? [entry] : entry.resources || []));
  }
  return result;
}

function resolveAsset(from, reference) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return null;
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean) return null;
  const relative = path.posix.normalize(clean.startsWith("/") ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean));
  if (relative.startsWith("../") || relative === ".." || relative.includes("\\") || relative.split("/").some((part) => part.startsWith("."))) {
    throw new Error(`Unsafe package asset ${reference} referenced by ${from}`);
  }
  return relative;
}

function sourceReferences(file, source) {
  const result = [];
  if (file.endsWith(".html")) {
    // Local script, stylesheet, image and linked-document dependencies are all required.
    for (const match of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) result.push(match[1]);
  } else if (file.endsWith(".css")) {
    for (const match of source.matchAll(/url\(\s*["']?([^\s)'";]+)["']?\s*\)/gi)) result.push(match[1]);
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/gi)) result.push(match[1]);
  } else if (file.endsWith(".js")) {
    for (const call of source.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
      for (const match of call[1].matchAll(/["']([^"']+)["']/g)) result.push(match[1]);
    }
  }
  return result.map((reference) => resolveAsset(file, reference)).filter(Boolean);
}

function collectPackageFiles(root, manifest, extra = noticeFiles) {
  const pending = [...manifestFiles(manifest), ...extra];
  const seen = new Set();
  while (pending.length) {
    const file = resolveAsset("manifest.json", pending.pop());
    if (!file || seen.has(file)) continue;
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch { throw new Error(`Required package asset is missing: ${file}`); }
    if (!stat.isFile()) throw new Error(`Required package asset must be a regular file: ${file}`);
    seen.add(file);
    if (/\.(html|css|js)$/.test(file)) pending.push(...sourceReferences(file, fs.readFileSync(absolute, "utf8")));
  }
  return [...seen].sort();
}

function copyPackageFiles(root, output, files) {
  for (const file of files) {
    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
}

module.exports = { noticeFiles, manifestFiles, resolveAsset, sourceReferences, collectPackageFiles, copyPackageFiles };
