/*
 * Original Airlock Instagram adapter. No IGPlus implementation material is used.
 * Matchers use URL boundaries, HTML elements, and accessible roles/names. They
 * deliberately leave unidentified surfaces alone. See the Instagram fixture
 * provenance notes for the limited public-page evidence and live-test gaps.
 */
(function (scope, factory) {
  const adapter = factory();
  if (typeof module === 'object' && module.exports) module.exports = adapter;
  if (scope.AirlockContentRuntime) scope.AirlockContentRuntime.registerAdapter(adapter);
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MAIN = 'main,[role="main"]';
  const POST = 'article,[role="article"]';
  const INTERACTIVE = 'a[href],button,[role="button"],[role="link"]';
  const SEMANTIC_SCOPE = POST + ',a[href],button,[role="button"],form,[role="dialog"],[role="region"],[role="list"],[role="feed"],nav,[role="navigation"]';
  const CANDIDATES = 'a[href],button,input,textarea,article,main,video,img,[role],[aria-label],[aria-labelledby]';
  const APP_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
  const RESERVED_ROOTS = new Set(['p', 'direct', 'explore', 'search', 'stories', 'accounts', 'challenge', 'checkpoint', 'oauth', 'two_factor', 'privacy', 'settings', 'reel', 'reels']);
  const WORDS = {
    search: /^(?:search|search instagram|buscar|búsqueda)$/iu,
    discovery: /^(?:explore|discover|popular on instagram|explorar|descubrir)$/iu,
    stories: /^(?:stories|story|view story|highlights|historias|ver historia|historias destacadas)$/iu,
    comments: /^(?:comments?|view comments|add a comment(?:…|\.\.\.)?|write a comment|comentarios?|comentar|añade un comentario|agrega un comentario)$/iu,
    notes: /^(?:notes?|add (?:a )?note|leave (?:a )?note|your note|notas?|añadir nota|agregar nota|tu nota)$/iu,
    threads: /^(?:threads|open threads|abrir threads)$/iu,
    protection: /(?:\b(?:account|security|authentication|log in|login|sign up|password|verification|qr code)\b|cuenta|seguridad|contraseña|verificación|iniciar sesión)/iu,
    unread: /(?:\bunread\b|sin leer|no leíd[oa]s?)/iu,
    metric: /(?:\b(?:likes|comments|views|followers|following)\b|me gusta|comentarios|visualizaciones|seguidores|seguidos)/iu
  };
  const COUNT = /^[\p{N}]+(?:[.,\s][\p{N}]+)*(?:[.,][\p{N}]+)?\s*[KMBkmb]?\+?$/u;

  function supported(url) {
    return url && /^https?:$/.test(url.protocol) && APP_HOSTS.has(url.hostname);
  }

  function segments(url) {
    try {
      const path = decodeURIComponent(url.pathname);
      // Encoded separators do not identify a trusted route boundary.
      if (/%2f|%5c/i.test(url.pathname) || path.includes('\\')) return [];
      return path.split('/').filter(Boolean);
    } catch (_) { return []; }
  }

  function route(url) {
    const parts = segments(url);
    const first = parts[0];
    const home = url.pathname === '/' || url.pathname === '';
    return {
      parts, home,
      following: home && url.searchParams.get('variant') === 'following',
      reels: first === 'reel' || first === 'reels' || (parts.length === 2 && parts[1] === 'reels' && !RESERVED_ROOTS.has(first)),
      stories: first === 'stories',
      explore: parts.length === 1 && first === 'explore',
      search: first === 'search' || (first === 'explore' && ['search', 'tags', 'locations'].includes(parts[1])),
      direct: first === 'direct',
      post: first === 'p' && parts.length >= 2,
      protected: ['accounts', 'challenge', 'checkpoint', 'oauth', 'two_factor', 'privacy', 'settings'].includes(first)
    };
  }

  function name(element, document) {
    const label = element.getAttribute('aria-label');
    if (label) return label.trim();
    const ids = element.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    const text = (element.textContent || '').trim();
    if (text) return text;
    // SVG labels can name a control without coupling to graphic path data.
    return element.querySelector('[aria-label]')?.getAttribute('aria-label')?.trim() || '';
  }

  function hasSearch(root, document) {
    if (!root || !root.querySelectorAll) return false;
    if (root.querySelector('input[type="search"],[role="searchbox"],form[role="search"],[role="search"]')) return true;
    return Array.from(root.querySelectorAll('input,form,[role="dialog"]')).some(el => WORDS.search.test(name(el, document)));
  }

  function discoverySurface(element, document, currentRoute) {
    if (!currentRoute.explore || element.closest('[role="search"],form[role="search"]')) return false;
    if (!element.matches(MAIN + ',[role="grid"],[role="feed"],[role="region"]')) return false;
    if (hasSearch(element, document)) return false;
    return WORDS.discovery.test(name(element, document)) ||
      (element.matches(MAIN) && document.title === 'Popular on Instagram');
  }

  function discoveryOnly(document, currentRoute) {
    if (!document || !currentRoute.explore || hasSearch(document, document)) return false;
    return Array.from(document.querySelectorAll(MAIN + ',[role="grid"],[role="feed"],[role="region"]'))
      .some(element => discoverySurface(element, document, currentRoute));
  }

  function destination(url, controls) {
    if (controls.homeDestination === 'messages') return new URL('/direct/inbox/', url.origin).href;
    if (controls.homeDestination === 'following') return new URL('/?variant=following', url.origin).href;
    return new URL('/', url.origin).href;
  }

  function decideNavigation({url, controls, document}) {
    if (!supported(url) || !controls) return null;
    const current = route(url);
    let featureId = null;
    if (controls.blockReels && current.reels) featureId = 'instagram.blockReels';
    else if (controls.stories === 'blocked' && current.stories) featureId = 'instagram.stories';
    else if (controls.blockExplore && discoveryOnly(document, current)) featureId = 'instagram.blockExplore';
    else if (current.home && (controls.homeDestination === 'messages' ||
      (controls.homeDestination === 'following' && !current.following))) featureId = 'instagram.homeDestination';
    if (!featureId) return null;
    const targetUrl = destination(url, controls);
    return targetUrl === url.href ? null : {featureId, targetUrl};
  }

  function sameOriginLink(element, url) {
    if (!element.matches('a[href]')) return null;
    try {
      const target = new URL(element.getAttribute('href'), url.href);
      return supported(target) && target.origin === url.origin ? target : null;
    } catch (_) { return null; }
  }

  function inNavigation(element) {
    return !!element.closest('nav,[role="navigation"],header,footer,[role="contentinfo"]');
  }

  function postContext(element, current) {
    if (element.closest(POST)) return true;
    const dialog = element.closest('[role="dialog"]');
    if (dialog && dialog.querySelector(POST)) return true;
    return (current.post || current.reels) && !!element.closest(MAIN) && !inNavigation(element);
  }

  function homeContent(element, current) {
    return current.home && !!element.closest(MAIN) &&
      !element.closest('[role="dialog"],nav,[role="navigation"],aside,[role="complementary"]');
  }

  function protectedMedia(element, current, document) {
    if (current.protected) return true;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.matches('form,[role="dialog"],[role="region"]')) {
        if (WORDS.protection.test(name(ancestor, document)) ||
          ancestor.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]')) return true;
      }
    }
    // An image that supplies the only name of a page-owned control must remain
    // available: a pure collector cannot replace its accessible name safely.
    const control = element.closest(INTERACTIVE);
    return element.matches('img') && !!control &&
      !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby') && !control.textContent.trim();
  }

  function collect({document, root, url, controls}) {
    if (!supported(url) || !document || !controls) return [];
    const current = route(url);
    let scope = root || document;
    if (scope.nodeType === 3) scope = scope.parentElement;
    if (!scope || !scope.querySelectorAll) return [];
    if (scope.nodeType === 1) scope = scope.closest(SEMANTIC_SCOPE) || scope;
    const candidates = Array.from(scope.querySelectorAll(CANDIDATES));
    if (scope.nodeType === 1 && scope.matches(CANDIDATES)) candidates.unshift(scope);
    const matches = [];
    const seen = new Map();
    function add(element, key, effect = 'hide', pauseMedia = false) {
      if (!element || element.nodeType !== 1) return;
      const signature = key + ':' + effect;
      if (!seen.has(element)) seen.set(element, new Set());
      if (seen.get(element).has(signature)) return;
      seen.get(element).add(signature);
      const match = {element, featureId: 'instagram.' + key, effect};
      if (pauseMedia) match.pauseMedia = true;
      matches.push(match);
    }
    function counts(parent) {
      for (const child of parent.querySelectorAll('span,strong,b')) {
        if (!child.children.length && COUNT.test(child.textContent.trim())) add(child, 'hideMetrics');
      }
    }

    for (const element of candidates) {
      const label = name(element, document);
      const link = sameOriginLink(element, url);
      const target = link ? route(link) : null;
      const isControl = element.matches(INTERACTIVE);
      const inPost = postContext(element, current);
      if (controls.blockReels && target?.reels) add(element, 'blockReels', 'hide', true);
      if (controls.blockExplore) {
        if (target?.explore && !WORDS.search.test(label) && !element.closest('[role="search"],form[role="search"]')) add(element, 'blockExplore');
        if (discoverySurface(element, document, current)) add(element, 'blockExplore', 'hide', true);
      }
      if (controls.stories === 'blocked' || controls.stories === 'home-hidden') {
        const storyContainer = element.closest('[role="list"],[role="region"]');
        const homeStory = homeContent(element, current) && !element.closest(POST) &&
          !!storyContainer && WORDS.stories.test(name(storyContainer, document));
        const semanticStory = WORDS.stories.test(label) && element.matches(INTERACTIVE + ',[role="list"],[role="region"]');
        if ((target?.stories || semanticStory) && (controls.stories === 'blocked' || homeStory)) add(element, 'stories', 'hide', true);
      }
      if (controls.hideHomeFeed && homeContent(element, current) && element.matches(POST)) add(element, 'hideHomeFeed', 'hide', true);
      if (controls.hideComments && inPost) {
        const commentLink = target?.parts[0] === 'p' && target.parts.length >= 3 && target.parts[2] === 'comments';
        const commentName = WORDS.comments.test(label) || /^(?:view all [\d,.]+ comments|ver (?:los )?[\d,.]+ comentarios)$/iu.test(label);
        if (commentLink || (commentName && element.matches(INTERACTIVE + ',textarea,input,[role="textbox"],[role="list"],[role="region"],form'))) add(element, 'hideComments');
      }
      if (controls.hideNotes && current.direct && WORDS.notes.test(label) &&
        element.matches(INTERACTIVE + ',[role="list"],[role="region"]')) add(element, 'hideNotes');
      if (controls.hideThreads && !inPost) {
        let threadsLink = false;
        if (element.matches('a[href]')) {
          try { const host = new URL(element.getAttribute('href'), url.href).hostname; threadsLink = host === 'threads.net' || host.endsWith('.threads.net') || host === 'threads.com' || host.endsWith('.threads.com'); } catch (_) { /* Invalid link: no match. */ }
        }
        if ((threadsLink && inNavigation(element)) ||
          (isControl && inNavigation(element) && WORDS.threads.test(label) &&
            (!element.matches('a[href]') || !!link))) add(element, 'hideThreads');
      }
      if (controls.hideMetrics) {
        const parts = target?.parts || [];
        const profileCounts = parts.length === 2 && !RESERVED_ROOTS.has(parts[0]) && ['followers', 'following'].includes(parts[1]);
        const engagementCounts = parts[0] === 'p' && parts.length === 3 && ['liked_by', 'comments'].includes(parts[2]);
        if (profileCounts || engagementCounts) counts(element);
        // Counts need their own semantic label; arbitrary digits in captions,
        // timestamps, messages, and action names are never a metric match.
        if (inPost && element.matches('span,strong,b,output,[role="status"]') && WORDS.metric.test(label) && /\p{N}/u.test(label) &&
          !element.matches(INTERACTIVE) && !element.querySelector(INTERACTIVE) &&
          (element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby'))) add(element, 'hideMetrics');
      }
      if (controls.unreadBadges && controls.unreadBadges !== 'normal' && !isControl &&
        !element.querySelector(INTERACTIVE) && WORDS.unread.test(label) &&
        (COUNT.test(element.textContent.trim()) || /\p{N}/u.test(label))) {
        const navLink = element.closest('a[href]');
        const navTarget = navLink && sameOriginLink(navLink, url);
        const navParts = navTarget ? segments(navTarget) : [];
        const inboxEntry = navParts[0] === 'direct' && (navParts.length === 1 || navParts.length === 2 && navParts[1] === 'inbox');
        const conversationEntry = navParts[0] === 'direct' && navParts[1] === 't';
        if (!conversationEntry && (inNavigation(element) || inboxEntry || navParts[0] === 'accounts' && navParts[1] === 'activity')) {
          add(element, 'unreadBadges', controls.unreadBadges === 'subdued' ? 'subdue' : 'hide');
        }
      }
      const hideVideo = controls.hideVideos && element.matches('video');
      const hideImage = controls.hideImages && element.matches('img');
      if ((hideVideo || hideImage) && !protectedMedia(element, current, document)) {
        if (hideVideo) add(element, 'hideVideos', 'hide', true);
        // The shared hide effect removes a whole element. CSS backgrounds may
        // decorate text/actions, so leave them intact rather than hide owners.
        if (hideImage) add(element, 'hideImages');
      }
    }
    return matches;
  }

  return {id: 'instagram', decideNavigation, collect};
});
