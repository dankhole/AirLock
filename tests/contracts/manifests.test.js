const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

test("authored browser manifests share top-frame platform ordering and navigation/options declarations",()=>{
  for(const file of ["manifest.json","firefox/manifest.json"]) {
    const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,"../..",file)));
    assert.ok(manifest.permissions.includes("webNavigation"));
    assert.deepEqual(manifest.options_ui,{page:"options/options.html",open_in_tab:true});
    assert.deepEqual(manifest.background.scripts,["shared/daily-lock.js","shared/content-controls.js","background/background.js"]);
    assert.deepEqual(manifest.content_scripts[0].js,["shared/page-state.js","content/content.js"]);
    for(const site of ["youtube","instagram","facebook"]) {
      const entry=manifest.content_scripts.find(entry=>entry.matches.includes(`*://*.${site}.com/*`));
      assert.ok(entry,site); assert.equal(entry.all_frames,false); assert.equal(entry.run_at,"document_start");
      assert.deepEqual(entry.js,["shared/content-controls.js","shared/page-state.js","content/controls/runtime.js",`content/controls/sites/${site}.js`]);
    }
  }
});
