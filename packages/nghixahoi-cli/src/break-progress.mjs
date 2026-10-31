// The progress numbers Kit=Code shows (docs/reward-rules.md §10). The CLI's summary, the Mini and the
// dashboard all show breakProgressPercent, so they agree. Every number is floored: none of them
// reaches a milestone's percent before both of that milestone's targets are reached.
//
// Since 2026-10-29 (rewards/5-cumulative; docs/plans/2026-10-29-milestones-cumulative.md) each milestone is a threshold on the
// cycle's totals, which a summary gives, `cycleTotals` (reward.mjs): every number here is then the cycle's totals against the
// milestones, as the numbers were against the totals since install until 2026-10-20, a milestone the summary says is reached
// counting as reached whatever the totals. Three kinds of summary are read, by what they hold:
//
//   - `cycleTotals`, a tracker's since 2026-10-29: thresholds on the cycle's totals;
//   - `countedFrom` on its milestones and no `cycleTotals`, a tracker's from 2026-10-20 to 2026-10-29 (rewards/2-no-stack), whose
//     milestones each counted fresh from the moment the one before it was reached: every number is the progress within the
//     current milestone, what was earned since its start, and nothing earned before it;
//   - neither, a tracker's before 2026-10-20, or a record that is not what Kit=Code writes: thresholds on the totals since install.
//
// Pure, with no imports: the web app imports this file at build time.

function earnedOf(reward) {
  return {
    seconds: Math.floor(Math.max(0, Number(reward?.earnedSeconds) || 0)),
    equals: Math.max(0, Number(reward?.totalEquals) || 0),
  };
}

function targetsOf(milestone) {
  return {
    seconds: Math.max(0, Number(milestone?.requiredSeconds) || 0),
    equals: Math.max(0, Number(milestone?.requiredEquals) || 0),
  };
}

function ladderOf(milestones) {
  return (Array.isArray(milestones) ? milestones : [])
    .map((milestone) => ({
      percent: Number(milestone?.percent) || 0,
      ...targetsOf(milestone),
      milestone,
    }))
    .sort((a, b) => a.percent - b.percent);
}

// The cycle's totals a summary gives, {seconds, equals}, every milestone a threshold on them: a tracker's since 2026-10-29. Null for
// a summary that gives none, a tracker's from before.
function cycleTotalsOf(reward) {
  const totals = reward?.cycleTotals;

  if (totals === null || typeof totals !== 'object') {
    return null;
  }

  return {
    seconds: Math.floor(Math.max(0, Number(totals.seconds) || 0)),
    equals: Math.max(0, Number(totals.equals) || 0),
  };
}

// Whether a summary's milestones count fresh, each from where it says: a tracker's from 2026-10-20 to 2026-10-29.
function countsFresh(milestones) {
  return Array.isArray(milestones) && milestones.some((milestone) => milestone !== null && typeof milestone === 'object' && Object.hasOwn(milestone, 'countedFrom'));
}

// A milestone the summary says is reached: ready, or a code an earlier Kit=Code recorded as shown.
function isReached(milestone) {
  return milestone?.unlocked === true || milestone?.redeemed === true || milestone?.status === 'ready' || milestone?.status === 'redeemed';
}

// What counts toward `milestone`, {seconds, equals}. Since 2026-10-29: the cycle's totals, and for one reached, its targets,
// which it met. From a tracker of 2026-10-20 to 2026-10-29, counted fresh: what was earned since its start, `countedFrom`;
// nothing for one that has not begun; and for one reached, its targets. From a tracker before 2026-10-20: the totals since
// install.
export function earnedToward(reward, milestone) {
  const earned = earnedOf(reward);
  const cycle = cycleTotalsOf(reward);

  if (cycle !== null && milestone !== null && typeof milestone === 'object') {
    return isReached(milestone) ? targetsOf(milestone) : cycle;
  }

  if (milestone === null || typeof milestone !== 'object' || !Object.hasOwn(milestone, 'countedFrom')) {
    return earned;
  }

  if (isReached(milestone)) {
    return targetsOf(milestone);
  }

  const from = milestone.countedFrom;

  if (from === null || typeof from !== 'object') {
    return {seconds: 0, equals: 0};
  }

  return {
    seconds: Math.max(0, earned.seconds - Math.floor(Math.max(0, Number(from.seconds) || 0))),
    equals: Math.max(0, earned.equals - Math.max(0, Number(from.equals) || 0)),
  };
}

