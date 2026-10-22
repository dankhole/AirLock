const assert=require("node:assert/strict");
const path=require("node:path");
const {poll}=require("./driver");

async function checkOverflow(browser,page,description) {
  const dimensions=await browser.evaluate(page,()=>({width:window.innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(dimensions.scroll<=dimensions.width+1,`${description}: ${JSON.stringify(dimensions)}`);
  return dimensions;
}

async function runUiChecks(browser,options,popup,artifacts,t) {
  const navigatePanel=async panel=>{
    await browser.click(options,`.settings-nav a[href="#${panel}"]`);
    await poll(()=>browser.evaluate(options,panel=>!document.getElementById(panel).hidden,panel),Boolean,`${panel} panel navigation settled`);
  };
  await browser.focus(options);
  await navigatePanel("general");
  await poll(()=>browser.evaluate(options,()=>!document.getElementById("enabled-toggle").disabled),Boolean,"settings unlocked after hold");
  assert.equal(await browser.evaluate(options,()=>document.getElementById("settings-delay-input").value),"0","zero-minute setting rendered");
  await browser.evaluate(options,()=>document.getElementById("enabled-toggle").focus());
  await browser.pressKey(options,"Space");
  await poll(()=>browser.evaluate(options,()=>({open:document.getElementById("confirm-dialog").open,active:document.activeElement.id,focused:document.hasFocus(),checked:document.getElementById("enabled-toggle").checked,status:document.getElementById("ui-status").textContent})),state=>state.open,"keyboard confirmation opens");
  assert.equal(await browser.evaluate(options,()=>document.activeElement.id),"confirm-dialog-cancel","dialog starts on safe cancel action");
  for(let i=0;i<4;i++){
    await browser.pressKey(options,"Tab");
    const focus=await browser.evaluate(options,()=>({inside:document.getElementById("confirm-dialog").contains(document.activeElement),tag:document.activeElement.tagName,id:document.activeElement.id}));
    // Native dialogs allow Tab to browser chrome; background page controls must remain inert.
    assert.ok(focus.inside||focus.tag==="BODY",`modal excludes background controls: ${JSON.stringify(focus)}`);
  }
  await browser.evaluate(options,()=>{window.__airlockDialogClosed=false;document.getElementById("confirm-dialog").addEventListener("close",()=>{window.__airlockDialogClosed=true;},{once:true});});
  await browser.pressKey(options,"Escape");
  await poll(()=>browser.evaluate(options,()=>window.__airlockDialogClosed),Boolean,"native close event completed");
  await poll(()=>browser.evaluate(options,()=>document.activeElement.id),value=>value==="enabled-toggle","Escape restores invoker focus");
  assert.equal(await browser.evaluate(options,async()=>(await browser.runtime.sendMessage({type:"GET_SETTINGS_STATE"})).config.enabled),true,"cancel preserves settings");
  await browser.focus(options);
  await browser.pressKey(options,"Space");
  await poll(()=>browser.evaluate(options,()=>({open:document.getElementById("confirm-dialog").open,active:document.activeElement.id,focused:document.hasFocus(),checked:document.getElementById("enabled-toggle").checked,status:document.getElementById("ui-status").textContent})),state=>state.open,"reopened confirmation");
  await checkOverflow(browser,options,"confirmation dialog");
  await browser.screenshot(options,path.join(artifacts,"options-confirmation.png"));
  await browser.click(options,"#confirm-dialog-submit");
  await poll(()=>browser.evaluate(options,async()=>({...await browser.runtime.sendMessage({type:"GET_SETTINGS_STATE"}),uiStatus:document.getElementById("ui-status").textContent,dialogOpen:document.getElementById("confirm-dialog").open})),s=>s.config.enabled===false&&!s.pending,"zero hold applies weakening after confirmation without pending countdown");
  await browser.click(options,"#enabled-toggle");
  await poll(()=>browser.evaluate(options,()=>document.getElementById("confirm-dialog").open),Boolean,"restore confirmation opened");
  await browser.click(options,"#confirm-dialog-submit");
  await poll(()=>browser.evaluate(options,async()=>browser.runtime.sendMessage({type:"GET_SETTINGS_STATE"})),s=>s.config.enabled===true&&!s.pending,"restore restrictions");
  for(const panel of ["general","sites","youtube","instagram","facebook"]){
    await navigatePanel(panel);
    const unnamed=await browser.evaluate(options,()=>Array.from(document.querySelectorAll("input,select,button")).filter(e=>e.getClientRects().length&&!e.hidden).filter(e=>{
      const labels=Array.from(e.labels||[]).map(l=>l.textContent).join(" ");
      const refs=(e.getAttribute("aria-labelledby")||"").split(/\s+/).map(id=>document.getElementById(id)?.textContent||"").join(" ");
      return !(labels||refs||e.getAttribute("aria-label")||(e.tagName==="BUTTON"?e.textContent:"")).trim();
    }).map(e=>e.id||e.outerHTML));
    assert.deepEqual(unnamed,[],`${panel} controls have accessible names`);
  }

  await browser.setViewport(options,320);
  await navigatePanel("instagram");
  const dimensions=await checkOverflow(browser,options,"Instagram platform at narrow viewport");
  await browser.screenshot(options,path.join(artifacts,"options-instagram-320.png"));
  await browser.evaluate(options,()=>document.documentElement.style.fontSize="200%");
  await checkOverflow(browser,options,"Instagram platform with 200% root text");
  await browser.screenshot(options,path.join(artifacts,"options-instagram-text-large.png"));
  await browser.evaluate(options,()=>document.documentElement.style.fontSize="");
  const sites=Array.from({length:30},(_,i)=>i===0?"a-very-long-example-domain-for-settings-reflow.example.com":`tracked-${i}.example.com`);
  await browser.evaluate(options,async sites=>{const value=await browser.storage.local.get("configRevision");await browser.storage.local.set({sites,siteWaitEnabled:{},configRevision:(value.configRevision||0)+1});},sites);
  await navigatePanel("sites");
  await poll(()=>browser.evaluate(options,()=>document.getElementById("site-list").textContent),text=>text.includes("tracked-29.example.com"),"large site list rendered");
  await checkOverflow(browser,options,"long domains and thirty tracked sites");
  await browser.screenshot(options,path.join(artifacts,"options-sites-long.png"));
  await browser.evaluate(options,async()=>{const value=await browser.storage.local.get("configRevision");await browser.storage.local.set({sites:[],siteWaitEnabled:{},configRevision:(value.configRevision||0)+1});});
  await poll(()=>browser.evaluate(options,()=>document.getElementById("site-list").textContent),text=>!text.includes("tracked-29.example.com"),"empty tracked site state");
  await browser.screenshot(options,path.join(artifacts,"options-sites-empty.png"));
  await browser.setViewport(popup,320);
  await checkOverflow(browser,popup,"popup at narrow viewport");
  if(browser.emulateMedia){
    await browser.emulateMedia(options,{forcedColors:"active",reducedMotion:"reduce"});
    await navigatePanel("general");
    await browser.keyboardFocus(options,"#enabled-toggle");
    const focus=await browser.evaluate(options,()=>{
      const target=document.getElementById("enabled-toggle");const style=getComputedStyle(target);
      return {forced:matchMedia("(forced-colors: active)").matches,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,active:document.activeElement===target,pageFocused:document.hasFocus(),focusVisible:target.matches(":focus-visible"),outline:style.outlineStyle,width:parseFloat(style.outlineWidth),color:style.outlineColor};
    });
    assert.equal(focus.forced,true);assert.equal(focus.reduced,true);
    assert.ok(focus.active&&focus.pageFocused&&focus.focusVisible,`keyboard focus established: ${JSON.stringify(focus)}`);
    assert.ok(focus.outline!=="none"&&focus.width>0&&focus.color!=="rgba(0, 0, 0, 0)",`forced-colors focus outline: ${JSON.stringify(focus)}`);
    await browser.screenshot(options,path.join(artifacts,"options-forced-colors.png"));
  }
  t.diagnostic(`UI checks: keyboard confirmation/Escape/focus, zero hold, named controls; ${dimensions.width}px actual viewport, 200% root text, long/30/empty sites, popup narrow; ${browser.emulateMedia?"forced-colors and reduced-motion emulation passed":"forced-colors/reduced-motion emulation unavailable in this driver"}`);
}
module.exports={runUiChecks,checkOverflow};
