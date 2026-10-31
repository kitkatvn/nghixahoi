import {earnedToward, milestoneProgressPercent} from './break-progress.mjs';
import {focusTime, groupedNumber} from './number-format.mjs';

// A time left, as the hook, `summary` and the skill write it: the one focus-time format (number-format.mjs), so from 1,000 hours whole
// hours with commas, "1,234h", since 2026-10-30.
export function formatBreakDuration(seconds) {
  return focusTime(seconds);
}

export function equalsToBreakCopy(equalsLeft) {
  const remaining = Math.max(0, Math.floor(Number(equalsLeft) || 0));
  return remaining === 0 ? '= done' : `${groupedNumber(remaining)} = to break`;
}

export function timeToBreakCopy(secondsLeft, durationLeft = formatBreakDuration(secondsLeft)) {
  const remaining = Math.max(0, Math.floor(Number(secondsLeft) || 0));
  return remaining === 0 ? 'time done' : `${durationLeft} to break`;
}

export function findNextBreakMilestone(milestones = []) {
  const list = Array.isArray(milestones) ? milestones : [];

  return list.find((milestone) => (
    !milestone.redeemed &&
    milestone.status !== 'ready' &&
    milestone.status !== 'redeemed' &&
    !milestone.unlocked
  )) ?? list.find((milestone) => !milestone.redeemed && milestone.status === 'locked') ?? null;
}

export function nextBreakReminder(reward) {
  if (!reward || typeof reward !== 'object') {
    return null;
  }

  const milestone = findNextBreakMilestone(reward.milestones);
  if (!milestone) {
    return null;
  }

  // What counts toward it (break-progress.mjs earnedToward): since 2026-10-29 the cycle's totals, every milestone a threshold on
  // them; from a tracker of 2026-10-20 to 2026-10-29 what was earned since it began, the moment the milestone before it was
  // reached; from a tracker before then, the totals since install.
  const {seconds: earnedSeconds, equals: totalEquals} = earnedToward(reward, milestone);
  const requiredSeconds = Math.max(0, Number(milestone.requiredSeconds) || 0);
  const requiredEquals = Math.max(0, Number(milestone.requiredEquals) || 0);
  // Floored, so it reads 100 only once the milestone is unlocked (docs/reward-rules.md §10).
  const progressPercent = milestoneProgressPercent(reward, milestone);
  const equalsLeft = Math.max(0, requiredEquals - totalEquals);
  const secondsLeft = Math.max(0, requiredSeconds - earnedSeconds);
  const durationLeft = formatBreakDuration(secondsLeft);
  const almost = progressPercent >= 80;
  const equalsCopy = equalsToBreakCopy(equalsLeft);
  const timeCopy = timeToBreakCopy(secondsLeft, durationLeft);
  const shortLine = `${equalsCopy} · ${timeCopy}`;

  return {
    percent: milestone.percent,
    equalsLeft,
    secondsLeft,
    progressPercent,
    almost,
    durationLeft,
    equalsCopy,
    timeCopy,
    shortLine,
    mentionLine: `Break next: ${shortLine} (${milestone.percent}%).`,
    metaLine: shortLine,
  };
}
