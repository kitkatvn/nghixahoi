import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import {addSourceEqualsOnce, equalsLedgerFrom, loadEqualsLedger, removeProjectEquals} from './equals-ledger.mjs';
import {countCommits, createFolderProjectId, createProjectId, detectRepoRoot, listWorktrees, tryDetectRepoRoot} from './git.mjs';
import {
  isLineSeen,
  loadSeenLines,
  loadState,
  recordSeenLines,
  seenLinesExist,
  STORE_PATH,
  StateFileError,
  StateLockError,
  updateState,
  withStateLock,
} from './store.mjs';
import {
  applySourceScan,
  convertSnapshot,
  createSourceSnapshot,
  emptySnapshot,
  listedFileKeys,
  readProjectScan,
  readProjectScanUnder,
  readSourceEntry,
  RULES,
  RULES_VERSION,
  sameSnapshotFiles,
  shouldIgnoreRelativePath,
  SNAPSHOT_FORMAT,
  SnapshotError,
  snapshotLineKeys,
  snapshotRules,
} from './source-snapshot.mjs';
import {
  advanceWindow,
  createActivityWindow,
  focusTimeFrom,
  recordActivity,
  startedFocusTime,
  storedFocusTime,
} from './focus-clock.mjs';
import {beginNextCycle, noteMilestonesReached} from './milestones-reached.mjs';
import {buildRewardSummary} from './reward.mjs';
import {updateAvailable} from './newest-version.mjs';
import {createScanner} from './scanner.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export {DEFAULT_PORT} from './tracker-ports.mjs';

const SYNC_INTERVAL_MS = 2000;
const SAVE_INTERVAL_MS = 10000;
const GIT_INTERVAL_MS = 15000;
const SOURCE_FALLBACK_INTERVAL_MS = 60000;
const SOURCE_DEBOUNCE_MS = 500;
// The tracker's thread stops while it waits for the state lock, and with it the local API. So its
// periodic save waits briefly and tries again on the next one, and a scan's result is folded in
// with a short wait and tried again a little later.
const PERIODIC_SAVE_LOCK_TIMEOUT_MS = 2000;
const SCAN_LOCK_TIMEOUT_MS = 1000;
const SCAN_RETRY_MS = 2000;
// A project whose folder cannot be watched is scanned this often instead.
export const POLL_INTERVAL_MS = 5000;
// After git changes a repository's list of worktrees in its own folder (.git/worktrees), the list is asked for this much later.
const WORKTREES_SETTLE_MS = 1000;
const SILENT_LOG = {info() {}, warn() {}, error() {}};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProject(project) {
  const sourceType = project.sourceType === 'vibe' ? 'vibe' : 'git';

  return {
    id: project.id,
    repoRoot: project.repoRoot,
    sourceType,
    active: true,
    activeSeconds: Number(project.activeSeconds) || 0,
    idleSeconds: Number(project.idleSeconds) || 0,
    commitCount: Number(project.commitCount) || 0,
    changeBatchCount: Number(project.changeBatchCount) || 0,
    lastActiveAt: project.lastActiveAt ?? new Date().toISOString(),
    sourceSnapshot: project.sourceSnapshot?.files && typeof project.sourceSnapshot === 'object'
      ? project.sourceSnapshot
      : project.vibeSnapshot?.files && typeof project.vibeSnapshot === 'object'
        ? project.vibeSnapshot
        : null,
    // A worktree the tracker found (noteWorktrees): the repository it is a worktree of, and since when git no longer lists it.
    ...(typeof project.worktreeOf === 'string' ? {worktreeOf: project.worktreeOf, ...(project.goneAt ? {goneAt: project.goneAt} : {})} : {}),
  };
}

// A repository's worktrees the tracker found (noteWorktrees; docs/reward-rules.md §5.9), kept in its record by id, each a project
// record of its own: a Kit=Code from before them keeps the field as it is, and reads nothing in it.
function storedWorktrees(record) {
  return isObject(record?.worktrees) ? record.worktrees : {};
}

// Every project record of a stored state, as [id, record, the id of the repository it is a worktree of, or null]. A worktree that
// is also a project of its own is that project, and is listed once.
function storedRecords(stored) {
  const projects = isObject(stored?.projects) ? stored.projects : {};
  const records = Object.entries(projects).map(([id, record]) => [id, record, null]);
  const listed = new Set(Object.keys(projects));

  for (const [parentId, parent] of Object.entries(projects)) {
    for (const [id, record] of Object.entries(storedWorktrees(parent))) {
      if (isObject(record) && !listed.has(id)) {
        listed.add(id);
        records.push([id, record, parentId]);
      }
    }
  }

  return records;
}

// Where project `id`'s record is in a stored state, `holder[key]`, among the projects or a repository's worktrees; or null.
function recordPlace(stored, id) {
  const projects = isObject(stored?.projects) ? stored.projects : null;

  if (!projects) {
    return null;
  }

  if (isObject(projects[id])) {
    return {holder: projects, key: id};
  }

  for (const parent of Object.values(projects)) {
    if (isObject(storedWorktrees(parent)[id])) {
      return {holder: parent.worktrees, key: id};
    }
  }

  return null;
}

function storedRecord(stored, id) {
  const place = recordPlace(stored, id);
  return place ? place.holder[place.key] : undefined;
}

// Replaces project `id`'s record, wherever it is stored, with `make` of it (a legacy vibeSnapshot left out).
function replaceRecord(stored, id, make) {
  const place = recordPlace(stored, id);
  const {vibeSnapshot, ...current} = place.holder[place.key];
  place.holder[place.key] = make(current);
  return place.holder[place.key];
}

function normalizeState(state) {
  const projects = {};

  for (const [id, project, parentId] of storedRecords(state)) {
    projects[id] = normalizeProject({id, ...project, ...(parentId === null ? {} : {sourceType: 'git', worktreeOf: parentId})});
  }

  return {
    version: 4,
    projects,
    ...(state.onboarding ? {onboarding: state.onboarding} : {}),
  };
}

function detectProject(targetPath = '.') {
  const absolutePath = path.resolve(process.cwd(), targetPath);
  const gitRoot = tryDetectRepoRoot(absolutePath);

  if (gitRoot) {
    return {
      id: createProjectId(gitRoot),
      root: gitRoot,
      sourceType: 'git',
    };
  }

  return {
    id: createFolderProjectId(absolutePath),
    root: absolutePath,
    sourceType: 'vibe',
  };
}

export function describeProject(targetPath = '.') {
  const project = detectProject(targetPath);

  return {
    id: project.id,
    repoRoot: project.root,
    sourceType: project.sourceType,
  };
}

export function describeProjects(targetPaths = []) {
  const projects = new Map();

  for (const targetPath of targetPaths) {
    const project = describeProject(targetPath);
    projects.set(project.id, project);
  }

  return [...projects.values()];
}

