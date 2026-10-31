import path from 'node:path';
import {spawn} from 'node:child_process';
import {hookFinished, hookStarted} from './diagnostics.mjs';
import {appendLogLine} from './log-file.mjs';
import {formatBreakDuration, nextBreakReminder} from './next-break-reminder.mjs';
import {groupedNumber} from './number-format.mjs';
import {getDiskRewardSummary, getReadyUnannouncedTiers, markTiersAnnounced} from './reward.mjs';
import {STORE_DIR, StateLockError, withStateLock} from './store.mjs';
import {isProcessAlive, readTrackerRecord} from './tracker-instance.mjs';
import {CLI_GLOBAL_COMMAND, DASHBOARD_URL} from './integration-spec.mjs';
import {updateAvailable} from './newest-version.mjs';
import {problemSentences, TRACKER_STOPPED} from './tracker-problems.mjs';
import {campaignEnded, trackingConfigInForce} from './tracking-config.mjs';

export const HOOK_LOG_PATH = path.join(STORE_DIR, 'hook.log');

// The hook has 5 s in all (integration-spec.mjs). Another Kit=Code process holds the state lock for
// milliseconds at a time; waiting longer than this means it is stuck, or busy with a large write.
const HOOK_LOCK_TIMEOUT_MS = 1000;

function isDisabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.NGHIXAHOI_HOOKS_OFF ?? '').toLowerCase());
}

function isNghixahoiManagementPrompt(prompt) {
  const trimmed = String(prompt ?? '').trim().toLowerCase();

  return trimmed === 'nghixahoi' ||
    trimmed.startsWith('nghixahoi ') ||
    trimmed === '/nghixahoi' ||
    trimmed.startsWith('/nghixahoi ');
}

// Bounded (log-file.mjs), and it never throws: the hook fails open even when logging fails.
function logHookError(error) {
  appendLogLine(HOOK_LOG_PATH, error?.stack ?? error?.message ?? String(error));
}

// What the hook says about the tracker, in fixed words only (tracker-problems.mjs): tracker.json is
// the user's file, and only a pid, two times and problem codes are read from it.
// The tracker writes tracker.json at least every 10 s; a minute without means it is stuck.
const HEARTBEAT_STALE_MS = 60_000;

function trackerContext(now = Date.now()) {
  const record = readTrackerRecord();

  if (!record || !isProcessAlive(record.pid)) {
    return TRACKER_STOPPED;
  }

  // A tracker from before 2026-09-24 writes no heartbeat, and is taken at its word.
  const heartbeat = Date.parse(record.heartbeatAt);

  if (Number.isFinite(heartbeat) && now - heartbeat > HEARTBEAT_STALE_MS) {
    return 'Kit=Code tracker is not responding, so focus time may not be counted.';
  }

  if (record.tracking !== 'degraded') {
    return '';
  }

  return problemSentences(record.problems).join(' ');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(input));
  });
}

function notify(title, message) {
  const command = process.platform === 'darwin'
    ? {
      bin: 'osascript',
      args: ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    }
    : process.platform === 'win32'
      ? {
        bin: 'powershell.exe',
        args: ['-NoProfile', '-Command', `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`],
      }
      : {
        bin: 'notify-send',
        args: [title, message],
      };

  try {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.on('error', () => {});
    child.unref();
  } catch {
    // Desktop notifications are best-effort.
  }
}

// A milestone reached is said in neutral words (the operator's decisions 5 and 6 of 2026-10-01): its message, from the
// campaign, is on the dashboard, and no milestone is a reward ready, or a code. Until then this said "Reward ready at",
// and the announcement below "Kit=Code break code ready".
//
// Since 2026-10-22 (rewards/3-repeat-vouchers, phase 2) the milestones are those of the cycle counted in (reward.mjs): from cycle
// 2 on the context names it, "Kit=Code progress (cycle 2): …", and the milestones it lists and announces are that cycle's; the =
// and the time are the totals, which keep counting. Cycle 1 reads as it always has. The cycle is the record's, read with the
// rest of the file: no receipt is checked here (hard rule 7).
function cycleOf(reward) {
  return Number.isSafeInteger(reward?.cycle) && reward.cycle > 1 ? reward.cycle : null;
}

function progressContextFor(reward) {
  const nextBreak = reward.nextBreak ?? nextBreakReminder(reward);
  const ready = reward.milestones.filter((entry) => entry.status === 'ready' && !entry.redeemed);
  const cycle = cycleOf(reward);
  const parts = [
    `Kit=Code progress${cycle === null ? '' : ` (cycle ${cycle})`}: ${groupedNumber(reward.totalEquals)} = counted, ${formatBreakDuration(reward.earnedSeconds)} active.`,
  ];

  if (ready.length > 0) {
    parts.push(`Milestone reached at ${ready.map((entry) => `${entry.percent}%`).join(', ')}. Mention \`${CLI_GLOBAL_COMMAND} dashboard\` briefly after this turn.`);
  }

  if (nextBreak) {
    const almost = nextBreak.almost ? ' Almost there.' : '';
    const equalsCopy = nextBreak.equalsCopy ?? `${groupedNumber(nextBreak.equalsLeft)} = to break`;
    const timeCopy = nextBreak.timeCopy ?? `${nextBreak.durationLeft} to break`;
    parts.push(
      `Next break milestone: ${nextBreak.percent}% (${nextBreak.progressPercent}% there; ${equalsCopy}; ${timeCopy}).${almost}`,
    );
    parts.push(`After this turn, briefly mention remaining progress in one short line like: ${nextBreak.mentionLine}`);
  }

  return parts.join(' ');
}

