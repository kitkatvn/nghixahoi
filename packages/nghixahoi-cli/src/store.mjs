import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {leftoverTempFiles, writeFileAtomically} from './atomic-file.mjs';
import {addSeenLines, hasSeenLine, NO_SEEN_LINES, readSeenLinesFile, SeenLinesFormatError, writeSeenLinesFile} from './seen-lines.mjs';
import {lineMapsWrittenOnOneLine} from './source-snapshot.mjs';

export const STORE_DIR = path.join(os.homedir(), '.nghixahoi');
export const STORE_PATH = path.join(STORE_DIR, 'state.json');
export const STATE_LOCK_PATH = `${STORE_PATH}.lock`;
// Every line Kit=Code has seen (seen-lines.mjs; docs/security.md, "The seen-lines file"). Written only
// under the state lock, and before state.json in the same update.
export const SEEN_LINES_PATH = path.join(STORE_DIR, 'seen-lines');

// state.json is the user's only copy of their progress, and it names their projects: only they
// may read it.
const STATE_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
// A lock whose holder is a process on this machine that no longer exists is stale at once. One
// whose holder cannot be checked (another machine, or a pid reused since) is stale after this long;
// no update holds the lock for more than a few seconds.
const STALE_LOCK_MS = 10 * 60 * 1000;
// A lock file is written right after it is created. One that is still unreadable after this long
// was left by a process that died in between.
const UNREADABLE_LOCK_MS = 5000;
const STATE_LOCK_BREAK_PATH = `${STATE_LOCK_PATH}.break`;
const STALE_BREAK_MS = 5000;

const KEEP_PROGRESS_ADVICE = 'Kit=Code has left the file as it is, because it holds your progress. ' +
  'Repair it or restore it from a backup; to start again with no progress, move it aside.';

// A file of the user's progress that Kit=Code cannot read or count against: state.json unless
// `filePath` names another. Every command that meets one stops, and nothing is written.
export class StateFileError extends Error {
  constructor(problem, cause, {filePath = STORE_PATH, advice = KEEP_PROGRESS_ADVICE} = {}) {
    super(`Kit=Code cannot read ${filePath}: ${problem}. ${advice}`, {cause});
    this.name = 'StateFileError';
    this.filePath = filePath;
  }
}

export class StateLockError extends Error {
  constructor(message, cause) {
    super(message, {cause});
    this.name = 'StateLockError';
  }
}

function createEmptyState() {
  return {
    version: 4,
    projects: {},
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCountedEntries(entries) {
  const normalized = {};

  if (!entries || typeof entries !== 'object') {
    return normalized;
  }

  for (const [id, entry] of Object.entries(entries)) {
    normalized[id] = {
      equals: Number(entry?.equals) || 0,
      counted_at: entry?.counted_at ?? null,
    };
  }

  return normalized;
}

function normalizeEqualsLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return null;
  }

  const projects = {};

  if (ledger.projects && typeof ledger.projects === 'object') {
    for (const [projectId, projectLedger] of Object.entries(ledger.projects)) {
      if (!projectLedger || typeof projectLedger !== 'object') {
        continue;
      }

      const normalizedProjectId = String(projectLedger.project_id || projectId);
      const countedCommits = normalizeCountedEntries(projectLedger.counted_commits);
      const countedBatches = normalizeCountedEntries(projectLedger.counted_batches);
      const totalEquals = Number(projectLedger.total_equals)
        || Object.values(countedCommits).reduce((sum, entry) => sum + entry.equals, 0)
        + Object.values(countedBatches).reduce((sum, entry) => sum + entry.equals, 0);

      projects[normalizedProjectId] = {
        project_id: normalizedProjectId,
        repo_root: typeof projectLedger.repo_root === 'string' ? projectLedger.repo_root : null,
        source_type: projectLedger.source_type === 'vibe' ? 'vibe' : 'git',
        total_equals: totalEquals,
        counted_commits: countedCommits,
        counted_batches: countedBatches,
        first_counted_at: projectLedger.first_counted_at ?? null,
        last_updated_at: projectLedger.last_updated_at ?? null,
      };
    }
  }

  return {
    total_equals: Object.values(projects).reduce((sum, project) => sum + project.total_equals, 0),
    projects,
    earned_tiers: Array.isArray(ledger.earned_tiers) ? ledger.earned_tiers : [],
    first_counted_at: ledger.first_counted_at ?? null,
    last_updated_at: ledger.last_updated_at ?? null,
  };
}

