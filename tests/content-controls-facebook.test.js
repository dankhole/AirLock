const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../content/controls/sites/facebook.js');
const controlsApi = require('../shared/content-controls.js');
const { createRuntime } = require('../content/controls/runtime.js');
const { createPageState } = require('../shared/page-state.js');

const defaults = { hideReels: false, reelsRoute: 'allow', hideStories: false, hideSuggested: false };
function fixture(html, href = 'https://www.facebook.com/') {
  const document = new JSDOM(html, { url: href }).window.document;
  return { document, url: new URL(href) };
}
function scan(context, controls, root) {
  return adapter.collect({ ...context, root: root || context.document, controls: { ...defaults, ...controls } });
}
function ids(matches) { return [...new Set(matches.map(match => match.element.id))].sort(); }

test('Reel routes redirect only Facebook slash-bounded paths to same-origin home', () => {
  for (const host of ['www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com', 'facebook.com']) {
    for (const path of ['/reel/123', '/reels', '/reels/', '/share/r/abc', '/reel?source=nav']) {
      const url = new URL(`https://${host}${path}`);
      assert.deepEqual(adapter.decideNavigation({ url, controls: { reelsRoute: 'home' } }), { featureId: 'facebook.reelsRoute', targetUrl: `https://${host}/` });
      assert.equal(adapter.decideNavigation({ url, controls: defaults }), null);
    }
  }
  for (const href of ['https://facebook.com/', 'https://facebook.com/reelistic', 'https://facebook.com/reelsaved', 'https://facebook.com/share/random', 'https://facebook.com/watch?next=/reel/1', 'https://facebook.com/groups/123/reels', 'https://facebook.com.evil.test/reel/1', 'https://notfacebook.com/reels', 'ftp://facebook.com/reels']) {
    assert.equal(adapter.decideNavigation({ url: new URL(href), controls: { reelsRoute: 'home' } }), null, href);
  }
});

test('Reels identify dedicated feed units and navigation but preserve shared posts and Stories', () => {
  const context = fixture(`
    <nav><ul><li id="nav"><a href="/reels/">Reels</a></li><li id="home"><a href="/">Home</a></li></ul></nav>
    <div data-pagelet="Stories" id="stories"><div role="button" aria-label="Reels" id="reel-tab">Reels</div><a href="/stories/1">Story</a></div>
    <div role="feed">
      <div role="article" id="reel"><h3>Reels</h3><a href="/reel/123">Watch</a><video></video></div>
      <div data-pagelet="ReelsTray" id="pagelet"><a href="/reel/456">Watch</a></div>
      <div role="article" id="shared"><p>My friend shared this video</p><a id="shared-link" href="/share/r/abc">Their Reel</a><video></video></div>
      <div role="article" id="normal"><p>Freelance work</p><div aria-label="Freelance work">Hello</div><a href="/watch/123">Video</a></div>
      <div role="article" id="query"><a href="/watch?redirect=/reel/123">Unrelated</a></div>
      <div role="article" id="external"><a href="https://facebook.com.evil.test/reels">External</a></div>
      <div role="article" id="reelistic"><a href="/reelistic">Not a Reel</a></div>
      <div role="article" id="suggested"><h3>Suggested for you</h3></div>
      <div role="article" id="pymk"><h3>People you may know</h3></div>
    </div>
    <div id="composer"><div role="button">What's on your mind?</div></div>
    <div id="marketplace"><a href="/marketplace">Marketplace</a></div>
  `);
  const html = context.document.documentElement.outerHTML;
  const matches = scan(context, { hideReels: true });
  assert.deepEqual(ids(matches), ['', 'nav', 'pagelet', 'reel', 'reel-tab', 'shared-link']);
  assert.ok(!matches.some(match => match.element.id === 'shared' || match.element.id === 'stories'));
  assert.ok(matches.every(match => match.featureId === 'facebook.hideReels' && match.effect === 'hide'));
  assert.equal(context.document.documentElement.outerHTML, html);
  assert.deepEqual(scan(context, defaults), []);
  assert.deepEqual(ids(scan(context, { hideSuggested: true })), ['pymk', 'suggested']);
  assert.deepEqual(ids(scan(context, { hideStories: true })), ['stories']);
});

test('localized Reel headings are exact and unrelated labels or mentions remain visible', () => {
  for (const label of ['Reels', 'ريلز', '릴스', 'リール', '短视频']) {
    const context = fixture(`<div role="feed"><div role="article" id="positive"><h2>${label}</h2><video></video></div><div role="article" id="mention"><h2>About ${label} today</h2></div><div role="article" id="text"><span>${label}</span></div></div>`);
    assert.deepEqual(ids(scan(context, { hideReels: true })), ['positive']);
  }
  const context = fixture('<div aria-label="Reel estate">a shop</div><div data-sigil="unrelatedreel">ordinary</div><div data-store=\'{"message":"reel"}\'>ordinary JSON</div>');
  assert.deepEqual(scan(context, { hideReels: true }), []);
});

