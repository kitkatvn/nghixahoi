#!/usr/bin/env node

import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import readline from 'node:readline/promises';
import {DASHBOARD_URL, openDashboard} from '../src/open-dashboard.mjs';
// The command this build runs as, in everything it prints: nghixahoi in production, nghixahoi in a tester build (since 2026-10-29).
import {CLI_GLOBAL_COMMAND} from '../src/integration-spec.mjs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {createServer} from '../src/api.mjs';
import {isLoopbackAddress} from '../src/api-access.mjs';
import {
  configProblemCode,
  describeOutcome,
  diagnosticsEnabled,
  diagnosticsStatus,
  errorCodeOf,
  errorNameOf,
  projectRef,
  recordEvent,
  sendQueued,
  startDiagnosticsLoop,
  sweepHookMarkers,
} from '../src/diagnostics.mjs';
import {manualHookSnippet} from '../src/hook-installers.mjs';
import {runPromptHook} from '../src/hook-prompt.mjs';
import {installIntegration, integrationStatus, uninstallIntegration} from '../src/integration-installers.mjs';
import {ensureInstallId} from '../src/install-id.mjs';
import {milestoneProgressPercent} from '../src/break-progress.mjs';
import {focusTime, groupedNumber} from '../src/number-format.mjs';
import {safeProblemCode} from '../src/tracker-problems.mjs';
import {getDiskRewardSummary} from '../src/reward.mjs';
import {
  createRuntime,
  DEFAULT_HOST,
  describeWorktrees,
  listProjects,
  prepareState,
  registerProject,
  removeProject,
  startWatchers,
} from '../src/runtime.mjs';
import {loadState, onboardingPreferences, StateFileError, StateLockError} from '../src/store.mjs';
import {createLog} from '../src/log-file.mjs';
import {
  claimTracker,
  findRunningTracker,
  isProcessAlive,
  readTrackerRecord,
  releaseTracker,
  TRACKER_LOG_PATH,
  trackerHealth,
  updateTrackerRecord,
} from '../src/tracker-instance.mjs';
import {stopLegacyTracker} from '../src/legacy.mjs';
import {describeHolder, firstFreePort, listenOnFirstFree, portHolder, trackerPorts} from '../src/tracker-ports.mjs';
import {askTrackerToStop, watchForStopRequest} from '../src/tracker-stop.mjs';
import {startTrackingConfigLoop, TRACKING_CONFIG_DISPLAY_PATH, trackingConfigUrl} from '../src/tracking-config.mjs';
import {tryNewestVersion} from '../src/newest-version.mjs';
import {normalizeSetupPlatform} from '../src/onboarding-platform.mjs';
import {uninstallNghixahoi} from '../src/uninstall.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const VERSION = require(path.join(PACKAGE_ROOT, 'package.json')).version;
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  primary: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  underline: '\x1b[4m',
};

