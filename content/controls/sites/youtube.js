// Renderer coverage adapted from doma-itachi/Youtube-shorts-block (MIT).
// See THIRD_PARTY_NOTICES.md for the complete upstream notice.
(function (scope) {
  'use strict';

  const CARD = 'ytd-video-renderer,ytd-grid-video-renderer,ytd-rich-item-renderer,ytm-video-with-context-renderer,yt-lockup-view-model,ytd-reel-item-renderer,ytm-reel-item-renderer,ytm-shorts-lockup-view-model,yt-shorts-lockup-view-model,shorts-lockup-view-model';
  const SHELF = 'ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-rich-shelf-renderer,grid-shelf-view-model';
  const NAV = 'ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer,ytm-pivot-bar-item-renderer,yt-tab-shape,ytm-tab-renderer,tp-yt-paper-tab';
  const NAV_TITLE = 'a[title="Shorts"],a[title="ショート"]';
  const SHORT_MODEL = 'ytd-reel-item-renderer,ytm-reel-item-renderer,ytm-shorts-lockup-view-model,yt-shorts-lockup-view-model,shorts-lockup-view-model';

  function onYouTube(url) {
    return url && /^https?:$/.test(url.protocol) && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'));
  }

  function parseLink(element, base) {
    try { return new URL(element.getAttribute('href'), base); } catch (_) { return null; }
  }

  function shortId(url) {
    if (!onYouTube(url)) return null;
    const match = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  }

  function validTime(value) {
    return value !== null && value.length <= 20 && /^(?:\d+|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/.test(value) && value !== '';
  }

  // Include enclosing renderers when a thumbnail href or heading text changes.
  function candidates(root, selector) {
    const found = new Set();
    if (!root || !root.querySelectorAll) return found;
    if (root.nodeType === 1 && root.matches(selector)) found.add(root);
    for (const element of root.querySelectorAll(selector)) found.add(element);
    for (let element = root.nodeType === 1 ? root.parentElement : null; element; element = element.parentElement) {
      if (element.matches(selector)) found.add(element);
    }
    return found;
  }

  function shortsCard(element, url) {
    if (element.matches(SHORT_MODEL)) return true;
    // A card's explicit Shorts badge remains evidence when its thumbnail uses a
    // normal watch URL. A badge inside a nested shelf/card never labels the outer
    // rich item, which may also contain ordinary videos.
    if (element.matches('ytd-rich-item-renderer') &&
        Array.from(element.querySelectorAll('span[aria-label="Shorts"]')).some(badge =>
          badge.closest(CARD) === element && !element.contains(badge.closest(SHELF)))) return true;
    const thumbnails = Array.from(element.querySelectorAll('ytd-thumbnail a[href],a#thumbnail[href],a.media-item-thumbnail-container[href],a.yt-lockup-view-model__content-image[href],.yt-lockup-view-model__content-image a[href]'));
    if (thumbnails.length) return thumbnails.every(anchor => shortId(parseLink(anchor, url)));
    return Boolean(element.querySelector(SHORT_MODEL));
  }

  function shortsShelf(element, url) {
    if (element.matches('ytd-reel-shelf-renderer,ytm-reel-shelf-renderer')) return true;
    // The donor also covers rich shelves before Shorts-specific card renderers
    // arrive. Require the exact section name as well as its icon; a generic icon
    // alone is common on ordinary shelves.
    const namedHeading = Array.from(element.querySelectorAll('h2')).some(heading =>
      heading.textContent.trim() === 'Shorts' && heading.querySelector('yt-icon:not([hidden])'));
    if (!element.querySelector(SHORT_MODEL) && !namedHeading) return false;
    const cards = Array.from(element.querySelectorAll(CARD));
    if (!cards.every(card => shortsCard(card, url))) return false;
    // Keep an ambiguous shelf if it includes an ordinary video in newer markup.
    return !Array.from(element.querySelectorAll('a[href]')).some(anchor => {
      const link = parseLink(anchor, url);
      return onYouTube(link) && link.pathname === '/watch';
    });
  }

  function shortsNavigation(element, url) {
    if (element.matches('ytm-pivot-bar-item-renderer') && element.querySelector('.pivot-bar-item-tab.pivot-shorts')) return true;
    if (element.matches(NAV_TITLE) && !element.closest('nav,[role="navigation"],ytd-guide-renderer,ytd-mini-guide-renderer')) return false;
    const links = Array.from(element.querySelectorAll('a[href]'));
    if (element.matches('a[href]')) links.unshift(element);
    return links.some(anchor => {
      const link = parseLink(anchor, url);
      return onYouTube(link) && (shortId(link) || /^\/(?:shorts|(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/shorts)\/?$/.test(link.pathname));
    });
  }

  const adapter = {
    id: 'youtube',
    decideNavigation({ url, controls }) {
      if (!controls || controls.shortsRoute !== 'watch') return null;
      const id = shortId(url);
      if (!id) return null;
      const target = new URL('/watch', url);
      target.searchParams.set('v', id);
      for (const key of ['t', 'start']) {
        const value = url.searchParams.get(key);
        if (validTime(value)) target.searchParams.set(key, value);
      }
      if (!target.searchParams.has('t')) {
        const fragment = /^#t=(.*)$/.exec(url.hash);
        if (fragment && validTime(fragment[1])) target.searchParams.set('t', fragment[1]);
      }
      return { featureId: 'youtube.shortsRoute', targetUrl: target.href };
    },
    collect({ document, root = document, url, controls }) {
      if (!controls || !onYouTube(url)) return [];
      const matches = [];
      if (controls.hideShorts) {
        for (const element of candidates(root, SHELF)) {
          if (shortsShelf(element, url)) matches.push({ element, featureId: 'youtube.hideShorts', effect: 'hide', pauseMedia: true });
        }
        for (const element of candidates(root, CARD)) {
          if (shortsCard(element, url)) matches.push({ element, featureId: 'youtube.hideShorts', effect: 'hide', pauseMedia: true });
        }
      }
      if (controls.hideNavigation) {
        for (const element of candidates(root, NAV + ',' + NAV_TITLE)) {
          if (shortsNavigation(element, url)) matches.push({ element, featureId: 'youtube.hideNavigation', effect: 'hide' });
        }
      }
      return matches;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (scope.AirlockContentRuntime) scope.AirlockContentRuntime.registerAdapter(adapter);
})(typeof globalThis === 'undefined' ? this : globalThis);
