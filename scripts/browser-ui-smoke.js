// Supplemental visual check: no settings hold, uses isolated synthetic install data.
const path=require("node:path");
const fs=require("node:fs");
const {root,launchChromium,launchFirefox,poll}=require("../browser-tests/driver");
const {runUiChecks}=require("../browser-tests/ui-checks");
(async()=>{
 const selected=process.argv[2]||"chromium";
 const browser=await(selected==="firefox"?launchFirefox():launchChromium());
 const artifacts=path.join(root,"store/test-artifacts",browser.name.toLowerCase());fs.mkdirSync(artifacts,{recursive:true});
 try{
  const options=await browser.newPage();await browser.goto(options,`${browser.extensionOrigin}/options/options.html`);
  await poll(()=>browser.evaluate(options,async()=>browser.runtime.sendMessage({type:"GET_SETTINGS_STATE"})),state=>state?.ok,"settings authority");
  await browser.evaluate(options,async()=>{const value=await browser.storage.local.get("configRevision");await browser.storage.local.set({settingsDelayMinutes:0,sites:["youtube.com"],siteWaitEnabled:{"youtube.com":false},configRevision:(value.configRevision||0)+1,dailyUsage:{date:new Date().toLocaleDateString("en-CA"),sites:{"youtube.com":123000}}});});
  await browser.screenshot(options,path.join(artifacts,"options-desktop.png"),1280);
  await browser.screenshot(options,path.join(artifacts,"options-narrow.png"),390);
  const popup=await browser.newPage();await browser.goto(popup,`${browser.extensionOrigin}/popup/popup.html`);
  await poll(()=>browser.evaluate(popup,()=>document.getElementById("ui-status").textContent),text=>!text.includes("Loading"),"popup initialized");
  await browser.screenshot(popup,path.join(artifacts,"popup-configured.png"),360);
  await runUiChecks(browser,options,popup,artifacts,{diagnostic:console.log});
  console.log(JSON.stringify({browser:browser.name,version:browser.version,visualChecks:"passed",artifacts}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
