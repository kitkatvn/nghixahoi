import {breakProgressPercent} from './break-progress.mjs';
import {equalsLedgerFrom, storedEqualsLedger} from './equals-ledger.mjs';
import {focusTimeFrom} from './focus-clock.mjs';
import {nextBreakReminder} from './next-break-reminder.mjs';
import {NGHIXAHOI_DISPLAY_MILESTONES, NGHIXAHOI_REWARD_TIERS} from './integration-spec.mjs';
import {readMilestoneRecord} from './milestone-record.mjs';
import {loadState, updateState} from './store.mjs';
import {campaignEnded, trackingConfigInForce} from './tracking-config.mjs';

export const REWARD_TIERS = NGHIXAHOI_REWARD_TIERS;
export const CAMPAIGN_MILESTONES = NGHIXAHOI_DISPLAY_MILESTONES;
export const REWARD_MILESTONES = [
  ...REWARD_TIERS.map((tier) => ({...tier, rewardBacked: true})),
  ...CAMPAIGN_MILESTONES.map((milestone) => ({...milestone, rewardBacked: false})),
];
export const MILESTONE_PERCENTS = REWARD_MILESTONES.map((milestone) => milestone.percent);
// The focus time the 100 % milestone needs, fixed (operator decision Q5, 2026-09-25; docs/reward-rules.md
// §3). Until then it was a setting, down to 1 s: --reward-seconds, NGHIXAHOI_REWARD_SECONDS, and
// rewardSettings.requiredSeconds in state.json. A requiredSeconds an older Kit=Code stored stays in the
// file, unread, as the removed requiredEquals does. Since 2026-10-20 each milestone names its own time in the table
// (integration-spec.mjs), where it was this × its percent: the same numbers in the tester table, which held the operator's
// from 2026-10-21 to 2026-10-22, 100 %'s 8 h, and since then its own again, 100 %'s 3600 s. The = targets are the table's too; no
// setting of the user's changes either (the --reward-equals setting, which gated nothing, was removed on 2026-09-24). Since
// 2026-10-23 these are the bundled table's, the last of the three fallbacks: the summary's requiredSeconds and requiredEquals are
// the last milestone's in force (milestonesOf, below), which the server's tracking config may set (tracking-config.mjs).
const LAST_MILESTONE = REWARD_MILESTONES[REWARD_MILESTONES.length - 1];
export const REWARD_SECONDS = LAST_MILESTONE.requiredSeconds;

const VALID_TIER_PERCENTS = new Set(REWARD_TIERS.map((tier) => tier.percent));

// The milestones, with the targets of `config`, a tracking config (tracking-config.mjs): by default the one in force, the
// document the tracker took from the server, its last good copy, or the table this Kit=Code bundles, the REWARD_MILESTONES above.
// Since 2026-10-23 (tracking/2-cli; docs/plans/2026-10-22-server-tracking-config.md) every milestone is decided against the
// targets in force at the moment it is decided: a milestone reached stays reached, whatever the targets do after (the record says
// so); the one in progress keeps what it earned since it began, and is reached once that meets the targets now in force, so a
// target lowered under what it earned reaches it at the next write, and one raised only lowers its percent. The percents are the
// contract's, 30, 50 and 100, and 30 % the one tier, as before.
export function milestonesOf(config = trackingConfigInForce()) {
  return config.milestones.map(({percent, focusSeconds, equals}) => ({percent, requiredSeconds: focusSeconds, requiredEquals: equals, rewardBacked: VALID_TIER_PERCENTS.has(percent)}));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(source) {
  return source === 'codex' || source === 'claude' ? source : null;
}

export function normalizeTierPercent(value) {
  const percent = Number(value);

  if (!VALID_TIER_PERCENTS.has(percent)) {
    return null;
  }

  return percent;
}

function announcementsOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([source, at]) => normalizeSource(source) && typeof at === 'string'))
    : {};
}

