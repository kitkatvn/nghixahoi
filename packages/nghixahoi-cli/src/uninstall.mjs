import fs from 'node:fs';
import process from 'node:process';
import {hookStatus} from './hook-installers.mjs';
import {uninstallIntegration} from './integration-installers.mjs';
import {AGENT_SPECS} from './integration-spec.mjs';
import {stopLegacyTracker} from './legacy.mjs';
import {uninstallSkillTree} from './skill-installer.mjs';
import {STORE_DIR} from './store.mjs';
import {findRunningTracker, isProcessAlive, releaseTracker} from './tracker-instance.mjs';
import {askTrackerToStop} from './tracker-stop.mjs';

const INTEGRATION_SOURCES = Object.keys(AGENT_SPECS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stops the tracker tracker.json names, if it answers as that tracker: a process that does not may
// be anything, since a pid is reused after a restart. A tracker an earlier Kit=Code left running is
// stopped first (src/legacy.mjs), and counts as this one when this one is not running.
export async function stopTrackerForUninstall() {
  const legacy = await stopLegacyTracker();
  const running = await findRunningTracker();
  const host = running?.record.host ?? '127.0.0.1';
  const port = Number(running?.record.port ?? 4747);

  if (!running || running.state === 'unresponsive') {
    releaseTracker();
    return {stopped: legacy === 'stopped' ? true : legacy === 'requested' ? 'requested' : false, host, port};
  }

  // SIGTERM, or on Windows, which has none, a stop request (tracker-stop.mjs).
  try {
    askTrackerToStop(running.record);
  } catch {
    releaseTracker();
    return {stopped: false, host, port};
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(running.record.pid)) {
      releaseTracker();
      return {stopped: true, host, port};
    }

    await sleep(200);
  }

  return {stopped: 'requested', host, port};
}

export async function uninstallNghixahoi() {
  // A config Kit=Code cannot parse may still call the runner under ~/.nghixahoi, and so may one the user
  // made read-only, which Kit=Code does not write. Removing the runner but not the hook would leave a
  // hook error on every prompt, so nothing is changed at all. A read-only config with no Kit=Code
  // entry calls no runner, and needs no write.
  const refused = INTEGRATION_SOURCES
    .map((source) => ({source, ...hookStatus(source)}))
    .filter((status) => status.installed === null || (status.installed && status.error?.readOnly));

  if (refused.length > 0) {
    return {refused};
  }

  const report = {
    tracker: await stopTrackerForUninstall(),
    integrations: {},
    skills: {},
    store: {removed: false, path: STORE_DIR},
  };

  for (const source of INTEGRATION_SOURCES) {
    report.integrations[source] = uninstallIntegration(source);
    report.skills[source] = uninstallSkillTree(source);
  }

  if (fs.existsSync(STORE_DIR)) {
    fs.rmSync(STORE_DIR, {recursive: true, force: true});
    report.store.removed = true;
  }

  return report;
}