// Since 2026-10-30 (web/7-update-notice; docs/plans/2026-10-29-production-rename-nghixahoi.md, phase 2): while the claim backend's
// signed newest version, as the tracker last saved it, is newer than this Kit=Code, one line, so that Codex or Claude tells the user,
// in the words of the setup prompt's "Updates, for later" ("When Kit=Code says a newer version is available … paste the setup prompt
// from <dashboard> again"). Read from the copy on disk alone, its version checked and not its signature, with no network
// (src/newest-version.mjs; hard rule 7); anything wrong with the copy, or with reading it, is no line, and the rest of the context
// as it would be. Never in a build that never fetches, nor in a tester build, whose version is not x.y.z.
export function updateLineFor(version) {
  return `Kit=Code: a newer version ${version} is available: paste the setup prompt from ${DASHBOARD_URL} again. Briefly tell the user so after this turn, once in this conversation.`;
}

function updateContext() {
  try {
    const update = updateAvailable();
    return update === null ? '' : updateLineFor(update.version);
  } catch {
    return '';
  }
}

function hookOutputFor({tiers = [], reward = null}) {
  const progressContext = [reward ? progressContextFor(reward) : '', trackerContext(), updateContext()].filter(Boolean).join(' ');

  if (tiers.length === 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: progressContext,
      },
    };
  }

  const cycle = cycleOf(reward);
  const labels = `${tiers.map((tier) => `${tier.percent}%`).join(', ')}${cycle === null ? '' : `, cycle ${cycle}`}`;
  const command = `${CLI_GLOBAL_COMMAND} dashboard`;
  const additionalContext = [
    progressContext,
    `Kit=Code milestone reached (${labels}). Briefly tell the user they can open the dashboard with \`${command}\` after this turn.`,
  ].filter(Boolean).join(' ');

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

// What the hook reports, and the tiers it announces, from one read of state.json. The read and the
// announcement happen under the state lock, so a tier is announced once per agent, and the file is
// written only when something is announced. If the lock stays busy, progress is still reported from
// a plain read, and the announcement waits for a later prompt.
function collectPromptProgress(source) {
  try {
    return withStateLock(() => {
      const reward = getDiskRewardSummary();
      const readyTiers = getReadyUnannouncedTiers(source);

      return {reward, announced: markTiersAnnounced(source, readyTiers)};
    }, {lockTimeoutMs: HOOK_LOCK_TIMEOUT_MS});
  } catch (error) {
    if (!(error instanceof StateLockError)) {
      throw error;
    }

    return {reward: getDiskRewardSummary(), announced: []};
  }
}

// In a tester build alone (src/diagnostics.mjs), each run also leaves a start marker, which it removes as it ends, so that a
// run its agent stopped at the timeout is found later by whatever sends, since it cannot record its own end; and it records
// a failure, by the error's code and name, or else a run past 2 s: one event at most, one small file. The hook never touches
// the network: a tester build's tracker, or a command, sends what it recorded. Neither call ever throws; in any other build
// each returns at once.
export async function runPromptHook({source}) {
  if (isDisabled()) {
    return;
  }

  const started = Date.now();
  const marker = hookStarted(source, started);
  let failure = null;

  try {
    const input = await readStdin();
    const payload = JSON.parse(input || '{}');

    if (isNghixahoiManagementPrompt(payload.prompt)) {
      return;
    }

    // After the campaign's end, by this computer's clock (since 2026-10-23, tracking/2-cli; D4 of
    // docs/plans/2026-10-22-server-tracking-config.md), the hook adds nothing: no progress, no milestone, no notification, and nothing
    // written. The end is the last good copy's, read from disk with its bounds checked and no signature: the hook never fetches
    // (src/tracking-config.mjs; hard rule 7). Counting goes on in the tracker, so an end moved later brings every word back.
    if (campaignEnded(trackingConfigInForce())) {
      return;
    }

    const {reward, announced} = collectPromptProgress(source);

    if (announced.length === 0) {
      process.stdout.write(`${JSON.stringify(hookOutputFor({reward}))}\n`);
      return;
    }

    const label = announced.map((tier) => `${tier.percent}%`).join(', ');
    const cycle = cycleOf(reward);
    notify('Kit=Code milestone reached', `Milestone ${label}${cycle === null ? '' : ` of cycle ${cycle}`} unlocked. Open ${CLI_GLOBAL_COMMAND} dashboard.`);
    process.stdout.write(`${JSON.stringify(hookOutputFor({tiers: announced, reward}))}\n`);
  } catch (error) {
    failure = error;
    logHookError(error);
  } finally {
    hookFinished(marker, source, Date.now() - started, failure);
  }
}
