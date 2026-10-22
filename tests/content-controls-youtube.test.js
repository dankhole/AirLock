const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../content/controls/sites/youtube.js');
const controlsApi = require('../shared/content-controls.js');
const { createRuntime } = require('../content/controls/runtime.js');
const { createPageState } = require('../shared/page-state.js');

const defaults = { hideShorts: false, hideNavigation: false, shortsRoute: 'allow' };
function fixture(html, href = 'https://www.youtube.com/') {
  const document = new JSDOM(html, { url: href }).window.document;
  return { document, url: new URL(href) };
}
function scan(context, controls, root) {
  return adapter.collect({ ...context, root: root || context.document, controls: { ...defaults, ...controls } });
}
function ids(matches) { return [...new Set(matches.map(match => match.element.id))].sort(); }
function navigation(href, shortsRoute = 'watch') {
  return adapter.decideNavigation({ url: new URL(href), controls: { ...defaults, shortsRoute } });
}

test('Shorts conversion validates host, path, ID and preserves origin and safe time only', () => {
  for (const host of ['www.youtube.com', 'm.youtube.com', 'youtube.com']) {
    const decision = navigation(`https://${host}/shorts/Abc_12-dEf3/?t=1m2s&feature=share#ignored`);
    assert.deepEqual(decision, { featureId: 'youtube.shortsRoute', targetUrl: `https://${host}/watch?v=Abc_12-dEf3&t=1m2s` });
  }
  assert.equal(navigation('https://www.youtube.com/shorts/Abc_12-dEf3?start=42').targetUrl, 'https://www.youtube.com/watch?v=Abc_12-dEf3&start=42');
  assert.equal(navigation('https://www.youtube.com/shorts/Abc_12-dEf3#t=2h3m4s').targetUrl, 'https://www.youtube.com/watch?v=Abc_12-dEf3&t=2h3m4s');
  assert.equal(navigation('https://www.youtube.com/shorts/Abc_12-dEf3?t=javascript:bad&start=-1').targetUrl, 'https://www.youtube.com/watch?v=Abc_12-dEf3');
  for (const href of [
    'https://www.youtube.com/', 'https://www.youtube.com/shorts',
    'https://www.youtube.com/shorts/too-short', 'https://www.youtube.com/shorts/Abc_12-dEf34',
    'https://www.youtube.com/shorts/Abc_12-dEf3/extra', 'https://www.youtube.com/shorts/Abc%2F12-dE3',
    'https://www.youtube.com/watch?v=Abc_12-dEf3&next=/shorts/Abc_12-dEf3',
    'https://www.youtube.com/playlist?list=shorts/Abc_12-dEf3',
    'https://youtube.com.evil.test/shorts/Abc_12-dEf3', 'https://notyoutube.com/shorts/Abc_12-dEf3',
    'ftp://youtube.com/shorts/Abc_12-dEf3', 'https://www.youtube.com/%73horts/Abc_12-dEf3'
  ]) assert.equal(navigation(href), null, href);
  assert.equal(navigation('https://www.youtube.com/shorts/Abc_12-dEf3', 'allow'), null);
});

test('desktop and mobile shelves and thumbnails preserve regular siblings and generic shelves', () => {
  const context = fixture(`
    <ytd-reel-shelf-renderer id="desktop-shelf"><video></video></ytd-reel-shelf-renderer>
    <ytm-reel-shelf-renderer id="mobile-shelf"></ytm-reel-shelf-renderer>
    <ytd-rich-shelf-renderer id="rich-shorts"><h2>Shorts</h2><ytd-reel-item-renderer></ytd-reel-item-renderer></ytd-rich-shelf-renderer>
    <grid-shelf-view-model id="new-shelf"><ytm-shorts-lockup-view-model></ytm-shorts-lockup-view-model></grid-shelf-view-model>
    <ytd-rich-shelf-renderer id="regular-shelf"><h2><yt-icon></yt-icon>Music</h2><ytd-video-renderer id="normal"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer></ytd-rich-shelf-renderer>
    <ytd-video-renderer id="desktop-card"><ytd-thumbnail><a href="/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer>
    <ytd-grid-video-renderer id="channel-card"><ytd-thumbnail><a href="/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-grid-video-renderer>
    <ytd-rich-item-renderer id="rich-card"><a id="thumbnail" href="/shorts/Abc_12-dEf3"></a></ytd-rich-item-renderer>
    <ytm-video-with-context-renderer id="mobile-card"><a class="media-item-thumbnail-container" href="/shorts/Abc_12-dEf3"></a></ytm-video-with-context-renderer>
    <ytd-video-renderer id="description-link"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3"></a></ytd-thumbnail><div id="description"><a href="/shorts/Abc_12-dEf3">a mentioned Short</a></div></ytd-video-renderer>
    <ytd-video-renderer id="query-link"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3&next=/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer>
    <ytd-video-renderer id="external"><ytd-thumbnail><a href="https://evil.test/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer>
    <ytd-comments id="comments"><a href="/shorts/Abc_12-dEf3">comment</a></ytd-comments>
    <video id="watch-player"></video>
  `);
  const html = context.document.documentElement.outerHTML;
  const matches = scan(context, { hideShorts: true }).filter(match => match.element.id);
  assert.deepEqual(ids(matches), ['channel-card', 'desktop-card', 'desktop-shelf', 'mobile-card', 'mobile-shelf', 'new-shelf', 'rich-card', 'rich-shorts']);
  assert.ok(matches.every(match => match.featureId === 'youtube.hideShorts' && match.pauseMedia === true && match.effect === 'hide'));
  assert.equal(context.document.documentElement.outerHTML, html, 'collector must not modify DOM');
  assert.deepEqual(scan(context, defaults), []);
});