function normalizeOnboarding(onboarding) {
  if (!onboarding || typeof onboarding !== 'object') {
    return null;
  }

  return {
    completed: onboarding.completed === true,
    autoTrack: onboarding.autoTrack === true,
    companionView: 'mini',
  };
}

// What callers read. Writes never go through this view: they change the file's own object (see
// updateState), so fields this version does not know are kept. Since 2026-09-25 that includes
// rewardSettings: an older Kit=Code's time target, which nothing reads (reward.mjs REWARD_SECONDS).
function normalizeState(state) {
  const ledger = normalizeEqualsLedger(state.equalsLedger);
  const onboarding = normalizeOnboarding(state.onboarding);

  const nextState = {...state};

  if (ledger) {
    nextState.equalsLedger = ledger;
  } else {
    delete nextState.equalsLedger;
  }

  if (onboarding) {
    nextState.onboarding = onboarding;
  } else {
    delete nextState.onboarding;
  }

  return nextState;
}

function describeReadError(error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return `permission denied (${error.code})`;
  }

  if (error.code === 'EISDIR') {
    return 'it is a folder, not a file (EISDIR)';
  }

  return error.code ? `${error.message}` : String(error);
}

// The file's text, or null when there is no file yet. Any other failure is an error: an
// unreadable file must never be mistaken for an empty one.
function readStateText() {
  try {
    return fs.readFileSync(STORE_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw new StateFileError(describeReadError(error), error);
  }
}

function parseState(text) {
  if (text.trim() === '') {
    throw new StateFileError('it is empty');
  }

  let state;

  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new StateFileError(`it is not valid JSON (${error.message})`, error);
  }

  if (!isObject(state)) {
    throw new StateFileError('it does not hold a Kit=Code state object');
  }

  return state;
}

// JSON as JSON.stringify(value, null, 2) writes it, two spaces a level, except that each object in
// `oneLine` is written on one line.
function stringify(value, indent, oneLine, key) {
  if (typeof value?.toJSON === 'function') {
    value = value.toJSON(key);
  }

  if (value === null || typeof value !== 'object' || oneLine.has(value)
    || value instanceof Number || value instanceof String || value instanceof Boolean) {
    return JSON.stringify(value);
  }

  const inner = `${indent}  `;

  if (Array.isArray(value)) {
    const items = value.map((item, index) => `${inner}${stringify(item, inner, oneLine, String(index)) ?? 'null'}`);
    return items.length === 0 ? '[]' : `[\n${items.join(',\n')}\n${indent}]`;
  }

  const members = [];

  for (const name of Object.keys(value)) {
    const text = stringify(value[name], inner, oneLine, name);

    if (text !== undefined) {
      members.push(`${inner}${JSON.stringify(name)}: ${text}`);
    }
  }

  return members.length === 0 ? '{}' : `{\n${members.join(',\n')}\n${indent}}`;
}

// Two spaces a level, as it has always been written, except that the line map of each file of a
// snapshot in this version's format is written on one line: a line map is thousands of keys, and on
// lines of their own they made up most of the file (docs/lessons-learned.md F4).
function serializeState(state) {
  const oneLine = lineMapsWrittenOnOneLine(state);
  return `${oneLine.size === 0 ? JSON.stringify(state, null, 2) : stringify(state, '', oneLine, '')}\n`;
}

// The update in progress in this process, if any: the state as read once under the lock, whether
// anything has changed it, the lines it has seen, and seen-lines as read once under the lock.
let transaction = null;

function transactionState() {
  if (!transaction.loaded) {
    transaction.text = readStateText();
    transaction.state = transaction.text === null ? createEmptyState() : parseState(transaction.text);
    transaction.loaded = true;
  }

  return transaction.state;
}

// Reads state.json. It never writes: a missing file reads as empty progress, and a file that
// cannot be read or parsed throws StateFileError. Inside withStateLock it returns the state that
// update is working on, read once. Treat the result as read-only.
export function loadState() {
  if (transaction) {
    return normalizeState(transactionState());
  }

  const text = readStateText();
  return normalizeState(text === null ? createEmptyState() : parseState(text));
}

