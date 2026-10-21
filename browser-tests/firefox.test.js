const test=require("node:test");
const {launchFirefox}=require("./driver");
const {runScenario}=require("./scenario");
test("Firefox actual temporary addon integrates guarded settings, surfaces, routes and core gate",{timeout:180000},async t=>{
 const browser=await launchFirefox();t.after(()=>browser.close());await runScenario(browser,t);
});
