const fs = require("fs");
const path = require("path");

const target = process.argv[2] || "all";
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const filesToCopy = [
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "background/background.js",
  "content/content.js",
];

const iconFiles = ["icons/icon-16.png", "icons/icon-48.png", "icons/icon-128.png"];

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

function buildForBrowser(browser) {
  const outDir = path.join(distDir, browser);
  fs.mkdirSync(outDir, { recursive: true });

  // Read base manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf-8"));

  if (browser === "chrome") {
    // Chrome uses a service worker for background
    manifest.background = {
      service_worker: "background/background.js",
    };
  }
  // Firefox uses the "scripts" key which is already in the base manifest

  // Copy polyfill
  const polyfillSrc = path.join(rootDir, "node_modules", "webextension-polyfill", "dist", "browser-polyfill.min.js");
  if (fs.existsSync(polyfillSrc)) {
    copyFile(polyfillSrc, path.join(outDir, "lib", "browser-polyfill.min.js"));
  }

  // Inject polyfill script tag into popup.html for Chrome
  const popupHtmlSrc = path.join(rootDir, "popup", "popup.html");
  let popupHtml = fs.readFileSync(popupHtmlSrc, "utf-8");
  if (browser === "chrome") {
    popupHtml = popupHtml.replace(
      '<script src="popup.js"></script>',
      '<script src="../lib/browser-polyfill.min.js"></script>\n  <script src="popup.js"></script>'
    );
  }
  fs.mkdirSync(path.join(outDir, "popup"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "popup", "popup.html"), popupHtml);

  // Add polyfill to content_scripts for Chrome
  if (browser === "chrome") {
    manifest.content_scripts[0].js.unshift("lib/browser-polyfill.min.js");
  }

  // For Chrome, prepend importScripts for polyfill in background script
  if (browser === "chrome") {
    const bgSrc = path.join(rootDir, "background", "background.js");
    const bgContent = fs.readFileSync(bgSrc, "utf-8");
    const bgOut = path.join(outDir, "background", "background.js");
    fs.mkdirSync(path.dirname(bgOut), { recursive: true });
    fs.writeFileSync(bgOut, 'importScripts("../lib/browser-polyfill.min.js");\n\n' + bgContent);
  }

  // Write manifest
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Copy remaining files (skip popup.html and background.js for Chrome since we handled them)
  for (const file of filesToCopy) {
    if (file === "popup/popup.html") continue;
    if (file === "background/background.js" && browser === "chrome") continue;
    copyFile(path.join(rootDir, file), path.join(outDir, file));
  }

  // Copy icons if they exist
  for (const icon of iconFiles) {
    const src = path.join(rootDir, icon);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(outDir, icon));
    }
  }

  console.log(`Built for ${browser} -> dist/${browser}/`);
}

if (target === "all") {
  buildForBrowser("chrome");
  buildForBrowser("firefox");
} else {
  buildForBrowser(target);
}
