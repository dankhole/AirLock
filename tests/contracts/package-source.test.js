const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {collectPackageFiles,noticeFiles}=require("../../scripts/package-files");
const root=path.resolve(__dirname,"../..");

test("both authored dependency graphs package all controls, shared UI and licenses",()=>{
 const expected=[...noticeFiles,"shared/daily-lock.js","shared/content-controls.js","shared/page-state.js","shared/settings-client.js","shared/settings-ui.js","shared/settings-ui.css","content/content.js","content/controls/runtime.js","content/controls/sites/youtube.js","content/controls/sites/facebook.js","content/controls/sites/instagram.js","popup/popup.html","popup/popup.css","popup/popup.js","options/options.html","options/options.css","options/options.js","background/background.js"];
 const graphs=[];
 for(const source of ["manifest.json","firefox/manifest.json"]){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,source)));
  const files=collectPackageFiles(root,manifest);
  for(const file of expected)assert.ok(files.includes(file),`${source}: ${file}`);
  assert.ok(files.every(file=>!/(?:^|\/)(?:node_modules|\.git|\.codex|\.claude|\.DS_Store|store|dist)(?:\/|$)/.test(file)));
  graphs.push(files);
 }
 assert.deepEqual(graphs[0],graphs[1]);
});
