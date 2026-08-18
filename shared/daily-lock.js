(function (root, factory) {
  const dailyLock = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = dailyLock;
  }

  root.AirlockDailyLock = dailyLock;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_START = "22:00";
  const DEFAULT_END = "07:00";
  const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

  function parseTimeOfDay(value) {
    if (typeof value !== "string") return null;

    const match = TIME_PATTERN.exec(value);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;

    return {
      hours: hours,
      minutes: minutes,
      minuteOfDay: hours * 60 + minutes
    };
  }

  function normalizeTimeOfDay(value, fallback) {
    const parsed = parseTimeOfDay(value);
    if (parsed) {
      return String(parsed.hours).padStart(2, "0") + ":" + String(parsed.minutes).padStart(2, "0");
    }

    return fallback;
  }

  function getNextOccurrence(timeOfDay, now) {
    const parsed = parseTimeOfDay(timeOfDay);
    if (!parsed) return null;

    const current = new Date(now);
    const next = new Date(current);
    next.setHours(parsed.hours, parsed.minutes, 0, 0);

    if (next.getTime() <= current.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime();
  }

  function getState(config, nowValue) {
    const now = new Date(nowValue === undefined ? Date.now() : nowValue);
    const enabled = config && config.enabled === true;
    const start = parseTimeOfDay(config && config.start);
    const end = parseTimeOfDay(config && config.end);

    if (!enabled || !start || !end || start.minuteOfDay === end.minuteOfDay) {
      return {
        enabled: enabled,
        valid: Boolean(start && end && start.minuteOfDay !== end.minuteOfDay),
        locked: false,
        unlockAt: null,
        nextBoundaryAt: null,
        nextBoundaryType: null
      };
    }

    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const crossesMidnight = start.minuteOfDay > end.minuteOfDay;
    const locked = crossesMidnight
      ? currentMinute >= start.minuteOfDay || currentMinute < end.minuteOfDay
      : currentMinute >= start.minuteOfDay && currentMinute < end.minuteOfDay;
    const nextStartAt = getNextOccurrence(config.start, now);
    const nextEndAt = getNextOccurrence(config.end, now);
    const nextBoundaryType = nextStartAt < nextEndAt ? "start" : "end";
    const nextBoundaryAt = Math.min(nextStartAt, nextEndAt);

    return {
      enabled: true,
      valid: true,
      locked: locked,
      unlockAt: locked ? nextEndAt : null,
      nextBoundaryAt: nextBoundaryAt,
      nextBoundaryType: nextBoundaryType
    };
  }

  return {
    DEFAULT_START: DEFAULT_START,
    DEFAULT_END: DEFAULT_END,
    parseTimeOfDay: parseTimeOfDay,
    normalizeTimeOfDay: normalizeTimeOfDay,
    getNextOccurrence: getNextOccurrence,
    getState: getState
  };
});