// How far `value` has got from one target to the next, from 0 to 1.
function segmentFraction(value, from, to) {
  if (!(to > from)) {
    return value >= to ? 1 : 0;
  }

  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

// Climbs the milestones in order. Past every milestone `reached` accepts, the percent is that
// milestone's percent plus the share of the way to the next one, and stays below the next one.
function climb(ladder, reached, fraction) {
  let previous = {percent: 0, seconds: 0, equals: 0};

  for (const step of ladder) {
    if (!reached(step)) {
      const percent = Math.floor(previous.percent + fraction(previous, step) * (step.percent - previous.percent));
      return Math.max(previous.percent, Math.min(step.percent - 1, percent));
    }

    previous = step;
  }

  return previous.percent;
}

// Counted fresh: past every milestone reached, that one's percent plus `share` of the way to the next, floored, and at
// most `cap(step)`.
function climbFresh(reward, milestones, share, cap = (step) => step.percent - 1) {
  let previous = 0;

  for (const step of ladderOf(milestones)) {
    if (!isReached(step.milestone)) {
      const earned = earnedToward(reward, step.milestone);
      const percent = Math.floor(previous + share(earned, step) * (step.percent - previous));
      return Math.max(previous, Math.min(cap(step), percent));
    }

    previous = step.percent;
  }

  return previous;
}

function shareOf(value, target) {
  return target > 0 ? Math.min(1, value / target) : 1;
}

// Percent of the way to one milestone: floor(100 × min(time ÷ its time, = ÷ its =)), at most 100.
// It is 100 only when both targets are reached, so a locked milestone never shows 100 %. The time and the = are what counts
// toward it (earnedToward): the cycle's totals since 2026-10-29, what was earned since its start while milestones counted fresh.
export function milestoneProgressPercent(reward, milestone) {
  const {seconds, equals} = earnedToward(reward, milestone);
  const requiredSeconds = Math.max(0, Number(milestone?.requiredSeconds) || 0);
  const requiredEquals = Math.max(0, Number(milestone?.requiredEquals) || 0);
  const time = requiredSeconds > 0 ? Math.floor((100 * seconds) / requiredSeconds) : 100;
  const equalsPercent = requiredEquals > 0 ? Math.floor((100 * equals) / requiredEquals) : 100;

  return Math.max(0, Math.min(100, time, equalsPercent));
}

// The one progress number: how far along the milestones, 30, 50 and 100 % since 2026-10-08 (10, 20, 30, 50 and 100 %
// until then), both targets have got together. It is at least the percent of every milestone reached, and below the percent of the
// first one that is not. Since 2026-10-29 the share of the way to the next milestone is the share of the way from the last one's
// targets to the next one's that the cycle's totals have covered, both of them, as it was over the totals since install until
// 2026-10-20; a milestone the summary says is reached counts as reached. Counted fresh, from 2026-10-20 to 2026-10-29, it was the
// share of the next one's own targets earned since its start.
export function breakProgressPercent(reward, milestones = reward?.milestones) {
  const cycle = cycleTotalsOf(reward);

  if (cycle !== null) {
    return climb(
      ladderOf(milestones),
      (step) => isReached(step.milestone) || (cycle.seconds >= step.seconds && cycle.equals >= step.equals),
      (from, to) => Math.min(segmentFraction(cycle.seconds, from.seconds, to.seconds), segmentFraction(cycle.equals, from.equals, to.equals)),
    );
  }

  if (countsFresh(milestones)) {
    return climbFresh(reward, milestones, (earned, step) => Math.min(shareOf(earned.seconds, step.seconds), shareOf(earned.equals, step.equals)));
  }

  const {seconds, equals} = earnedOf(reward);

  return climb(
    ladderOf(milestones),
    (step) => seconds >= step.seconds && equals >= step.equals,
    (from, to) => Math.min(segmentFraction(seconds, from.seconds, to.seconds), segmentFraction(equals, from.equals, to.equals)),
  );
}

// Time alone, placed on the same milestones: since 2026-10-29 the cycle's focus time, climbing past every milestone whose time it
// met, as the totals since install did until 2026-10-20. Counted fresh, it reached the next milestone's percent once its time was
// earned, and went no further: time earned past it while waiting for = counted toward nothing.
export function timeProgressPercent(reward, milestones = reward?.milestones) {
  const cycle = cycleTotalsOf(reward);

  if (cycle !== null) {
    return climb(ladderOf(milestones), (step) => cycle.seconds >= step.seconds, (from, to) => segmentFraction(cycle.seconds, from.seconds, to.seconds));
  }

  if (countsFresh(milestones)) {
    return climbFresh(reward, milestones, (earned, step) => shareOf(earned.seconds, step.seconds), (step) => step.percent);
  }

  const {seconds} = earnedOf(reward);

  return climb(ladderOf(milestones), (step) => seconds >= step.seconds, (from, to) => segmentFraction(seconds, from.seconds, to.seconds));
}

// = alone, placed on the same milestones, as time alone is.
export function equalsProgressPercent(reward, milestones = reward?.milestones) {
  const cycle = cycleTotalsOf(reward);

  if (cycle !== null) {
    return climb(ladderOf(milestones), (step) => cycle.equals >= step.equals, (from, to) => segmentFraction(cycle.equals, from.equals, to.equals));
  }

  if (countsFresh(milestones)) {
    return climbFresh(reward, milestones, (earned, step) => shareOf(earned.equals, step.equals), (step) => step.percent);
  }

  const {equals} = earnedOf(reward);

  return climb(ladderOf(milestones), (step) => equals >= step.equals, (from, to) => segmentFraction(equals, from.equals, to.equals));
}