test('Shorts navigation is independent and only matches navigation renderers', () => {
  const context = fixture(`
    <ytd-guide-entry-renderer id="shorts-nav"><a href="/shorts" title="Shorts">Shorts</a></ytd-guide-entry-renderer>
    <ytd-mini-guide-entry-renderer id="mini"><a href="/shorts/">ショート</a></ytd-mini-guide-entry-renderer>
    <ytm-pivot-bar-item-renderer id="mobile-nav"><div class="pivot-bar-item-tab pivot-shorts"></div></ytm-pivot-bar-item-renderer>
    <yt-tab-shape id="channel-tab"><a href="/@example/shorts">Shorts</a></yt-tab-shape>
    <yt-tab-shape id="channel-id-tab"><a href="/channel/UC_example/shorts/">Shorts</a></yt-tab-shape>
    <yt-tab-shape id="custom-channel-tab"><a href="/c/Example/shorts">Shorts</a></yt-tab-shape>
    <yt-tab-shape id="user-channel-tab"><a href="/user/Example/shorts">Shorts</a></yt-tab-shape>
    <yt-tab-shape id="videos-tab"><a href="/@example/videos">Videos</a></yt-tab-shape>
    <yt-tab-shape id="invalid-channel-tab"><a href="/something/shorts">Not a known channel route</a></yt-tab-shape>
    <ytd-guide-entry-renderer id="subscriptions"><a href="/feed/subscriptions">Subscriptions</a></ytd-guide-entry-renderer>
    <ytd-guide-entry-renderer id="lookalike"><a href="https://youtube.com.evil.test/shorts" title="Shorts">Shorts</a></ytd-guide-entry-renderer>
    <a id="ordinary-link" href="/shorts" title="Shorts">Content link</a>
  `);
  const matches = scan(context, { hideNavigation: true });
  assert.deepEqual(ids(matches), ['channel-id-tab', 'channel-tab', 'custom-channel-tab', 'mini', 'mobile-nav', 'shorts-nav', 'user-channel-tab']);
  assert.ok(matches.every(match => match.featureId === 'youtube.hideNavigation'));
  assert.deepEqual(scan(context, { hideShorts: true }), []);
});

test('mixed generic shelves retain ordinary video siblings while hiding positive Shorts cards', () => {
  const context = fixture(`<ytd-rich-shelf-renderer id="mixed-rich"><h2><yt-icon></yt-icon>Mixed videos</h2><ytm-shorts-lockup-view-model id="short"></ytm-shorts-lockup-view-model><ytd-video-renderer id="ordinary"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer></ytd-rich-shelf-renderer>
    <grid-shelf-view-model id="mixed-grid"><shorts-lockup-view-model id="short-grid"></shorts-lockup-view-model><yt-lockup-view-model id="ordinary-grid"><a class="yt-lockup-view-model__content-image" href="/watch?v=Abc_12-dEf3"></a></yt-lockup-view-model></grid-shelf-view-model>`);
  assert.deepEqual(ids(scan(context, { hideShorts: true })), ['short', 'short-grid']);
});

