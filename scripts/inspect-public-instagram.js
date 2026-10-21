const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'airlock-public-instagram-'));
 let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true});
  const page=await context.newPage();
  for(const width of [1280,390])for(const url of ['https://www.instagram.com/explore/','https://www.instagram.com/?variant=following']){
   await page.setViewportSize({width,height:900});
   let status;try{const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});status=response?.status();await page.waitForTimeout(2500);}catch(error){console.log(JSON.stringify({url,width,error:error.message.split('\n')[0]}));continue;}
   const structure=await page.evaluate(()=>({title:document.title,main:document.querySelectorAll('main,[role=main]').length,search:document.querySelectorAll('[role=search],input[type=search],input[placeholder="Search"]').length,navLinks:[...document.querySelectorAll('a[href]')].map(a=>{try{const u=new URL(a.href);return u.hostname.endsWith('instagram.com')?u.pathname:null;}catch{return null;}}).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,30),namedRoles:[...document.querySelectorAll('[role][aria-label]')].map(e=>({role:e.getAttribute('role'),label:e.getAttribute('aria-label')})).slice(0,20)}));
   console.log(JSON.stringify({browser:context.browser().version(),url,width,status,...structure}));
  }
 }finally{if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
