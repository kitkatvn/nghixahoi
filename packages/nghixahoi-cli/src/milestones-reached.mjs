import {equalsLedgerFrom} from './equals-ledger.mjs';
import {focusTimeFrom} from './focus-clock.mjs';
import {readMilestoneRecord} from './milestone-record.mjs';
import {decideMilestones, MILESTONE_PERCENTS, milestonesOf, REWARD_TIERS} from './reward.mjs';

// When each milestone first became ready (docs/reward-rules.md §6.1), for the claim bundle. Kept in
// state.json, where the tracker writes the progress it belongs to, as `milestonesReached`:
//
//   {"recordingSince": "2026-09-25T09:15:00.004Z",
//    "milestones": {"10": {"reachedBeforeRecording": true}, "50": {"reachedAt": "2026-09-25T11:03:27.918Z"}}}
//
// It is written where progress goes up, and nowhere else: the tracker's save, which moves the focus
// clock, and the updates that credit = (runtime.mjs persistRuntimeState, foldScan, switchProjectRules).
// Never by the prompt hook, which runs on every message a user sends; never by a redeem, a removal or a
// load. An entry once written is never changed or removed: a rules switch, a re-baseline, a restart or
// progress going down again leaves it where it is.
//
// 0.1.39 drops it when it rewrites the file (install-id.mjs says how). The next write of this version then
// begins a new record, and a milestone reached by then is recorded as reached before recording began:
// the time it was reached is lost, and none is made up.
//
// Since 2026-10-08 the milestones are 30, 50 and 100 % (integration-spec.mjs): the entries an earlier version wrote for 10
// and 20 % stay in the record, never changed or removed, as every entry does, and nothing reads them now.
//
// Since 2026-10-20 (rewards/2-no-stack) the record decides the milestones: each counts from the moment the one before it
// was reached (reward.mjs decideMilestones), so an entry also holds the totals at that moment, written with it, once:
//
//   "50": {"reachedAt": "2026-10-20T11:03:27.918Z", "focusSeconds": 4200, "equals": 21}
//
// and, the first time this Kit=Code writes a record that holds a milestone reached without them, by an earlier Kit=Code or
// before the record began, `freshSince` records the totals then: the milestone after it counts from there (the plan's
// decision 2). An earlier entry is never given totals it did not hold, and none is made up (milestone-record.mjs).
//
// Since 2026-10-22 (rewards/3-repeat-vouchers, phase 2) the record counts in cycles (milestone-record.mjs): a milestone newly
// reached is recorded in the cycle it is in, and a new cycle begins only by beginNextCycle, on a receipt the claim backend
// signed for the voucher of the cycle before, which the tracker has checked (api.mjs). Nothing else begins one: no read, no
// failure and no prompt resets anyone's progress.
//
// Since 2026-10-29 (rewards/5-cumulative; docs/plans/2026-10-29-milestones-cumulative.md) each milestone is a threshold on the
// cycle's totals (reward.mjs decideMilestones), and the record keeps its shape: it still says when each milestone was reached, with
// the totals then, and the record decides what is reached, a reached milestone staying reached. freshSince is still written as
// before, though nothing here reads it now, so that a Kit=Code of 2026-10-20 to 2026-10-29 reads a record this one wrote as it did.

export {MILESTONE_PERCENTS};

function totalsIn(stored, focusSeconds) {
  return {
    seconds: Math.floor(Math.max(0, Number(focusSeconds ?? focusTimeFrom(stored).activeSeconds) || 0)),
    equals: Math.max(0, Number(equalsLedgerFrom(stored).total_equals) || 0),
  };
}

function redeemedIn(stored) {
  const tiers = new Set(REWARD_TIERS.map((tier) => tier.percent));
  return new Set(equalsLedgerFrom(stored).earned_tiers
    .filter((entry) => entry !== null && typeof entry === 'object' && tiers.has(Number(entry.percent)) && typeof entry.redeemed_at === 'string')
    .map((entry) => Number(entry.percent)));
}