test('donor-backed Shorts heading, badge and individual sidebar routes retain conservative boundaries', () => {
  // These are reduced reproductions of the donor's richShelf/channel/title-link
  // selectors, not captures of an authenticated current YouTube document.
  const context = fixture(`
    <ytd-rich-shelf-renderer id="heading-shelf"><h2><yt-icon></yt-icon>Shorts</h2><div><a href="/shorts/Abc_12-dEf3">Short</a></div></ytd-rich-shelf-renderer>
    <ytd-rich-shelf-renderer id="ordinary-heading"><h2><yt-icon></yt-icon>Music</h2></ytd-rich-shelf-renderer>
    <ytd-rich-shelf-renderer id="mixed-heading"><h2><yt-icon></yt-icon>Shorts</h2><a href="/watch?v=Abc_12-dEf3">Normal video</a></ytd-rich-shelf-renderer>
    <ytd-rich-item-renderer id="badge-card"><span aria-label="Shorts"></span></ytd-rich-item-renderer>
    <ytd-rich-item-renderer id="watch-url-badge-card"><span aria-label="Shorts"></span><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3">A Short with a watch URL</a></ytd-thumbnail></ytd-rich-item-renderer>
    <ytd-rich-item-renderer id="ordinary-badge"><span aria-label="Shorts highlights"></span><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3">Normal video</a></ytd-thumbnail></ytd-rich-item-renderer>
    <ytd-rich-item-renderer id="mixed-outer"><ytd-rich-shelf-renderer id="nested-mixed"><h2><yt-icon></yt-icon>Shorts</h2><ytd-rich-item-renderer id="nested-short"><span aria-label="Shorts"></span></ytd-rich-item-renderer><ytd-video-renderer><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3">Normal sibling</a></ytd-thumbnail></ytd-video-renderer></ytd-rich-shelf-renderer></ytd-rich-item-renderer>
    <ytd-guide-entry-renderer id="individual-nav"><a href="/shorts/Abc_12-dEf3" title="Shorts">Shorts</a></ytd-guide-entry-renderer>
    <nav><a id="title-nav" href="/shorts/Abc_12-dEf3" title="Shorts">Shorts</a><a id="external-nav" href="https://example.com/shorts/Abc_12-dEf3" title="Shorts">Shorts</a></nav>
    <a id="ordinary-title-link" href="/shorts/Abc_12-dEf3" title="Shorts">A post mentioning Shorts</a>
  `);
  assert.deepEqual(ids(scan(context, {hideShorts: true})), ['badge-card', 'heading-shelf', 'nested-short', 'watch-url-badge-card']);
  assert.deepEqual(ids(scan(context, {hideNavigation: true})), ['individual-nav', 'title-nav']);
});

test('affected roots, repeated scans and reused thumbnail URLs have fresh classifications', () => {
  const context = fixture('<section><ytd-video-renderer id="card"><ytd-thumbnail><a href="/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer><ytd-video-renderer id="normal"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer></section>');
  const anchor = context.document.querySelector('#card a');
  assert.deepEqual(ids(scan(context, { hideShorts: true }, anchor)), ['card']);
  assert.deepEqual(ids(scan(context, { hideShorts: true }, anchor)), ['card']);
  anchor.href = '/watch?v=Abc_12-dEf3';
  assert.deepEqual(scan(context, { hideShorts: true }, anchor), []);
  anchor.href = '/shorts/Abc_12-dEf3';
  assert.deepEqual(scan(context, { hideShorts: false }, anchor), []);
  const replacement = context.document.createElement('ytd-reel-shelf-renderer');
  replacement.id = 'replacement';
  context.document.querySelector('section').replaceWith(replacement);
  assert.deepEqual(ids(scan(context, { hideShorts: true }, replacement)), ['replacement']);
});

test('runtime restores Shorts nodes across live toggles, queued disable, DOM reuse and disposal', async () => {
  const dom = new JSDOM('<ytd-video-renderer id="card"><ytd-thumbnail><a href="/shorts/Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer><ytd-video-renderer id="ordinary"><ytd-thumbnail><a href="/watch?v=Abc_12-dEf3"></a></ytd-thumbnail></ytd-video-renderer>', { url: 'https://www.youtube.com/' });
  const { window } = dom;
  let saved = { enabled: true, contentControls: { version: 1, youtube: { hideShorts: true } }, configRevision: 1 };
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
    const card = window.document.querySelector('#card');
    const anchor = card.querySelector('a');
    assert.equal(card.getAttribute('data-airlock-hidden'), 'youtube.hideShorts');
    assert.equal(window.document.querySelector('#ordinary').hasAttribute('data-airlock-hidden'), false);
    change({ enabled: false });
    await settle();
    assert.equal(card.hasAttribute('data-airlock-hidden'), false);
    assert.equal(window.document.querySelector('[data-airlock-controls-style]'), null);
    change({ enabled: true });
    await settle();
    assert.equal(card.getAttribute('data-airlock-hidden'), 'youtube.hideShorts');
    anchor.href = '/watch?v=Abc_12-dEf3';
    await settle();
    assert.equal(card.hasAttribute('data-airlock-hidden'), false, 'reused normal card restored');
    anchor.href = '/shorts/Abc_12-dEf3';
    change({ enabled: false });
    await settle();
    assert.equal(card.hasAttribute('data-airlock-hidden'), false, 'queued scan cannot enforce after disable');
    change({ enabled: true });
    await settle();
    assert.equal(card.getAttribute('data-airlock-hidden'), 'youtube.hideShorts');
    runtime.dispose();
    assert.equal(card.hasAttribute('data-airlock-hidden'), false);
    assert.equal(window.document.querySelector('[data-airlock-controls-style]'), null);
    assert.equal(storageListeners.size, 0);
    assert.equal(messageListeners.size, 0);
  } finally {
    runtime.dispose();
    window.close();
  }
});