function parseBooleanEnv(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function colorize(value, ...styles) {
  if (!USE_COLOR) {
    return value;
  }

  return `${styles.join('')}${value}${COLOR.reset}`;
}

function trackerAllowedOrigins() {
  const origins = new Set(
    String(process.env.NGHIXAHOI_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  // The dashboard's origin, or, for a DASHBOARD_URL that is not a URL, production's (since 2026-10-22, where it was the
  // previous project's site): the same origin, which a release under latest writes as it writes DASHBOARD_URL (since
  // ops/3-domain-input, scripts/release.mjs). A tester build's copy has no fallback.
  try {
    origins.add(new URL(DASHBOARD_URL).origin);
  } catch {
    origins.add('https://nghixahoi.vn');
  }

  return [...origins].join(',');
}

function trackerChildEnvironment(overrides = {}) {
  return {
    ...process.env,
    NGHIXAHOI_ALLOWED_ORIGINS: trackerAllowedOrigins(),
    NGHIXAHOI_DAEMON: '1',
    NGHIXAHOI_NO_OPEN: '1',
    NO_COLOR: process.env.NO_COLOR ?? '1',
    ...overrides,
  };
}

function createStatusReporter() {
  const frames = ['-', '\\', '|', '/'];
  const useSpinner = process.stdout.isTTY && !process.env.CI;
  let frameIndex = 0;
  let message = '';
  let timer = null;
  let lastPlainMessage = '';

  const clear = () => {
    if (useSpinner && message) {
      process.stdout.write('\r\x1b[2K');
    }
  };

  const render = () => {
    if (!useSpinner || !message) {
      return;
    }

    const frame = colorize(frames[frameIndex % frames.length], COLOR.cyan);
    frameIndex += 1;
    process.stdout.write(`\r${frame} ${message}`);
  };

  return {
    set(nextMessage) {
      if (!nextMessage || nextMessage === message) {
        return;
      }

      message = nextMessage;

      if (!useSpinner) {
        if (lastPlainMessage !== nextMessage) {
          console.log(nextMessage);
          lastPlainMessage = nextMessage;
        }

        return;
      }

      render();
      timer ??= setInterval(render, 120);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      clear();
      message = '';
    },
  };
}

function parseArgs(argv) {
  const firstArg = argv[2];
  const command = !firstArg || (
    firstArg.startsWith('-') &&
    firstArg !== '--help' &&
    firstArg !== '-h' &&
    firstArg !== '--version' &&
    firstArg !== '-v'
  ) ? 'help' : firstArg;
  const options = {
    command,
    subcommand: argv[3],
    host: DEFAULT_HOST,
    // None given: the tracker takes the first free of 4747 to 4751 (src/tracker-ports.mjs).
    port: undefined,
    source: undefined,
    tier: undefined,
    openDashboard: !parseBooleanEnv(process.env.NGHIXAHOI_NO_OPEN),
    yes: false,
    setupPlatform: undefined,
    allowNonLoopback: false,
  };

  if (options.command === '--help' || options.command === '-h') {
    options.command = 'help';
  } else if (options.command === '--version' || options.command === '-v') {
    options.command = 'version';
  }

  for (let index = command === firstArg ? 3 : 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--host' && next) {
      options.host = next;
      index += 1;
    } else if (arg === '--port' && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === '--source' && next) {
      options.source = next;
      index += 1;
    } else if (arg === '--tier' && next) {
      options.tier = Number(next);
      index += 1;
    } else if (arg === '--platform' && next) {
      options.setupPlatform = next;
      index += 1;
    } else if (arg === '--no-open') {
      options.openDashboard = false;
    } else if (arg === '--allow-non-loopback') {
      options.allowNonLoopback = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--version' || arg === '-v') {
      options.command = 'version';
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }

  // --reward-seconds and NGHIXAHOI_REWARD_SECONDS are gone, as --reward-equals is: the time target is
  // fixed (operator decision Q5, 2026-09-25; reward.mjs REWARD_SECONDS). Either is ignored if given.
  return options;
}

function printHelp() {
  console.log(`Usage: ${CLI_GLOBAL_COMMAND} [command] [options]

Commands:
  add [path]            Add a project to Kit=Code, default current directory
  remove [path]         Remove a project and its contribution data
  track                 Start the Kit=Code tracker in the background
  untrack               Stop the Kit=Code tracker
  list                  Show added project totals
  status                Show tracker, project, and reward progress
  summary               Show compact =, active time, and milestone progress
  awards                Show reward and milestone readiness
  dashboard             Open the dashboard for the running tracker
  setup                 Open Kit=Code preferences and onboarding
  uninstall             Remove Kit=Code hooks, skills, tracker, and local state
  hook prompt --source codex|claude
                        Internal prompt hook used by Codex and Claude
  codex on|off|status   Install, remove, or inspect the Codex hook and skill
  claude on|off|status  Install, remove, or inspect the Claude hook and skill
  diagnostics status|send
                        A tester build's diagnostics: what waits, and send it now

Options:
  --host <host>         Host to bind, default ${DEFAULT_HOST}
  --allow-non-loopback  Let track bind a --host other than 127.0.0.1 or localhost
  --port <port>         Port to bind, default the first free of ${trackerPorts()[0]} to ${trackerPorts().at(-1)}
  --no-open             Do not open the hosted dashboard automatically
  --platform <os>       Preview Welcome chrome: macos|windows|linux (default: host OS)
  --yes                 Confirm destructive commands without prompting
  -v, --version         Print version
  -h, --help            Print help
`);
}

// The numbers come from the summary: the same ones the Mini and the dashboard show
// (docs/reward-rules.md §10). The next milestone follows the ready ones: until 2026-10-01 a ready milestone hid it, and
// showing a 10–30 % code was what cleared one; with the codes gone nothing does (docs/reward-rules.md §7). Since 2026-10-22
// the milestones are those of the cycle counted in, which it names from cycle 2 on, when it began (docs/reward-rules.md §2,
// "Cycles"); cycle 1 reads as it always has.
//
// Since 2026-10-23 (tracking/2-cli; the plan's D4) a campaign that has ended, by this computer's clock and the end the targets in force
// give (src/tracking-config.mjs), is said so in the plan's words, and no next milestone is named: the summary has none. Counting, and
// what was reached, are as before.
function printRewardSummary(reward = getDiskRewardSummary()) {
  const next = reward.nextBreak;
  const ready = reward.milestones.filter((milestone) => milestone.status === 'ready' && !milestone.redeemed);

  console.log('Kit=Code summary');
  console.log(`  = counted: ${groupedNumber(reward.totalEquals)}`);
  console.log(`  active time: ${focusTime(reward.earnedSeconds)}`);
  console.log(`  campaign progress: ${reward.progressPercent}%`);

  if (reward.campaign?.ended) {
    console.log(`  ${campaignEndedWords(reward.campaign)}`);
  }

  if (Number.isSafeInteger(reward.cycle) && reward.cycle > 1) {
    console.log(`  cycle: ${reward.cycle}, its milestones counted from ${reward.cycleStartedAt}`);
  }

  if (ready.length > 0) {
    console.log(`  ready: ${ready.map((milestone) => `${milestone.percent}%`).join(', ')}`);
  }

  if (next) {
    console.log(`  next milestone: ${next.percent}% (${next.progressPercent}% there)`);
    console.log(`  to break: ${next.equalsCopy}, ${next.timeCopy}`);
  }
}

// Each milestone, locked or ready. Since 2026-10-01 none has a code (the operator's decision 6): a tier whose code an
// earlier version recorded as shown keeps its `redeemed` status in the API, and reads as ready here, a milestone reached;
// until then it read "code shown", and the 10–30 % tiers "reward".
function printAwards() {
  const reward = getDiskRewardSummary();

  console.log('Kit=Code awards');
  for (const milestone of reward.milestones) {
    const status = milestone.status === 'redeemed' ? 'ready' : milestone.status;
    console.log(`  ${milestone.percent}% milestone: ${status} (${milestoneProgressPercent(reward, milestone)}%)`);
  }

  if (reward.campaign?.ended) {
    console.log(`  ${campaignEndedWords(reward.campaign)}`);
  }
}

// An instant in Vietnam time, UTC+7 all year, as "YYYY-MM-DD HH:MM": the campaign's end is set so (docs/backend.md,
// VOUCHER_CAMPAIGN_END), and the plan's words name its date there.
function vietnamTime(instant) {
  return new Date(Date.parse(instant) + 7 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

// The plan's words for a campaign that has ended (D4 of docs/plans/2026-10-22-server-tracking-config.md).
function campaignEndedWords(campaign) {
  return `Kit=Code's campaign ended on ${vietnamTime(campaign.endsAt).slice(0, 10)} (Vietnam time). Your totals are kept; no more vouchers can be claimed.`;
}

// Which targets Kit=Code counts by, and where they came from (src/tracking-config.mjs), so that a fallback never reads as the healthy
// path; and the campaign's end. From the summary this command builds: the last good copy on disk, as the prompt hook reads it.
function targetsLine(targets) {
  if (targets.source === 'bundled') {
    return trackingConfigUrl() === null
      ? 'the ones this Kit=Code bundles; this build never asks a server for them'
      : `the ones this Kit=Code bundles, since ${TRACKING_CONFIG_DISPLAY_PATH} holds no good copy of the server's yet`;
  }

  return `the server's, issued ${targets.issuedAt}${targets.source === 'saved' ? `, from the copy in ${TRACKING_CONFIG_DISPLAY_PATH}` : ''}`;
}

function campaignLine(campaign) {
  if (campaign.endsAt === null) {
    return 'no end set';
  }

  return campaign.ended ? `ended on ${vietnamTime(campaign.endsAt).slice(0, 10)} (Vietnam time)` : `ends ${vietnamTime(campaign.endsAt)} (Vietnam time)`;
}

async function printStatus(options) {
  const totals = listProjects();
  const found = await findRunningTracker();
  const running = found?.state === 'running' || await isServerRunning(options);
  const problems = found?.health?.tracking === 'degraded' && Array.isArray(found.health.problems) ? found.health.problems : [];

  console.log('Kit=Code status');
  console.log(`  tracker: ${running ? 'running' : found?.state === 'unresponsive' ? 'not responding' : 'stopped'}`);

  // The port, when it is not the first: what holds that one, as the tracker found it when it started (runDaemon).
  if (running && found?.record && Number(found.record.port) !== trackerPorts()[0]) {
    console.log(`  port: ${portLine(found.record)}`);
  }

  if (problems.length > 0) {
    // /api/health may be answered by a process squatting the port, so its codes are sanitized and
    // its counts coerced to a number before they are printed (docs/security.md).
    console.log(`  tracker problems: ${problems.map((problem) => {
      const count = Number.isInteger(problem.projects) ? problem.projects : 0;
      return `${safeProblemCode(problem.code)} (${groupedNumber(count)} project${count === 1 ? '' : 's'})`;
    }).join(', ')}; see ${TRACKER_LOG_PATH}`);
  }
  console.log(`  added projects: ${groupedNumber(totals.trackingProjects)}`);
  printWorktrees();
  const reward = getDiskRewardSummary();
  console.log(`  targets: ${targetsLine(reward.targets)}`);
  console.log(`  campaign: ${campaignLine(reward.campaign)}`);
  printRewardSummary(reward);
}


// The tracker's port, and why it is not the first: the ports it found in use, and what held each, as tracker.json records them.
function portLine(record) {
  const inUse = Array.isArray(record.portsInUse) ? record.portsInUse.filter((entry) => Number.isInteger(entry?.port)) : [];
  const held = inUse.map((entry) => {
    const holder = describeHolder(entry.heldBy);
    return holder ? `${entry.port} (held by ${holder})` : String(entry.port);
  });
  return `${record.port}${held.length > 0 ? `, since ${held.join(', ')} ${held.length === 1 ? 'was' : 'were'} in use` : ''}`;
}

// The worktrees of the added repositories (docs/reward-rules.md §5.9): how many are counted with them, and each one git lists that
// cannot be counted, and why.
function printWorktrees() {
  const worktrees = describeWorktrees();
  const counted = worktrees.filter((worktree) => worktree.state === 'ok').length;

  if (counted > 0) {
    console.log(`  worktrees: ${groupedNumber(counted)}, counted with their repositories`);
  }

  for (const worktree of worktrees.filter((entry) => entry.state !== 'ok')) {
    const why = worktree.state === 'prunable' ? 'git calls it prunable: its folder is gone' : 'git cannot read it';
    console.log(`  worktree not counted: ${worktree.path} (${why})`);
  }
}

// Electron is an optional dependency, and it downloads its binary the first time it is required
// (node_modules/electron/index.js). Three different failures, each reported as what it is: the
// package is not installed; the download failed; or the binary is not where Electron says.
function resolveElectronPath() {
  try {
    require.resolve('electron');
  } catch {
    return {ok: false, reason: 'missing-electron'};
  }

  let electronPath;

  try {
    electronPath = require('electron');
  } catch (error) {
    return {ok: false, reason: 'electron-download-failed', detail: error?.message ?? String(error)};
  }

  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    return {ok: false, reason: 'electron-binary-missing', detail: String(electronPath)};
  }

  return {ok: true, path: electronPath};
}

const ELECTRON_READY_MS = 1500;

function openElectronEntry(entryName, environment = {}) {
  return new Promise((resolve) => {
    if (process.env.NGHIXAHOI_DRY_ELECTRON === 'fail') {
      resolve({
        ok: false,
        reason: 'missing-electron',
        detail: 'Forced Electron launch failure for checks.',
      });
      return;
    }

    if (parseBooleanEnv(process.env.NGHIXAHOI_DRY_ELECTRON)) {
      resolve({ok: true, reason: 'dry-run'});
      return;
    }

    const electron = resolveElectronPath();
    if (!electron.ok) {
      resolve(electron);
      return;
    }

    const electronPath = electron.path;

    const entryPath = path.resolve(fileURLToPath(new URL(`../src/${entryName}`, import.meta.url)));
    if (!fs.existsSync(entryPath)) {
      resolve({ok: false, reason: 'missing-entry', detail: entryPath});
      return;
    }

    let settled = false;
    let stderr = '';
    const child = spawn(electronPath, [entryPath], {
      detached: true,
      env: {
        ...process.env,
        NGHIXAHOI_NODE_PATH: process.execPath,
        NGHIXAHOI_CLI_ENTRY: fileURLToPath(import.meta.url),
        NGHIXAHOI_NO_OPEN: '1',
        ...environment,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      // GUI Electron must remain visible on Windows; windowsHide can suppress the desktop window.
      windowsHide: false,
    });

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();

      if (result.ok) {
        child.unref();
      }

      resolve(result);
    };

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.once('error', (error) => {
      finish({ok: false, reason: 'spawn-error', detail: error.message});
    });

    child.once('exit', (code, signal) => {
      const detail = stderr.trim()
        || `Electron exited before the window opened (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`;
      finish({ok: false, reason: 'exited', detail, code, signal});
    });

    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        finish({ok: true});
      }
    }, ELECTRON_READY_MS);
  });
}

function printElectronSetupHelp() {
  console.error('Kit=Code setup needs Electron for the desktop folder picker.');
  console.error('Reinstall with: npm install -g @kitkatvn/nghixahoi');
  console.error('If install succeeded but Electron is still missing, fix npm cache permissions and reinstall.');
}

function printElectronLaunchFailure(result, label) {
  console.error(`${label} could not open.`);

  if (result?.reason === 'electron-download-failed') {
    console.error(`Electron's binary could not be downloaded: ${result.detail}`);
    console.error(`Electron downloads it the first time Kit=Code opens a window. Check the network connection, and any proxy, then run \`${CLI_GLOBAL_COMMAND} setup\` again.`);
    return;
  }

  if (result?.reason === 'electron-binary-missing') {
    console.error(`Electron's binary is missing: Electron points to ${result.detail}, and nothing is there.`);
    console.error('Reinstall with: npm install -g @kitkatvn/nghixahoi');
    return;
  }

  if (result?.detail) {
    console.error(result.detail);
  }
  printElectronSetupHelp();
}

async function openOnboardingWindow(options = {}) {
  console.log('Opening Kit=Code Welcome...');
  const environment = {
    NGHIXAHOI_HOST: options.host,
    // None given: Welcome starts the tracker without one, and opens the Mini on the port it took.
    ...(options.port === undefined ? {} : {NGHIXAHOI_PORT: String(options.port)}),
    NGHIXAHOI_INITIAL_PROJECT: path.resolve(options.initialProject ?? process.cwd()),
  };

  if (options.setupPlatform) {
    const platform = normalizeSetupPlatform(options.setupPlatform);
    if (!platform) {
      console.error('Invalid --platform. Use macos, windows, or linux (aliases: darwin, win32).');
      recordWelcomeFailed(options.welcomeCommand ?? 'setup', {reason: 'invalid-platform'});
      await sendOnce();
      return false;
    }
    environment.NGHIXAHOI_SETUP_PLATFORM = platform;
  }

  const result = await openElectronEntry('onboarding-electron.mjs', environment);
  if (result.ok) {
    return true;
  }

  printElectronLaunchFailure(result, 'Kit=Code Welcome');
  recordWelcomeFailed(options.welcomeCommand ?? 'setup', result);
  await sendOnce();
  return false;
}

function printDashboardHint(options) {
  console.log(`${colorize('Dashboard', COLOR.bold)}: ${colorize(DASHBOARD_URL, COLOR.cyan, COLOR.underline)}`);

  if (!options.openDashboard) {
    console.log(colorize('Open dashboard manually when you are ready.', COLOR.dim));
    return;
  }

  console.log(colorize('Opening dashboard in your browser...', COLOR.primary));

  if (!openDashboard(DASHBOARD_URL)) {
    console.log(colorize('Could not open the browser automatically. Paste the dashboard URL above.', COLOR.yellow));
  }
}

// What happened to the hook, from `on` and `off` (`action`), or what `status` found.
function describeHook(hook) {
  if (hook.action === 'refused') {
    return hook.installed === false ? 'not installed (see below)' : 'not removed (see below)';
  }

  if (hook.action) {
    return {installed: 'installed', unchanged: 'already installed', removed: 'removed', 'not-found': 'not found'}[hook.action];
  }

  if (hook.installed === null) {
    return `unknown (${hook.error.message})`;
  }

  return hook.installed ? 'installed' : 'not installed';
}

function printIntegrationStatus(source, status) {
  console.log(`${source}:`);
  if (status.runner) {
    console.log(`  runner: ${status.runner.installed ? 'installed' : 'not installed'}`);
    console.log(`  runner file: ${status.runner.path}`);
  }

  console.log(`  hook: ${describeHook(status.hook)}`);
  console.log(`  config: ${status.hook.path}`);
  if (status.hook.backupPath) {
    console.log(`  config backup: ${status.hook.backupPath}`);
  }
  if (status.hook.command) {
    console.log(`  hook command: ${status.hook.command}`);
  }

  if (status.skill.removed !== undefined) {
    console.log(`  skill: ${status.skill.removed ? 'removed' : 'not found'}`);
  } else {
    console.log(`  skill: ${status.skill.installed ? 'installed' : 'not installed'}`);
  }
  console.log(`  skill file: ${status.skill.path}`);

  if (source === 'codex' && status.hook.installed) {
    console.log('Open /hooks in Codex to review and trust the Kit=Code hook.');
  }
}

// The config was left as it is: say why, and what to change by hand. A read-only file could be read,
// so its Kit=Code entries (`entries`) are printed exactly as they are in it.
function printRefusedHook(source, hook) {
  console.error(`Kit=Code left ${hook.path} as it is: it ${hook.error.problem}.`);
  const entries = hook.entries ?? [];

  if (hook.installed === false) {
    console.error(`To add the Kit=Code hook yourself, merge this into ${hook.path}:`);
    console.error(JSON.stringify(manualHookSnippet(source), null, 2));

    if (entries.length > 0) {
      console.error(`and delete ${entries.length === 1 ? 'the Kit=Code entry' : `the ${entries.length} Kit=Code entries`} already in it, so that the hook runs once:`);
      for (const entry of entries) {
        console.error(JSON.stringify(entry, null, 2));
      }
    }
    return;
  }

  if (entries.length > 0) {
    console.error(`To turn the hook off yourself, delete ${entries.length === 1 ? 'this entry' : 'these entries'} from "hooks" > "UserPromptSubmit" in that file, with its group if nothing else is left in it:`);
    for (const entry of entries) {
      console.error(JSON.stringify(entry, null, 2));
    }
    return;
  }

  console.error(`To turn the hook off yourself, delete the entry whose "command" is "${hook.command}" from "hooks" > "UserPromptSubmit" in that file.`);
}

async function confirmUninstall() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Remove all Kit=Code hooks, skills, tracker, and ~/.nghixahoi data? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function describeRemovedHook(hook) {
  if (hook.action === 'removed') {
    return 'removed';
  }

  return hook.action === 'not-found' ? 'not found' : `not removed: ${hook.error.message}`;
}

function printUninstallReport(report) {
  console.log('Kit=Code uninstall complete.');
  console.log(`  tracker: ${report.tracker.stopped === true ? 'stopped' : report.tracker.stopped === 'requested' ? 'stop requested' : 'not running'}`);
  console.log(`  codex hook: ${describeRemovedHook(report.integrations.codex.hook)} (${report.integrations.codex.hook.path})`);
  console.log(`  claude hook: ${describeRemovedHook(report.integrations.claude.hook)} (${report.integrations.claude.hook.path})`);
  console.log(`  codex skill: ${report.skills.codex.removed ? 'removed' : 'not found'} (${report.skills.codex.path})`);
  console.log(`  claude skill: ${report.skills.claude.removed ? 'removed' : 'not found'} (${report.skills.claude.path})`);
  console.log(`  local state: ${report.store.removed ? 'removed' : 'not found'} (${report.store.path})`);
}

async function handleUninstall(options) {
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error(`Refusing to uninstall without confirmation. Re-run with: ${CLI_GLOBAL_COMMAND} uninstall --yes`);
      process.exit(1);
    }

    if (!(await confirmUninstall())) {
      console.log('Kit=Code uninstall canceled.');
      return;
    }
  }

  console.log('Removing Kit=Code...');
  const report = await uninstallNghixahoi();

  if (report.refused) {
    console.error('Kit=Code uninstall stopped before changing anything:');
    for (const status of report.refused) {
      if (status.error.readOnly) {
        printRefusedHook(status.source, status);
      } else {
        console.error(`  ${status.error.message}. The Kit=Code hook there, if any, runs: ${status.command}`);
      }
    }
    console.error(report.refused.every((status) => status.error.readOnly)
      ? `Then run \`${CLI_GLOBAL_COMMAND} uninstall --yes\` again.`
      : `Repair that file, or delete the Kit=Code hook from it by hand, then run \`${CLI_GLOBAL_COMMAND} uninstall --yes\` again.`);
    process.exit(1);
  }

  printUninstallReport(report);
}

