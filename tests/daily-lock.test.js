const test = require("node:test");
const assert = require("node:assert/strict");
const dailyLock = require("../shared/daily-lock.js");

function localTime(day, hours, minutes, seconds = 0) {
  return new Date(2026, 0, day, hours, minutes, seconds, 0).getTime();
}

function schedule(start, end) {
  return { enabled: true, start: start, end: end };
}

test("normalizes valid times and rejects malformed values", () => {
  assert.equal(dailyLock.normalizeTimeOfDay("09:05", "22:00"), "09:05");
  assert.equal(dailyLock.normalizeTimeOfDay("9:05", "22:00"), "22:00");
  assert.equal(dailyLock.normalizeTimeOfDay("24:00", "22:00"), "22:00");
  assert.equal(dailyLock.normalizeTimeOfDay("12:60", "22:00"), "22:00");
});

test("locks within a same-day window and unlocks at its end", () => {
  const before = dailyLock.getState(schedule("09:00", "17:00"), localTime(15, 8, 59));
  const atStart = dailyLock.getState(schedule("09:00", "17:00"), localTime(15, 9, 0));
  const inside = dailyLock.getState(schedule("09:00", "17:00"), localTime(15, 12, 30));
  const atEnd = dailyLock.getState(schedule("09:00", "17:00"), localTime(15, 17, 0));

  assert.equal(before.locked, false);
  assert.equal(before.nextBoundaryType, "start");
  assert.equal(atStart.locked, true);
  assert.equal(inside.locked, true);
  assert.equal(inside.unlockAt, localTime(15, 17, 0));
  assert.equal(atEnd.locked, false);
  assert.equal(atEnd.nextBoundaryType, "start");
});

test("supports overnight windows on both sides of midnight", () => {
  const evening = dailyLock.getState(schedule("22:00", "07:00"), localTime(15, 23, 0));
  const morning = dailyLock.getState(schedule("22:00", "07:00"), localTime(16, 6, 30));
  const daytime = dailyLock.getState(schedule("22:00", "07:00"), localTime(16, 12, 0));

  assert.equal(evening.locked, true);
  assert.equal(evening.unlockAt, localTime(16, 7, 0));
  assert.equal(morning.locked, true);
  assert.equal(morning.unlockAt, localTime(16, 7, 0));
  assert.equal(daytime.locked, false);
  assert.equal(daytime.nextBoundaryType, "start");
  assert.equal(daytime.nextBoundaryAt, localTime(16, 22, 0));
});

test("treats the end boundary as unlocked even after seconds have elapsed", () => {
  const state = dailyLock.getState(schedule("22:00", "07:00"), localTime(16, 7, 0, 30));

  assert.equal(state.locked, false);
  assert.equal(state.nextBoundaryType, "start");
});

test("disables invalid zero-length schedules", () => {
  const state = dailyLock.getState(schedule("08:30", "08:30"), localTime(15, 8, 30));

  assert.equal(state.valid, false);
  assert.equal(state.locked, false);
  assert.equal(state.nextBoundaryAt, null);
});

test("does not schedule boundaries when the daily lock is disabled", () => {
  const state = dailyLock.getState(
    { enabled: false, start: "22:00", end: "07:00" },
    localTime(15, 23, 0)
  );

  assert.equal(state.enabled, false);
  assert.equal(state.valid, true);
  assert.equal(state.locked, false);
  assert.equal(state.nextBoundaryAt, null);
});

test("calculates scheduled duration across midnight", () => {
  assert.equal(dailyLock.getDurationMinutes("22:00", "07:00"), 9 * 60);
  assert.equal(dailyLock.getDurationMinutes("23:00", "07:00"), 8 * 60);
  assert.equal(dailyLock.getDurationMinutes("09:00", "17:30"), 8 * 60 + 30);
  assert.equal(dailyLock.getDurationMinutes("09:00", "09:00"), 0);
});

test("classifies schedule changes by locked-time coverage", () => {
  assert.equal(
    dailyLock.classifyScheduleChange("22:00", "07:00", "21:00", "08:00"),
    "stronger"
  );
  assert.equal(
    dailyLock.classifyScheduleChange("22:00", "07:00", "23:00", "07:00"),
    "weaker"
  );
  assert.equal(
    dailyLock.classifyScheduleChange("22:00", "07:00", "21:00", "06:00"),
    "weaker"
  );
  assert.equal(
    dailyLock.classifyScheduleChange("09:00", "17:00", "09:00", "17:00"),
    "same"
  );
  assert.equal(
    dailyLock.classifyScheduleChange("09:00", "09:00", "08:00", "17:00"),
    "invalid"
  );
});