// Since 2026-10-22 (rewards/3-repeat-vouchers, phase 2) a tier is announced once per agent in each cycle: cycle 1's
// announcements are `announced_at`, as they always were, and a later cycle's are kept by its number, `announced_in_cycles`,
// {"2": {"claude": "2026-…"}}, a field written only once a later cycle has one, so that a file with none is byte for byte
// what it was, and a Kit=Code from before reads cycle 1's as ever.
function cycleAnnouncementsOf(value) {
  if (!isObject(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value)
    .filter(([cycle]) => /^[1-9][0-9]*$/u.test(cycle) && Number(cycle) >= 2)
    .map(([cycle, announced]) => [cycle, announcementsOf(announced)])
    .filter(([, announced]) => Object.keys(announced).length > 0));
}

function normalizeTierRecord(entry) {
  const percent = normalizeTierPercent(
    typeof entry === 'object' && entry !== null ? entry.percent : entry,
  );

  if (!percent) {
    return null;
  }

  const byCycle = cycleAnnouncementsOf(entry?.announced_in_cycles);

  return {
    percent,
    redeemed_at: typeof entry?.redeemed_at === 'string' ? entry.redeemed_at : null,
    announced_at: announcementsOf(entry?.announced_at),
    ...(Object.keys(byCycle).length > 0 ? {announced_in_cycles: byCycle} : {}),
  };
}

// Whether `record`, a tier's record, normalized, holds its announcement to `source` in `cycle`.
function announcedIn(record, source, cycle) {
  return cycle > 1 ? Boolean(record?.announced_in_cycles?.[String(cycle)]?.[source]) : Boolean(record?.announced_at?.[source]);
}

export function normalizeEarnedTiers(entries) {
  const records = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const record = normalizeTierRecord(entry);

    if (!record) {
      continue;
    }

    const existing = records.get(record.percent);
    const byCycle = {...(existing?.announced_in_cycles ?? {})};

    for (const [cycle, announced] of Object.entries(record.announced_in_cycles ?? {})) {
      byCycle[cycle] = {...(byCycle[cycle] ?? {}), ...announced};
    }

    records.set(record.percent, {
      percent: record.percent,
      redeemed_at: existing?.redeemed_at ?? record.redeemed_at,
      announced_at: {
        ...(existing?.announced_at ?? {}),
        ...record.announced_at,
      },
      ...(Object.keys(byCycle).length > 0 ? {announced_in_cycles: byCycle} : {}),
    });
  }

  return [...records.values()].sort((a, b) => a.percent - b.percent);
}

function tierRecordMap(ledger) {
  return new Map(normalizeEarnedTiers(ledger.earned_tiers).map((record) => [record.percent, record]));
}

// Replaces the stored records of one tier with a single record made by `change`, in the place of
// the first one. Every other entry, including tiers this version does not know, and every field it
// does not know, is kept as it is.
function updateTierRecord(ledger, percent, change) {
  const entries = ledger.earned_tiers;
  const isThisTier = (entry) => normalizeTierRecord(entry)?.percent === percent;
  const matching = entries.filter(isThisTier);
  const stored = matching.filter(isObject);
  const merged = normalizeEarnedTiers(matching)[0] ?? {percent, redeemed_at: null, announced_at: {}};
  const record = change({
    ...Object.assign({}, ...stored),
    ...merged,
    announced_at: {
      ...Object.assign({}, ...stored.map((entry) => (isObject(entry.announced_at) ? entry.announced_at : {}))),
      ...merged.announced_at,
    },
  });
  const firstIndex = entries.findIndex(isThisTier);

  if (firstIndex === -1) {
    const after = entries.findIndex((entry) => Number(isObject(entry) ? entry.percent : entry) > percent);
    entries.splice(after === -1 ? entries.length : after, 0, record);
    return;
  }

  ledger.earned_tiers = entries.flatMap((entry, index) => {
    if (index === firstIndex) {
      return [record];
    }

    return isThisTier(entry) ? [] : [entry];
  });
}

function reachesTargets(earned, milestone) {
  return earned.seconds >= milestone.requiredSeconds && earned.equals >= milestone.requiredEquals;
}

