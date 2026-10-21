const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildForBrowser } = require("../scripts/build.js");
const { collectPackageFiles, noticeFiles } = require("../scripts/package-files.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airlock-build-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const files = {
    "background/main.js":"globalThis.background = true;\n",
    "shared/a.js":"globalThis.shared = true;\n",
    "shared/b.js":"globalThis.second = true;\n",
    "content/core.js":"globalThis.core = true;\n",
    "content/adapter.js":"globalThis.adapter = true;\n",
    "popup/popup.html":'<link href="../shared/ui.css"><script src="../shared/a.js"></script><script src="popup.js"></script>\n',
    "popup/popup.js":"globalThis.popup = true;\n",
    "options/options.html":'<script src="../shared/b.js"></script><script src="options.js"></script>\n',
    "options/options.js":"globalThis.options = true;\n",
    "shared/ui.css":"body { color: blue; }\n",
    "icons/icon.png":"icon",
    "node_modules/webextension-polyfill/dist/browser-polyfill.min.js":"globalThis.browser = {};\n",
    // Deliberately present private and unrelated sources; dependency packaging excludes them.
    "popup/.DS_Store":"private", "content/unused.js":"unused", ".config/credentials":"private",
  };
  for (const file of noticeFiles) files[file]=`license ${file}\n`;
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
    fs.writeFileSync(path.join(root,file),source);
  }
  const manifest = {
    manifest_version:3,name:"Fixture",version:"1.0.13",
    background:{scripts:["shared/a.js","shared/b.js","background/main.js"]},
    content_scripts:[{matches:["<all_urls>"],js:["content/core.js"]},{matches:["*://*.youtube.com/*"],js:["shared/a.js","content/adapter.js"]}],
    action:{default_popup:"popup/popup.html"},options_ui:{page:"options/options.html",open_in_tab:true},icons:{16:"icons/icon.png"},
  };
  fs.mkdirSync(path.join(root,"firefox"));
  for (const file of ["manifest.json","firefox/manifest.json"]) fs.writeFileSync(path.join(root,file),JSON.stringify(manifest,null,4)+"\n");
  return {root,manifest};
}

test("Chrome includes ordered worker dependencies and polyfill in every script entry and UI", (t) => {
  const {root} = fixture(t);
  const out = buildForBrowser("chrome",root);
  const manifest = JSON.parse(fs.readFileSync(path.join(out,"manifest.json")));
  assert.deepEqual(manifest.background,{service_worker:"background/main.js"});
  for (const entry of manifest.content_scripts) assert.equal(entry.js[0],"lib/browser-polyfill.min.js");
  assert.match(fs.readFileSync(path.join(out,"background/main.js"),"utf8"),/^importScripts\("\.\.\/lib\/browser-polyfill.min.js", "\.\.\/shared\/a.js", "\.\.\/shared\/b.js"\);/);
  for (const page of ["popup/popup.html","options/options.html"]) {
    const html=fs.readFileSync(path.join(out,page),"utf8");
    assert.ok(html.indexOf("browser-polyfill.min.js") < html.indexOf(page.startsWith("popup") ? "../shared/a.js" : "../shared/b.js"));
  }
  assert.ok(collectPackageFiles(out,manifest).includes("shared/ui.css"));
  for (const file of ["popup/.DS_Store","content/unused.js",".config/credentials"]) assert.equal(fs.existsSync(path.join(out,file)),false);
});

test("Firefox dependencies and authored manifest remain byte-identical", (t) => {
  const {root,manifest}=fixture(t);
  const out=buildForBrowser("firefox",root);
  assert.deepEqual(fs.readFileSync(path.join(out,"manifest.json")),fs.readFileSync(path.join(root,"firefox/manifest.json")));
  for (const file of collectPackageFiles(root,manifest)) assert.deepEqual(fs.readFileSync(path.join(out,file)),fs.readFileSync(path.join(root,file)),file);
  assert.equal(fs.existsSync(path.join(out,"lib")),false);
});

test("missing transitive asset fails before replacing previous successful output", (t) => {
  const {root}=fixture(t);
  const out=buildForBrowser("chrome",root);
  fs.unlinkSync(path.join(root,"shared/ui.css"));
  assert.throws(()=>buildForBrowser("chrome",root),/Required package asset is missing: shared\/ui.css/);
  assert.equal(fs.readFileSync(path.join(out,"shared/ui.css"),"utf8"),"body { color: blue; }\n");
});

test("unknown targets and escaped or symlink dependencies cannot enter a package", (t) => {
  const {root,manifest}=fixture(t);
  assert.throws(()=>buildForBrowser("opera",root),/Unsupported browser/);
  manifest.content_scripts[0].js=["../private.js"];
  assert.throws(()=>collectPackageFiles(root,manifest),/Unsafe package asset/);
  manifest.content_scripts[0].js=["content/linked.js"];
  fs.symlinkSync(path.join(root,"content/core.js"),path.join(root,"content/linked.js"));
  assert.throws(()=>collectPackageFiles(root,manifest),/regular file/);
});
