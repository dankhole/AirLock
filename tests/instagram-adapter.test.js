const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {JSDOM} = require('jsdom');
const adapter = require('../content/controls/sites/instagram');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/instagram-semantic.html'), 'utf8');
const defaults = {
  blockReels: false, blockExplore: false, stories: 'show', homeDestination: 'default', hideHomeFeed: false,
  hideComments: false, hideNotes: false, hideThreads: false, hideMetrics: false, unreadBadges: 'normal', hideVideos: false, hideImages: false
};

function page(html = fixture, pathname = '/') {
  return new JSDOM(html, {url: new URL(pathname, 'https://www.instagram.com/').href});
}
function collect(dom, patch = {}, root) {
  return adapter.collect({document: dom.window.document, root: root || dom.window.document,
    url: new URL(dom.window.location.href), controls: {...defaults, ...patch}});
}
function ids(matches, key) {
  return matches.filter(match => !key || match.featureId === 'instagram.' + key).map(match => match.element.id).sort();
}
function navigation(pathname, patch, document, origin = 'https://www.instagram.com') {
  return adapter.decideNavigation({url: new URL(pathname, origin), document, controls: {...defaults, ...patch}});
}

test('browser registration and CommonJS expose the same pure contract', () => {
  const registrations = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/controls/sites/instagram.js'), 'utf8'), {
    AirlockContentRuntime: {registerAdapter: value => registrations.push(value)}
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'instagram');
  assert.deepEqual(Object.keys(adapter).sort(), ['collect', 'decideNavigation', 'id']);
});

test('all off defaults leave every surface intact and do not mutate the page', () => {
  const dom = page();
  const before = dom.window.document.documentElement.outerHTML;
  assert.deepEqual(collect(dom), []);
  assert.equal(navigation('/', defaults, dom.window.document), null);
  collect(dom, {blockReels: true, hideComments: true, hideVideos: true});
  assert.equal(dom.window.document.documentElement.outerHTML, before);
  dom.window.close();
});

test('Reels decisions cover singular, plural and profile routes with one final allowed target', () => {
  for (const origin of ['https://instagram.com', 'https://www.instagram.com', 'https://m.instagram.com']) {
    for (const pathname of ['/reels', '/reels/', '/reels/clip/?source=inbox', '/reel/clip/', '/example/reels/']) {
      for (const [homeDestination, destination] of [['default', '/'], ['following', '/?variant=following'], ['messages', '/direct/inbox/']]) {
        const decision = navigation(pathname, {blockReels: true, homeDestination}, undefined, origin);
        assert.deepEqual(decision, {featureId:'instagram.blockReels', targetUrl:origin + destination});
        assert.equal(navigation(destination, {blockReels:true, homeDestination}, undefined, origin), null);
      }
    }
  }
});

test('parsed route boundaries do not treat queries, substrings, external hosts or posts as Reels', () => {
  for (const pathname of ['/p/video/', '/p/reels/', '/stories/reels/', '/accounts/reels/', '/direct/reels/', '/explore/reels/', '/reelsfan/', '/example/reelsfan/', '/direct/t/thread/?next=/reels/', '/example/?reel=/reel/clip/', '/reel%2Fclip/', '/reels-fan/', '/profile/reels/extra/']) {
    assert.equal(navigation(pathname, {blockReels:true}), null, pathname);
  }
  assert.equal(navigation('/reels/', {blockReels:true}, undefined, 'https://notinstagram.com'), null);
  assert.equal(navigation('/reels/', {blockReels:true}, undefined, 'https://instagram.com.example.com'), null);
  assert.equal(navigation('/reels/', {blockReels:false,homeDestination:'messages'}), null);
  for (const hostname of ['help.instagram.com','about.instagram.com','i.instagram.com']) {
    assert.equal(navigation('/',{homeDestination:'messages'},undefined,'https://'+hostname),null);
    assert.equal(navigation('/reels/',{blockReels:true},undefined,'https://'+hostname),null);
  }
});

