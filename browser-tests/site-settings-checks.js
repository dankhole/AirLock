const assert=require("node:assert/strict");
const path=require("node:path");
const {poll}=require("./driver");

async function runSiteSettingsChecks(browser,options,sitePage,artifacts,t) {
  const site="youtube.com";
  const suffix=encodeURIComponent(site);
  const read=()=>browser.evaluate(options,async()=>browser.runtime.sendMessage({type:"GET_SETTINGS_STATE"}));
  const original=await read();
  assert.equal(original.config.settingsDelayMinutes,0,"site settings checks follow the completed settings hold");
  assert.equal(original.config.enabled,true);
  assert.equal(original.config.cooldownUntil,null);
  assert.ok(original.config.sites.includes(site));
  const fixtureUrl=await browser.evaluate(sitePage,()=>location.href);
  await browser.evaluate(options,()=>{
    window.__airlockSiteTabId=null;
    window.__airlockSiteTabObserver=(message,sender)=>{
      if(message?.type==="CONTENT_READY"&&/(^|\.)youtube\.com$/.test(message.domain||"")&&sender.frameId===0)
        window.__airlockSiteTabId=sender.tab?.id;
    };
    // Observe the real content bootstrap without responding or requiring tabs permission.
    browser.runtime.onMessage.addListener(window.__airlockSiteTabObserver);
  });
  let tabId;
  try {
    await browser.goto(sitePage,fixtureUrl);
    tabId=await poll(()=>browser.evaluate(options,()=>window.__airlockSiteTabId),Number.isInteger,"actual fixture content sender tab");
  } finally {
    await browser.evaluate(options,()=>{
      browser.runtime.onMessage.removeListener(window.__airlockSiteTabObserver);
      delete window.__airlockSiteTabObserver;
    });
  }
  assert.ok(Number.isInteger(tabId),"actual fixture tab is addressable");
  async function request(patch) {
    const state=await read();
    const result=await browser.evaluate(options,async message=>browser.runtime.sendMessage(message),{type:"REQUEST_CONFIG_CHANGE",expectedRevision:state.revision,patch});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.applied,true,"zero settings hold applies the complete patch");
    assert.equal(result.pending,null);
    return result;
  }
  async function core(mode,description) {
    return poll(()=>browser.evaluate(options,async tabId=>browser.tabs.sendMessage(tabId,{type:"AIRLOCK_GET_PAGE_STATE"}),tabId),state=>state?.ready&&state.coreMode===mode,description);
  }
  async function confirm(description,predicate) {
    await poll(()=>browser.evaluate(options,()=>document.getElementById("confirm-dialog").open),Boolean,description+" confirmation opens");
    await browser.evaluate(options,()=>{
      window.__airlockSiteDialogClosed=false;
      document.getElementById("confirm-dialog").addEventListener("close",()=>{window.__airlockSiteDialogClosed=true;},{once:true});
    });
    await browser.click(options,"#confirm-dialog-submit");
    await poll(()=>browser.evaluate(options,()=>window.__airlockSiteDialogClosed),Boolean,description+" native close finishes");
    return poll(read,state=>state.ok&&!state.pending&&predicate(state),description+" authority applies");
  }
  async function edit(id,value,description,predicate) {
    await browser.evaluate(options,({id,value})=>{
      const input=document.getElementById(id);
      input.focus();input.value=value;
      input.dispatchEvent(new Event("input",{bubbles:true}));
      input.dispatchEvent(new Event("change",{bubbles:true}));
    },{id,value});
    await browser.click(options,"#save-settings");
    return confirm(description,predicate);
  }
  async function pause(paused) {
    await browser.focus(options);
    const before=await read();
    assert.equal((before.config.siteTrackingEnabled||{})[site]===false,!paused);
    await browser.click(options,'[id="site-tracking-'+suffix+'"]');
    const unchanged=await read();
    assert.equal((unchanged.config.siteTrackingEnabled||{})[site]===false,!paused,"tracking changes only after confirmation");
    await browser.click(options,"#save-settings");
    return confirm(paused?"pause tracking":"resume tracking",state=>((state.config.siteTrackingEnabled||{})[site]===false)===paused);
  }
  const used=state=>state.usage.sites[site]||0;
  const saved=(key)=>Object.prototype.hasOwnProperty.call(original.config[key]||{},site)?original.config[key][site]:null;
  const restore={
    siteTrackingEnabled:{[site]:saved("siteTrackingEnabled")},
    siteWaitEnabled:{[site]:saved("siteWaitEnabled")},
    dailyLimits:{[site]:saved("dailyLimits")},
    dailyLimitPolicies:{[site]:saved("dailyLimitPolicies")},
    dailyLockEnabled:original.config.dailyLockEnabled,
    dailyLockStart:original.config.dailyLockStart,
    dailyLockEnd:original.config.dailyLockEnd,
    cooldownUntil:null,
    contentControls:{youtube:{hideShorts:original.config.contentControls.youtube.hideShorts}}
  };
  try {
    await browser.focus(options);
    await browser.click(options,'.settings-nav a[href="#sites"]');
    await poll(()=>browser.evaluate(options,id=>Boolean(document.getElementById(id)),"site-policy-"+suffix),Boolean,"tracked site settings rendered");
    assert.equal(original.config.dailyLimits[site],undefined,"limit preferences begin dormant");
    await browser.click(options,'[id="site-summary-'+suffix+'"]');
    const dormant=await browser.evaluate(options,suffix=>({
      policyDisabled:document.getElementById("site-policy-"+suffix).disabled,
      durationDisabled:document.getElementById("site-cooldown-"+suffix).disabled,
      mode:document.getElementById("site-policy-"+suffix).value
    }),suffix);
    assert.deepEqual(dormant,{policyDisabled:false,durationDisabled:false,mode:"block"});
    let state=await edit("site-cooldown-"+suffix,"17","dormant break duration",state=>state.config.dailyLimitPolicies[site]?.cooldownMinutes===17);
    assert.equal(state.config.dailyLimitPolicies[site].mode,"block","duration editing preserves the midnight action");
    assert.equal(state.config.dailyLimits[site],undefined);
    state=await edit("site-policy-"+suffix,"cooldown","dormant break action",state=>state.config.dailyLimitPolicies[site]?.mode==="cooldown");
    assert.equal(state.config.dailyLimitPolicies[site].cooldownMinutes,17);
    assert.equal(state.config.dailyLimits[site],undefined,"changing action does not silently enable a limit");
    await edit("site-policy-"+suffix,"block","saved midnight action",state=>state.config.dailyLimitPolicies[site]?.mode==="block");
    await browser.screenshot(options,path.join(artifacts,"options-site-preferences-desktop.png"),1280);

    await browser.click(options,'[id="site-summary-'+suffix+'"]');
    const shortcut=await browser.evaluate(options,suffix=>{
      const button=document.getElementById("site-tracking-"+suffix);
      const details=document.getElementById("site-summary-"+suffix).closest("details");
      return {closed:!details.open,outside:!details.contains(button),visible:button.getClientRects().length>0,label:button.textContent.trim()};
    },suffix);
    assert.deepEqual(shortcut,{closed:true,outside:true,visible:true,label:"Pause"});
    const paused=await pause(true);
    const pausedUsed=used(paused);
    await core("none","pause removes the core site gate");
    await request({contentControls:{youtube:{hideShorts:true}}});
    await poll(()=>browser.evaluate(sitePage,()=>getComputedStyle(document.getElementById("short-card")).display),value=>value==="none","independent content rule still hides while tracking is paused");
    await browser.focus(sitePage);
    const downtimeFocused=await browser.evaluate(sitePage,async()=>{await new Promise(resolve=>setTimeout(resolve,4000));return document.hasFocus();});
    assert.equal(downtimeFocused,true,"downtime check has actual foreground focus");
    state=await read();
    assert.ok(state.config.sites.includes(site),"pausing retains the tracked domain");
    assert.equal(state.config.siteTrackingEnabled[site],false);
    assert.equal(used(state),pausedUsed,"foreground downtime adds no usage");
    assert.equal(state.config.dailyLimitPolicies[site].cooldownMinutes,17,"pause retains saved preferences");
    await browser.screenshot(options,path.join(artifacts,"options-site-paused-narrow.png"),390);

    await pause(false);
    await core("none","resume with saved no-wait access");
    const activeStarted=Date.now();
    await browser.focus(sitePage);
    const focused=await browser.evaluate(sitePage,async()=>{await new Promise(resolve=>setTimeout(resolve,1500));return document.hasFocus();});
    assert.equal(focused,true,"usage check has actual foreground focus");
    state=await read();
    const activeElapsed=Date.now()-activeStarted;
    assert.ok(used(state)>pausedUsed,"focused usage resumes after Resume");
    assert.ok(used(state)-pausedUsed<=activeElapsed+750,"Resume does not backfill the paused interval");

    await request({siteWaitEnabled:{[site]:true}});
    await core("timer","saved site wait is enforced before pausing");
    const session=await browser.evaluate(options,async tabId=>(await browser.storage.session.get("session_"+tabId))["session_"+tabId],tabId);
    assert.ok(session?.remainingMs>0,"unfinished wait exists");
    await pause(true);
    await core("none","pause removes an unfinished site wait");
    const retained=await browser.evaluate(options,async tabId=>(await browser.storage.session.get("session_"+tabId))["session_"+tabId],tabId);
    assert.equal(retained.remainingMs,session.remainingMs,"pause retains unfinished wait progress");
    assert.equal(retained.createdAt,session.createdAt);
    await pause(false);
    await core("timer","Resume restores the saved unfinished wait");
    await pause(true);

    const schedule=await browser.evaluate(options,()=>{
      const format=date=>String(date.getHours()).padStart(2,"0")+":"+String(date.getMinutes()).padStart(2,"0");
      return {dailyLockEnabled:true,dailyLockStart:format(new Date(Date.now()-120000)),dailyLockEnd:format(new Date(Date.now()+120000))};
    });
    await request(schedule);
    await core("none","paused site bypasses an active daily schedule");
    await pause(false);
    await core("dailyLock","Resume enforces the saved active daily schedule");
    await pause(true);
    await core("none","Pause clears the scheduled lock");
    await request({dailyLockEnabled:false,dailyLimits:{[site]:1}});
    assert.ok(used(await read())>=60000,"fixture usage exceeds the new daily limit");
    await core("none","paused site bypasses its reached daily limit");
    await pause(false);
    await core("dailyLimit","Resume enforces the saved reached daily limit");
    await pause(true);
    await core("none","Pause clears the reached daily-limit gate");

    const cooldown=await browser.evaluate(options,async()=>browser.runtime.sendMessage({type:"START_COOLDOWN"}));
    assert.equal(cooldown.ok,true);
    await core("cooldown","manual cooldown still blocks a paused site");
    state=await read();
    assert.ok(state.config.cooldownUntil>Date.now());
    assert.equal(state.config.siteTrackingEnabled[site],false);
    await request({cooldownUntil:null});
    await core("none","ending manual cooldown restores paused downtime");
    t.diagnostic("Site settings: dormant break/action editing, collapsed Pause/Resume, real-clock downtime/no backfill, retained wait, schedule/limit resume, independent hiding and manual cooldown passed");
  } finally {
    await request(restore);
    await core("none","site settings checks restore original no-wait access");
    const restored=await read();
    for(const key of ["siteTrackingEnabled","siteWaitEnabled","dailyLimits","dailyLimitPolicies"])
      assert.deepEqual(restored.config[key]||{},original.config[key]||{},key+" restored after checks");
  }
}

module.exports={runSiteSettingsChecks};