// What became of the hook in the agent's settings, for a tester build's diagnostics: by outcome, and a refusal by a fixed code,
// never the file's path or its words.
function recordAgentHook(source, action, hook) {
  recordEvent('agent-hook', {agent: source, action, outcome: hook.action, problem: hook.action === 'refused' ? configProblemCode(hook.error) : 'none'}, {source: 'command'});
}

async function handleHookInstaller(source, action) {
  if (action === 'on') {
    const status = installIntegration(source);
    printIntegrationStatus(source, status);
    recordAgentHook(source, 'on', status.hook);
    let failed = false;
    if (status.hook.action === 'refused') {
      printRefusedHook(source, status.hook);
      process.exitCode = 1;
      failed = true;
    }
    if (!onboardingPreferences().completed) {
      if (!(await openOnboardingWindow({host: DEFAULT_HOST, initialProject: process.cwd(), welcomeCommand: `${source}-on`}))) {
        console.error(`Kit=Code Welcome could not open. Fix Electron install, then re-run \`${CLI_GLOBAL_COMMAND} setup\`.`);
        process.exitCode = 1;
        failed = true;
      }
    }
    if (failed) {
      await sendOnce();
    }
    return;
  }

  if (action === 'off') {
    const status = uninstallIntegration(source);
    printIntegrationStatus(source, status);
    recordAgentHook(source, 'off', status.hook);
    if (status.hook.action === 'refused') {
      printRefusedHook(source, status.hook);
      process.exitCode = 1;
      await sendOnce();
    }
    return;
  }

  if (action === 'status') {
    printIntegrationStatus(source, integrationStatus(source));
    return;
  }

  printHelp();
  process.exit(1);
}