test('Home destination is independent of feed visibility and never produces an intermediate redirect', () => {
  assert.deepEqual(navigation('/?variant=home&x=1', {homeDestination:'following',hideHomeFeed:true}),
    {featureId:'instagram.homeDestination',targetUrl:'https://www.instagram.com/?variant=following'});
  assert.equal(navigation('/?variant=following&x=1#feed', {homeDestination:'following'}), null);
  for (const source of ['/', '/?variant=following', '/?variant=favorites']) {
    assert.equal(navigation(source, {homeDestination:'messages'}).targetUrl, 'https://www.instagram.com/direct/inbox/');
  }
  for (const source of ['/direct/inbox/', '/direct/t/thread/', '/example/', '/p/post/', '/explore/search/', '/stories/example/1/']) {
    assert.equal(navigation(source, {homeDestination:'messages',hideHomeFeed:true}), null, source);
  }
  assert.equal(navigation('/', {hideHomeFeed:true}), null);
});

test('Stories blocked includes highlights/direct routes; home-hidden does not block routing', () => {
  for (const source of ['/stories/', '/stories/example/1/', '/stories/highlights/1/']) {
    assert.equal(navigation(source, {stories:'blocked',homeDestination:'messages'}).targetUrl, 'https://www.instagram.com/direct/inbox/');
    assert.equal(navigation(source, {stories:'home-hidden'}), null);
  }
  for (const source of ['/storiesfan/', '/example/?next=/stories/example/1/']) assert.equal(navigation(source, {stories:'blocked'}), null);
});

test('Explore redirects an identified discovery root while preserving Search and ambiguous bootstrap', () => {
  const discovery = page('<main role="main"><div role="grid" aria-label="Explore"><a href="/p/x/">Post</a></div></main>', '/explore/');
  assert.equal(navigation('/explore/', {blockExplore:true,homeDestination:'following'}, discovery.window.document).targetUrl,
    'https://www.instagram.com/?variant=following');
  const publicPage = page('<title>Popular on Instagram</title><main role="main"><div role="status" aria-label="Loading..."></div></main>', '/explore/');
  assert.equal(navigation('/explore/', {blockExplore:true}, publicPage.window.document).featureId, 'instagram.blockExplore');
  const search = page('<main><input type="search" aria-label="Search"><div role="grid" aria-label="Explore"></div></main>', '/explore/');
  assert.equal(navigation('/explore/', {blockExplore:true}, search.window.document), null);
  const empty = page('<main></main>', '/explore/');
  assert.equal(navigation('/explore/', {blockExplore:true}, empty.window.document), null);
  assert.equal(navigation('/explore/', {blockExplore:true}), null);
  for (const source of ['/search/', '/explore/search/?q=example', '/explore/tags/intent/', '/explore/locations/1/', '/explorefan/']) {
    assert.equal(navigation(source, {blockExplore:true}, discovery.window.document), null, source);
  }
  for (const dom of [discovery,publicPage,search,empty]) dom.window.close();
});

test('Reels collection hides entry routes and retains posts/profile/query/external links', () => {
  const dom = page();
  const matches = collect(dom, {blockReels:true});
  assert.deepEqual(ids(matches), ['post-reel','profile-reels','reels-nav']);
  assert(matches.every(match => match.pauseMedia === true));
  assert(!ids(matches).includes('profile-post'));
  dom.window.close();
});

test('Explore collection preserves narrow Search and tagged/location results', () => {
  for (const width of [390,640,767,768,1280]) {
    const dom = page('<nav><a id="explore" href="/explore/">Explore</a><a id="search" href="/explore/" aria-label="Search">Search</a></nav><main><form role="search"><input type="search"></form><div id="discovery" role="grid" aria-label="Explore"><a href="/p/discovery/">Post</a></div><div id="results" role="grid" aria-label="Search results"><a href="/p/result/">Result</a></div><a id="tag" href="/explore/tags/intent/">Tag</a></main>', '/explore/');
    Object.defineProperty(dom.window, 'innerWidth', {value:width});
    assert.deepEqual(ids(collect(dom, {blockExplore:true})), ['discovery','explore']);
    dom.window.close();
  }
});

test('home-hidden Stories affects only the tray; blocked Stories includes profile and post entries', () => {
  const dom = page();
  assert.deepEqual(ids(collect(dom, {stories:'home-hidden'})), ['home-story','story-tray']);
  assert.deepEqual(ids(collect(dom, {stories:'blocked'})), ['home-story','post-story','profile-story','story-tray']);
  dom.reconfigure({url:'https://www.instagram.com/example/'});
  assert.deepEqual(collect(dom, {stories:'home-hidden'}), []);
  dom.window.close();
});