// The milestones as they stacked until 2026-10-20 (docs/reward-rules.md §2): each reached when the totals since install
// meet its own targets, with every milestone below the highest one reached, or whose code an earlier Kit=Code recorded as
// shown (E8). A record that is not what Kit=Code writes is read so, and nothing is written over it (decideMilestones). Since
// 2026-10-29 this is the rule itself, over cycle 1: each milestone a threshold on the totals since its cycle began.
function stackedReached(totals, redeemed) {
  const highest = Math.max(0, ...REWARD_MILESTONES
    .filter((milestone) => reachesTargets(totals, milestone) || redeemed.has(milestone.percent))
    .map((milestone) => milestone.percent));

  return new Set(MILESTONE_PERCENTS.filter((percent) => percent <= highest));
}

// Which milestones are reached (docs/reward-rules.md §2; docs/plans/2026-10-29-milestones-cumulative.md). Since 2026-10-29 each
// milestone is a threshold on the cycle's totals: reached once the focus time and the = counted since the cycle began both meet
// its own targets. Every milestone counts from the cycle's start, and nothing is counted from the milestone before it, so a
// surplus of time or of = when one is reached counts toward the next too, and one write can reach several. From 2026-10-20 to
// 2026-10-29 (rewards/2-no-stack) each counted its own focus time and = fresh from the moment the one before it was reached, the
// first from the cycle's start, and one write reached one milestone at most; until 2026-10-20 each was a threshold on the totals
// since install, as it is now on the cycle's.
//
// `totals` are the focus seconds, floored, and the = counted since install; `record` the milestone record as state.json
// holds it; `redeemed` the tiers an earlier Kit=Code recorded a code shown for. A milestone the record holds is reached,
// whatever the totals say now, and so is every one below it: a reached milestone stays reached. One that is not held
// is reached once the cycle's totals meet its targets, its moment the moment this is found: the record's next write records it,
// with these totals. The record's freshSince, which counted fresh needed, decides nothing now.
//
// A file with no record yet is read as the first write will record it: the milestones its totals reached as they stacked by the
// table this Kit=Code bundles, reached before the record began; and those the totals meet by the targets in force.
//
// The milestones count in the cycle the record is in (milestone-record.mjs; since 2026-10-22, rewards/3-repeat-vouchers, phase 2):
// cycle 1 from install, until the tracker takes a receipt the claim backend signed for a voucher; then the next, from the totals at
// that moment. Nothing of an earlier cycle counts toward a later one, and nothing an earlier Kit=Code recorded as a code shown
// (`redeemed`) does either: that is cycle 1's.
//
// Returns {stacked, entries, cycle}: `stacked` true for a record that is not what Kit=Code writes, read as the milestones
// stacked; otherwise each entry {percent, reached, recorded, countedFrom, end}, `countedFrom` the totals it counts from, the
// cycle's start, for every milestone; `end` the totals it was reached at, null when not reached or not known; and `cycle`
// {number, startedAt, start, totals}, the cycle counted in, when it began (null for cycle 1), its start totals, and its own
// totals, what was earned since it began.
//
// `milestones` gives the targets, milestonesOf's: by default those in force (tracking-config.mjs; since 2026-10-23). What was
// reached before the record began, and a record not what Kit=Code writes, are read as the milestones stacked by the table this
// Kit=Code bundles, never by the targets in force: they were reached under a Kit=Code's own table, and the server's raise must not
// take away what the record's first write would keep (a ruling of tracking/2-cli, docs/reward-rules.md §2).
export function decideMilestones({totals, record, redeemed = new Set(), milestones = milestonesOf()}) {
  const read = readMilestoneRecord(record, MILESTONE_PERCENTS);

  if (read.state === 'damaged') {
    return {stacked: true, reached: stackedReached(totals, redeemed)};
  }

  const current = read.state === 'none' ? null : read.current;
  const later = current !== null && current.cycle > 1;
  const start = later ? {...current.start} : {seconds: 0, equals: 0};
  const cycleTotals = {seconds: Math.max(0, totals.seconds - start.seconds), equals: Math.max(0, totals.equals - start.equals)};
  const before = read.state === 'none'
    ? new Map([...stackedReached(totals, redeemed)].map((percent) => [percent, {kind: 'before-recording', end: null}]))
    : current.entries;
  const shown = later ? [] : [...redeemed].filter((percent) => MILESTONE_PERCENTS.includes(percent));
  const met = milestones.filter((milestone) => reachesTargets(cycleTotals, milestone)).map((milestone) => milestone.percent);
  const highest = Math.max(0, ...before.keys(), ...shown, ...met);

  const entries = milestones.map((milestone) => {
    const entry = before.get(milestone.percent);

    if (milestone.percent > highest) {
      return {percent: milestone.percent, reached: false, recorded: false, countedFrom: {...start}, end: null};
    }

    // Reached: held by the record, or found now, by its own targets or below one that is, at this write's totals.
    return entry === undefined
      ? {percent: milestone.percent, reached: true, recorded: false, countedFrom: {...start}, end: {...totals}}
      : {percent: milestone.percent, reached: true, recorded: true, countedFrom: {...start}, end: entry.end ?? null};
  });

  return {
    stacked: false,
    entries,
    cycle: later
      ? {number: current.cycle, startedAt: current.startedAt, start, totals: cycleTotals}
      : {number: 1, startedAt: null, start, totals: cycleTotals},
  };
}

