const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {JSDOM} = require('jsdom');
const controlsApi = require('../shared/content-controls');
const {createPageState} = require('../shared/page-state');
const {createRuntime} = require('../content/controls/runtime');
const adapter = require('../content/controls/sites/instagram');

function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const fn of [...listeners]) fn(...args); }
  };
}

test('Instagram runtime pauses current/lazy media, suppresses play, reverses controls and preserves text/actions', async () => {
  const html = fs.readFileSync(path.join(__dirname,'fixtures/instagram-semantic.html'),'utf8');
  const dom = new JSDOM(html,{url:'https://www.instagram.com/direct/t/thread/'});
  const {window} = dom;
  const document = window.document;
  const pageState = createPageState();
  pageState.setCore({ready:true,coreMode:'none'});
  const onChanged = event();
  const onMessage = event();
  let config = {contentControlsEnabled:true,contentControls:controlsApi.getDefaults(),configRevision:1};
  Object.assign(config.contentControls.instagram,{blockReels:true,hideImages:true,hideVideos:true,hideComments:true,unreadBadges:'subdued'});
  const browser = {storage:{local:{get:async()=>config},onChanged},runtime:{onMessage}};
  const timers = new Map();
  let serial = 0;
  const state = new Map();
  function track(video) {
    const mediaState = {paused:false,pauses:0,plays:0};
    video.pause = () => {mediaState.paused=true;mediaState.pauses+=1;};
    video.play = () => {mediaState.paused=false;mediaState.plays+=1;return Promise.resolve();};
    state.set(video,mediaState);
    return mediaState;
  }
  for (const video of document.querySelectorAll('video')) track(video);
  const attachmentVideo = document.getElementById('attachment-video');
  const attachmentImage = document.getElementById('attachment-image');
  const runtime = createRuntime({window,document,browser,controlsApi,pageState,
    setTimeout(fn,delay) { const id=++serial;timers.set(id,{fn,delay});return id; },
    clearTimeout(id) {timers.delete(id);},
    navigate() {assert.fail('No navigation is allowed in a DM thread by media/comment controls');}
  });
  runtime.registerAdapter(adapter);
  async function flush() {
    for (let turn=0;turn<8;turn+=1) {
      await Promise.resolve();
      for (const [id,timer] of [...timers]) if (timer.delay===0) {timers.delete(id);timer.fn();}
    }
  }
  function change(patch) {
    config = {...config,contentControls:controlsApi.normalize(config.contentControls),configRevision:config.configRevision+1};
    Object.assign(config.contentControls.instagram,patch);
    onChanged.emit({contentControls:{newValue:config.contentControls},configRevision:{newValue:config.configRevision}},'local');
  }
  try {
    await flush();
    assert.equal(runtime.getStatus().failure,null);
    assert.equal(attachmentVideo.getAttribute('data-airlock-hidden'),'instagram.hideVideos');
    assert.equal(window.getComputedStyle(attachmentVideo).display,'none');
    assert.equal(state.get(attachmentVideo).paused,true);
    assert(state.get(attachmentVideo).pauses>0);
    assert.equal(state.get(document.getElementById('security-video')).pauses,0);
    assert.equal(window.getComputedStyle(attachmentImage).display,'none');
    assert.equal(document.getElementById('badge').getAttribute('data-airlock-subdued'),'instagram.unreadBadges');
    for (const id of ['dm-composer','send-action','attachment-action','background-image','background-action','security-qr','challenge-image','named-avatar']) {
      const element=document.getElementById(id);
      assert.notEqual(window.getComputedStyle(element).display,'none',id);
      assert(!element.hasAttribute('data-airlock-hidden'),id);
    }
    const playing=state.get(attachmentVideo);
    playing.paused=false;
    const previousPauses=playing.pauses;
    attachmentVideo.dispatchEvent(new window.Event('play'));
    assert.equal(playing.paused,true);
    assert.equal(playing.pauses,previousPauses+1);

    change({unreadBadges:'hidden'});
    await flush();
    const badge=document.getElementById('badge');
    assert.equal(badge.getAttribute('data-airlock-hidden'),'instagram.unreadBadges');
    assert(!badge.hasAttribute('data-airlock-subdued'));
    assert(!document.getElementById('dm-nav').hasAttribute('data-airlock-hidden'));
    const recycled=document.getElementById('post-reel');
    assert.equal(recycled.getAttribute('data-airlock-hidden'),'instagram.blockReels');
    recycled.href='/p/reels/';
    await flush();
    assert(!recycled.hasAttribute('data-airlock-hidden'));

    const lazy=document.createElement('video');
    const lazyState=track(lazy);
    document.getElementById('inbox').append(lazy);
    await flush();
    assert.equal(lazy.getAttribute('data-airlock-hidden'),'instagram.hideVideos');
    assert.equal(lazyState.paused,true);

    const comment=document.getElementById('comment-action');
    assert(comment.hasAttribute('data-airlock-hidden'));
    comment.innerHTML='Share';
    await flush();
    assert(!comment.hasAttribute('data-airlock-hidden'));

    change({blockReels:false,hideVideos:false,hideImages:false,hideComments:false,unreadBadges:'normal'});
    await flush();
    assert.equal(document.querySelector('[data-airlock-hidden],[data-airlock-subdued]'),null);
    assert.equal(document.querySelector('[data-airlock-controls-style]'),null);
    assert.equal(document.getElementById('attachment-video'),attachmentVideo);
    assert.equal(document.getElementById('attachment-image'),attachmentImage);
    assert.notEqual(window.getComputedStyle(attachmentImage).display,'none');
    assert.equal(playing.plays,0,'Disabling suppression never resumes page-owned media automatically');
    const pausesAfterDisable=playing.pauses;
    attachmentVideo.dispatchEvent(new window.Event('play'));
    assert.equal(playing.pauses,pausesAfterDisable,'Play suppression is removed after disable');

    change({hideVideos:true,hideImages:true});
    await flush();
    assert(attachmentVideo.hasAttribute('data-airlock-hidden'));
    config={...config,contentControlsEnabled:false,configRevision:config.configRevision+1};
    onChanged.emit({contentControlsEnabled:{newValue:false}},'local');
    await flush();
    assert.equal(document.querySelector('[data-airlock-hidden],[data-airlock-subdued],[data-airlock-controls-style]'),null);
    config={...config,contentControlsEnabled:true,configRevision:config.configRevision+1};
    onChanged.emit({contentControlsEnabled:{newValue:true}},'local');
    await flush();
    assert(attachmentVideo.hasAttribute('data-airlock-hidden'));
    runtime.dispose();
    assert.equal(document.querySelector('[data-airlock-hidden],[data-airlock-subdued],[data-airlock-controls-style]'),null);
    assert.equal(runtime.getStatus().disposed,true);
  } finally {runtime.dispose();window.close();}
});