test('feed hiding is scoped to Home/Following articles and preserves post dialogs', () => {
  const dom = page();
  assert.deepEqual(ids(collect(dom, {hideHomeFeed:true})), ['home-post']);
  assert(collect(dom, {hideHomeFeed:true})[0].pauseMedia);
  dom.reconfigure({url:'https://www.instagram.com/?variant=following'});
  assert.deepEqual(ids(collect(dom, {hideHomeFeed:true})), ['home-post']);
  const dialog = dom.window.document.createElement('div');
  dialog.setAttribute('role','dialog');
  dialog.innerHTML = '<article id="modal-post">An ordinary post</article>';
  dom.window.document.querySelector('main').append(dialog);
  assert.deepEqual(ids(collect(dom, {hideHomeFeed:true})), ['home-post']);
  for (const source of ['/example/', '/p/post/', '/direct/inbox/', '/explore/']) {
    dom.reconfigure({url:'https://www.instagram.com'+source});
    assert.deepEqual(collect(dom, {hideHomeFeed:true}), [], source);
  }
  dom.window.close();
});

test('comments hide identified post controls/list/composer while preserving caption/share/DM composer', () => {
  const dom = page();
  const expected = ['comment-action','comment-composer','comment-form','comments-link','comments-list'];
  for (const source of ['/', '/p/example/', '/reel/allowed/', '/example/', '/direct/t/thread/']) {
    dom.reconfigure({url:'https://www.instagram.com'+source});
    assert.deepEqual(ids(collect(dom, {hideComments:true})), expected, source);
  }
  assert(!ids(collect(dom, {hideComments:true})).includes('dm-composer'));
  assert(!ids(collect(dom, {hideComments:true})).includes('caption'));
  dom.window.close();
});

test('Notes is an inbox-only identified surface and retains conversations and composer', () => {
  const dom = page(undefined, '/direct/inbox/');
  assert.deepEqual(ids(collect(dom, {hideNotes:true})), ['note-create','notes']);
  dom.reconfigure({url:'https://www.instagram.com/p/post/'});
  assert.deepEqual(collect(dom, {hideNotes:true}), []);
  dom.window.close();
});

test('Threads identifies promotion/navigation without hiding outbound links in captions', () => {
  const dom = page();
  assert.deepEqual(ids(collect(dom, {hideThreads:true})), ['threads-nav']);
  const spoof = dom.window.document.createElement('a');
  spoof.id='threads-spoof'; spoof.href='https://threads.com.example.com/'; spoof.textContent='Threads';
  dom.window.document.querySelector('nav').append(spoof);
  assert.deepEqual(ids(collect(dom, {hideThreads:true})), ['threads-nav']);
  dom.reconfigure({url:'https://www.instagram.com/direct/t/thread/'});
  assert.deepEqual(ids(collect(dom, {hideThreads:true})), ['threads-nav']);
  assert(!ids(collect(dom,{hideThreads:true})).includes('shared-threads'));
  dom.window.close();
});

test('metric counts retain follower navigation labels and Like/Follow/caption/timestamp content', () => {
  const dom = page();
  assert.deepEqual(ids(collect(dom, {hideMetrics:true})), ['comment-count','followers-count','following-count','like-count','view-count']);
  const hidden = ids(collect(dom, {hideMetrics:true}));
  for (const preserved of ['followers-link','following-link','like-action','caption','timestamp','dm-composer']) assert(!hidden.includes(preserved));
  dom.window.close();
});

test('badge modes affect identified nav cues while retaining inbox navigation and conversation unread text', () => {
  const dom = page(undefined, '/direct/inbox/');
  for (const [mode,effect] of [['subdued','subdue'],['hidden','hide']]) {
    const matches = collect(dom, {unreadBadges:mode});
    assert.deepEqual(ids(matches), ['badge']);
    assert.equal(matches[0].effect,effect);
  }
  assert.deepEqual(collect(dom, {unreadBadges:'normal'}), []);
  const list=dom.window.document.getElementById('conversations');
  const nestedNav=dom.window.document.createElement('nav');
  list.replaceWith(nestedNav);nestedNav.append(list);
  assert.deepEqual(ids(collect(dom,{unreadBadges:'hidden'})),['badge']);
  dom.window.close();
});