// Records, in `stored`, each milestone first found reached: `stored` is the file's own object, inside
// updateState, after the update has written the progress it is making. The first write of a Kit=Code that
// keeps the record begins it, at `now`, and a milestone already reached then is recorded as reached
// before recording began, with no time, since none is known. From then on, a milestone newly reached is
// recorded at `now`. A record, or an entry, that is not what Kit=Code writes is left exactly as it is:
// never repaired, never written over. `now` is the tracker's clock, which a test can move.
//
// Since 2026-10-20 a milestone newly reached is recorded with the totals at `now`, its focus seconds, floored, and its =;
// `focusSeconds` is the tracker's own clock, when it folds a scan between two saves, ahead of the file's by up to one
// save. From 2026-10-20 to 2026-10-29 one write reached one milestone at most; since then one write records every milestone the
// cycle's totals meet, each with this write's totals. A milestone reached with no totals known, and freshSince not yet written,
// has it written now.
//
// Since 2026-10-23 (tracking/2-cli) a milestone is found reached against the targets in force (reward.mjs milestonesOf;
// tracking-config.mjs), or `config`'s, a tracking config, when one is given: the record keeps every milestone it holds whatever
// the targets do, so a raise takes nothing reached away, and a target lowered under what the milestone in progress earned is
// recorded reached by this write.
export function noteMilestonesReached(stored, now = new Date(Date.now()), {focusSeconds, config} = {}) {
  const record = stored.milestonesReached;
  const read = readMilestoneRecord(record, MILESTONE_PERCENTS);

  if (read.state === 'damaged') {
    return;
  }

  const totals = totalsIn(stored, focusSeconds);
  const decided = decideMilestones({totals, record, redeemed: redeemedIn(stored), ...(config === undefined ? {} : {milestones: milestonesOf(config)})});
  const at = now.toISOString();
  const atTotals = {at, focusSeconds: totals.seconds, equals: totals.equals};

  if (read.state === 'none') {
    const before = decided.entries.filter((entry) => entry.reached);
    stored.milestonesReached = {
      recordingSince: at,
      milestones: Object.fromEntries(before.map((entry) => [String(entry.percent), {reachedBeforeRecording: true}])),
      ...(before.length > 0 ? {freshSince: atTotals} : {}),
    };
    return;
  }

  // The milestones of the cycle counted in: cycle 1's are the record's own; a later cycle's, its entry's, the last of `cycles`
  // (milestone-record.mjs), whose numbers can skip since 2026-10-22's phase 3.
  const cycle = read.current.cycle > 1 ? record.cycles[record.cycles.length - 1] : null;
  const milestones = cycle === null ? record.milestones : cycle.milestones;

  for (const entry of decided.entries) {
    if (!entry.reached || entry.recorded || Object.hasOwn(milestones, String(entry.percent))) {
      continue;
    }

    // Found reached now, with the totals of this write (decideMilestones gives a milestone reached and not recorded no other end).
    milestones[String(entry.percent)] = entry.end === null
      ? {reachedAt: at}
      : {reachedAt: at, focusSeconds: entry.end.seconds, equals: entry.end.equals};
  }

  const unknown = MILESTONE_PERCENTS.some((percent) => {
    const entry = record.milestones[String(percent)];
    return entry !== undefined && (entry.reachedBeforeRecording === true || entry.focusSeconds === undefined);
  });

  if (unknown && record.freshSince === undefined) {
    record.freshSince = atTotals;
  }
}

