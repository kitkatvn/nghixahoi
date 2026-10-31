// Focus time: one clock for all projects (operator decision Q3, 2026-09-24; docs/reward-rules.md
// §4). A wall-clock second is active when any registered project had real activity within the idle
// window before it, and it counts once, however many projects were active in it. Nothing is active
// until the first real activity: not after a tracker starts, not after a project is added.
//
// Pure: the tracker passes in every time, so the arithmetic is tested without waiting.

export const IDLE_WINDOW_MS = 5 * 60 * 1000;

// When activity keeps a clock active. `coveredUntil` is the end of the window of the activity
// already counted; activity recorded since the last advance is pending until the next one.
export function createActivityWindow() {
  return {coveredUntil: 0, pendingStart: null, pendingUntil: 0};
}

export function recordActivity(window, at) {
  window.pendingStart = window.pendingStart === null ? at : Math.min(window.pendingStart, at);
  window.pendingUntil = Math.max(window.pendingUntil, at + IDLE_WINDOW_MS);
}

// Splits the interval (from, to] into active and idle milliseconds, and moves the window on. An
// activity recorded after the interval it happened in, as a scan's result is, counts from `from`.
export function advanceWindow(window, from, to) {
  // A time that is not a number would turn every counter it touches into NaN, which is written to
  // state.json as null and read back as 0: stop here instead.
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new TypeError(`advanceWindow needs two times, and got ${from} and ${to}`);
  }

  const span = Math.max(0, to - from);
  let activeMs = Math.max(0, Math.min(to, window.coveredUntil) - from);

  if (window.pendingStart !== null) {
    const start = Math.max(from, window.pendingStart, window.coveredUntil);
    const end = Math.min(to, window.pendingUntil);
    activeMs += Math.max(0, end - start);
    window.coveredUntil = Math.max(window.coveredUntil, window.pendingUntil);
    window.pendingStart = null;
    window.pendingUntil = 0;
  }

  activeMs = Math.min(activeMs, span);
  return {activeMs, idleMs: span - activeMs};
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The shared clock as stored in state.json, or null in a file written before it existed.
export function storedFocusTime(state) {
  if (!isObject(state?.focusTime)) {
    return null;
  }

  const activeSeconds = seconds(state.focusTime.activeSeconds);
  return activeSeconds === null ? null : {activeSeconds, idleSeconds: seconds(state.focusTime.idleSeconds) ?? 0};
}

// Time as a file without the shared clock counted it: summed over its projects.
export function summedProjectTime(state) {
  const projects = Object.values(isObject(state?.projects) ? state.projects : {}).filter(isObject);

  return {
    activeSeconds: projects.reduce((sum, project) => sum + (seconds(project.activeSeconds) ?? 0), 0),
    idleSeconds: projects.reduce((sum, project) => sum + (seconds(project.idleSeconds) ?? 0), 0),
  };
}

// Focus time as every reader sees it: the shared clock, or, in a file that predates it, the summed
// total the clock will start from. So nobody's earned time goes down when the rule changes.
export function focusTimeFrom(state) {
  return storedFocusTime(state) ?? summedProjectTime(state);
}

// A shared clock for a file that has none: it starts from the file's summed total, and records it.
export function startedFocusTime(state, at = new Date()) {
  const {activeSeconds, idleSeconds} = summedProjectTime(state);

  return {activeSeconds, idleSeconds, carriedOver: {activeSeconds, idleSeconds, at: at.toISOString()}};
}