test('broad media matches tags while protecting text/background actions, auth/security and image-only controls', () => {
  const dom = page(undefined, '/direct/t/thread/');
  assert.deepEqual(ids(collect(dom, {hideVideos:true})), ['attachment-video','post-video']);
  assert(collect(dom, {hideVideos:true}).every(match=>match.pauseMedia));
  assert.deepEqual(ids(collect(dom, {hideImages:true})), ['attachment-image','avatar','post-image']);
  const hidden = ids(collect(dom,{hideImages:true,hideVideos:true}));
  assert(!hidden.includes('background-image'));
  assert(!hidden.includes('background-action'));
  assert.equal(dom.window.document.getElementById('background-image').textContent,'Background image with preserved text');
  for (const source of ['/accounts/login/', '/challenge/1/', '/checkpoint/', '/settings/', '/accounts/edit/']) {
    dom.reconfigure({url:'https://www.instagram.com'+source});
    assert.deepEqual(collect(dom, {hideImages:true,hideVideos:true}), [], source);
  }
  dom.window.close();
});

test('semantic English/Spanish names work with ARIA labels and do not classify ordinary message text', () => {
  const dom = page('<main><article><button id="comment" aria-label="Comentar">Comentar</button><div id="list" role="region" aria-label="Comentarios"></div><textarea id="composer" aria-label="Añade un comentario"></textarea><button id="like" aria-label="Me gusta">Me gusta</button></article><textarea id="dm" aria-label="Mensaje"></textarea><div id="notes" role="region" aria-label="Notas"></div><p id="ordinary">Comentarios, notas y 25 me gusta</p></main>', '/direct/inbox/');
  assert.deepEqual(ids(collect(dom,{hideComments:true,hideNotes:true,hideMetrics:true})),['comment','composer','list','notes']);
  dom.window.close();
});

test('mutation-scoped collection finds semantic ancestors and recycled hrefs without scanning unrelated posts', () => {
  const dom = page();
  const doc = dom.window.document;
  assert.deepEqual(ids(collect(dom, {hideMetrics:true}, doc.getElementById('followers-count'))), ['followers-count']);
  assert.deepEqual(ids(collect(dom, {hideComments:true}, doc.getElementById('comment-action').firstChild)), ['comment-action']);
  const recycled = doc.getElementById('post-reel');
  assert.deepEqual(ids(collect(dom, {blockReels:true}, recycled)), ['post-reel']);
  recycled.href='/p/ordinary/';
  assert.deepEqual(collect(dom, {blockReels:true}, recycled), []);
  const inserted = doc.createElement('article'); inserted.id='new-post'; inserted.innerHTML='<video id="new-video"></video><button id="new-comment" aria-label="Comment"></button>';
  doc.querySelector('main').append(inserted);
  assert.deepEqual(ids(collect(dom, {hideComments:true,hideVideos:true}, inserted)), ['new-comment','new-video']);
  dom.window.close();
});

test('combined restrictions retain DM/search/profile/post actions and emit independent feature IDs', () => {
  const dom = page(undefined,'/direct/inbox/');
  const controls = {blockReels:true,blockExplore:true,stories:'blocked',hideHomeFeed:true,hideComments:true,hideNotes:true,hideThreads:true,hideMetrics:true,unreadBadges:'hidden',hideVideos:true,hideImages:true,homeDestination:'messages'};
  const matches = collect(dom,controls);
  const hidden = ids(matches);
  for (const id of ['dm-nav','dm-composer','send-action','attachment-action','conversations','search-nav','search-form','search-box','profile-post','followers-link','following-link','caption','like-action','share-action','security-qr','security-video','challenge-image','background-image','background-action']) {
    assert(!hidden.includes(id), id);
  }
  assert.equal(navigation('/direct/inbox/',controls,dom.window.document),null);
  assert(matches.some(match=>match.featureId==='instagram.hideComments'));
  assert(matches.some(match=>match.featureId==='instagram.hideVideos'));
  dom.window.close();
});

test('collection is confined to the Instagram same-origin application', () => {
  const dom = page();
  for (const hostname of ['example.com','help.instagram.com','about.instagram.com','i.instagram.com']) {
    const url=new URL('https://'+hostname+'/reels/');
    assert.deepEqual(adapter.collect({document:dom.window.document,root:dom.window.document,url,controls:{...defaults,blockReels:true,hideImages:true}}),[]);
  }
  dom.window.close();
});
