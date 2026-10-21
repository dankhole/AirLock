(function (root, factory) {
  const controls = factory();
  if (typeof module === "object" && module.exports) module.exports = controls;
  root.AirlockControls = controls;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const VERSION = 1;
  const rows = [
    ["youtube", "hideShorts", "Hide Shorts", "Hide identified Shorts cards and shelves while keeping ordinary videos.", false],
    ["youtube", "hideNavigation", "Hide Shorts navigation", "Hide Shorts menu and tab entry points.", false],
    ["youtube", "shortsRoute", "Shorts links", "Open Shorts in the regular player; the video remains available.", "allow", [["allow", "Allow Shorts"], ["watch", "Regular player"]]],
    ["instagram", "blockReels", "Block Reels", "Hide Reels entry points and redirect Reel routes.", false],
    ["instagram", "blockExplore", "Block Explore", "Hide discovery and redirect Explore while preserving account and text search.", false],
    ["instagram", "stories", "Stories", "Hide the Home tray or restrict all Stories and highlights.", "show", [["show", "Show"], ["home-hidden", "Hide Home tray"], ["blocked", "Block Stories"]]],
    ["instagram", "homeDestination", "Home destination", "Choose where Home opens; profiles, search, and ordinary posts stay accessible.", "default", [["default", "Default Home"], ["following", "Following"], ["messages", "Messages"]]],
    ["instagram", "hideHomeFeed", "Hide Home feed", "Hide Home and Following posts independently of the Home destination.", false],
    ["instagram", "hideComments", "Hide comments", "Hide comment previews, lists, and composers while retaining captions and messages.", false],
    ["instagram", "hideNotes", "Hide Notes", "Hide Notes and their creation controls while keeping conversations.", false],
    ["instagram", "hideThreads", "Hide Threads promotions", "Hide Threads promotion and navigation within Instagram.", false],
    ["instagram", "hideMetrics", "Hide engagement counts", "Hide numerical engagement and follower indicators while keeping actions.", false],
    ["instagram", "unreadBadges", "Unread badges", "Reduce or hide unread cues; browser and OS notifications are unchanged.", "normal", [["normal", "Normal"], ["subdued", "Subdued"], ["hidden", "Hidden"]]],
    ["instagram", "hideVideos", "Hide videos", "Hide videos and pause their playback, including attachments; account access is exempt.", false],
    ["instagram", "hideImages", "Hide images", "Hide images, including avatars and attachments, while keeping text, controls, and account access.", false],
    ["facebook", "hideReels", "Hide Reels", "Hide identified Reel units and navigation while preserving ordinary posts.", false],
    ["facebook", "reelsRoute", "Reel links", "Redirect Reel routes to the same-origin Home page.", "allow", [["allow", "Allow Reels"], ["home", "Redirect to Home"]]],
    ["facebook", "hideStories", "Hide Stories", "Hide the Stories tray and its owned empty space.", false],
    ["facebook", "hideSuggested", "Hide suggestions", "Hide Suggested for you and People you may know units.", false]
  ];
  const catalog = Object.freeze(rows.map(([platform, key, label, description, defaultValue, options]) => {
    const item = { id: platform + "." + key, platform, key, label, description, type: options ? "enum" : "boolean", default: defaultValue };
    if (options) item.options = Object.freeze(options.map(([value, optionLabel]) => Object.freeze({ value, label: optionLabel })));
    return Object.freeze(item);
  }));
  const platforms = ["youtube", "instagram", "facebook"];
  function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  function getDefaults() {
    const result = { version: VERSION, youtube: {}, instagram: {}, facebook: {} };
    catalog.forEach((item) => { result[item.platform][item.key] = item.default; });
    return result;
  }
  function isSupported(raw) { return !isObject(raw) || !Number.isInteger(raw.version) || raw.version <= VERSION; }
  function normalize(raw) {
    const result = getDefaults();
    if (!isObject(raw) || (raw.version !== undefined && raw.version !== VERSION)) return result;
    catalog.forEach((item) => {
      const value = isObject(raw[item.platform]) ? raw[item.platform][item.key] : undefined;
      if ((item.type === "boolean" && typeof value === "boolean") ||
          (item.type === "enum" && item.options.some((option) => option.value === value))) result[item.platform][item.key] = value;
    });
    return result;
  }
  function getPlatform(hostname) {
    if (typeof hostname !== "string") return null;
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return platforms.find((platform) => host === platform + ".com" || host.endsWith("." + platform + ".com")) || null;
  }
  function isActive(platform, controls) {
    if (!platforms.includes(platform) || !isObject(controls)) return false;
    const normalized = normalize(controls.version !== undefined || controls[platform] ? controls : { [platform]: controls });
    return catalog.some((item) => item.platform === platform && normalized[platform][item.key] !== item.default);
  }
  function validatePatch(patch) {
    if (!isObject(patch)) return false;
    return Object.entries(patch).every(([platform, values]) => {
      if (platform === "version") return values === VERSION;
      if (!platforms.includes(platform) || !isObject(values)) return false;
      return Object.entries(values).every(([key, value]) => {
        const item = catalog.find((entry) => entry.platform === platform && entry.key === key);
        return Boolean(item && (item.type === "boolean" ? typeof value === "boolean" : item.options.some((option) => option.value === value)));
      });
    });
  }
  function mergePatch(raw, patch) {
    const next = normalize(raw);
    platforms.forEach((platform) => { if (patch[platform]) Object.assign(next[platform], patch[platform]); });
    return next;
  }
  function classifyPatch(raw, patch) {
    const before = normalize(raw);
    const next = mergePatch(before, patch);
    let stronger = false;
    for (const item of catalog) {
      const from = before[item.platform][item.key];
      const to = next[item.platform][item.key];
      if (from === to) continue;
      let weaker;
      if (item.type === "boolean") weaker = from === true;
      else if (item.key === "stories") weaker = ["show", "home-hidden", "blocked"].indexOf(to) < ["show", "home-hidden", "blocked"].indexOf(from);
      else if (item.key === "unreadBadges") {
        weaker = from === "hidden" && to !== "hidden";
        if (from !== "hidden" && to !== "hidden") continue;
      } else weaker = from !== item.default;
      if (weaker) return "weaker";
      stronger = true;
    }
    return stronger ? "stronger" : "same";
  }
  function getPreset(id) {
    if (id === "short-form") return { contentControls: {
      youtube: { hideShorts: true, hideNavigation: true, shortsRoute: "watch" },
      instagram: { blockReels: true }, facebook: { hideReels: true, reelsRoute: "home" }
    } };
    if (id === "instagram-inbox") return { contentControls: { instagram: { homeDestination: "messages", blockReels: true, blockExplore: true } } };
    return null;
  }
  return { VERSION, catalog, getDefaults, normalize, isSupported, getPlatform, isActive, validatePatch, mergePatch, classifyPatch, getPreset };
});
