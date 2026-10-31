// The milestone record in state.json, `milestonesReached`, read (docs/reward-rules.md §6.1): what each milestone's entry
// says, checked as Kit=Code writes it. Pure, with no imports: reward.mjs reads it to decide the milestones, and
// milestones-reached.mjs to write the record and to report it in the claim bundle.
//
//   {"recordingSince": "2026-09-25T09:15:00.004Z",
//    "milestones": {"30": {"reachedBeforeRecording": true},
//                   "50": {"reachedAt": "2026-10-20T11:03:27.918Z", "focusSeconds": 3600, "equals": 15}},
//    "freshSince": {"at": "2026-10-20T10:00:00.000Z", "focusSeconds": 2400, "equals": 11}}
//
// Since 2026-10-20 (rewards/2-no-stack) an entry the CLI writes also holds the totals at the moment the milestone was
// reached, its focus seconds and its =, and `freshSince` the totals at the moment this Kit=Code first wrote a record that
// holds a milestone reached without them: by an earlier Kit=Code, or before the record began. The milestone after such a
// one counts from `freshSince` (the plan's decision 2). An entry an earlier Kit=Code wrote, `reachedAt` alone, stays as it
// is, and so does every field this version does not know.
//
// Since 2026-10-22 (rewards/3-repeat-vouchers, phase 2) the record counts in cycles (the plan of 2026-10-21, decision 1: after a
// claim, all progress resets). Cycle 1 is the record as it was, its entries in `milestones`; each later cycle is one entry of
// `cycles`, added when the tracker takes a receipt the claim backend signed for the voucher of the cycle before
// (milestones-reached.mjs, beginNextCycle), and never changed after but for its own milestones, added once each. Since 2026-10-22's
// phase 3 a cycle is numbered as the claim backend counts, the one after its receipt's, so the numbers can skip: a Kit=Code installed
// afresh in cycle 1 that takes the receipt of cycle 2 begins cycle 3.
//
//    "cycles": [{"cycle": 2, "startedAt": "2026-10-22T08:00:00.000Z", "focusSeconds": 57900, "equals": 1810,
//                "receipt": {"claimId": "…", "issuedAt": "2026-10-22T07:58:00.000Z"},
//                "milestones": {"30": {"reachedAt": "…", "focusSeconds": 68722, "equals": 2110}}}]
//
// A cycle's start is the totals since install at the moment it began, which its first milestone counts from; the totals keep
// counting across cycles. Nothing of cycle 1 changes when cycle 2 begins: the record is additive only (hard rule 4).
//
// Since 2026-10-29 (rewards/5-cumulative) every milestone counts from its cycle's start, a threshold on the cycle's totals
// (reward.mjs decideMilestones). The record's shape, and what this reader takes, did not change: an entry's totals still say when
// it was reached, and freshSince, which nothing decides by now, is still read, and still required where an entry with totals
// follows one without, as a Kit=Code of 2026-10-20 to 2026-10-29 requires it, so that the two read every record alike.

// A time as toISOString writes it, and a real one: 2026-02-30 is not.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isInstant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) {
    return false;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// A record as Kit=Code writes it: when it began, and its entries.
export function isRecord(record) {
  return isObject(record) && isInstant(record.recordingSince) && isObject(record.milestones);
}

// The totals an entry, or freshSince, holds: both, whole and not below 0, or neither (null). Anything else is undefined:
// not what Kit=Code writes.
function totalsOf(value) {
  const hasSeconds = Object.hasOwn(value, 'focusSeconds');
  const hasEquals = Object.hasOwn(value, 'equals');

  if (!hasSeconds && !hasEquals) {
    return null;
  }

  return hasSeconds && hasEquals && isCount(value.focusSeconds) && isCount(value.equals)
    ? {seconds: value.focusSeconds, equals: value.equals}
    : undefined;
}

// One milestone's entry: {kind: 'before-recording'} or {kind: 'reached', reachedAt, end}, `end` the totals it was reached
// at, or null when the entry holds none; undefined when it is not an entry Kit=Code writes.
function entryOf(entry) {
  if (!isObject(entry)) {
    return undefined;
  }

  if (entry.reachedBeforeRecording === true && entry.reachedAt === undefined) {
    return totalsOf(entry) === null ? {kind: 'before-recording', reachedAt: null, end: null} : undefined;
  }

  if (isInstant(entry.reachedAt) && entry.reachedBeforeRecording === undefined) {
    const end = totalsOf(entry);
    return end === undefined ? undefined : {kind: 'reached', reachedAt: entry.reachedAt, end};
  }

  return undefined;
}