// Runs `run` holding the state lock. The first loadState or updateState inside reads the file,
// once. If an updateState changed it, the file is written once at the end, atomically and 0600;
// if `run` throws, nothing is written. Calls nest: an inner one joins the outer.
//
// Lines recorded with recordSeenLines are written to seen-lines first, so that it never lacks a line
// a snapshot in state.json holds: a crash between the two writes leaves it holding more, never less.
// If state.json then cannot be written, seen-lines is put back as it was.
export function withStateLock(run, {lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS} = {}) {
  if (transaction) {
    return run();
  }

  const release = acquireStateLock(lockTimeoutMs);
  transaction = {loaded: false, text: null, state: null, changed: false, seen: new Set(), seeded: false, seenFile: undefined};

  try {
    const result = run();
    const seenBefore = transaction.seen.size > 0 ? writeSeenLines(transaction.seen) : undefined;

    try {
      if (transaction.changed) {
        const next = serializeState(transaction.state);

        if (next !== (transaction.text ?? serializeState(createEmptyState()))) {
          writeState(next);
        }
      }
    } catch (error) {
      if (seenBefore !== undefined) {
        restoreSeenLines(seenBefore);
      }

      throw error;
    }

    return result;
  } finally {
    transaction = null;
    release();
  }
}

// Changes state.json under the lock. `mutate` gets the file's own object, not the normalized view
// loadState returns: change only what you mean to, and everything else, including fields this
// version does not know, is written back as it was.
export function updateState(mutate, options) {
  if (!transaction) {
    return withStateLock(() => updateState(mutate), options);
  }

  const result = mutate(transactionState());
  transaction.changed = true;
  return result;
}

function writeState(text) {
  // Under the lock no other process is writing, so these belong to writers that died mid-write.
  for (const tempPath of leftoverTempFiles(STORE_PATH)) {
    fs.rmSync(tempPath, {force: true});
  }

  writeFileAtomically(STORE_PATH, text, {mode: STATE_FILE_MODE});
}

// Records lines as seen, by their snapshot keys: in the update in progress, or in one of their own.
// They reach seen-lines when the update ends, before state.json. `seeding` says they are the lines of
// every snapshot, from which seen-lines is made when there is none (runtime.mjs migrateState).
export function recordSeenLines(keys, {seeding = false} = {}) {
  if (!transaction) {
    return withStateLock(() => recordSeenLines(keys, {seeding}));
  }

  for (const key of keys) {
    transaction.seen.add(key);
  }

  transaction.seeded ||= seeding;
  return undefined;
}

// Whether seen-lines has been made: it exists, or the update in progress is making it.
export function seenLinesExist() {
  return Boolean(transaction?.seeded) || fs.existsSync(SEEN_LINES_PATH);
}

// The lines in seen-lines, or null when there is no file yet. One that cannot be read, or is not a
// seen-lines file, throws a StateFileError naming it, and is left as it is.
export function loadSeenLines() {
  try {
    return readSeenLinesFile(SEEN_LINES_PATH);
  } catch (error) {
    const problem = error instanceof SeenLinesFormatError ? error.message : describeReadError(error);

    throw new StateFileError(problem, error, {
      filePath: SEEN_LINES_PATH,
      advice: 'Kit=Code has left the file as it is. Restore it from a backup, or move it aside: Kit=Code then makes it again from the snapshots in state.json.',
    });
  }
}

// seen-lines as the update in progress read it, once: null when there is no file.
function transactionSeenLines() {
  if (transaction.seenFile === undefined) {
    transaction.seenFile = loadSeenLines();
  }

  return transaction.seenFile;
}

// Whether a line, by its snapshot key, has been seen before: it is in seen-lines, or this update has
// recorded it. Counting rules that credit a line once per user, ever, ask it (source-snapshot.mjs
// applySourceScan). Only inside withStateLock, where nothing else writes seen-lines.
export function isLineSeen(key) {
  if (!transaction) {
    throw new Error('isLineSeen needs the state lock');
  }

  return transaction.seen.has(key) || hasSeenLine(transactionSeenLines() ?? NO_SEEN_LINES, key);
}

// Adds `keys` to seen-lines. Returns what the file held before, null when there was none, or
// undefined when every line was there already and nothing was written.
function writeSeenLines(keys) {
  const before = transactionSeenLines();
  const lines = addSeenLines(before ?? NO_SEEN_LINES, keys);

  if (before !== null && lines === before) {
    return undefined;
  }

  writeSeenLinesFile(SEEN_LINES_PATH, lines);
  return before;
}