// Where this HOME's tracker answers: the port given, or the one tracker.json names while its process lives, or the first it takes.
function trackerAddress(options) {
  if (options.port !== undefined) {
    return {host: options.host, port: options.port};
  }

  const record = readTrackerRecord();
  return record && isProcessAlive(record.pid) ? {host: record.host ?? options.host, port: Number(record.port)} : {host: options.host, port: trackerPorts()[0]};
}

async function isServerRunning(options) {
  return Boolean(await trackerHealth(trackerAddress(options)));
}

// `nghixahoi diagnostics status` and `nghixahoi diagnostics send` (docs/way-of-working.md, "A full staging round"): what a tester
// build's diagnostics hold, and Send logs now from the terminal, for when the dashboard cannot reach the tracker. Any other
// build says it sends nothing, and sends nothing.
async function handleDiagnostics(action) {
  if (action === 'status' || action === undefined) {
    const status = diagnosticsStatus();

    if (!status.enabled) {
      console.log(describeOutcome({outcome: 'disabled'}));
      return;
    }

    sweepHookMarkers({source: 'command'});
    console.log('Kit=Code diagnostics: this tester build sends Kit=Code\'s own events and errors to its staging server, never your code, files, prompts or project names.');
    console.log(`  staging server: ${status.destination}`);
    console.log(`  install id: ${status.installId ?? 'none yet'}`);
    console.log(`  invited email: ${status.invitedEmail ?? 'none given'}`);
    console.log(`  waiting to be sent: ${groupedNumber(status.queued)} event${status.queued === 1 ? '' : 's'}`);

    if (status.closedUntil) {
      console.log(`  paused: the staging server is not taking diagnostics; Kit=Code tries again after ${status.closedUntil}`);
    }

    console.log(`  last send: ${status.lastSend ? `${status.lastSend.at}, ${describeOutcome(status.lastSend)}` : 'none yet'}`);
    return;
  }

  if (action === 'send') {
    if (!diagnosticsEnabled()) {
      console.log(describeOutcome({outcome: 'disabled'}));
      return;
    }

    sweepHookMarkers({source: 'command'});
    const result = await sendQueued({timeoutMs: 10_000, maxBatches: 5, manual: true, source: 'command'});
    console.log(describeOutcome(result));

    if (result.outcome !== 'stored' && result.outcome !== 'nothing') {
      process.exitCode = 1;
    }

    return;
  }

  printHelp();
  process.exit(1);
}

