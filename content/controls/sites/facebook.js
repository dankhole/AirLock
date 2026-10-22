// Section and container coverage adapted from safwat-fathi/facebook-reels-blocker (MIT).
// See THIRD_PARTY_NOTICES.md for the complete upstream notice.
(function (scope) {
  'use strict';

  const REEL_HEADERS = new Set(['Reels', 'ريلز', '릴스', 'リール', '短视频']);
  const SUGGESTED_HEADERS = new Set(['Suggested for you', 'People you may know']);
  const STORIES = '[data-focus-target="stories_tray"],[data-pagelet="Stories"]';
  const UNIT = '[data-pagelet^="FeedUnit"],[role="article"],[data-pagelet^="Reels"],li,[data-mcomponent="MContainer"],[data-sigil="mtop-section"],[data-sigil="mComposite"]';
  const HEADINGS = 'h2,h3,[role="heading"],[data-mcomponent="TextArea"]';
  const SIGNALS = `${STORIES},${HEADINGS},span,a[href],[aria-label],[data-pagelet^="Reels"],[data-sigil],[data-store]`;

  function onFacebook(url) {
    return url && /^https?:$/.test(url.protocol) && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'));
  }

  function reelRoute(url) {
    return onFacebook(url) && /^\/(?:reels?|share\/r)(?:\/|$)/.test(url.pathname);
  }

  function linkUrl(element, base) {
    try { return new URL(element.getAttribute('href'), base); } catch (_) { return null; }
  }

  function text(element) { return (element.textContent || '').trim().replace(/\s+/g, ' '); }

  function exactReelLabel(element) {
    return REEL_HEADERS.has((element.getAttribute('aria-label') || '').trim()) ||
      (element.matches(HEADINGS) && REEL_HEADERS.has(text(element)));
  }

  function mobileUnit(element) {
    // Heights alone are never Reel evidence. This is only called for a semantic header.
    for (let cur = element, depth = 0; cur && depth < 6; cur = cur.parentElement, depth++) {
      if (cur.matches('body,[role="main"],[role="feed"],main')) break;
      if (cur.matches('[data-mcomponent="MContainer"],[data-sigil="mtop-section"],[data-sigil="mComposite"]')) {
        // Do not take a wrapper holding several independent posts or trays.
        if (cur.querySelectorAll('[role="article"],[data-pagelet^="FeedUnit"],'+STORIES).length) continue;
        if (Array.from(cur.querySelectorAll('[data-mcomponent="MContainer"]')).some(child => !child.contains(element))) continue;
        const height = Number(cur.getAttribute('data-actual-height'));
        if ((height >= 300 || cur.querySelector('video,a[href]')) && (!height || height >= 300)) return cur;
      }
    }
    return null;
  }

  function unitContainer(element, allowArticle) {
    for (let cur = element; cur && !cur.matches('body,html,main,[role="main"],[role="feed"]'); cur = cur.parentElement) {
      if (cur.matches(STORIES)) return null;
      if (cur.matches('[data-pagelet^="Reels"]')) return cur;
      if (!allowArticle && cur.matches('article,[data-pagelet^="FeedUnit"],[role="article"]')) return null;
      if (allowArticle && cur.matches('[data-pagelet^="FeedUnit"],[role="article"]')) return cur;
      if (cur.tagName === 'LI' && cur.parentElement && cur.parentElement.matches('ul,ol,[role="list"]')) {
        return allowArticle || safeLinkUnit(cur, element) ? cur : null;
      }
      if (cur.parentElement && cur.parentElement.matches('[role="list"]')) {
        return allowArticle || safeLinkUnit(cur, element) ? cur : null;
      }
      if (allowArticle && cur.parentElement && cur.parentElement.matches('[role="feed"]')) {
        return mobileUnit(element) || (cur.querySelectorAll('[role="article"],[data-pagelet^="FeedUnit"],[data-mcomponent="MContainer"]').length === 0 ? cur : null);
      }
    }
    return allowArticle ? mobileUnit(element) : null;
  }

  function safeLinkUnit(container, anchor) {
    // Only collapse a navigation/pure link slot. Ordinary list posts and messages
    // may share a Reel link alongside text or other content.
    if (container.querySelector('article,[role="article"],[data-pagelet^="FeedUnit"],p,video')) return false;
    if (text(container) !== text(anchor) || container.querySelectorAll('a[href]').length !== 1) return false;
    // Textless photos and independent icon actions are still neighboring content.
    return Array.from(container.querySelectorAll('*')).every(child =>
      child === anchor || anchor.contains(child) || child.contains(anchor));
  }

  function spanReelTray(element, url) {
    if (!element.matches('span') || element.childElementCount || !REEL_HEADERS.has(text(element))) return null;
    const unit = unitContainer(element, true);
    if (!unit || unit.querySelector('p,article,[contenteditable="true"],[role="textbox"]')) return null;
    const destinations = new Set();
    for (const anchor of unit.querySelectorAll('a[href]')) {
      const target = linkUrl(anchor, url);
      if (target && reelRoute(target) && anchor.querySelector('img,video')) {
        destinations.add(target.origin + target.pathname.replace(/\/$/, ''));
      }
    }
    if (destinations.size < 2) return null;
    // Facebook posts often use spans rather than paragraphs. Text outside the
    // tray label/cards/actions is still an ordinary caption, even with Reel URLs.
    const textNodes = unit.ownerDocument.createTreeWalker(unit, 4 /* SHOW_TEXT */);
    for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
      if (!node.textContent.trim() || element.contains(node) ||
          node.parentElement.closest('a[href],button,[role="button"]')) continue;
      return null;
    }
    return unit;
  }

  function soleWrapper(element) {
    let top = element;
    for (let depth = 0; depth < 3; depth++) {
      const parent = top.parentElement;
      if (!parent || parent.tagName !== 'DIV' || parent.matches('[role="main"],[role="feed"],[role="article"],[role="navigation"]') || parent.childElementCount !== 1 || parent.querySelector('[role="article"],[role="feed"]')) break;
      // Text beside a tray is ordinary content even if it has only one element child.
      if (Array.from(parent.childNodes).some(node => node.nodeType === 3 && node.textContent.trim())) break;
      top = parent;
    }
    return top;
  }

  function candidates(root) {
    const found = new Set();
    if (!root || !root.querySelectorAll) return found;
    if (root.nodeType === 1 && root.matches(SIGNALS)) found.add(root);
    for (const element of root.querySelectorAll(SIGNALS)) found.add(element);
    // Reclassify an enclosing unit when the runtime passes a changed thumbnail/text subtree.
    for (let cur = root.nodeType === 1 ? root : null; cur && !cur.matches('body,html,main,[role="main"],[role="feed"]'); cur = cur.parentElement) {
      if (cur.matches(UNIT+','+STORIES)) {
        if (cur.matches(SIGNALS)) found.add(cur);
        for (const element of cur.querySelectorAll(SIGNALS)) found.add(element);
        break;
      }
    }
    return found;
  }

  const adapter = {
    id: 'facebook',
    decideNavigation({ url, controls }) {
      return controls && controls.reelsRoute === 'home' && reelRoute(url)
        ? { featureId: 'facebook.reelsRoute', targetUrl: new URL('/', url).href }
        : null;
    },
    collect({ document, root = document, url, controls }) {
      if (!controls || !onFacebook(url)) return [];
      const matches = [];
      const seen = new Map();
      function mark(element, featureId, pauseMedia) {
        if (!element) return;
        const keys = seen.get(element) || new Set();
        if (keys.has(featureId)) return;
        keys.add(featureId);
        seen.set(element, keys);
        matches.push({ element, featureId, effect: 'hide', ...(pauseMedia ? { pauseMedia: true } : {}) });
      }
      for (const element of candidates(root)) {
        if (controls.hideStories && element.matches(STORIES)) mark(soleWrapper(element), 'facebook.hideStories', true);
        if (controls.hideSuggested && element.matches(HEADINGS) && SUGGESTED_HEADERS.has(text(element))) {
          mark(unitContainer(element, true), 'facebook.hideSuggested', true);
        }
        if (!controls.hideReels) continue;
        const spanTray = spanReelTray(element, url);
        if (spanTray) mark(spanTray, 'facebook.hideReels', true);
        const labelled = exactReelLabel(element);
        const pagelet = element.matches('[data-pagelet^="Reels"]');
        // Mobile sigils are a token list, not a substring of an arbitrary JSON value.
        const sigil = (element.getAttribute('data-sigil') || '').split(/\s+/).some(value => /^(?:reel|reels)(?:-|$)/.test(value));
        if (labelled || pagelet || sigil) {
          const dedicatedUnit = pagelet || sigil || element.matches(HEADINGS+',article,[role="article"],[data-pagelet^="FeedUnit"]');
          // A link or button labelled Reels can still belong to an ordinary post.
          mark(unitContainer(element, dedicatedUnit) || element, 'facebook.hideReels', true);
        } else if (element.matches('a[href]') && reelRoute(linkUrl(element, url))) {
          // A shared Reel URL is not proof the surrounding ordinary post is a Reel.
          mark(unitContainer(element, false) || element, 'facebook.hideReels', true);
        }
      }
      return matches;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (scope.AirlockContentRuntime) scope.AirlockContentRuntime.registerAdapter(adapter);
})(typeof globalThis === 'undefined' ? this : globalThis);