test('donor-backed span headings require a bounded tray with multiple Reel destinations', () => {
  // The donor scans exact Reels spans. Repeated Reel cards provide the extra
  // structural evidence needed to collapse a tray rather than an ordinary post.
  const context = fixture(`<div role="feed">
    <div data-pagelet="FeedUnit_1" id="span-tray"><div><span>Reels</span></div><a href="/reel/123"><img></a><a href="/reel/456"><img></a></div>
    <div role="article" id="shared-post"><span>Reels</span><p>My friend shared these videos</p><a id="shared-one" href="/reel/123">One</a><a id="shared-two" href="/reel/456">Two</a></div>
    <div role="article" id="single-post"><span>Reels</span><a id="single-link" href="/reel/123">Watch</a></div>
    <div role="article" id="duplicate-post"><span>Reels</span><a id="duplicate-one" href="/reel/123">Watch</a><a id="duplicate-two" href="/reel/123">Watch again</a></div>
    <div role="article" id="span-caption-post"><span>Reels</span><div><span>My ordinary post about these videos</span></div><a href="/reel/123"><img></a><a href="/reel/456"><img></a></div>
  </div>`);
  const matches = ids(scan(context, {hideReels: true}));
  assert(matches.includes('span-tray'));
  for (const id of ['shared-post', 'single-post', 'duplicate-post', 'span-caption-post']) assert(!matches.includes(id), id);
  const label = context.document.querySelector('#span-tray span');
  assert(ids(scan(context, {hideReels: true}, label)).includes('span-tray'));
  label.textContent = 'Videos';
  assert(!ids(scan(context, {hideReels: true}, label)).includes('span-tray'));
});

test('a shared Reel URL never hides an ordinary list-backed article or message', () => {
  const context = fixture(`<ul><li id="ordinary-post"><article><p>Ordinary post text</p><a id="shared" href="/reel/123">Shared Reel</a><p>More text</p></article></li>
    <li id="message"><div>Here is something I found <a id="message-link" href="/reel/456">video</a> yesterday</div></li>
    <li id="plain-post"><p>Another post</p><a id="post-link" href="/reels/">Reels</a></li>
    <li id="photo-post"><img src="photo.jpg"><a id="photo-link" href="/reel/123">Reel</a></li>
    <li id="icon-action"><button aria-label="Separate action"><svg></svg></button><a id="icon-link" href="/reel/123">Reel</a></li></ul>
    <div role="article" id="labelled-post"><p>My friend shared this</p><a id="labelled-link" href="/reel/789" aria-label="Reels">Reels</a><div role="button" id="reel-button" aria-label="Reels">Open Reel</div></div>`);
  assert.deepEqual(ids(scan(context, { hideReels: true })), ['icon-link', 'labelled-link', 'message-link', 'photo-link', 'post-link', 'reel-button', 'shared']);
});

test('Stories wrapper collapse is bounded and respects ordinary text and sibling content', () => {
  const context = fixture(`
    <main><div id="wrap1"><div><div data-focus-target="stories_tray" id="tray"><video></video></div></div></div></main>
    <div id="mixed"><div data-pagelet="Stories" id="old-tray"></div><p id="normal-sibling">Normal content</p></div>
    <div id="with-text">ordinary text<div data-focus-target="stories_tray" id="text-tray"></div></div>
    <div role="article" id="post"><div data-focus-target="stories_tray" id="post-tray"></div></div>
  `);
  assert.deepEqual(ids(scan(context, { hideStories: true })), ['old-tray', 'post-tray', 'text-tray', 'wrap1']);
  assert.deepEqual(scan(context, { hideReels: true }), []);
});

test('mobile semantic containers preserve neighboring posts and unrelated heights', () => {
  const context = fixture(`
    <div role="feed"><div data-mcomponent="MContainer" id="mobile" data-actual-height="464"><div data-mcomponent="TextArea">Reels</div><a href="/reel/123">Watch</a></div>
      <div data-mcomponent="MContainer" id="regular" data-actual-height="464"><div data-mcomponent="TextArea">Friend's post</div><a href="/watch/123">Video</a></div>
      <div data-sigil="mComposite" id="suggested-mobile" data-actual-height="500"><div data-mcomponent="TextArea">People you may know</div><a href="/friends/">Friends</a></div>
    </div>
    <div data-mcomponent="MContainer" id="outer"><div data-mcomponent="MContainer" id="inner-reel" data-actual-height="460"><h3>Reels</h3><a href="/reel/123">Watch</a></div><div data-mcomponent="MContainer" id="inner-normal"><p>Ordinary</p></div></div>
    <div role="feed"><div data-mcomponent="MContainer" id="single-neighbor-wrapper" data-actual-height="460"><h3 id="standalone-header">Reels</h3><div data-mcomponent="MContainer" id="single-neighbor"><p>Ordinary neighboring post</p></div></div></div>
    <div data-actual-height="460" id="height-only"><p>Height is not evidence</p></div>
    <div style="height:464px" id="style-only"><p>Also ordinary</p></div>
  `, 'https://m.facebook.com/');
  const matches = scan(context, { hideReels: true });
  assert.ok(ids(matches).includes('mobile'));
  assert.ok(ids(matches).includes('inner-reel'));
  for (const id of ['outer', 'inner-normal', 'regular', 'height-only', 'style-only', 'single-neighbor-wrapper', 'single-neighbor']) assert.ok(!ids(matches).includes(id), id);
  assert.deepEqual(ids(scan(context, { hideSuggested: true })), ['suggested-mobile']);
});