// The focus time still needed to reach 100 %: its own focus target less the cycle's focus time, 0 once it is reached or its time is
// met. Since 2026-10-29; from 2026-10-20 each milestone not reached was counted fresh and added up, and until then it was the 100 %
// target less the time earned since install.
function timeLeft(cycleTotals, milestones) {
  const last = milestones[milestones.length - 1];
  return last === undefined || last.unlocked ? 0 : Math.max(0, last.requiredSeconds - cycleTotals.seconds);
}

// Since 2026-10-31 (web/16-day-limit-server-day; docs/requirements.md R60): when each voucher this install was given was issued, by the
// receipts it took (milestones-reached.mjs, beginNextCycle), each later cycle's `receipt.issuedAt`, the instant the claim backend signed:
// one per claim, oldest first. The dashboard counts those that fall on the claim backend's own Vietnam day, which the backend says beside
// its day's most (apps/api create-app.ts, milestoneMessagesAnswer, `day`), and at the day's most greys its claim button. The tracker
// keeps and says what it holds; it decides no day, so no clock of the person's moves the answer. A convenience, not a control: the backend
// refuses a claim past its day's most whatever this says. A receipt never handed back is not here, nor a voucher of this number claimed
// from another install, so a count from it can only be short, and the button then stays as it was. A record with no cycles, none yet, or
// one not what Kit=Code writes gives none.
//
// From 2026-10-30 (web/15-day-limit) until then it was `vouchersToday`, {date, count}, counted on the Vietnam day of the tracker's own
// clock: whenever that clock and the backend's were on other days the button was wrong, and CI failed on it.
export function vouchersIssued(record) {
  const read = readMilestoneRecord(record, MILESTONE_PERCENTS);

  if (read.state !== 'kept') {
    return [];
  }

  const byClaim = new Map();

  for (const {receipt} of read.cycles) {
    if (receipt !== null && !byClaim.has(receipt.claimId)) {
      byClaim.set(receipt.claimId, receipt.issuedAt);
    }
  }

  return [...byClaim.values()].sort((one, other) => Date.parse(one) - Date.parse(other));
}

