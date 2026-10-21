const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {createFixtureProxy}=require("./fixture-proxy");
const root=path.resolve(__dirname,"..");

async function launchChromium() {
  const {chromium}=require("playwright");
  const proxy=await createFixtureProxy();
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),"airlock-chromium-"));
  let context;
  try {
    const extension=path.join(root,"dist/chrome");
    context=await chromium.launchPersistentContext(profile,{channel:"chromium",headless:true,ignoreHTTPSErrors:true,proxy:{server:proxy.url},viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
    const workerUrl=new URL(worker.url());
    const extensionOrigin=`${workerUrl.protocol}//${workerUrl.host}`;
    return {
      name:"Chromium",version:context.browser().version(),extensionOrigin,
      async newPage(){return context.newPage();},
      async newPopup(sitePage){
        await sitePage.bringToFront();
        const opened=context.waitForEvent("page");
        await worker.evaluate(url=>chrome.tabs.create({url,active:false}),`${extensionOrigin}/popup/popup.html`);
        const popup=await opened;await popup.waitForLoadState("domcontentloaded");return popup;
      },
      goto:(page,url)=>page.goto(url,{waitUntil:"domcontentloaded"}),
      evaluate:(page,fn,arg)=>page.evaluate(fn,arg),
      focus:page=>page.bringToFront(),
      click:(page,selector)=>page.locator(selector).click(),
      async pressKey(page,key){await page.bringToFront();await page.keyboard.press(key);},
      setViewport:(page,width)=>page.setViewportSize({width,height:1000}),
      emulateMedia:(page,options)=>page.emulateMedia(options),
      async keyboardFocus(page,selector){await page.bringToFront();await page.locator(selector).focus();await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");},
      async beginKeyboardHold(page,selector){await page.bringToFront();await page.mouse.move(0,0);await page.locator(selector).focus();await page.keyboard.down("Space");return ()=>page.keyboard.up("Space");},
      screenshot:async(page,file,width)=>{if(width)await page.setViewportSize({width,height:1000});await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(100);await page.screenshot({path:file,fullPage:true});},
      async close(){await context.close();await proxy.close();fs.rmSync(profile,{recursive:true,force:true});},
    };
  }catch(error){if(context)await context.close();await proxy.close();fs.rmSync(profile,{recursive:true,force:true});throw error;}
}

async function launchFirefox() {
  const {Builder,By,Key}=require("selenium-webdriver");
  const firefox=require("selenium-webdriver/firefox");
  const {download}=await import("geckodriver");
  const proxy=await createFixtureProxy();
  let driver;
  try {
    const executable=await download("0.36.0");
    const options=new firefox.Options().setBinary(process.env.AIRLOCK_FIREFOX_BINARY||"/Applications/Firefox.app/Contents/MacOS/firefox")
      .addArguments("-headless","-remote-allow-system-access").setAcceptInsecureCerts(true)
      .setPreference("network.proxy.type",1).setPreference("network.proxy.http","127.0.0.1").setPreference("network.proxy.http_port",proxy.port)
      .setPreference("network.proxy.ssl","127.0.0.1").setPreference("network.proxy.ssl_port",proxy.port).setPreference("network.proxy.no_proxies_on","");
    driver=await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder(executable)).build();
    await driver.manage().window().setRect({width:1280,height:1000});
    // Directory-install verifies actual source; AIRLOCK_FIREFOX_ADDON can also select the packaged ZIP.
    const addon=await driver.installAddon(process.env.AIRLOCK_FIREFOX_ADDON||path.join(root,"dist/firefox"),true);
    await driver.setContext(firefox.Context.CHROME);
    const uuid=await driver.executeScript('return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]]',addon);
    await driver.setContext(firefox.Context.CONTENT);
    const select=async(page)=>{if(await driver.getWindowHandle()!==page)await driver.switchTo().window(page);};
    return {
      name:"Firefox",version:(await driver.getCapabilities()).get("browserVersion"),extensionOrigin:`moz-extension://${uuid}`,
      async newPage(){await driver.switchTo().newWindow("tab");return driver.getWindowHandle();},
      async goto(page,url){await select(page);return driver.get(url);},
      async evaluate(page,fn,arg){await select(page);return driver.executeAsyncScript(`const done=arguments[arguments.length-1];Promise.resolve((${fn.toString()})(arguments[0])).then(done,error=>done({__error:String(error)}));`,arg);},
      async focus(page){await driver.switchTo().window(page);},
      async click(page,selector){await select(page);await driver.findElement(By.css(selector)).click();},
      async pressKey(page,key){await select(page);const keys={Tab:Key.TAB,Escape:Key.ESCAPE,Space:Key.SPACE,Enter:Key.ENTER};await driver.actions().sendKeys(keys[key]||key).perform();},
      async setViewport(page,width){await select(page);await driver.manage().window().setRect({width,height:1000});},
      async beginKeyboardHold(page,selector){await select(page);await driver.actions().move({x:0,y:0,origin:"viewport"}).perform();const element=await driver.findElement(By.css(selector));await driver.executeScript("arguments[0].focus()",element);await driver.actions().keyDown(Key.SPACE).perform();return ()=>driver.actions().keyUp(Key.SPACE).perform();},
      async screenshot(page,file,width){await select(page);if(width)await driver.manage().window().setRect({width,height:1000});await driver.executeScript("window.scrollTo(0,0)");await new Promise(resolve=>setTimeout(resolve,100));fs.writeFileSync(file,await driver.takeScreenshot(),"base64");},
      async close(){await driver.quit();await proxy.close();},
    };
  }catch(error){if(driver)await driver.quit();await proxy.close();throw error;}
}

async function poll(get, predicate, description, timeout=10000) {
  const start=Date.now();let value;
  while(Date.now()-start<timeout){
    try {value=await get();if(predicate(value))return value;}
    catch(error){if(!/Execution context was destroyed|Cannot find context|Browsing context has been discarded/.test(error.message))throw error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}
module.exports={root,launchChromium,launchFirefox,poll};