// Begins the next cycle, in `stored`, the file's own object inside updateState, on `receipt`, a receipt the tracker read and
// found signed with the claim backend's key and for this install (cycle-receipt.mjs, api.mjs): {installId, cycle, claimId,
// issuedAt}. The plan of 2026-10-21's decision 1: after a claim, all progress resets. The receipt of the cycle the record is in
// begins the next, once: the record holds which receipt began each cycle, so the same receipt again, or one of a cycle past,
// changes nothing. Since 2026-10-22's phase 3 (the coordinator's ruling: the server is the authority on cycles) one of a cycle
// ahead, as a Kit=Code installed afresh after its person's earlier vouchers is given, begins the cycle after the receipt's, as the
// claim backend counts them; until then it changed nothing, and such an install stayed in its cycle for good. Either way a
// receipt only ever resets progress, and never adds any. The new cycle starts at the totals at `now`, `focusSeconds` the
// tracker's own clock as a save writes it (noteMilestonesReached); the totals themselves go on counting, and nothing earlier is
// changed or removed: the record is additive only (hard rule 4). First, as any write that makes progress does, it records what
// is reached by now in the cycle it closes, beginning the record if none was.
//
// Returns {outcome: 'started', cycle, startedAt, start}; {outcome: 'used', cycle, startedAt}, the cycle this receipt began
// already; {outcome: 'cycle', current}, the receipt of a cycle before the record's, `current`; or {outcome: 'damaged', problem},
// a record not what Kit=Code writes, left as it is.
export function beginNextCycle(stored, receipt, now = new Date(Date.now()), {focusSeconds} = {}) {
  noteMilestonesReached(stored, now, {focusSeconds});
  const read = readMilestoneRecord(stored.milestonesReached, MILESTONE_PERCENTS);

  if (read.state === 'damaged') {
    return {outcome: 'damaged', problem: read.problem};
  }

  const used = read.cycles.find((cycle) => cycle.receipt.claimId === receipt.claimId);

  if (used !== undefined) {
    return {outcome: 'used', cycle: used.cycle, startedAt: used.startedAt};
  }

  if (receipt.cycle < read.current.cycle) {
    return {outcome: 'cycle', current: read.current.cycle};
  }

  const totals = totalsIn(stored, focusSeconds);
  const startedAt = now.toISOString();
  const record = stored.milestonesReached;
  const next = {
    cycle: receipt.cycle + 1,
    startedAt,
    focusSeconds: totals.seconds,
    equals: totals.equals,
    receipt: {claimId: receipt.claimId, issuedAt: receipt.issuedAt},
    milestones: {},
  };

  if (Array.isArray(record.cycles)) {
    record.cycles.push(next);
  } else {
    record.cycles = [next];
  }

  return {outcome: 'started', cycle: next.cycle, startedAt, start: {focusSeconds: totals.seconds, equals: totals.equals}};
}

// A milestone record that is not what Kit=Code writes. The claim bundle does not guess at it.
export class MilestoneRecordError extends Error {
  constructor(problem) {
    super(`The record of when each milestone was reached, in state.json, ${problem}. Kit=Code has left it as it is.`);
    this.name = 'MilestoneRecordError';
  }
}

function totalsField(totals) {
  return {focusSeconds: totals.seconds, equals: totals.equals};
}

// The record as the claim bundle reports it: when it began, or null when it has not, and each
// milestone's status and time, from 30 to 100 %. Reads only; a damaged record throws a
// MilestoneRecordError.
//
// Since 2026-10-20 each milestone also carries `start` and `end`, the totals it counted from and those it was reached at,
// {focusSeconds, equals}, when its entry holds them; null otherwise: not reached, or reached with no totals known.
//
// Since 2026-10-22 the record reported is that of the cycle counted in, `cycle`, and `cycleStart` says where it began:
// {at: null, focusSeconds: 0, equals: 0} for cycle 1, install; the moment a later one began, and the totals then, which its
// 30 % counts from.
//
// Since 2026-10-29 every milestone counts from the cycle's start, `cycleStart`, and none carries a start of its own (schema
// version 5): until then each had one, 30 %'s the cycle's, each other's the end of the one before it, or freshSince after one
// reached with no totals known.
const FIRST_CYCLE_START = Object.freeze({at: null, focusSeconds: 0, equals: 0});

export function milestonesReachedFrom(state) {
  const read = readMilestoneRecord(state.milestonesReached, MILESTONE_PERCENTS);

  if (read.state === 'none') {
    return {recordingSince: null, cycle: 1, cycleStart: {...FIRST_CYCLE_START}, milestones: MILESTONE_PERCENTS.map((percent) => ({percent, status: 'not-reached', reachedAt: null, end: null}))};
  }

  if (read.state === 'damaged') {
    throw new MilestoneRecordError(read.problem);
  }

  const {current} = read;

  const milestones = MILESTONE_PERCENTS.map((percent) => {
    const entry = current.entries.get(percent);

    if (entry === undefined) {
      return {percent, status: 'not-reached', reachedAt: null, end: null};
    }

    const end = entry.end === null ? null : totalsField(entry.end);
    return entry.kind === 'before-recording'
      ? {percent, status: 'reached-before-recording', reachedAt: null, end}
      : {percent, status: 'reached', reachedAt: entry.reachedAt, end};
  });

  return {
    recordingSince: read.recordingSince,
    cycle: current.cycle,
    cycleStart: current.cycle > 1 ? {at: current.startedAt, focusSeconds: current.start.seconds, equals: current.start.equals} : {...FIRST_CYCLE_START},
    milestones,
  };
}