// The reward summary for `earnedSeconds` of focus time and `totalEquals` counted, against the milestone table
// (integration-spec.mjs), and the milestone record (`record`, state.json's milestonesReached; decideMilestones). It takes
// no target: a `settings` a caller still passes, as older code and tests do, is not read.
//
// Since 2026-10-20 each milestone of the summary also says where it counts from, `countedFrom`, {seconds, equals}: until
// 2026-10-29 the moment the one before it was reached, or null for one that had not begun; since 2026-10-29 the cycle's start,
// for every milestone. And since 2026-10-29 the summary gives the cycle's totals, `cycleTotals`, {seconds, equals}, what was
// earned since the cycle began, which every milestone is a threshold on: a summary that has them counts so (break-progress.mjs).
// A record that is not what Kit=Code writes gives the summary as it was before 2026-10-20: no `countedFrom` and no
// `cycleTotals`, every milestone a threshold on the totals since install.
//
// Since 2026-10-22 the summary says the cycle its milestones count in, `cycle`, 1 until the tracker takes a receipt for a
// voucher (decideMilestones), and `cycleStartedAt`, when a later one began, null for cycle 1; both null for a record that is
// not what Kit=Code writes. Its milestones and tiers are that cycle's: in a later one, none is `redeemed`, a code an earlier
// Kit=Code recorded as shown being cycle 1's.
//
// Since 2026-10-23 (tracking/2-cli; docs/plans/2026-10-22-server-tracking-config.md) its targets are those of `config`, a tracking
// config (tracking-config.mjs), by default the one in force, and the summary says which: `targets`, {source, issuedAt}, `source`
// 'server', 'saved' or 'bundled', `issuedAt` the document's, null for the bundled table; and `campaign`, {endsAt, ended}, the end
// the config gives, an instant or null, and whether it has passed by `now`, the user's clock. Once it has, `nextBreak` is null:
// the campaign names no next milestone, though counting goes on, and a milestone reached is reached as before.
//
// Since 2026-10-31 (web/16-day-limit-server-day) `vouchersIssued`: when each voucher this install was given was issued (vouchersIssued,
// above), which the dashboard counts on the claim backend's day against its day's most. From 2026-10-30 until then `vouchersToday`.
export function buildRewardSummary({earnedSeconds, totalEquals, ledger, record, config = trackingConfigInForce(), now = Date.now()}) {
  const targets = milestonesOf(config);
  const records = tierRecordMap(ledger);
  const normalizedEarnedSeconds = Math.floor(Math.max(0, Number(earnedSeconds) || 0));
  const normalizedTotalEquals = Math.max(0, Number(totalEquals) || 0);
  const totals = {seconds: normalizedEarnedSeconds, equals: normalizedTotalEquals};
  const redeemed = new Set(REWARD_TIERS.filter((tier) => records.get(tier.percent)?.redeemed_at).map((tier) => tier.percent));
  const decided = decideMilestones({totals, record, redeemed, milestones: targets});
  const laterCycle = !decided.stacked && decided.cycle.number > 1;
  const milestones = targets.map((milestone, index) => {
    const record = records.get(milestone.percent);
    const isRedeemed = milestone.rewardBacked && Boolean(record?.redeemed_at) && !laterCycle;
    const unlocked = decided.stacked ? decided.reached.has(milestone.percent) : decided.entries[index].reached;

    return {
      percent: milestone.percent,
      requiredEquals: milestone.requiredEquals,
      requiredSeconds: milestone.requiredSeconds,
      rewardBacked: milestone.rewardBacked,
      displayOnly: !milestone.rewardBacked,
      unlocked,
      redeemed: isRedeemed,
      redeemedAt: isRedeemed ? record.redeemed_at : null,
      status: isRedeemed ? 'redeemed' : unlocked ? 'ready' : 'locked',
      ...(decided.stacked ? {} : {countedFrom: decided.entries[index].countedFrom}),
    };
  });
  const tierPercents = new Set(REWARD_TIERS.map((tier) => tier.percent));
  const tiers = milestones.filter((milestone) => tierPercents.has(milestone.percent)).map((milestone) => ({
    percent: milestone.percent,
    requiredEquals: milestone.requiredEquals,
    requiredSeconds: milestone.requiredSeconds,
    unlocked: milestone.unlocked,
    redeemed: milestone.redeemed,
    redeemedAt: milestone.redeemedAt,
    status: milestone.status,
  }));

  const last = targets[targets.length - 1];
  const ended = campaignEnded(config, now);
  const summary = {
    requiredSeconds: last.requiredSeconds,
    requiredEquals: last.requiredEquals,
    earnedSeconds: normalizedEarnedSeconds,
    totalEquals: normalizedTotalEquals,
    timeLeftSeconds: timeLeft(decided.stacked ? totals : decided.cycle.totals, milestones),
    cycle: decided.stacked ? null : decided.cycle.number,
    cycleStartedAt: decided.stacked ? null : decided.cycle.startedAt,
    ...(decided.stacked ? {} : {cycleTotals: {...decided.cycle.totals}}),
    targets: {source: config.source ?? 'bundled', issuedAt: config.issuedAt ?? null},
    campaign: {endsAt: config.campaignEndsAt ?? null, ended},
    vouchersIssued: vouchersIssued(record),
    tiers,
    milestones,
  };

  // The one progress number the CLI, the Mini and the dashboard all show (docs/reward-rules.md
  // §10). `progress` is the same number as a fraction; until 2026-09-24 it was time alone.
  summary.progressPercent = breakProgressPercent(summary);
  summary.progress = summary.progressPercent / 100;
  summary.nextBreak = ended ? null : nextBreakReminder(summary);
  return summary;
}