// A later cycle's entry, read for `percents`, `after` the number of the cycle before it: {cycle, startedAt, start, receipt,
// entries}, or a problem's words, a string, when it is not what Kit=Code writes. Each of its milestones was reached with its
// totals: a later cycle counts from a start it knows. Its number is past the one before it, by one when the tracker took the
// receipt of the cycle it was in, and by more since 2026-10-22's phase 3, when it took one of a cycle ahead, as the claim
// backend counts them (milestones-reached.mjs, beginNextCycle).
function cycleOf(value, after, percents) {
  if (!isObject(value) || !Number.isSafeInteger(value.cycle) || value.cycle <= after || !isInstant(value.startedAt) || !isCount(value.focusSeconds) || !isCount(value.equals)
    || !isObject(value.receipt) || typeof value.receipt.claimId !== 'string' || !CLAIM_ID.test(value.receipt.claimId) || !isInstant(value.receipt.issuedAt)
    || !isObject(value.milestones)) {
    return `holds a cycle after cycle ${after} that Kit=Code does not write`;
  }

  const cycle = value.cycle;
  const entries = new Map();

  for (const percent of percents) {
    if (!Object.hasOwn(value.milestones, String(percent))) {
      continue;
    }

    const entry = entryOf(value.milestones[String(percent)]);

    if (entry?.kind !== 'reached' || entry.end === null) {
      return `holds an entry for ${percent} % in cycle ${cycle} that Kit=Code does not write`;
    }

    entries.set(percent, entry);
  }

  return {
    cycle,
    startedAt: value.startedAt,
    start: {seconds: value.focusSeconds, equals: value.equals},
    receipt: {claimId: value.receipt.claimId, issuedAt: value.receipt.issuedAt},
    entries,
  };
}

// The record, read for `percents`, the milestones in order (the retired 10 and 20 % are never among them, whatever their
// entries hold):
//
//   {state: 'none'}: no record yet, a file from before it, or one 0.1.39 rewrote;
//   {state: 'damaged', problem}: not what Kit=Code writes, which is left as it is, never repaired or written over;
//   {state: 'kept', recordingSince, freshSince, entries, cycles, current}: `entries` maps each percent recorded in cycle 1 to
//   its entry, and `freshSince` is cycle 1's {at, seconds, equals} or null; since 2026-10-22 `cycles` lists the later cycles,
//   oldest first, each {cycle, startedAt, start, receipt, entries}, and `current` is the cycle the milestones count in now:
//   {cycle: 1, startedAt: null, start: {seconds: 0, equals: 0}, receipt: null, entries, freshSince} with no later one, else
//   the last, its freshSince null.
//
// A milestone with its totals, after one whose totals are not known, counts from freshSince: without it, the record is
// not one Kit=Code writes.
export function readMilestoneRecord(record, percents) {
  if (record === undefined) {
    return {state: 'none'};
  }

  if (!isRecord(record)) {
    return {state: 'damaged', problem: 'is not the record Kit=Code writes'};
  }

  let freshSince = null;

  if (record.freshSince !== undefined) {
    const totals = isObject(record.freshSince) && isInstant(record.freshSince.at) ? totalsOf(record.freshSince) : undefined;

    if (!totals) {
      return {state: 'damaged', problem: 'holds a start of fresh counting (freshSince) that Kit=Code does not write'};
    }

    freshSince = {at: record.freshSince.at, ...totals};
  }

  const entries = new Map();

  for (const percent of percents) {
    if (!Object.hasOwn(record.milestones, String(percent))) {
      continue;
    }

    const entry = entryOf(record.milestones[String(percent)]);

    if (entry === undefined) {
      return {state: 'damaged', problem: `holds an entry for ${percent} % that Kit=Code does not write`};
    }

    entries.set(percent, entry);
  }

  // Each milestone's start, in order: install for the first; for another, the totals the one before it was reached at,
  // when its entry holds them, and otherwise freshSince.
  let previousEnd = {seconds: 0, equals: 0};

  for (const percent of percents) {
    const entry = entries.get(percent);

    if (entry?.end && previousEnd === null && freshSince === null) {
      return {state: 'damaged', problem: `holds the totals ${percent} % was reached at, with no start for them to count from`};
    }

    previousEnd = entry?.end ?? null;
  }

  // Since 2026-10-22: the later cycles, oldest first, each past the one before it, the first past cycle 1.
  const cycles = [];

  if (record.cycles !== undefined) {
    if (!Array.isArray(record.cycles)) {
      return {state: 'damaged', problem: 'holds cycles that Kit=Code does not write'};
    }

    for (const value of record.cycles) {
      const cycle = cycleOf(value, cycles.at(-1)?.cycle ?? 1, percents);

      if (typeof cycle === 'string') {
        return {state: 'damaged', problem: cycle};
      }

      cycles.push(cycle);
    }
  }

  const current = cycles.at(-1) ?? {cycle: 1, startedAt: null, start: {seconds: 0, equals: 0}, receipt: null, entries, freshSince};
  return {state: 'kept', recordingSince: record.recordingSince, freshSince, entries, cycles, current: {freshSince: null, ...current}};
}
