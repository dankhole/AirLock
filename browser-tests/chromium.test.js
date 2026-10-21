const test=require("node:test");
const {launchChromium}=require("./driver");
const {runScenario}=require("./scenario");
test("Chromium actual extension integrates guarded settings, surfaces, routes and core gate",{timeout:180000},async t=>{
 const browser=await launchChromium();t.after(()=>browser.close());await runScenario(browser,t);
});