function rewardSummaryFrom(state) {
  const ledger = equalsLedgerFrom(state);
  // The shared clock (docs/reward-rules.md §4); in a file from before it, the summed total.
  const earnedSeconds = focusTimeFrom(state).activeSeconds;

  return buildRewardSummary({
    earnedSeconds,
    totalEquals: ledger.total_equals,
    ledger,
    record: state.milestonesReached,
  });
}

export function getDiskRewardSummary() {
  return rewardSummaryFrom(loadState());
}

// Records tier changes in the stored ledger, under the state lock.
function saveTierRecords(changes) {
  updateState((state) => {
    const ledger = storedEqualsLedger(state);

    for (const [percent, change] of changes) {
      updateTierRecord(ledger, percent, change);
    }

    ledger.last_updated_at = new Date().toISOString();
  });
}

// Since 2026-10-01 nothing records a code as shown (the operator's decision 6: the break codes are gone). A tier whose
// code an earlier version recorded as shown keeps its redeemed_at, and so its status, `redeemed`: it was reached, and
// the record says so (docs/reward-rules.md §7).

// Each tier given is announced to `source` in its cycle, `tier.cycle`, 1 when it names none (getReadyUnannouncedTiers).
export function markTiersAnnounced(source, tiers) {
  const normalizedSource = normalizeSource(source);

  if (!normalizedSource || tiers.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  const announced = [];
  const changes = [];

  for (const tier of tiers) {
    const percent = normalizeTierPercent(tier.percent);

    if (!percent) {
      continue;
    }

    const cycle = Number.isSafeInteger(tier.cycle) && tier.cycle > 1 ? tier.cycle : 1;

    changes.push([percent, (record) => (cycle === 1
      ? {...record, announced_at: {...record.announced_at, [normalizedSource]: now}}
      : {...record, announced_in_cycles: {...record.announced_in_cycles, [cycle]: {...record.announced_in_cycles?.[cycle], [normalizedSource]: now}}})]);
    announced.push({...tier, cycle, announcedAt: now});
  }

  if (changes.length > 0) {
    saveTierRecords(changes);
  }

  return announced;
}

export function getReadyUnannouncedTiers(source) {
  const normalizedSource = normalizeSource(source);

  if (!normalizedSource) {
    return [];
  }

  const state = loadState();
  const records = tierRecordMap(equalsLedgerFrom(state));
  const summary = rewardSummaryFrom(state);
  const cycle = summary.cycle ?? 1;

  return summary.tiers
    .filter((tier) => tier.status === 'ready' && !announcedIn(records.get(tier.percent), normalizedSource, cycle))
    .map((tier) => ({...tier, cycle}));
}