// Puts seen-lines back as it was before an update that could not finish. If that fails too, it keeps
// the lines the update added: more than state.json needs, never less.
function restoreSeenLines(before) {
  try {
    if (before === null) {
      fs.rmSync(SEEN_LINES_PATH, {force: true});
    } else {
      writeSeenLinesFile(SEEN_LINES_PATH, before);
    }
  } catch {
    // The error that stopped the update is the one to report.
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function inspectLock(lockPath) {
  let stat;

  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  let holder = null;

  try {
    holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    holder = null;
  }

  return {holder: isObject(holder) ? holder : null, ino: stat.ino, mtimeMs: stat.mtimeMs};
}

function isStale(lock) {
  const age = Date.now() - lock.mtimeMs;

  if (!lock.holder) {
    return age > UNREADABLE_LOCK_MS;
  }

  const {pid, host} = lock.holder;

  if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
    return true;
  }

  return age > STALE_LOCK_MS;
}

function tryCreate(lockPath, content) {
  let fd;

  try {
    fd = fs.openSync(lockPath, 'wx', STATE_FILE_MODE);
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }

    throw error;
  }

  try {
    fs.writeFileSync(fd, content);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockPath, {force: true});
    throw error;
  }

  fs.closeSync(fd);
  return true;
}

// Removes a stale lock. Breakers take turns through a second lock, so two of them cannot both
// remove the stale lock and then one remove the lock the other has just taken.
function breakStaleLock(examined) {
  if (!tryCreate(STATE_LOCK_BREAK_PATH, String(process.pid))) {
    const breaker = inspectLock(STATE_LOCK_BREAK_PATH);

    // It is held for microseconds; one this old was left by a breaker that died.
    if (breaker && Date.now() - breaker.mtimeMs > STALE_BREAK_MS) {
      fs.rmSync(STATE_LOCK_BREAK_PATH, {force: true});
    }

    return false;
  }

  try {
    const current = inspectLock(STATE_LOCK_PATH);

    if (current && current.ino === examined.ino && current.mtimeMs === examined.mtimeMs && isStale(current)) {
      fs.rmSync(STATE_LOCK_PATH, {force: true});
      return true;
    }

    return false;
  } finally {
    fs.rmSync(STATE_LOCK_BREAK_PATH, {force: true});
  }
}

function describeHolder(lock) {
  if (!lock?.holder) {
    return 'another Kit=Code process';
  }

  const since = lock.holder.since ? ` since ${lock.holder.since}` : '';
  return `Kit=Code process ${lock.holder.pid} on ${lock.holder.host}${since}`;
}

function acquireStateLock(timeoutMs) {
  const token = crypto.randomUUID();
  const content = JSON.stringify({pid: process.pid, host: os.hostname(), since: new Date().toISOString(), token});
  const deadline = Date.now() + timeoutMs;

  try {
    fs.mkdirSync(STORE_DIR, {recursive: true});

    for (;;) {
      if (tryCreate(STATE_LOCK_PATH, content)) {
        return () => releaseStateLock(token);
      }

      const lock = inspectLock(STATE_LOCK_PATH);

      if (lock && isStale(lock) && breakStaleLock(lock)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new StateLockError(
          `${STORE_PATH} is busy: ${describeHolder(lock)} is changing it. Try again in a moment. ` +
          `If no Kit=Code process is running, delete ${STATE_LOCK_PATH}.`,
        );
      }

      sleepSync(LOCK_RETRY_MS);
    }
  } catch (error) {
    if (error instanceof StateLockError) {
      throw error;
    }

    throw new StateLockError(`Kit=Code could not lock ${STORE_PATH}: ${error.message}`, error);
  }
}

function releaseStateLock(token) {
  try {
    if (inspectLock(STATE_LOCK_PATH)?.holder?.token === token) {
      fs.rmSync(STATE_LOCK_PATH, {force: true});
    }
  } catch {
    // A lock that cannot be removed is broken by the next writer once this process has exited.
  }
}

export function onboardingPreferences() {
  return normalizeOnboarding(loadState().onboarding) ?? {
    completed: false,
    autoTrack: true,
    companionView: 'mini',
  };
}

export function saveOnboardingPreferences(preferences) {
  const next = normalizeOnboarding({...preferences, completed: preferences?.completed !== false});

  updateState((state) => {
    state.onboarding = {...(isObject(state.onboarding) ? state.onboarding : {}), ...next};
  });

  return next;
}
