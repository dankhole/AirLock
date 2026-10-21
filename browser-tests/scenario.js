const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");
const {root,poll}=require("./driver");
const {runUiChecks}=require("./ui-checks");

async function runScenario(browser,t) {
  t.diagnostic(`${browser.name} ${browser.version}; actual temporary extension, synthetic HTTPS site origins`);
  const artifacts=path.join(root,"store/test-artifacts",browser.name.toLowerCase());fs.mkdirSync(artifacts,{recursive:true});
  const options=await browser.newPage();await browser.goto(options,`${browser.extensionOrigin}/options/options.html`);
  const send=async(message)=>{
    const result=await browser.evaluate(options,async message=>browser.runtime.sendMessage(message),message);
    assert.equal(result?.__error,undefined,JSON.stringify(result));return result;
  };
  await poll(()=>send({type:"GET_SETTINGS_STATE"}),state=>state?.ok,"settings authority");
  // Synthetic fresh-install fixture only; every subsequent configuration change uses the authority.
  await browser.evaluate(options,async()=>browser.storage.local.set({sites:[],siteWaitEnabled:{},settingsDelayMinutes:1,dailyUsage:{date:new Date().toLocaleDateString("en-CA"),sites:{"youtube.com":123000}}}));
  let state=await send({type:"GET_SETTINGS_STATE"});
  assert.equal(state.ok,true);
  const pages={};
  for(const site of ["youtube","facebook","instagram"]){
    const page=pages[site]=await browser.newPage();await browser.goto(page,`https://www.${site}.com/`);
    const display=await browser.evaluate(page,()=>getComputedStyle(document.getElementById("short-card")).display);
    assert.notEqual(display,"none",`${site} starts off`);
  }
  await browser.focus(options);
  await poll(()=>browser.evaluate(options,()=>!document.getElementById("short-form-preset").disabled),Boolean,"preset UI ready");
  await browser.click(options,"#short-form-preset");
  await poll(()=>browser.evaluate(options,()=>document.getElementById("confirm-dialog").open),Boolean,"preset confirmation dialog");
  assert.ok(await browser.evaluate(options,()=>document.querySelectorAll("#confirm-dialog-differences li").length)>0,"exact changes shown");
  await browser.click(options,"#confirm-dialog-submit");
  state=await poll(()=>send({type:"GET_SETTINGS_STATE"}),value=>value.ok&&value.config.contentControls.youtube.hideShorts,"UI-confirmed preset authority applies");
  assert.deepEqual(state.config.sites,[]);
  await poll(()=>browser.evaluate(options,()=>document.activeElement?.id),value=>value==="short-form-preset","focus restored after stronger preset confirmation");
  for(const site of Object.keys(pages)){
    const page=pages[site];
    await poll(()=>browser.evaluate(page,()=>getComputedStyle(document.getElementById("short-card")).display),value=>value==="none",`${site} computed hiding`);
    assert.notEqual(await browser.evaluate(page,()=>getComputedStyle(document.getElementById("normal-card")).display),"none",`${site} ordinary content preserved`);
  }
  await browser.evaluate(pages.youtube,()=>{const clone=document.getElementById("short-card").cloneNode(true);clone.id="lazy-card";document.querySelector("main").append(clone);});
  await poll(()=>browser.evaluate(pages.youtube,()=>getComputedStyle(document.getElementById("lazy-card")).display),value=>value==="none","lazy Shorts hiding");
  await browser.evaluate(pages.youtube,()=>document.querySelector("#lazy-card a").href="/watch?v=abcdefghijk");
  await poll(()=>browser.evaluate(pages.youtube,()=>getComputedStyle(document.getElementById("lazy-card")).display),value=>value!=="none","recycled ordinary video restored");
  await browser.evaluate(pages.youtube,()=>history.pushState({},"","/shorts/abcdefghijk?t=10&tracking=drop"));
  await poll(()=>browser.evaluate(pages.youtube,()=>location.href),value=>value==="https://www.youtube.com/watch?v=abcdefghijk&t=10","History API canonical redirect");
  await browser.goto(pages.facebook,"https://www.facebook.com/reel/123");
  await poll(()=>browser.evaluate(pages.facebook,()=>location.href),value=>value==="https://www.facebook.com/","Facebook direct route redirect");
  await browser.goto(pages.instagram,"https://www.instagram.com/reel/example/");
  await poll(()=>browser.evaluate(pages.instagram,()=>location.pathname),value=>value==="/","Instagram singular route redirect");
  await browser.focus(options);
  state=await send({type:"GET_SETTINGS_STATE"});
  state=await send({type:"REQUEST_CONFIG_CHANGE",expectedRevision:state.revision,patch:{sites:["youtube.com"],siteWaitEnabled:{"youtube.com":true}}});
  assert.equal(state.applied,true,JSON.stringify(state));
  await browser.goto(pages.youtube,"https://www.youtube.com/shorts/abcdefghijk");
  await poll(()=>browser.evaluate(pages.youtube,()=>Boolean(document.querySelector("airlock-overlay"))),Boolean,"Airlock wait gate");
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(await browser.evaluate(pages.youtube,()=>location.pathname),"/shorts/abcdefghijk","active core gate defers route navigation");
  await browser.focus(options);
  state=await send({type:"GET_SETTINGS_STATE"});
  state=await send({type:"REQUEST_CONFIG_CHANGE",expectedRevision:state.revision,patch:{settingsDelayMinutes:0,siteWaitEnabled:{"youtube.com":false},contentControls:{youtube:{hideShorts:false,hideNavigation:false,shortsRoute:"allow"},facebook:{hideReels:false,reelsRoute:"allow"},instagram:{blockReels:false}}}});
  assert.equal(state.ok,true);assert.equal(state.applied,false);assert.ok(state.pending?.id,"weakening creates pending hold");
  await poll(()=>browser.evaluate(options,()=>!document.getElementById("pending-config-section").hidden),Boolean,"pending UI rendered");
  await browser.screenshot(options,path.join(artifacts,"options-pending.png"),1280);
  const popup=browser.newPopup ? await browser.newPopup(pages.youtube) : await browser.newPage();
  if(!browser.newPopup)await browser.goto(popup,`${browser.extensionOrigin}/popup/popup.html`);
  await poll(()=>browser.evaluate(popup,()=>!document.getElementById("pending-config-section").hidden),Boolean,"popup pending UI rendered");

  await browser.screenshot(popup,path.join(artifacts,"popup-pending.png"),360);
  await browser.focus(options);
  const pendingId=state.pending.id;
  await browser.evaluate(options,()=>{
    const send=browser.runtime.sendMessage.bind(browser.runtime);window.__airlockHoldTrace=[];
    browser.runtime.sendMessage=async message=>{const response=await send(message);if(/PENDING_CONFIG_CHANGE/.test(message.type))window.__airlockHoldTrace.push({type:message.type,elapsed:message.elapsedMs,sequence:message.sequence,reason:response.reason,remaining:response.pending?.remainingMs});return response;};
  });
  const originalRemaining=state.pending.remainingMs;
  const releaseFirst=await browser.beginKeyboardHold(options,"#pending-config-hover-target");
  try {
    await poll(()=>send({type:"GET_SETTINGS_STATE"}),value=>value.pending&&value.pending.remainingMs<originalRemaining,"real keyboard progress begins",5000);
  }catch(error){
    t.diagnostic(`Hold UI: ${JSON.stringify(await browser.evaluate(options,()=>({hasFocus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.id,engagement:document.getElementById("pending-config-engagement").textContent,status:document.getElementById("ui-status").textContent})))}`);
    t.diagnostic(`Hold trace: ${JSON.stringify(await browser.evaluate(options,()=>window.__airlockHoldTrace.slice(-20)))}`);
    t.diagnostic(`Hold probe: ${JSON.stringify(await send({type:"ADVANCE_PENDING_CONFIG_CHANGE",pendingId:state.pending.id,clientId:"focus-probe",sequence:1,elapsedMs:0}))}`);
    throw error;
  }
  await releaseFirst();
  await new Promise(resolve=>setTimeout(resolve,350));
  const paused=(await send({type:"GET_SETTINGS_STATE"})).pending.remainingMs;
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal((await send({type:"GET_SETTINGS_STATE"})).pending.remainingMs,paused,"key release pauses progress");
  const releaseKeyboard=await browser.beginKeyboardHold(options,"#pending-config-hover-target");
  let progress;
  try {
    progress=await poll(()=>send({type:"GET_SETTINGS_STATE"}),value=>value.ok&&!value.pending,"actual Space-key foreground hold",75000);
  }finally{await releaseKeyboard();}
  assert.equal(progress.config.contentControls.youtube.hideShorts,false,"keyboard hold applied the weakening");
  assert.equal(progress.config.siteWaitEnabled["youtube.com"],false);
  assert.equal(progress.config.settingsDelayMinutes,0,"zero-minute hold persists after the previous hold completes");
  assert.equal((await send({type:"ADVANCE_PENDING_CONFIG_CHANGE",pendingId,clientId:"stale-browser-view",sequence:1,elapsedMs:1000})).reason,"stale-pending","completed hold cannot be replayed");
  for(const site of Object.keys(pages)){
    await poll(()=>browser.evaluate(pages[site],()=>getComputedStyle(document.getElementById("short-card")).display),value=>value!=="none",`${site} disable restores computed visibility`);
    assert.equal(await browser.evaluate(pages[site],()=>document.querySelectorAll("[data-airlock-hidden],[data-airlock-subdued]").length),0,`${site} marks removed`);
  }
  await browser.focus(options);
  await browser.screenshot(options,path.join(artifacts,"options-desktop.png"),1280);
  await browser.screenshot(options,path.join(artifacts,"options-narrow.png"),390);
  await browser.click(options,'.settings-nav a[href="#sites"]');
  await browser.screenshot(options,path.join(artifacts,"options-sites.png"),1280);
  const finalPopup=browser.newPopup ? await browser.newPopup(pages.youtube) : popup;
  if(!browser.newPopup)await browser.goto(finalPopup,`${browser.extensionOrigin}/popup/popup.html`);
  await browser.screenshot(finalPopup,path.join(artifacts,"popup-configured.png"),360);
  await runUiChecks(browser,options,finalPopup,artifacts,t);
  t.diagnostic(`Screenshots: ${artifacts}; guarded enable + 60-second disable, all-site hide/preservation, lazy/recycled cards, SPA/direct routes, wait priority passed`);
}
module.exports={runScenario};
