import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {writeFileAtomically} from './atomic-file.mjs';
import {hookCommandFor, sourceConfig} from './integration-spec.mjs';
import {isProcessAlive, trackerHealth} from './tracker-instance.mjs';

// Kit=Code as it was installed before 2026-10-29, when its technical names were kitcode: the command `kitcode`, the state folder
// ~/.kitcode, the hooks that ran ~/.kitcode/bin/kitcode, the skill folders named kitcode, and the tracker that ~/.kitcode/tracker.json
// names (docs/plans/2026-10-29-no-kitcode-trace.md, ruling 1). This module is the one place that knows those names, and it is
// code alone: no prompt, page, message or doc tells a user one of them. It recognises the hook entries of every version that
// wrote them, so that `<agent> on` replaces them and `off` and `uninstall` remove them; it recognises the skill an earlier
// Kit=Code wrote, so that `on` takes it out; and it stops the tracker an earlier install left running, so that this one can
// listen where it did. An earlier package left installed is then inert: no hook runs it, and its tracker is stopped.
//
// It never reads ~/.kitcode for progress, and never moves, writes over or removes anything in it but the one stop request a
// tracker on Windows asks for (hard rule 4): this Kit=Code starts fresh in ~/.nghixahoi.
const LEGACY_NAME = 'kitcode';
// The state folder an earlier Kit=Code kept everything in. Resolved when asked, as the CLI resolves its own from HOME.
const legacyStateDir = () => path.join(os.homedir(), `.${LEGACY_NAME}`);
// The runners an earlier Kit=Code wrote in it: ~/.kitcode/bin/kitcode, and ~/.kitcode/bin/nghixahoi, which the builds of
// 2026-10-29 that ran as nghixahoi wrote before the state folder moved.
const LEGACY_RUNNER_NAMES = Object.freeze([LEGACY_NAME, 'nghixahoi']);
// The commands an earlier Kit=Code's hook ran on PATH before it had a runner.
const LEGACY_PATH_COMMANDS = Object.freeze([LEGACY_NAME]);
// The name an earlier tracker answered /api/health with.
const LEGACY_TRACKER_APP = LEGACY_NAME;

// Every hook command an earlier Kit=Code wrote for `source`: its runner's absolute path as this platform writes it, the same
// quoted for sh (what Windows had before 2026-09-29), the display form the setup prompts showed, ~/.kitcode/bin/<name>, and the
// command on PATH that came before the runner.
export function legacyHookCommands(source) {
  sourceConfig(source);
  const home = os.homedir();

  return [
    ...LEGACY_RUNNER_NAMES.flatMap((name) => {
      const runnerPath = path.join(home, `.${LEGACY_NAME}`, 'bin', name);

      return [
        hookCommandFor(source, {runnerPath}),
        hookCommandFor(source, {runnerPath, platform: 'linux'}),
        hookCommandFor(source, {runnerPath, platform: 'win32'}),
        hookCommandFor(source, {runnerPath: `~/.${LEGACY_NAME}/bin/${name}`, platform: 'linux'}),
      ];
    }),
    ...LEGACY_PATH_COMMANDS.map((command) => `${command} hook prompt --source ${source}`),
  ];
}

export function isLegacyHookCommand(source, command) {
  return legacyHookCommands(source).includes(command);
}

// The skill an earlier Kit=Code wrote for `source`, ~/.<agent>/skills/kitcode/SKILL.md, and whether the file there is one: its
// front matter names the skill kitcode, as every version wrote it. A file of any other words is the user's, and is left alone.
function legacySkillPath(source) {
  const parts = sourceConfig(source).skillPathParts;
  return path.join(os.homedir(), ...parts.slice(0, -2), LEGACY_NAME, parts.at(-1));
}

function isLegacySkill(text) {
  return /^---\r?\nname: kitcode\r?\n/u.test(text);
}

// Takes out the skill an earlier Kit=Code wrote for `source`, and its folder when nothing else is in it, as that Kit=Code's
// own `off` would. Returns {removed, path}; never throws, since `on` goes on whatever happens here.
export function removeLegacySkill(source) {
  const filePath = legacySkillPath(source);

  try {
    if (!isLegacySkill(fs.readFileSync(filePath, 'utf8'))) {
      return {removed: false, path: filePath};
    }

    fs.rmSync(filePath);

    try {
      fs.rmdirSync(path.dirname(filePath));
    } catch {
      // Something else is in the folder: it stays.
    }

    return {removed: true, path: filePath};
  } catch {
    return {removed: false, path: filePath};
  }
}

function readLegacyTrackerRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(legacyStateDir(), 'tracker.json'), 'utf8'));
    return record && typeof record === 'object' && Number.isInteger(record.pid) ? record : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stops the tracker an earlier Kit=Code left running, when ~/.kitcode/tracker.json names one that is alive and answers as that
// tracker: SIGTERM, or on Windows, which has none, the stop request that tracker reads every second, ~/.kitcode/tracker-stop.json.
// A process that does not answer as that tracker may be anything, since a pid is reused after a restart, and is left alone.
// Returns 'none' (no such tracker), 'stopped', or 'requested' (asked, and not gone within the wait). Never throws.
export async function stopLegacyTracker({platform = process.platform, waitMs = 10_000} = {}) {
  const record = readLegacyTrackerRecord();

  if (!record || !isProcessAlive(record.pid)) {
    return 'none';
  }

  const health = await trackerHealth(record, 800, {app: LEGACY_TRACKER_APP});

  if (!health || (health.pid !== undefined && health.pid !== record.pid)) {
    return 'none';
  }

  try {
    if (platform === 'win32') {
      writeFileAtomically(path.join(legacyStateDir(), 'tracker-stop.json'), `${JSON.stringify({pid: record.pid, startedAt: record.startedAt})}\n`, {mode: 0o600});
    } else {
      process.kill(record.pid, 'SIGTERM');
    }
  } catch {
    return isProcessAlive(record.pid) ? 'none' : 'stopped';
  }

  for (let waited = 0; waited < waitMs; waited += 200) {
    if (!isProcessAlive(record.pid)) {
      return 'stopped';
    }

    await sleep(200);
  }

  return 'requested';
}