// The local API has no login. Bound to anything but loopback, it is on every network that can reach
// that address, so that takes --allow-non-loopback, and a warning.
function bindRefusal(options) {
  if (isLoopbackAddress(options.host) || options.allowNonLoopback) {
    return null;
  }

  return `Not started: ${options.host} is not a loopback address, so Kit=Code's local API, which has no authentication, would be reachable from other machines. Use --host 127.0.0.1, or add --allow-non-loopback to bind ${options.host} anyway.`;
}

function nonLoopbackWarning(options) {
  return `Warning: Kit=Code's local API will listen on ${options.host}:${options.port ?? trackerPorts().join('|')}, where other machines may reach it. It has no authentication. It answers only requests addressed to 127.0.0.1 or localhost: that stops web pages, not other programs, and any program that can connect to it can read your progress.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printTrackerNotRunning() {
  console.error(`Kit=Code tracker is not running. Run \`${CLI_GLOBAL_COMMAND} track\` first.`);
}

// A tester build's diagnostics (src/diagnostics.mjs): a command that saw something fail records it and sends what waits,
// once, with a short timeout, and quietly, since no tracker may be running to send it later. In any other build each
// returns at once, and nothing is written or sent.
const COMMAND_NAMES = new Set(['add', 'remove', 'track', 'untrack', 'list', 'status', 'summary', 'awards', 'dashboard', 'setup', 'uninstall', 'claude', 'codex', 'diagnostics']);

function commandName(command) {
  const name = command === 'award' || command === 'rewards' ? 'awards' : command;
  return COMMAND_NAMES.has(name) ? name : 'other';
}

// Once a process: the first failure sends what waits, then, and what a command records after it waits for the next send.
let sentOnce = false;

