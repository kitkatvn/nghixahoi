import {loadState, STORE_PATH, updateState} from './store.mjs';

export const EQUALS_LEDGER_PATH = STORE_PATH;

function createEmptyLedger() {
  return {
    total_equals: 0,
    projects: {},
    earned_tiers: [],
    first_counted_at: null,
    last_updated_at: null,
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

function normalizeProjectLedger(projectId, projectLedger = {}) {
  const countedCommits = normalizeCountedEntries(projectLedger.counted_commits);
  const countedBatches = normalizeCountedEntries(projectLedger.counted_batches);
  const totalEquals = Number(projectLedger.total_equals)
    || Object.values(countedCommits).reduce((sum, entry) => sum + entry.equals, 0)
    + Object.values(countedBatches).reduce((sum, entry) => sum + entry.equals, 0);

  return {
    project_id: projectId,
    repo_root: typeof projectLedger.repo_root === 'string' ? projectLedger.repo_root : null,
    source_type: projectLedger.source_type === 'vibe' ? 'vibe' : 'git',
    total_equals: totalEquals,
    counted_commits: countedCommits,
    counted_batches: countedBatches,
    first_counted_at: projectLedger.first_counted_at ?? null,
    last_updated_at: projectLedger.last_updated_at ?? null,
  };
}

function normalizeLedger(ledger) {
  const projects = {};

  if (ledger?.projects && typeof ledger.projects === 'object') {
    for (const [projectId, projectLedger] of Object.entries(ledger.projects)) {
      projects[projectId] = normalizeProjectLedger(projectId, projectLedger);
    }
  }

  const totalEquals = Object.values(projects).reduce((sum, project) => sum + project.total_equals, 0);

  return {
    total_equals: totalEquals,
    projects,
    earned_tiers: Array.isArray(ledger?.earned_tiers) ? ledger.earned_tiers : [],
    first_counted_at: ledger?.first_counted_at ?? null,
    last_updated_at: ledger?.last_updated_at ?? null,
  };
}

// The ledger as stored in `state`, for an updateState callback to change in place. Fields and
// entries this version does not know stay as they are.
export function storedEqualsLedger(state) {
  if (!isObject(state.equalsLedger)) {
    state.equalsLedger = createEmptyLedger();
  }

  const ledger = state.equalsLedger;

  if (!isObject(ledger.projects)) {
    ledger.projects = {};
  }

  if (!Array.isArray(ledger.earned_tiers)) {
    ledger.earned_tiers = [];
  }

  return ledger;
}

export function equalsLedgerFrom(state) {
  return normalizeLedger(state.equalsLedger);
}

export function loadEqualsLedger() {
  return equalsLedgerFrom(loadState());
}

// Counts a batch of = once. The check and the record happen in one locked update, so two
// processes cannot both count the same batch.
export function addSourceEqualsOnce(project, batchId, equals) {
  if (equals <= 0) {
    return loadEqualsLedger().total_equals;
  }

  return updateState((state) => {
    const ledger = storedEqualsLedger(state);
    const projectId = project.id ?? project.project_id;
    const stored = isObject(ledger.projects[projectId]) ? ledger.projects[projectId] : {};
    const current = normalizeProjectLedger(projectId, {
      ...stored,
      repo_root: project.repoRoot ?? project.repo_root ?? stored.repo_root,
      source_type: project.sourceType ?? project.source_type ?? stored.source_type,
    });

    if (current.counted_batches[batchId]) {
      return normalizeLedger(ledger).total_equals;
    }

    const countedAt = new Date().toISOString();
    ledger.projects[projectId] = {
      ...stored,
      project_id: current.project_id,
      repo_root: current.repo_root,
      source_type: current.source_type,
      total_equals: current.total_equals + equals,
      counted_commits: isObject(stored.counted_commits) ? stored.counted_commits : {},
      counted_batches: {
        ...(isObject(stored.counted_batches) ? stored.counted_batches : {}),
        [batchId]: {equals, counted_at: countedAt},
      },
      first_counted_at: current.first_counted_at ?? countedAt,
      last_updated_at: countedAt,
    };
    ledger.total_equals = normalizeLedger(ledger).total_equals;
    ledger.first_counted_at ??= countedAt;
    ledger.last_updated_at = countedAt;

    return ledger.total_equals;
  });
}

export const addVibeEqualsOnce = addSourceEqualsOnce;

export function getTotalEquals() {
  return loadEqualsLedger().total_equals;
}

export function removeProjectEquals(projectId) {
  return updateState((state) => {
    if (!isObject(state.equalsLedger?.projects) || !(projectId in state.equalsLedger.projects)) {
      return normalizeLedger(state.equalsLedger);
    }

    const ledger = storedEqualsLedger(state);
    delete ledger.projects[projectId];
    ledger.total_equals = normalizeLedger(ledger).total_equals;
    ledger.last_updated_at = new Date().toISOString();

    return normalizeLedger(ledger);
  });
}