test('reused nodes, subtree scans and separate sections are freshly classified without markers', () => {
  const context = fixture('<div role="feed"><div role="article" id="unit"><h3>Reels</h3><a href="/reel/123">Watch</a></div><div role="article" id="ordinary"><p>Ordinary</p></div></div>');
  const heading = context.document.querySelector('h3');
  assert.ok(ids(scan(context, { hideReels: true }, heading)).includes('unit'));
  heading.textContent = 'People you may know';
  context.document.querySelector('#unit a').href = '/friends/';
  assert.deepEqual(scan(context, { hideReels: true }, heading), []);
  assert.deepEqual(ids(scan(context, { hideSuggested: true }, heading)), ['unit']);
  assert.deepEqual(scan(context, { hideSuggested: false }, heading), []);
  assert.deepEqual(ids(scan(context, { hideSuggested: true }, heading)), ['unit']);
  assert.equal(context.document.querySelector('[data-reels-blocked]'), null);
  const overlap = fixture('<div role="article" id="overlap"><h3>Suggested for you</h3><div data-pagelet="Reels" id="nested"><video></video></div></div>');
  const matches = scan(overlap, { hideReels: true, hideSuggested: true });
  assert.ok(matches.some(match => match.element.id === 'overlap' && match.featureId === 'facebook.hideSuggested'));
  assert.ok(matches.some(match => match.element.id === 'nested' && match.featureId === 'facebook.hideReels'));
  assert.deepEqual(ids(scan(overlap, { hideReels: true })), ['nested']);
});

test('runtime reconciles section overlaps, recycled nodes, live settings and complete cleanup', async () => {
  const dom = new JSDOM('<div role="feed"><div role="article" id="unit"><h3>Suggested for you</h3><div data-pagelet="Reels" id="reel"></div></div><div role="article" id="ordinary"><p>Normal</p></div></div><div data-focus-target="stories_tray" id="stories"></div>', { url: 'https://www.facebook.com/' });
  const { window } = dom;
  let saved = { enabled: true, contentControls: { version: 1, facebook: { hideReels: true, hideSuggested: true, hideStories: true } }, configRevision: 1 };
  const storageListeners = new Set();
  const messageListeners = new Set();
  const event = listeners => ({ addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) });
  const browser = { storage: { local: { get: async () => saved }, onChanged: event(storageListeners) }, runtime: { onMessage: event(messageListeners) } };
  const pageState = createPageState();
  pageState.setCore({ ready: true, coreMode: 'none' });
  const runtime = createRuntime({ window, document: window.document, browser, controlsApi, pageState });
  runtime.registerAdapter(adapter);
  const settle = () => new Promise(resolve => window.setTimeout(resolve, 25));
  const change = patch => {
    saved = { ...saved, ...patch, configRevision: saved.configRevision + 1 };
    for (const listener of storageListeners) listener({ configRevision: { newValue: saved.configRevision } }, 'local');
  };
  try {
    await settle();
    const unit = window.document.querySelector('#unit');
    const reel = window.document.querySelector('#reel');
    const stories = window.document.querySelector('#stories');
    assert.equal(unit.getAttribute('data-airlock-hidden'), 'facebook.hideSuggested');
    assert.equal(reel.getAttribute('data-airlock-hidden'), 'facebook.hideReels');
    assert.equal(stories.getAttribute('data-airlock-hidden'), 'facebook.hideStories');
    assert.equal(window.document.querySelector('#ordinary').hasAttribute('data-airlock-hidden'), false);
    change({ contentControls: { version: 1, facebook: { hideReels: true, hideSuggested: false, hideStories: true } } });
    await settle();
    assert.equal(unit.hasAttribute('data-airlock-hidden'), false);
    assert.equal(reel.getAttribute('data-airlock-hidden'), 'facebook.hideReels');
    assert.equal(stories.getAttribute('data-airlock-hidden'), 'facebook.hideStories');
    reel.removeAttribute('data-pagelet');
    reel.textContent = 'Ordinary recycled content';
    await settle();
    assert.equal(reel.hasAttribute('data-airlock-hidden'), false);
    reel.setAttribute('data-pagelet', 'Reels');
    change({ enabled: false });
    await settle();
    assert.equal(window.document.querySelector('[data-airlock-hidden]'), null);
    change({ enabled: true });
    await settle();
    assert.equal(reel.getAttribute('data-airlock-hidden'), 'facebook.hideReels');
    runtime.dispose();
    assert.equal(window.document.querySelector('[data-airlock-hidden]'), null);
    assert.equal(window.document.querySelector('[data-airlock-controls-style]'), null);
    assert.equal(storageListeners.size, 0);
    assert.equal(messageListeners.size, 0);
  } finally {
    runtime.dispose();
    window.close();
  }
});