async function sendOnce() {
  if (!diagnosticsEnabled() || sentOnce) {
    return;
  }

  sentOnce = true;

  try {
    sweepHookMarkers({source: 'command'});
    await sendQueued({timeoutMs: 3000, maxBatches: 1, source: 'command'});
  } catch {
    // Quietly: whatever sends next sends it.
  }
}

function recordCommandFailed(command, error) {
  recordEvent('command-failed', {command: commandName(command), errorCode: errorCodeOf(error), errorName: errorNameOf(error)}, {source: 'command'});
}

function recordTrackerNotStarted(source, reason, error = null) {
  recordEvent('tracker-not-started', {reason, errorCode: errorCodeOf(error), errorName: errorNameOf(error)}, {source});
}

const WELCOME_REASONS = new Set(['missing-electron', 'electron-download-failed', 'electron-binary-missing', 'missing-entry', 'spawn-error', 'exited', 'invalid-platform']);

function recordWelcomeFailed(command, result) {
  const exitCode = Number.isInteger(result?.code) ? result.code : null;
  recordEvent('welcome-failed', {command, reason: WELCOME_REASONS.has(result?.reason) ? result.reason : 'other', exitCode}, {source: 'command'});
}

async function runDaemon(options, status = createStatusReporter()) {
  status.set('Starting Kit=Code tracker...');
  const log = createLog(TRACKER_LOG_PATH);
  // The tracker runs detached, with its output discarded: what matters goes to tracker.log too.
  const report = (level, message) => {
    log[level](message);

    if (level !== 'info') {
      console.error(message);
    }
  };

  // Anything thrown and not caught, and any promise rejected and not handled, is logged before the
  // tracker exits, instead of ending it without a trace. Nothing is saved on the way out: the file
  // keeps the last periodic save.
  const fatal = (kind) => (error) => {
    log.error(`${kind}: ${error?.stack ?? error}`);
    recordEvent('tracker-crashed', {kind: kind === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection', errorCode: errorCodeOf(error), errorName: errorNameOf(error)}, {source: 'tracker'});
    releaseTracker(process.pid);
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));

  // Checked here too, not only by `nghixahoi track`: anything can start this process.
  const refusal = bindRefusal(options);

  if (refusal) {
    status.stop();
    report('error', refusal);
    recordTrackerNotStarted('tracker', 'bind-refused');
    process.exit(1);
  }

  if (!isLoopbackAddress(options.host)) {
    report('warn', nonLoopbackWarning(options));
  }

  const startedAt = new Date().toISOString();
  // With no --port, the first free of the five (src/tracker-ports.mjs): tracker.json names the first until the tracker listens.
  const ports = options.port === undefined ? trackerPorts() : [options.port];
  const record = {pid: process.pid, host: options.host, port: ports[0], startedAt, version: VERSION, tracking: 'ok', problems: [], heartbeatAt: startedAt};

  // One tracker per HOME. A tracker that answers, or is starting, keeps its place; only one whose
  // process does not answer may be replaced. The claim is made before anything is written.
  const existing = await findRunningTracker();

  if (existing && existing.state !== 'unresponsive') {
    status.stop();
    report('warn', `Not started: another Kit=Code tracker (process ${existing.record.pid}) is ${existing.state} at http://${existing.record.host}:${existing.record.port}.`);
    recordTrackerNotStarted('tracker', 'already-running');
    process.exit(1);
  }

  if (!claimTracker(record, existing?.record ?? null).claimed) {
    status.stop();
    report('warn', 'Not started: another Kit=Code tracker started at the same moment.');
    recordTrackerNotStarted('tracker', 'claimed-elsewhere');
    process.exit(1);
  }

  let runtime;

  try {
    runtime = createRuntime(options);
  } catch (error) {
    releaseTracker(process.pid);
    report('error', `Not started: ${error.message}`);
    recordTrackerNotStarted('tracker', error instanceof StateFileError || error instanceof StateLockError ? 'state-unreadable' : 'start-failed', error);
    throw error;
  }

  // The install id the claim bundle carries, made once per HOME, and only by a tracker that has started:
  // one refused above writes nothing (src/install-id.mjs). A tracker that cannot make it still counts;
  // the bundle waits for it, and says so.
  try {
    ensureInstallId();
  } catch (error) {
    report('warn', `Kit=Code could not make its install id (${error.message}); the claim bundle is not given out until it can.`);
  }

  // A tester build's diagnostics while the tracker runs (src/diagnostics.mjs): its events sent every minute, a heartbeat every
  // hour, and Send logs now through the local API. In any other build it does nothing.
  const startedMs = Date.now();
  const uptimeSeconds = () => Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  const diagnostics = startDiagnosticsLoop({
    snapshot: () => {
      const current = runtime.status?.() ?? {tracking: 'ok', problems: []};
      return {projects: Object.values(runtime.state.projects).filter((project) => project.active).length, tracking: current.tracking, problems: current.problems.map((problem) => problem.code)};
    },
  });
  // The campaign's targets and end, from the server, in a build that carries the claim backend's key (src/tracking-config.mjs):
  // a random 5 to 120 s from now, then whenever the last try is over an hour old, and at once after a sleep. The tracker alone
  // fetches; whatever happens to a fetch stays in tracker.log, and the tracker counts by the targets it had. Since 2026-10-30 each try
  // fetches the newest version after it (src/newest-version.mjs), which the Mini and the hook say while it is newer than this one.
  const trackingConfig = startTrackingConfigLoop({log, alongside: ({signal}) => tryNewestVersion({log, signal})});
  const app = createServer(runtime, VERSION, {diagnostics});
  let cleanup = async () => {};
  let server = null;

  const exit = (code) => {
    releaseTracker(process.pid);

    if (!server) {
      process.exit(code);
      return;
    }

    server.closeAllConnections?.();
    server.close(() => process.exit(code));
  };

  const PROBLEMS = new Set(['watch-failed', 'project-missing', 'scan-failed', 'git-locked', 'git-unfinished']);

  cleanup = startWatchers(runtime, {
    log,
    onProgress(message) {
      status.set(message);
    },
    // tracker.json says how the tracker is doing, for the prompt hook; updating it is the heartbeat.
    onStatus(current) {
      updateTrackerRecord(process.pid, {...current, heartbeatAt: new Date().toISOString()});
    },
    // Each project's problem, raised or cleared, by its fixed code and an opaque reference to the project.
    onProblem({code, projectId, state, error}) {
      if (PROBLEMS.has(code)) {
        recordEvent('tracker-problem', {problem: code, state, project: projectRef(projectId), errorCode: errorCodeOf(error)}, {source: 'tracker'});
      }
    },
    // state.json can no longer be read. Stop without writing it: it holds the user's progress.
    onStateError(error) {
      status.stop();
      report('error', `Stopped: ${error.message}`);
      cleanup({persist: false});
      recordEvent('tracker-stopped', {reason: 'state-unreadable', uptimeSeconds: uptimeSeconds()}, {source: 'tracker'});
      Promise.allSettled([trackingConfig.stop(), diagnostics.stop()]).finally(() => exit(1));
    },
  });

  const shutdown = (signal) => async () => {
    try {
      await cleanup();
    } catch (error) {
      if (!(error instanceof StateFileError || error instanceof StateLockError)) {
        throw error;
      }

      report('error', error.message);
    }

    log.info(`stopped (${signal})`);
    recordEvent('tracker-stopped', {reason: signal === 'stop request' ? 'stop-request' : 'signal', uptimeSeconds: uptimeSeconds()}, {source: 'tracker'});
    await trackingConfig.stop();
    await diagnostics.stop();
    exit(0);
  };

  // Before the ports are tried, which takes a moment: a stop asked meanwhile still saves.
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
  // Windows has no SIGTERM: there `untrack` and `uninstall` leave a stop request (src/tracker-stop.mjs).
  watchForStopRequest(record, shutdown('stop request'));

  let port;
  let inUse;

  try {
    ({server, port, inUse} = await listenOnFirstFree((candidate) => app.listen(candidate, options.host), ports));
  } catch (error) {
    status.stop();
    await cleanup().catch(() => {});
    releaseTracker(process.pid);
    recordTrackerNotStarted('tracker', error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed', error);
    await trackingConfig.stop();
    await diagnostics.stop({finalSend: false});

    if (error.code === 'EADDRINUSE') {
      report('error', `Not started: ${await portsInUseWords(ports)}`);
      process.exit(1);
    }

    report('error', `Not started: ${error.message}`);
    process.exit(1);
  }

  // What held each port passed over, as the OS says, for `track` and `status` to name: the person's own program, never the agent's.
  const portsInUse = await Promise.all(inUse.map(async (taken) => ({port: taken, heldBy: await portHolder(taken)})));
  updateTrackerRecord(process.pid, {port, portsInUse});
  status.stop();
  log.info(`started: Kit=Code ${VERSION}, process ${process.pid}, http://${options.host}:${port}, node ${process.version}`);

  if (portsInUse.length > 0) {
    log.warn(`port ${portLine({port, portsInUse})}`);
  }

  recordEvent('tracker-started', {projects: Object.values(runtime.state.projects).filter((project) => project.active).length, port}, {source: 'tracker'});
  server.on('error', (error) => log.error(`The local API failed: ${error?.message ?? error}`));
}

// Every one of `ports` in use, in words: what holds the first, when the OS says, and what to do.
async function portsInUseWords(ports) {
  const holder = describeHolder(await portHolder(ports[0]));
  const which = ports.length === 1 ? `port ${ports[0]} is` : `ports ${ports[0]} to ${ports.at(-1)} are all`;
  return `${which} already in use${holder ? ` (${ports[0]} by ${holder})` : ''}. Stop the other program, or pass --port <port>.`;
}

function printAlreadyRunning(record, options) {
  console.log('Kit=Code tracker is already running.');
  console.log(`Local server: http://${record.host}:${record.port}`);

  if (String(record.host) !== String(options.host) || (options.port !== undefined && Number(record.port) !== Number(options.port))) {
    console.log(`It stays where it is. To move it, run \`${CLI_GLOBAL_COMMAND} untrack\`, then \`${CLI_GLOBAL_COMMAND} track${options.port === undefined ? '' : ` --port ${options.port}`}\`.`);
  }
}

async function startTracker(options) {
  const refusal = bindRefusal(options);

  if (refusal) {
    console.error(refusal);
    recordTrackerNotStarted('command', 'bind-refused');
    await sendOnce();
    process.exit(1);
  }

  if (!isLoopbackAddress(options.host)) {
    console.error(nonLoopbackWarning(options));
  }

  // A tracker an earlier Kit=Code left running listens where this one will: it is stopped, and nothing said (src/legacy.mjs).
  await stopLegacyTracker();

  // One tracker per HOME, whatever port it was started on. One that is starting gets a moment.
  let running = await findRunningTracker();

  for (let attempt = 0; running?.state === 'starting' && attempt < 50; attempt += 1) {
    await sleep(200);
    running = await findRunningTracker();
  }

  if (running && running.state !== 'unresponsive') {
    printAlreadyRunning(running.record, options);
    return;
  }

  if (running) {
    console.log(`tracker.json names process ${running.record.pid}, which does not answer at http://${running.record.host}:${running.record.port}. Starting a new tracker in its place.`);
  } else if (await isServerRunning(options)) {
    // Something answers as Kit=Code here, but no tracker of this HOME: another HOME's, or an old one.
    const {host, port} = trackerAddress(options);
    console.log('Kit=Code tracker is already running.');
    console.log(`Local server: http://${host}:${port}`);
    return;
  }

  // The tracker runs detached, with nowhere to print: a state file it could not read, or a snapshot
  // it could not convert, stops it here, where the reason can be shown. The file is converted here too.
  prepareState();
  releaseTracker();

  // So are ports all in use: the tracker checks again as it listens.
  const ports = options.port === undefined ? trackerPorts() : [options.port];

  if (await firstFreePort(options.host, ports) === null) {
    console.error(`Kit=Code tracker did not start: ${await portsInUseWords(ports)}`);
    recordTrackerNotStarted('command', 'port-in-use', Object.assign(new Error('every port is in use'), {code: 'EADDRINUSE'}));
    await sendOnce();
    process.exit(1);
  }

  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    'track',
    '--host',
    options.host,
    ...(options.port === undefined ? [] : ['--port', String(options.port)]),
    ...(options.allowNonLoopback ? ['--allow-non-loopback'] : []),
  ], {
    detached: true,
    env: trackerChildEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });

  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });
  child.unref();

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const started = readTrackerRecord();

    if (started?.pid === child.pid && await trackerHealth(started)) {
      console.log('Kit=Code tracker started.');
      console.log(`Local server: http://${started.host}:${started.port}`);

      if (Array.isArray(started.portsInUse) && started.portsInUse.length > 0) {
        console.log(`Port ${portLine(started)}.`);
      }

      return;
    }

    // Another `nghixahoi track` started a tracker at the same moment, and that one won: report it.
    const winner = readTrackerRecord();

    if (winner && winner.pid !== child.pid && isProcessAlive(winner.pid) && await trackerHealth(winner)) {
      printAlreadyRunning(winner, options);
      return;
    }

    if (childExited) {
      break;
    }

    await sleep(200);
  }

  console.error(`Kit=Code tracker did not start. Try running \`${CLI_GLOBAL_COMMAND} track\` again.`);
  recordTrackerNotStarted('command', 'did-not-answer');
  await sendOnce();
  process.exit(1);
}

