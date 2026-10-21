const fs = require("node:fs");
const path = require("node:path");
const { collectPackageFiles, copyPackageFiles } = require("./package-files.js");

const rootDir = path.resolve(__dirname, "..");
const POLYFILL = "lib/browser-polyfill.min.js";

function injectPolyfill(html, file) {
  if (!/<script\b/i.test(html)) throw new Error(`Extension page has no script insertion point: ${file}`);
  const reference = path.posix.relative(path.posix.dirname(file), POLYFILL);
  return html.replace(/<script\b/i, `<script src="${reference}"></script>\n  <script`);
}

function buildForBrowser(browser, root = rootDir) {
  if (!["chrome", "firefox"].includes(browser)) throw new Error(`Unsupported browser target: ${browser}`);
  const manifestSource = browser === "firefox" ? "firefox/manifest.json" : "manifest.json";
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestSource), "utf8"));
  const authoredBackgrounds = [...(manifest.background?.scripts || [])];
  // Resolve the complete dependency graph before deleting any previous successful output.
  const files = collectPackageFiles(root, manifest);
  const polyfillSource = path.join(root, "node_modules", "webextension-polyfill", "dist", "browser-polyfill.min.js");
  if (browser === "chrome" && !fs.existsSync(polyfillSource)) throw new Error("Required Chrome browser API polyfill is missing");
  const outDir = path.join(root, "dist", browser);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copyPackageFiles(root, outDir, files);
  if (browser === "chrome") {
    if (!authoredBackgrounds.length) throw new Error("Chrome build requires authored background scripts");
    const worker = authoredBackgrounds.at(-1);
    manifest.background = { service_worker: worker };
    for (const entry of manifest.content_scripts || []) {
      if (entry.js?.length && !entry.js.includes(POLYFILL)) entry.js.unshift(POLYFILL);
    }
    fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
    fs.copyFileSync(polyfillSource, path.join(outDir, POLYFILL));
    for (const file of files.filter((file) => file.endsWith(".html"))) {
      const html = fs.readFileSync(path.join(root, file), "utf8");
      if (/<script\b/i.test(html)) fs.writeFileSync(path.join(outDir, file), injectPolyfill(html, file));
    }
    const imports = [POLYFILL, ...authoredBackgrounds.slice(0, -1)].map((file) => JSON.stringify(path.posix.relative(path.posix.dirname(worker), file)));
    fs.writeFileSync(path.join(outDir, worker), `importScripts(${imports.join(", ")});\n\n${fs.readFileSync(path.join(root, worker), "utf8")}`);
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  } else {
    // Preserve every Firefox source file, including its authored manifest, byte for byte.
    fs.copyFileSync(path.join(root, manifestSource), path.join(outDir, "manifest.json"));
  }
  collectPackageFiles(outDir, manifest);
  return outDir;
}

if (require.main === module) {
  try {
    const target = process.argv[2] || "all";
    for (const browser of target === "all" ? ["chrome", "firefox"] : [target]) {
      buildForBrowser(browser);
      console.log(`Built for ${browser} -> dist/${browser}/`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildForBrowser, injectPolyfill };