export function resolveInitialProjectSuggestion(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return null;
  }

  let absolutePath;
  try {
    absolutePath = path.resolve(targetPath);
  } catch {
    return null;
  }

  try {
    if (!fs.statSync(absolutePath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const home = path.resolve(os.homedir());
  if (absolutePath === home || absolutePath === path.parse(absolutePath).root) {
    return null;
  }

  const project = describeProject(absolutePath);
  const registeredIds = new Set(listProjectRecords().map((entry) => entry.id));
  if (registeredIds.has(project.id)) {
    return null;
  }

  return project;
}

function createProjectRecord(detectedProject, existing = {}) {
  const now = new Date().toISOString();

  return normalizeProject({
    id: detectedProject.id,
    repoRoot: detectedProject.root,
    sourceType: detectedProject.sourceType,
    active: true,
    activeSeconds: existing.activeSeconds ?? 0,
    idleSeconds: existing.idleSeconds ?? 0,
    commitCount: existing.commitCount ?? 0,
    changeBatchCount: existing.changeBatchCount ?? 0,
    lastActiveAt: existing.lastActiveAt ?? now,
    sourceSnapshot: existing.sourceSnapshot ?? existing.vibeSnapshot ?? createSourceSnapshot(detectedProject.root, {sourceType: detectedProject.sourceType}),
  });
}

// Puts `project` into the stored state, over the record already there, so that fields this version
// does not know are kept. A legacy vibeSnapshot goes: normalizeProject has made it sourceSnapshot.
function storeProject(stored, project) {
  if (!isObject(stored.projects)) {
    stored.projects = {};
  }

  const {vibeSnapshot, ...existing} = isObject(stored.projects[project.id]) ? stored.projects[project.id] : {};
  stored.projects[project.id] = {...existing, ...project};
  stored.version = 4;
}

// The projects the person added: a worktree the tracker found is counted with its repository.
function projectTotals(state) {
  const projects = Object.values(normalizeState(state).projects).filter((project) => !project.worktreeOf);

  return {
    totalProjects: projects.length,
    trackingProjects: projects.filter((project) => project.active).length,
  };
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findProjectIdForPath(state, targetPath = '.') {
  if (state.projects[targetPath]) {
    return targetPath;
  }

  const detectedProject = detectProject(targetPath);

  if (state.projects[detectedProject.id]) {
    return detectedProject.id;
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  const candidates = Object.values(state.projects)
    .filter((project) => project.sourceType === 'vibe' && pathContains(project.repoRoot, absolutePath))
    .sort((a, b) => b.repoRoot.length - a.repoRoot.length);

  return candidates[0]?.id ?? detectedProject.id;
}


// The snapshot a project record holds (older files call it vibeSnapshot), or null.
function snapshotOf(record) {
  for (const snapshot of [record?.sourceSnapshot, record?.vibeSnapshot]) {
    if (isObject(snapshot) && isObject(snapshot.files)) {
      return snapshot;
    }
  }

  return null;
}

// The snapshot a project record holds as it is stored: sourceSnapshot, or vibeSnapshot in older
// files, or null when it has none yet. Unlike snapshotOf, it returns a damaged one, to be reported.
function storedSnapshot(record) {
  return record?.sourceSnapshot ?? record?.vibeSnapshot ?? null;
}

// A snapshot that cannot be counted against stops every command that scans, naming the file and the
// project (docs/security.md, "The state file").
function snapshotProblem(projectId, record, error) {
  const project = typeof record?.repoRoot === 'string' ? `the project at ${record.repoRoot} (${projectId})` : `project ${projectId}`;

  return error.newer
    ? new StateFileError(`the snapshot of ${project} was written by a newer Kit=Code: ${error.message}`, error, {
      advice: 'Kit=Code has left the file as it is. Going back to an older Kit=Code is not supported: use the Kit=Code that wrote it, or a later one.',
    })
    : new StateFileError(`the snapshot of ${project} is damaged: ${error.message}`, error);
}

function checkedSnapshot(projectId, record, check) {
  try {
    return check(storedSnapshot(record));
  } catch (error) {
    throw error instanceof SnapshotError ? snapshotProblem(projectId, record, error) : error;
  }
}

// The counting rules a project's snapshot was taken under, or null when it has none yet.
function rulesOfRecord(projectId, record, {newest = RULES_VERSION} = {}) {
  return storedSnapshot(record) === null ? null : checkedSnapshot(projectId, record, (snapshot) => snapshotRules(snapshot, {newest}));
}

// Brings state.json to this version's snapshot format (docs/reward-rules.md §5.2), in one locked
// update: each snapshot an older Kit=Code wrote is converted by cutting its line keys to 16
// characters, which counts nothing and loses nothing, and seen-lines is made from the snapshots when
// there is none yet. Every command that scans runs it first, in its own update; once the file is
// converted it does nothing and writes nothing. A snapshot that cannot be converted, or that a newer
// Kit=Code wrote, stops it with a StateFileError naming the project, before anything is written.
//
// A converted snapshot can hold files the scanner no longer reads, which the next full scan drops, as
// it always has: a .env file, a key, a lockfile, a folder .gitignore names. Their lines are not seen,
// so no hash of a line of a secret file outlives that scan in seen-lines (ruling, 2026-09-25).
export function migrateState({newest = RULES_VERSION} = {}) {
  return withStateLock(() => {
    const projects = storedRecords(loadState()).filter(([, record]) => isObject(record) && storedSnapshot(record) !== null);
    const seed = !seenLinesExist();
    const converted = [];
    const seen = [];
    let collisions = 0;

    for (const [projectId, record] of projects) {
      const format = checkedSnapshot(projectId, record, (snapshot) => {
        snapshotRules(snapshot, {newest});
        return snapshot.version ?? 1;
      });

      if (format === SNAPSHOT_FORMAT && !seed) {
        continue;
      }

      const result = checkedSnapshot(projectId, record, (snapshot) => convertSnapshot(snapshot, {newest}));
      const listed = result.converted ? listedFileKeys(record.repoRoot, {sourceType: record.sourceType === 'vibe' ? 'vibe' : 'git'}) : null;
      collisions += result.collisions;
      seen.push(...snapshotLineKeys(result.snapshot, listed));

      if (result.converted || record.sourceSnapshot !== result.snapshot) {
        converted.push([projectId, result.snapshot]);
      }
    }

    if (converted.length > 0) {
      updateState((stored) => {
        for (const [projectId, snapshot] of converted) {
          replaceRecord(stored, projectId, (current) => ({...current, sourceSnapshot: snapshot}));
        }
      });
    }

    recordSeenLines(seen, {seeding: seed});
    return {converted: converted.length, collisions};
  });
}

const SWITCH_ATTEMPTS = 3;

// The rules switch (docs/reward-rules.md §5.6), for one project. When its snapshot was taken under
// older counting rules than `to`, whatever is new since the snapshot is first counted under the old
// rules: code written while the tracker was stopped, say. Then the snapshot is taken again under the
// new rules, which counts nothing, and records them. Both come from one read of the project, so no
// edit falls between them, and they are written in one locked update. A snapshot already under `to`,
// or a project with none, is left as it is. `rules` is the rules by version.
//
// The read of a Git project is checked against git like any scan's (§5.8): when code can have arrived
// through git since the snapshot, nothing is counted under the old rules either. A snapshot written
// before hardening phase 2 recorded no git position, so a Git project's switch from it counts nothing.
export function switchProjectRules(projectId, {rules = RULES, to = RULES_VERSION} = {}) {
  for (let attempt = 0; attempt < SWITCH_ATTEMPTS; attempt += 1) {
    const record = storedRecord(loadState(), projectId);
    const from = isObject(record) ? rulesOfRecord(projectId, record, {newest: to}) : null;

    if (from === null || from >= to) {
      return {switched: false, from, to, equalsAdded: 0};
    }

    if (!rules[from] || !rules[to]) {
      throw new Error(`Kit=Code has no counting rules ${rules[from] ? to : from} to switch ${projectId} with.`);
    }

    const project = {id: projectId, repoRoot: record.repoRoot, sourceType: record.sourceType === 'vibe' ? 'vibe' : 'git'};
    const base = checkedSnapshot(projectId, record, (snapshot) => convertSnapshot(snapshot, {newest: to})).snapshot;
    let reads;

    try {
      reads = readProjectScanUnder(project.repoRoot, {sourceType: project.sourceType, rules: [rules[from], rules[to]], since: base.git});
    } catch (error) {
      throw Object.assign(new Error(`Kit=Code could not read ${project.repoRoot} to switch its counting rules: ${error.message}`, {cause: error}), {code: 'NGHIXAHOI_PROJECT_UNREADABLE'});
    }

    const [oldRead, newRead] = reads;
    const result = withStateLock(() => {
      migrateState({newest: to});
      const snapshot = snapshotOf(storedRecord(loadState(), projectId));

      // Another process counted in it since the read began: read it again.
      if (!snapshot || snapshot.rulesVersion !== from || !sameSnapshotFiles(snapshot.files, base.files)) {
        return null;
      }

      const credited = applySourceScan(snapshot, oldRead);
      const baseline = applySourceScan(emptySnapshot(to), newRead);
      const files = Object.fromEntries(Object.entries(baseline.snapshot.files).map(([fileKey, entry]) => (
        [fileKey, {...credited.snapshot.files[fileKey], lineCounts: entry.lineCounts}]
      )));

      updateState((stored) => {
        const switched = replaceRecord(stored, projectId, (current) => ({...current, sourceSnapshot: {...credited.snapshot, rulesVersion: to, files}}));

        if (credited.equalsAdded > 0) {
          switched.changeBatchCount = (Number(switched.changeBatchCount) || 0) + 1;
          addSourceEqualsOnce(project, crypto.randomUUID(), credited.equalsAdded);
          noteMilestonesReached(stored);
        }
      });
      recordSeenLines([...credited.addedKeys, ...baseline.addedKeys]);

      return {switched: true, from, to, equalsAdded: credited.equalsAdded};
    });

    if (result) {
      return result;
    }
  }

  throw new Error(`Kit=Code could not switch the counting rules of ${projectId}: its snapshot changed each time it was read.`);
}

// Makes state.json ready for the tracker. `nghixahoi track` runs it before it starts the tracker, where
// a failure can be shown, and the tracker again as it starts: the file converted (migrateState),
// seen-lines checked, and each project whose snapshot was taken under older rules switched
// (switchProjectRules). A project whose folder cannot be read now keeps its rules until it can be
// read; the tracker's scans of it fail meanwhile, as they would anyway. Returns the projects switched,
// and those that could not be read.
export function prepareState({rules = RULES, to = RULES_VERSION} = {}) {
  migrateState({newest: to});
  loadSeenLines();
  const switched = [];
  const unreadable = [];

  for (const [projectId, record] of storedRecords(loadState())) {
    if (!isObject(record) || (rulesOfRecord(projectId, record, {newest: to}) ?? to) >= to) {
      continue;
    }

    try {
      if (switchProjectRules(projectId, {rules, to}).switched) {
        switched.push(projectId);
      }
    } catch (error) {
      if (error.code !== 'NGHIXAHOI_PROJECT_UNREADABLE') {
        throw error;
      }

      unreadable.push(projectId);
    }
  }

  return {switched, unreadable};
}

// Folds a read of `project`'s files into state.json, in one locked update against the snapshot on
// disk, which is the record of what has been counted (docs/reward-rules.md §5.5). `base` is the
// snapshot the read started from: a file another process has counted since is read again under the
// lock rather than trusted. The = on added lines are written together with the snapshot that holds
// them, so a line counts once, whether nghixahoi add or the tracker reads it first, and the lines are
// recorded as seen. Under rules that credit a line once per user, a line seen before, in any project,
// earns nothing (§5.2, §5.7); a read that is a baseline, because code can have arrived through git,
// earns nothing at all (§5.8). Returns null when the project is not in state.json, or when a partial
// read cannot make its first snapshot.
//
// `focusSeconds` is the tracker's own clock, when it folds: ahead of the file's by up to one save, and the moment a milestone
// these = reach is recorded at with it (milestones-reached.mjs).
function foldScan(project, read, base, {lockTimeoutMs, focusSeconds} = {}) {
  return withStateLock(() => {
    // An older file is converted first, in this same update: after an upgrade, the first scan does it.
    migrateState();
    const record = storedRecord(loadState(), project.id);

    if (!isObject(record)) {
      return null;
    }

    const snapshot = snapshotOf(record);

    if (!snapshot && !read.complete) {
      return null;
    }

    // Other rules need the rules switch, which reads under both; the tracker makes it as it starts.
    if (snapshot && snapshot.rulesVersion !== read.rulesVersion) {
      throw new Error(`The snapshot of ${project.repoRoot} was taken under counting rules ${snapshot.rulesVersion}, and this scan is under rules ${read.rulesVersion}: the rules switch runs when the tracker starts.`);
    }

    // A project with no snapshot yet gets this read as its baseline: nothing in it counts, and nothing
    // in it is activity.
    const result = snapshot
      ? applySourceScan(snapshot, read, {
        base,
        reread: (relativePath) => readSourceEntry(project.repoRoot, relativePath, {checkPath: true}),
        seen: isLineSeen,
      })
      : {...applySourceScan(emptySnapshot(read.rulesVersion), read), equalsAdded: 0, linesChanged: []};

    if (!snapshot || record.vibeSnapshot || result.changedFiles > 0 || result.equalsAdded > 0 || result.gitMoved) {
      updateState((stored) => {
        const folded = replaceRecord(stored, project.id, (current) => ({...current, sourceSnapshot: result.snapshot}));

        if (result.equalsAdded > 0) {
          folded.changeBatchCount = (Number(folded.changeBatchCount) || 0) + 1;
          addSourceEqualsOnce(project, crypto.randomUUID(), result.equalsAdded);
          // = credited can make a milestone ready: recorded in this same update (docs/reward-rules.md §6.1).
          noteMilestonesReached(stored, undefined, {focusSeconds});
        }
      });
    }

    recordSeenLines(result.addedKeys);
    const after = loadState();

    return {
      ...result,
      changeBatchCount: Number(storedRecord(after, project.id).changeBatchCount) || 0,
      ledger: equalsLedgerFrom(after),
      record: after.milestonesReached,
    };
  }, {lockTimeoutMs});
}

// The tracker's shared clock, as it starts: from the file's clock, or, the first time a file is
// loaded under the shared-clock rule, from its summed total (operator decision Q3, 2026-09-24).
function focusClockFrom(stored, now = Date.now()) {
  const focus = storedFocusTime(stored)
    ? {...focusTimeFrom(stored), carriedOver: stored.focusTime.carriedOver}
    : startedFocusTime(stored, new Date(now));

  return {...focus, window: createActivityWindow(), lastTick: now};
}

// What state.json is on disk now, cheaply: it changes whenever the file is written.
function stateFileIdentity() {
  try {
    const stat = fs.statSync(STORE_PATH);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// The tracker's state as it starts. Until 2026-09-25 it also stored the time target it was started
// with (--reward-seconds, NGHIXAHOI_REWARD_SECONDS); the target is fixed now (reward.mjs REWARD_SECONDS).
export function createRuntime(options) {
  // Before anything is counted, or written: the file converted, and older rules switched.
  prepareState();
  // Taken before the read: a write after it shows as a change at the next reconcile.
  const stateIdentity = stateFileIdentity();
  const stored = loadState();

  return {
    options,
    state: normalizeState(stored),
    ledger: equalsLedgerFrom(stored),
    // The milestone record, which decides the milestones since 2026-10-20 (reward.mjs decideMilestones).
    record: stored.milestonesReached,
    focus: focusClockFrom(stored),
    stateIdentity,
    projectRuns: new Map(),
  };
}

export function registerProject(targetPath = '.') {
  const detected = detectProject(targetPath);
  const project = {id: detected.id, repoRoot: detected.root, sourceType: detected.sourceType};
  let registered = storedRecord(loadState(), detected.id);

  // A snapshot taken under older counting rules is switched first (docs/reward-rules.md §5.6).
  if (isObject(registered) && (rulesOfRecord(detected.id, registered) ?? RULES_VERSION) < RULES_VERSION) {
    switchProjectRules(detected.id);
    registered = storedRecord(loadState(), detected.id);
  }

  // The files are read outside the lock: on a large project that takes a while, and the tracker and
  // the prompt hook must not wait for it. The fold makes up for anything counted meanwhile. A Git
  // project's read is checked against git since the snapshot (§5.8); a new project's is its baseline.
  const base = snapshotOf(registered) ?? emptySnapshot();
  const read = readProjectScan(detected.root, {sourceType: detected.sourceType, since: base.git});
  const commitCount = detected.sourceType === 'git' ? countCommits(detected.root) : 0;

  return withStateLock(() => {
    // An older file is converted in this same update, so a command that fails converts nothing.
    migrateState();
    // A worktree the tracker found becomes a project of its own, with all it has counted (docs/reward-rules.md §5.9).
    promoteWorktree(detected.id);
    const record = loadState().projects?.[detected.id];

    if (!isObject(record)) {
      // A new project: what is there now is its baseline, and never counts; its lines are seen.
      const baseline = applySourceScan(emptySnapshot(read.rulesVersion), read);
      const created = createProjectRecord(detected, {commitCount, sourceSnapshot: baseline.snapshot});
      updateState((stored) => storeProject(stored, created));
      recordSeenLines(baseline.addedKeys);
    } else {
      // Added again: whatever is new since its snapshot counts, once.
      foldScan(project, read, base);

      if (record.active !== true || (detected.sourceType === 'git' && Number(record.commitCount) !== commitCount)) {
        updateState((stored) => {
          stored.projects[detected.id].active = true;

          if (detected.sourceType === 'git') {
            stored.projects[detected.id].commitCount = commitCount;
          }
        });
      }
    }

    return projectTotals(loadState());
  });
}

// Moves a worktree the tracker found among the projects, as it is, when the person adds it. Writes nothing otherwise.
function promoteWorktree(projectId) {
  const state = loadState();
  const place = recordPlace(state, projectId);

  if (!place || place.holder === state.projects) {
    return;
  }

  updateState((stored) => {
    const found = recordPlace(stored, projectId);
    const {goneAt, ...record} = found.holder[found.key];
    delete found.holder[found.key];
    stored.projects[projectId] = {...record, id: projectId, active: true};
  });
}

export function listProjects() {
  return projectTotals(loadState());
}

// The worktrees of the added repositories as git lists them now, for `nghixahoi status` (docs/reward-rules.md §5.9): each one the
// tracker counts with its repository, `ok`, and each it cannot, `prunable` or `unreadable`, by its folder. A worktree that is a
// project of its own is that project, and not listed.
export function describeWorktrees() {
  const state = normalizeState(loadState());
  const added = Object.values(state.projects).filter((project) => !project.worktreeOf);
  const addedIds = new Set(added.map((project) => project.id));
  const worktrees = new Map();

  for (const project of added.filter((entry) => entry.sourceType === 'git')) {
    let listed;

    try {
      listed = listWorktrees(project.repoRoot);
    } catch {
      continue;
    }

    for (const worktree of listed.filter((entry) => !entry.bare && !worktrees.has(entry.path))) {
      if (worktree.prunable) {
        worktrees.set(worktree.path, {path: worktree.path, state: 'prunable'});
        continue;
      }

      try {
        const root = detectRepoRoot(worktree.path);

        if (root !== project.repoRoot && !addedIds.has(createProjectId(root))) {
          worktrees.set(worktree.path, {path: worktree.path, state: 'ok'});
        }
      } catch {
        worktrees.set(worktree.path, {path: worktree.path, state: 'unreadable'});
      }
    }
  }

  return [...worktrees.values()];
}

// The projects the person added. A worktree the tracker found is not one: it is counted with its repository.
export function listProjectRecords() {
  const state = normalizeState(loadState());

  return Object.values(state.projects).filter((project) => !project.worktreeOf).map((project) => ({
    id: project.id,
    repoRoot: project.repoRoot,
    sourceType: project.sourceType,
    active: project.active,
  }));
}

export function registerNewProjects(targetPaths = []) {
  const existingIds = new Set(listProjectRecords().map((project) => project.id));
  const addedProjects = [];

  for (const project of describeProjects(targetPaths)) {
    if (existingIds.has(project.id)) {
      continue;
    }

    registerProject(project.repoRoot);
    existingIds.add(project.id);
    addedProjects.push(project);
  }

  return {
    addedProjects,
    projects: listProjectRecords(),
  };
}

export function removeProject(targetPathOrProjectId = '.') {
  return withStateLock(() => {
    const state = normalizeState(loadState());
    const projectId = findProjectIdForPath(state, targetPathOrProjectId);

    const project = state.projects[projectId];

    if (!project) {
      return null;
    }

    // A worktree the tracker found goes when git removes it, or with its repository: removed alone, the next poll would find it.
    if (project.worktreeOf) {
      return {worktreeOf: state.projects[project.worktreeOf]?.repoRoot ?? project.worktreeOf};
    }

    return updateState((stored) => {
      // Removing a project never lowers focus time (docs/reward-rules.md §4): the shared clock
      // cannot say which project a second belonged to. A file from before the shared clock starts
      // it now, from the summed total, when that total holds this project's time.
      if (!storedFocusTime(stored) && (Number(stored.projects[projectId]?.activeSeconds) || 0) > 0) {
        stored.focusTime = startedFocusTime(stored);
      }

      // Its worktrees go with it, and what they counted, as what it counted goes (§4).
      const worktreeIds = Object.keys(storedWorktrees(stored.projects[projectId])).filter((id) => !(id in stored.projects));
      delete stored.projects[projectId];
      stored.version = 4;
      removeProjectEquals(projectId);

      for (const id of worktreeIds) {
        removeProjectEquals(id);
      }

      return projectTotals(stored);
    });
  });
}

export function setAllProjectsActive(active) {
  return updateState((stored) => {
    for (const project of Object.values(isObject(stored.projects) ? stored.projects : {})) {
      if (isObject(project)) {
        project.active = active;
      }
    }

    return projectTotals(stored);
  });
}

export function setProjectActiveByPath(targetPath = '.', active = true) {
  return withStateLock(() => {
    const state = normalizeState(loadState());
    const projectId = findProjectIdForPath(state, targetPath);

    if (!state.projects[projectId]) {
      return null;
    }

    return updateState((stored) => {
      stored.projects[projectId].active = active;
      return projectTotals(stored);
    });
  });
}

// Scans `project` now and records any = it finds. A registered project is folded against its
// snapshot on disk; one that is not (check-project-ledger.mjs scans such a project) against its own.
export function refreshProject(project) {
  if (!project.sourceSnapshot || !project.sourceSnapshot.files) {
    project.sourceSnapshot = createSourceSnapshot(project.repoRoot, {sourceType: project.sourceType});
    return false;
  }

  const base = project.sourceSnapshot;
  const read = readProjectScan(project.repoRoot, {sourceType: project.sourceType, since: base.git});
  let result = foldScan(project, read, base);

  if (result) {
    project.changeBatchCount = result.changeBatchCount;
  } else {
    // Its = are counted against the lines seen, and recorded, and so are its lines, as for a
    // registered project.
    result = withStateLock(() => {
      const unregistered = applySourceScan(base, read, {seen: isLineSeen});

      if (unregistered.equalsAdded > 0) {
        addSourceEqualsOnce(project, crypto.randomUUID(), unregistered.equalsAdded);
        project.changeBatchCount = (Number(project.changeBatchCount) || 0) + 1;
      }

      recordSeenLines(unregistered.addedKeys);
      return unregistered;
    });
  }

  project.sourceSnapshot = result.snapshot;

  if (project.sourceType === 'git') {
    project.commitCount = countCommits(project.repoRoot);
  }

  return result.changedFiles > 0;
}

// Real activity in a project, at `at`: it makes that project, and the shared clock, active for the
// idle window after it.
function touchProject(runtime, project, run, at = Date.now()) {
  recordActivity(run.window, at);
  recordActivity(runtime.focus.window, at);
  project.lastActiveAt = new Date(at).toISOString();
}

// Whether a folded scan found real activity (operator decision Q4, 2026-09-25; docs/reward-rules.md §4):
// the normalised lines of a file the scanner reads changed, lines added or removed, and git did not
// change them. A touch, a save of the same text, or of the same lines re-spaced, re-quoted or with a
// trailing ; or , added or taken away, changes no line; a git operation on its own, and code that
// arrives through git, are git's (source-snapshot.mjs checkedAgainstGit).
function changedByUser(read, result) {
  return !read.gitOperation && result.linesChanged.length > 0;
}

function tickProject(project, run, now) {
  const {activeMs, idleMs} = advanceWindow(run.window, run.lastTick, now);
  project.activeSeconds += activeMs / 1000;
  project.idleSeconds += idleMs / 1000;
  run.lastTick = now;
}

// Moves every clock on to now. Each project keeps its own active and idle seconds; the shared clock
// counts each second once, active when any project was, and runs only while a project is watched.
function tickActiveProjects(runtime) {
  const now = Date.now();

  for (const [projectId, run] of runtime.projectRuns.entries()) {
    const project = runtime.state.projects[projectId];

    if (project) {
      tickProject(project, run, now);
    }
  }

  const focus = runtime.focus;

  if (runtime.projectRuns.size > 0) {
    const {activeMs, idleMs} = advanceWindow(focus.window, focus.lastTick, now);
    focus.activeSeconds += activeMs / 1000;
    focus.idleSeconds += idleMs / 1000;
  }

  focus.lastTick = now;
}

// Runs `job` after the project's earlier scans: one scan of a project at a time, in order.
function enqueue(runtime, projectId, run, job) {
  run.queue = run.queue.then(async () => {
    try {
      await job();
    } catch (error) {
      // A scan that was under way when its project stopped (a worktree gone, say) has nothing left to report to: a problem raised
      // now would stay, with no scan to clear it.
      if (!run.stopped) {
        scanFailed(runtime, projectId, error);
      }
    }
  });

  return run.queue;
}

// What is wrong with the tracker, by fixed code (the prompt hook turns each code into fixed words,
// so nothing from a file reaches the agent): the projects affected, and since when. `onProblem` hears of each project's
// problem raised and cleared, with the error that raised it where there is one: a tester build's diagnostics
// (src/diagnostics.mjs) record it, by the code, an opaque reference to the project and the error's code alone.
function reportProblem(runtime, code, projectId, message, error = null) {
  const problem = runtime.problems.get(code) ?? {since: new Date().toISOString(), projects: new Set()};

  if (problem.projects.has(projectId)) {
    return;
  }

  problem.projects.add(projectId);
  runtime.problems.set(code, problem);
  runtime.log.warn(message);
  runtime.watcherOptions?.onProblem?.({code, projectId, state: 'raised', error});
  runtime.watcherOptions?.onStatus?.(trackerStatus(runtime));
}

function clearProblem(runtime, code, projectId) {
  const problem = runtime.problems.get(code);

  if (!problem?.projects.delete(projectId)) {
    return;
  }

  if (problem.projects.size === 0) {
    runtime.problems.delete(code);
  }

  runtime.log.info(`${code} cleared for ${runtime.state.projects[projectId]?.repoRoot ?? projectId}`);
  runtime.watcherOptions?.onProblem?.({code, projectId, state: 'cleared', error: null});
  runtime.watcherOptions?.onStatus?.(trackerStatus(runtime));
}

// How the tracker is doing: `ok`, or `degraded` with the problems it knows of.
export function trackerStatus(runtime) {
  const problems = [...(runtime.problems ?? new Map()).entries()].map(([code, problem]) => ({
    code,
    projects: problem.projects.size,
    since: problem.since,
  }));

  return {tracking: problems.length > 0 ? 'degraded' : 'ok', problems};
}

function scanFailed(runtime, projectId, error) {
  if (error instanceof StateFileError) {
    runtime.watcherOptions?.onStateError?.(error);
    return;
  }

  // The project could not be read now: its folder is gone, or git could not list it. Its snapshot
  // stays as it is, and the next scan tries again.
  if (worktreeGone(runtime, projectId, error)) {
    return;
  }

  const root = runtime.state.projects[projectId]?.repoRoot ?? projectId;
  const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  reportProblem(runtime, missing ? 'project-missing' : 'scan-failed', projectId, `Scanning ${root} failed (${error?.code ?? 'error'}: ${error?.message ?? error}); its snapshot is kept, and nothing in it is counted until a scan succeeds.`, error);
}

// A Git project whose index stayed locked through a scan (index.lock, git.mjs gitArrival 'locked'): the
// scan was a baseline, so nothing in the project counts while the lock stays, and git refuses to run
// there too. Said as a problem, in fixed words, to the prompt hook, the dashboard and nghixahoi status, and
// cleared by the project's next scan that does not find it; a full scan runs every minute. Each read
// is judged once, as it comes back: a retried fold of an older read does not raise it again.
function noteGitLock(runtime, projectId, read) {
  if (read.baseline !== 'locked') {
    clearProblem(runtime, 'git-locked', projectId);
    return;
  }

  const root = runtime.state.projects[projectId]?.repoRoot ?? projectId;
  reportProblem(runtime, 'git-locked', projectId, `The git index of ${root} has stayed locked (index.lock) through a scan: its scans are baselines, so nothing in it is counted until the lock goes. A git command that crashed can leave that file behind.`);
}

// A Git project in which git shows an operation waiting for the user through a scan (a merge, a rebase, a
// cherry-pick, a revert, am or a squash merge; git.mjs gitArrival 'waiting'): the scan was a baseline, so
// nothing in the project counts until the operation is finished or aborted. Said as a problem, in fixed
// words, and cleared, as a lock is (noteGitLock); the log names the files git left. Until 2026-10-01
// nothing said so, and a REBASE_HEAD that a finished rebase left behind made every scan of a project a
// baseline for hours (docs/lessons-learned.md F22).
function noteGitWaiting(runtime, projectId, read) {
  if (read.baseline !== 'waiting') {
    clearProblem(runtime, 'git-unfinished', projectId);
    return;
  }

  const root = runtime.state.projects[projectId]?.repoRoot ?? projectId;
  const files = Array.isArray(read.gitWaiting) ? read.gitWaiting.join(', ') : 'unknown';
  reportProblem(runtime, 'git-unfinished', projectId, `Git shows an unfinished operation in ${root} (${files}): its scans are baselines, so nothing in it is counted until the operation is finished or aborted.`);
}

// Folds a read into state.json and follows it in the tracker's copy. `activityAt` says, from what the
// fold changed, when the project was active, or null when it was not: activity is decided by the fold
// that counted the change, never before it. When the lock stays busy, the same read is folded a little
// later; the fold allows for anything counted in between.
function applyRead(runtime, projectId, run, read, base, activityAt) {
  const project = runtime.state.projects[projectId];

  if (!project) {
    return null;
  }

  let result;

  try {
    result = foldScan(project, read, base, {lockTimeoutMs: SCAN_LOCK_TIMEOUT_MS, focusSeconds: runtime.focus?.activeSeconds});
  } catch (error) {
    if (!(error instanceof StateLockError)) {
      throw error;
    }

    setTimeout(() => {
      if (!run.stopped) {
        enqueue(runtime, projectId, run, () => applyRead(runtime, projectId, run, read, base, activityAt));
      }
    }, SCAN_RETRY_MS).unref();
    return null;
  }

  if (result) {
    project.sourceSnapshot = result.snapshot;
    project.changeBatchCount = result.changeBatchCount;
    runtime.ledger = result.ledger;
    runtime.record = result.record;
    clearProblem(runtime, 'scan-failed', projectId);
    clearProblem(runtime, 'project-missing', projectId);
    const at = activityAt(result);

    if (at !== null) {
      touchProject(runtime, project, run, at);
    }
  }

  return result;
}

// A scan of every file of the project. What it finds changed is activity as any scan's is
// (changedByUser), from when it found it; but what the first scan after a start finds happened while
// the tracker was not watching, and is counted but is not activity.
function queueFullScan(runtime, projectId, reason) {
  const run = runtime.projectRuns.get(projectId);

  if (!run || run.fullScanQueued) {
    return;
  }

  run.fullScanQueued = true;
  enqueue(runtime, projectId, run, async () => {
    run.fullScanQueued = false;
    const project = runtime.state.projects[projectId];

    if (!project || run.stopped) {
      return;
    }

    const base = snapshotOf(project) ?? emptySnapshot();
    const read = await runtime.scanner.read({root: project.repoRoot, sourceType: project.sourceType, since: base.git});
    noteGitLock(runtime, projectId, read);
    noteGitWaiting(runtime, projectId, read);
    applyRead(runtime, projectId, run, read, base, (result) => (reason !== 'start' && changedByUser(read, result) ? Date.now() : null));
  });
}

function relativeTo(root, fileName) {
  return path.relative(root, path.resolve(root, String(fileName))).split(path.sep).join('/');
}

// The files changed since the last batch. The scan is activity when the fold finds the user changed
// the normalised lines of a file the scanner reads (changedByUser): an event alone, on any file, is
// not. It counts from the first event of a file whose lines changed.
async function scanChangedPaths(runtime, projectId, run, batch) {
  const project = runtime.state.projects[projectId];

  if (!project || run.stopped) {
    return;
  }

  const base = snapshotOf(project) ?? emptySnapshot();
  const read = await runtime.scanner.read({root: project.repoRoot, sourceType: project.sourceType, changedPaths: [...batch.keys()], since: base.git});
  const firstEvents = new Map([...batch].map(([fileName, at]) => [relativeTo(project.repoRoot, fileName), at]));
  noteGitLock(runtime, projectId, read);
  noteGitWaiting(runtime, projectId, read);

  applyRead(runtime, projectId, run, read, base, (result) => {
    if (!changedByUser(read, result)) {
      return null;
    }

    const changed = new Set(result.linesChanged);
    const times = read.files.filter((entry) => changed.has(entry.fileKey)).map((entry) => firstEvents.get(entry.relativePath)).filter(Number.isFinite);
    return times.length > 0 ? Math.min(...times) : Date.now();
  });
}

function flushChanges(runtime, projectId, run) {
  clearTimeout(run.sourceTimer);
  run.sourceTimer = null;

  if (run.rescanRequested) {
    run.rescanRequested = false;
    queueFullScan(runtime, projectId, 'change');
  }

  if (run.changedPaths.size > 0) {
    const batch = run.changedPaths;
    run.changedPaths = new Map();
    enqueue(runtime, projectId, run, () => scanChangedPaths(runtime, projectId, run, batch));
  }
}

function onWatchEvent(runtime, projectId, run, fileName) {
  if (run.stopped) {
    return;
  }

  if (fileName === null || fileName === undefined || fileName === '') {
    // The platform did not say which file changed: look at them all.
    run.rescanRequested = true;
  } else if (/^\.git[\\/]worktrees(?:[\\/]|$)/.test(String(fileName))) {
    // `git worktree add` or `remove` in this repository: its worktrees are asked for soon, not at the next poll (noteWorktrees).
    run.worktreesTimer ??= setTimeout(() => {
      run.worktreesTimer = null;
      pollGit(runtime, projectId, run);
    }, WORKTREES_SETTLE_MS);
    return;
  } else if (shouldIgnoreRelativePath(String(fileName))) {
    return;
  } else if (!run.changedPaths.has(String(fileName))) {
    run.changedPaths.set(String(fileName), Date.now());
  }

  run.sourceTimer ??= setTimeout(() => flushChanges(runtime, projectId, run), SOURCE_DEBOUNCE_MS);
}

// Without a watcher, the project is scanned in full every few seconds: changes are still counted,
// and still make it active, a little later. The tracker says so in its log, /api/health and
// tracker.json, and the prompt hook tells the agent.
function watchFailed(runtime, projectId, run, error) {
  run.watcher?.close();
  run.watcher = null;

  if (run.stopped || run.poll) {
    return;
  }

  const root = runtime.state.projects[projectId]?.repoRoot ?? projectId;

  if (worktreeGone(runtime, projectId, error)) {
    return;
  }

  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    reportProblem(runtime, 'project-missing', projectId, `Watching ${root} failed (${error.code}: ${error.message}): the folder is gone, so nothing in it is counted.`, error);
    return;
  }

  run.poll = setInterval(() => queueFullScan(runtime, projectId, 'poll'), POLL_INTERVAL_MS);
  reportProblem(runtime, 'watch-failed', projectId, `Watching ${root} failed (${error?.code ?? 'error'}: ${error?.message ?? error}); polling it every ${POLL_INTERVAL_MS / 1000} s instead.`, error);
}

function watchProject(runtime, projectId, run) {
  const project = runtime.state.projects[projectId];

  try {
    run.watcher = fs.watch(project.repoRoot, {recursive: true}, (_eventType, fileName) => onWatchEvent(runtime, projectId, run, fileName));
    // Without this listener, a watcher's error (too many open files, say) ends the tracker.
    run.watcher.on('error', (error) => watchFailed(runtime, projectId, run, error));
  } catch (error) {
    watchFailed(runtime, projectId, run, error);
  }
}

// HEAD, the working tree's status and the commit count, asked of git off the tracker's thread. Until
// 2026-09-25 a change between two polls was activity: an empty commit, a stash or a checkout earned
// time. It is not (operator decision Q4): a change asks for a full scan instead, which records where
// git is for the next scan's check (docs/reward-rules.md §5.8), and is activity only for lines the user
// changed. The status leaves out the files the scanner does not read (scan-worker.mjs), so an install
// that rewrites a lockfile asks for nothing.
function pollGit(runtime, projectId, run) {
  const project = runtime.state.projects[projectId];

  if (!project || project.sourceType !== 'git' || run.gitPending || run.stopped) {
    return;
  }

  run.gitPending = true;
  runtime.scanner.git({root: project.repoRoot, worktrees: !project.worktreeOf}).then(({signature, commitCount, worktrees}) => {
    const current = runtime.state.projects[projectId];

    if (!current || run.stopped) {
      return;
    }

    if (Array.isArray(worktrees)) {
      noteWorktreesSafely(runtime, projectId, worktrees);
    }

    if (signature === null) {
      return;
    }

    if (run.lastGitSignature !== undefined && signature !== run.lastGitSignature) {
      queueFullScan(runtime, projectId, 'git');
    }

    run.lastGitSignature = signature;
    current.commitCount = commitCount;
  }).catch(() => {
    // Git could not be asked now; the next poll tries again.
  }).finally(() => {
    run.gitPending = false;
  });
}

// What a repository's worktrees are, by a poll's listing (scan-worker.mjs describeWorktrees; docs/reward-rules.md §5.9). Each one
// git lists that the tracker has not met is stored in the repository's record with no snapshot, so that its first scan is its
// baseline: nothing it holds when it is found counts. It is then watched and scanned as a project of its own, against the lines
// seen, so that a line counts once in all of them. One that git no longer lists, or calls prunable, or that git cannot read, is
// stopped, with all it counted kept (`goneAt`); listed again, its first scan is a baseline again. A worktree that is a project of
// its own, or another repository's worktree, is left as it is. Nothing is written when nothing changed.
function noteWorktrees(runtime, projectId, listed) {
  const project = runtime.state.projects[projectId];

  if (!project || project.worktreeOf) {
    return;
  }

  const found = new Map(listed
    .filter((worktree) => worktree.state === 'ok' && worktree.id !== projectId && worktree.root !== project.repoRoot)
    .map((worktree) => [worktree.id, worktree]));
  const known = Object.values(runtime.state.projects).filter((record) => record.worktreeOf === projectId);
  const changed = [...found.keys()].some((id) => !runtime.state.projects[id] || (runtime.state.projects[id].worktreeOf === projectId && runtime.state.projects[id].goneAt))
    || known.some((record) => !record.goneAt && !found.has(record.id));

  if (!changed) {
    return;
  }

  updateState((stored) => {
    const parent = stored.projects?.[projectId];

    if (!isObject(parent)) {
      return;
    }

    const now = new Date().toISOString();
    parent.worktrees = storedWorktrees(parent);

    for (const [id, worktree] of found) {
      const place = recordPlace(stored, id);
      const current = parent.worktrees[id];

      if (place && place.holder !== parent.worktrees) {
        continue;
      }

      if (!isObject(current)) {
        parent.worktrees[id] = {
          id,
          repoRoot: worktree.root,
          sourceType: 'git',
          active: true,
          activeSeconds: 0,
          idleSeconds: 0,
          commitCount: 0,
          changeBatchCount: 0,
          lastActiveAt: now,
          sourceSnapshot: null,
          foundAt: now,
        };
        runtime.log.info(`worktree found: ${worktree.root}, of ${project.repoRoot}; what it holds now is its baseline`);
      } else if (current.goneAt) {
        // Git may have put anything there meanwhile.
        const {goneAt, ...kept} = current;
        parent.worktrees[id] = {...kept, repoRoot: worktree.root, sourceSnapshot: null};
        runtime.log.info(`worktree back: ${worktree.root}, of ${project.repoRoot}; what it holds now is its baseline`);
      }
    }

    for (const [id, current] of Object.entries(parent.worktrees)) {
      if (isObject(current) && !current.goneAt && !found.has(id)) {
        parent.worktrees[id] = {...current, goneAt: now};
        runtime.log.info(`worktree gone: ${current.repoRoot}, of ${project.repoRoot}; what it counted is kept`);
      }
    }
  }, {lockTimeoutMs: SCAN_LOCK_TIMEOUT_MS});

  // At once, not at the next sync: a worktree found is watched, and its baseline taken, before more is written in it.
  reconcileProjects(runtime);
}

// A worktree the tracker found whose folder is gone: its repository's worktrees are asked for again at once, and it is stopped
// there (noteWorktrees), instead of raising a problem. True when that is so.
function worktreeGone(runtime, projectId, error) {
  const project = runtime.state.projects[projectId];
  const parentRun = project?.worktreeOf ? runtime.projectRuns.get(project.worktreeOf) : undefined;

  // git run in a folder that is gone fails with its own exit code, not ENOENT.
  if (!parentRun || !(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || !fs.existsSync(project.repoRoot))) {
    return false;
  }

  pollGit(runtime, project.worktreeOf, parentRun);
  return true;
}

// A busy lock waits for the next poll; a state file that cannot be read stops the tracker, as a scan's does.
function noteWorktreesSafely(runtime, projectId, listed) {
  try {
    noteWorktrees(runtime, projectId, listed);
  } catch (error) {
    if (error instanceof StateFileError) {
      runtime.watcherOptions?.onStateError?.(error);
    } else if (!(error instanceof StateLockError)) {
      runtime.log.error(`Noting the worktrees of ${runtime.state.projects[projectId]?.repoRoot ?? projectId} failed: ${error?.message ?? error}`);
    }
  }
}

function startProject(runtime, project) {
  if (runtime.projectRuns.has(project.id)) {
    return;
  }

  // No activity yet: a project becomes active only on real activity, never because the tracker
  // started watching it (until 2026-09-24 it was active for its first 5 minutes).
  const run = {
    lastTick: Date.now(),
    window: createActivityWindow(),
    lastGitSignature: undefined,
    gitPending: false,
    changedPaths: new Map(),
    rescanRequested: false,
    sourceTimer: null,
    worktreesTimer: null,
    fullScanQueued: false,
    queue: Promise.resolve(),
    watcher: null,
    poll: null,
    stopped: false,
  };

  runtime.projectRuns.set(project.id, run);
  watchProject(runtime, project.id, run);
  queueFullScan(runtime, project.id, 'start');
  pollGit(runtime, project.id, run);
}

function closeRun(run) {
  run.stopped = true;
  clearTimeout(run.sourceTimer);
  run.sourceTimer = null;
  clearTimeout(run.worktreesTimer);
  run.worktreesTimer = null;
  clearInterval(run.poll);
  run.poll = null;
  run.watcher?.close();
  run.watcher = null;
}

function stopProject(runtime, projectId) {
  const run = runtime.projectRuns.get(projectId);

  if (!run) {
    return;
  }

  const project = runtime.state.projects[projectId];

  if (project) {
    tickProject(project, run, Date.now());
  }

  closeRun(run);
  runtime.projectRuns.delete(projectId);

  for (const code of [...runtime.problems.keys()]) {
    clearProblem(runtime, code, projectId);
  }
}

// Re-reads state.json when it changed, and follows it: projects added are watched, projects removed
// are dropped, and the ledger is refreshed. The tracker's own counters stay its own; each project's
// snapshot comes from the file, where every scan writes it.
function reconcileProjects(runtime) {
  tickActiveProjects(runtime);
  const identity = stateFileIdentity();

  if (identity !== runtime.stateIdentity) {
    const stored = loadState();
    const diskState = normalizeState(stored);
    runtime.stateIdentity = identity;
    runtime.ledger = equalsLedgerFrom(stored);
    runtime.record = stored.milestonesReached;

    for (const [projectId, project] of Object.entries(runtime.state.projects)) {
      if (!diskState.projects[projectId]) {
        stopProject(runtime, projectId);
        continue;
      }

      diskState.projects[projectId] = {
        ...diskState.projects[projectId],
        activeSeconds: project.activeSeconds,
        idleSeconds: project.idleSeconds,
        commitCount: project.commitCount,
        lastActiveAt: project.lastActiveAt,
      };
    }

    runtime.state = diskState;
  }

  for (const project of Object.values(runtime.state.projects)) {
    if (project.active && !project.goneAt) {
      startProject(runtime, project);
    } else {
      stopProject(runtime, project.id);
    }
  }
}

// Writes the tracker's counters into the projects on disk: time, and the commit count git reports.
// Snapshots and change counts are not among them; each scan writes those as it counts. Projects
// added or removed on disk since the last reconcile stay added or removed, and everything else in
// the file is left as it is. Since 2026-09-25 it also records a milestone its time has made ready
// (docs/reward-rules.md §6.1), within one save, 10 s, of it becoming ready.
export function persistRuntimeState(runtime, options) {
  let saved = null;

  updateState((stored) => {
    if (!isObject(stored.projects)) {
      return;
    }

    for (const [projectId, project] of Object.entries(runtime.state.projects)) {
      const place = recordPlace(stored, projectId);

      if (!place) {
        continue;
      }

      place.holder[place.key] = {
        ...place.holder[place.key],
        activeSeconds: project.activeSeconds,
        idleSeconds: project.idleSeconds,
        commitCount: project.commitCount,
        lastActiveAt: project.lastActiveAt,
      };
    }

    // The shared clock is the tracker's own counter too. Fields it does not know are kept.
    if (runtime.focus) {
      stored.focusTime = {
        ...(isObject(stored.focusTime) ? stored.focusTime : {}),
        activeSeconds: runtime.focus.activeSeconds,
        idleSeconds: runtime.focus.idleSeconds,
        ...(runtime.focus.carriedOver ? {carriedOver: runtime.focus.carriedOver} : {}),
      };
    }

    stored.version = 4;
    noteMilestonesReached(stored);
    saved = {record: stored.milestonesReached === undefined ? undefined : structuredClone(stored.milestonesReached)};
  }, options);

  // What the save recorded, for the tracker's own summary until its next read of the file. A copy: the file's object is
  // the store's.
  if (saved) {
    runtime.record = saved.record;
  }
}

// Begins the next cycle on `receipt`, one the tracker has read and checked (api.mjs, POST /api/claim/receipt; the plan of
// 2026-10-21, decision 1), in one locked write with the tracker's own save: its counters first, as every save writes them,
// so that the cycle starts at the totals the tracker shows, the focus time on its own clock among them; then the record
// (milestones-reached.mjs, beginNextCycle), which says whether this receipt may begin one, and adds the cycle if it may.
// Nothing else in the file changes, and the totals are never reduced. Returns beginNextCycle's outcome; throws the store's
// StateLockError when the file stays locked, and its StateFileError when it cannot be read, as a save does, having written
// nothing.
export function startNextCycle(runtime, receipt, {lockTimeoutMs = PERIODIC_SAVE_LOCK_TIMEOUT_MS} = {}) {
  let outcome = null;
  let saved;

  withStateLock(() => {
    tickActiveProjects(runtime);
    persistRuntimeState(runtime);
    outcome = updateState((stored) => {
      const result = beginNextCycle(stored, receipt, new Date(Date.now()));
      saved = stored.milestonesReached === undefined ? undefined : structuredClone(stored.milestonesReached);
      return result;
    });
  }, {lockTimeoutMs});

  // What the write recorded, for the tracker's own summary at once: the new cycle's milestones count from now.
  runtime.record = saved;
  return outcome;
}

// Runs one of the tracker's periodic jobs. A busy lock skips it until the next tick. A state file
// that cannot be read stops the tracker through `onStateError`, before anything writes to it.
function trackerJob(options, job) {
  return () => {
    try {
      job();
    } catch (error) {
      if (error instanceof StateLockError) {
        return;
      }

      if (error instanceof StateFileError && options.onStateError) {
        options.onStateError(error);
        return;
      }

      throw error;
    }
  };
}

// What /api/summary and /api/events return. The tracker answers from memory: its clock, and the
// ledger as of its last read of state.json. A runtime without them reads the file.
//
// Since 2026-10-30 (web/7-update-notice), `update`: {version}, the newest Kit=Code while it is newer than this one, by the last good
// copy of the claim backend's signed newest version (src/newest-version.mjs), which the Mini says in its title bar; null otherwise,
// and always in a build that never fetches.
export function buildSummary(runtime) {
  // A worktree the tracker found is counted with its repository: not as a project, and its commits are the repository's.
  const projects = Object.values(runtime.state.projects).filter((project) => !project.worktreeOf);
  const trackingProjects = projects.filter((project) => project.active);
  const focus = runtime.focus ?? focusTimeFrom(runtime.state);
  const totalCommits = projects.reduce((sum, project) => sum + project.commitCount, 0);
  const totalChangeBatches = Object.values(runtime.state.projects).reduce((sum, project) => sum + project.changeBatchCount, 0);
  const ledger = runtime.ledger ?? loadEqualsLedger();
  const totalEquals = ledger.total_equals;
  const reward = buildRewardSummary({
    earnedSeconds: focus.activeSeconds,
    totalEquals,
    ledger,
    record: 'record' in runtime ? runtime.record : loadState().milestonesReached,
  });

  return {
    connected: true,
    global: {
      totalActiveSeconds: Math.floor(focus.activeSeconds),
      totalIdleSeconds: Math.floor(focus.idleSeconds),
      totalCommits,
      totalProjects: projects.length,
      trackingProjects: trackingProjects.length,
      totalEquals,
      totalChangeBatches,
      sourceModes: {
        git: trackingProjects.some((project) => project.sourceType === 'git'),
        vibe: trackingProjects.some((project) => project.sourceType === 'vibe'),
      },
    },
    reward,
    update: updateAvailable(),
  };
}

// Starts the tracker's work. `options.log` records what goes wrong; `options.onStatus` hears how the
// tracker is doing whenever that changes, and after every save; `options.onProblem`, each project's problem as it is raised
// and cleared (reportProblem).
export function startWatchers(runtime, options = {}) {
  runtime.watcherOptions = options;
  runtime.log = options.log ?? SILENT_LOG;
  runtime.problems = new Map();
  runtime.status = () => trackerStatus(runtime);
  runtime.scanner = createScanner({
    onError: (error) => runtime.log.error(`The scan worker failed (${error?.message ?? error}); a new one starts with the next scan.`),
  });
  options.onProgress?.('Loading added projects...');
  reconcileProjects(runtime);
  options.onProgress?.('Watching folders...');

  const syncTimer = setInterval(trackerJob(options, () => reconcileProjects(runtime)), SYNC_INTERVAL_MS);
  const saveTimer = setInterval(trackerJob(options, () => {
    tickActiveProjects(runtime);
    persistRuntimeState(runtime, {lockTimeoutMs: PERIODIC_SAVE_LOCK_TIMEOUT_MS});
    options.onStatus?.(trackerStatus(runtime));
  }), SAVE_INTERVAL_MS);
  const gitTimer = setInterval(() => {
    for (const [projectId, run] of runtime.projectRuns.entries()) {
      pollGit(runtime, projectId, run);
    }
  }, GIT_INTERVAL_MS);
  const rescanTimer = setInterval(() => {
    for (const projectId of runtime.projectRuns.keys()) {
      queueFullScan(runtime, projectId, 'rescan');
    }
  }, SOURCE_FALLBACK_INTERVAL_MS);

  // Stops every timer and watcher, then saves: changes still waiting are scanned first. With
  // {persist: false} it saves and scans nothing: for a state file that can no longer be read, which
  // must not be written either.
  return async ({persist = true} = {}) => {
    clearInterval(syncTimer);
    clearInterval(saveTimer);
    clearInterval(gitTimer);
    clearInterval(rescanTimer);
    const runs = [...runtime.projectRuns.entries()];

    if (persist) {
      for (const [projectId, run] of runs) {
        flushChanges(runtime, projectId, run);
      }

      await Promise.allSettled(runs.map(([, run]) => run.queue));
    }

    for (const [, run] of runs) {
      closeRun(run);
    }

    await runtime.scanner.close();

    if (persist) {
      tickActiveProjects(runtime);
      persistRuntimeState(runtime);
    }

    runtime.projectRuns.clear();
  };
}