// Stops the tracker tracker.json names. A process that does not answer as that tracker is left
// alone: after a restart its pid may belong to anything.
// A tracker an earlier Kit=Code left running is stopped first (src/legacy.mjs), and said as this one is.
async function stopTracker() {
  const legacy = await stopLegacyTracker();
  const running = await findRunningTracker();

  if (!running) {
    releaseTracker();
    console.log(legacy === 'stopped' ? 'Kit=Code tracker stopped.' : legacy === 'requested' ? 'Kit=Code tracker stop requested.' : 'Kit=Code tracker is not running.');
    return;
  }

  if (running.state === 'unresponsive') {
    const stop = process.platform === 'win32' ? `taskkill /PID ${running.record.pid} /F` : `kill ${running.record.pid}`;
    console.log(`Kit=Code tracker is not answering: tracker.json names process ${running.record.pid}, which does not answer at http://${running.record.host}:${running.record.port}. Kit=Code does not stop a process it cannot identify. If it is a Kit=Code tracker, stop it with: ${stop}`);
    return;
  }

  // SIGTERM, or on Windows, which has none, a stop request (src/tracker-stop.mjs).
  try {
    askTrackerToStop(running.record);
  } catch (error) {
    if (process.platform === 'win32') {
      console.log(`Kit=Code could not ask the tracker (process ${running.record.pid}) to stop: ${error.message}`);
      return;
    }

    releaseTracker();
    console.log('Kit=Code tracker is not running.');
    return;
  }

  // It scans the changes still waiting and saves before it exits.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(running.record.pid)) {
      releaseTracker();
      console.log('Kit=Code tracker stopped.');
      return;
    }

    await sleep(200);
  }

  console.log('Kit=Code tracker stop requested.');
}

