const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const https=require("node:https");
const net=require("node:net");
const {execFileSync}=require("node:child_process");

const fixtures={
  youtube:'<main><ytd-rich-item-renderer id="short-card"><a id="thumbnail" href="/shorts/abcdefghijk">Short</a></ytd-rich-item-renderer><ytd-rich-item-renderer id="normal-card"><a id="thumbnail" href="/watch?v=abcdefghijk">Ordinary video</a></ytd-rich-item-renderer><button id="append">Append</button></main>',
  facebook:'<main><div data-pagelet="Reels" id="short-card"><h2>Reels</h2><a href="/reel/123">Reel</a></div><div role="article" id="normal-card"><p>Ordinary post and text.</p></div></main>',
  instagram:'<main><nav><a id="short-card" href="/reels/">Reels</a><a id="normal-card" href="/direct/inbox/">Messages</a></nav></main>',
};

function fixtureHtml(host) {
  const platform=Object.keys(fixtures).find(site=>host===`${site}.com` || host.endsWith(`.${site}.com`));
  return '<!doctype html><html><head><meta charset="utf-8"><title>Airlock synthetic fixture</title><style>main{padding:20px}main>*{display:block;margin:10px;padding:10px}</style></head><body>'+(fixtures[platform]||'<main>Unknown fixture</main>')+'</body></html>';
}
function listen(server) {return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});}

async function createFixtureProxy() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'airlock-proxy-'));
  const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=airlock-fixture'],{stdio:'ignore'});
  const sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));};
  const secure=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    const host=(req.headers.host||'').split(':')[0];
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(fixtureHtml(host));
  });
  secure.on('connection',track);
  const securePort=await listen(secure);
  const proxy=http.createServer((req,res)=>{res.writeHead(403);res.end('External traffic disabled in fixture harness');});
  proxy.on('connection',track);
  proxy.on('connect',(req,client,head)=>{
    const host=req.url.split(':')[0];
    if(!/^(?:[a-z0-9-]+\.)*(?:youtube|facebook|instagram)\.com$/.test(host)) {client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=net.connect(securePort,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      client.pipe(upstream);upstream.pipe(client);
    });
    track(upstream);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
  });
  const port=await listen(proxy);
  return {port,url:`http://127.0.0.1:${port}`,async close(){for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>secure.close(resolve))]);fs.rmSync(root,{recursive:true,force:true});}};
}
module.exports={fixtures,fixtureHtml,createFixtureProxy};