const options = parseArgs(process.argv);

try {
  if (options.command === 'track' && process.env.NGHIXAHOI_DAEMON === '1') {
    await runDaemon(options);
  } else if (options.command === 'dashboard') {
    const status = createStatusReporter();
    status.set('Checking local server...');

    if (await isServerRunning(options)) {
      status.stop();
      console.log(`${colorize('Kit=Code', COLOR.bold, COLOR.primary)} is already live.`);
      printDashboardHint(options);
    } else {
      status.stop();
      printTrackerNotRunning();
      process.exit(1);
    }
  } else if (options.command === 'add') {
    const targetPath = process.argv[3] ?? '.';
    let totals;

    try {
      totals = registerProject(targetPath);
    } catch (error) {
      if (error instanceof StateFileError || error instanceof StateLockError) {
        throw error;
      }

      // The folder could not be listed: it is gone, not a folder, or git could not list it.
      console.error(`Kit=Code could not add ${path.resolve(targetPath)}: ${error.message}`);
      recordCommandFailed('add', error);
      await sendOnce();
      process.exit(1);
    }

    console.log('Project added to Kit=Code.');
    console.log(`Added projects: ${groupedNumber(totals.trackingProjects)}`);
  } else if (options.command === 'remove') {
    const targetPath = process.argv[3] ?? '.';
    const totals = removeProject(targetPath);

    if (!totals) {
      console.error('Folder not found.');
      process.exit(1);
    }

    // A worktree the tracker found is counted with its repository (docs/reward-rules.md §5.9).
    if (totals.worktreeOf) {
      console.error(`This folder is a worktree of ${totals.worktreeOf}, and Kit=Code counts it with that repository. It stops when the worktree is removed with git, or when ${totals.worktreeOf} is removed from Kit=Code.`);
      process.exit(1);
    }

    console.log('Project removed from Kit=Code.');
    console.log(`Added projects: ${groupedNumber(totals.trackingProjects)}`);
  } else if (options.command === 'track') {
    await startTracker(options);
  } else if (options.command === 'list') {
    const totals = listProjects();

    if (totals.trackingProjects === 0) {
      console.log(`No added projects. Run: ${CLI_GLOBAL_COMMAND} add`);
    } else {
      console.log(`Added projects: ${groupedNumber(totals.trackingProjects)}`);
    }
  } else if (options.command === 'status') {
    await printStatus(options);
  } else if (options.command === 'summary') {
    printRewardSummary();
  } else if (options.command === 'awards' || options.command === 'award' || options.command === 'rewards') {
    printAwards();
  } else if (options.command === 'untrack') {
    await stopTracker();
  } else if (options.command === 'setup') {
    // Welcome reads and writes state.json: a file it could not read stops here, with the reason.
    loadState();

    if (!(await openOnboardingWindow(options))) {
      process.exit(1);
    }
  } else if (options.command === 'uninstall') {
    await handleUninstall(options);
  } else if (options.command === 'hook' && options.subcommand === 'prompt') {
    await runPromptHook({source: options.source});
  } else if (options.command === 'codex') {
    await handleHookInstaller('codex', options.subcommand);
  } else if (options.command === 'claude') {
    await handleHookInstaller('claude', options.subcommand);
  } else if (options.command === 'diagnostics') {
    await handleDiagnostics(options.subcommand);
  } else if (options.command === 'version') {
    console.log(VERSION);
  } else {
    printHelp();
    process.exit(options.command === 'help' || !options.command ? 0 : 1);
  }
} catch (error) {
  // A tester build records the failure, and sends it, once: but never from the prompt hook, which touches no network, nor
  // from the tracker, which recorded its own.
  if (options.command !== 'hook' && !(options.command === 'track' && process.env.NGHIXAHOI_DAEMON === '1')) {
    recordCommandFailed(options.command, error);
    await sendOnce();
  }

  // A state file Kit=Code cannot read or lock stops the command with the reason. It is never replaced.
  if (error instanceof StateFileError || error instanceof StateLockError) {
    console.error(error.message);
    process.exit(1);
  }

  throw error;
}
