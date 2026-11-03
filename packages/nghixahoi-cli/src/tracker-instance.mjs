import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {reachableAddress} from './api-access.mjs';
import {writeFileAtomically} from './atomic-file.mjs';
import {STORE_DIR, withStateLock} from './store.mjs';
import {trackerPorts} from './tracker-ports.mjs';

// ~/.nghixahoi/tracker.json names the one tracker of this HOME: two trackers would each write their
// own time into the same projects. Only the tracker it names writes or removes it.
export const TRACKER_PATH = path.join(STORE_DIR, 'tracker.json');
// What the tracker did and what went wrong: it runs detached, with nowhere else to say it.
export const TRACKER_LOG_PATH = path.join(STORE_DIR, 'tracker.log');

// A tracker that has claimed tracker.json but does not answer yet is still starting, for this long.
const STARTING_GRACE_MS = 15_000;
const TRACKER_FILE_MODE = 0o600;
// Status updates wait this long for the state lock, then wait for the next update.
const UPDATE_LOCK_TIMEOUT_MS = 500;

// A process of this user that exists. One that belongs to another user cannot be this user's tracker.
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readTrackerRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8'));
    return record && typeof record === 'object' && Number.isInteger(record.pid) ? record : null;
  } catch {
    return null;
  }
}

// The port this HOME's tracker answers on: the one tracker.json names while its process lives, otherwise the first it would take
// (tracker-ports.mjs). Welcome and the Mini open on it when they are given no port.
export function recordedTrackerPort() {
  const record = readTrackerRecord();
  const port = Number(record?.port);

  return record && isProcessAlive(record.pid) && Number.isInteger(port) && port > 0 ? port : trackerPorts()[0];
}

function writeTrackerRecord(record) {
  fs.mkdirSync(STORE_DIR, {recursive: true});
  writeFileAtomically(TRACKER_PATH, `${JSON.stringify(record, null, 2)}\n`, {mode: TRACKER_FILE_MODE});
}

// The name the tracker's /api/health answers with (src/api.mjs).
export const TRACKER_APP = 'nghixahoi';

// What the tracker at host:port says about itself, or null when nothing there answers as Kit=Code (as `app`, the name an
// earlier Kit=Code's tracker answered with, for src/legacy.mjs). It asks with Host 127.0.0.1:<port>, as a browser on this
// machine does: the API answers no other Host (api-access.mjs), whatever address the tracker is bound to. fetch cannot set Host.
export function trackerHealth({host, port}, timeoutMs = 800, {app = TRACKER_APP} = {}) {
  return new Promise((resolve) => {
    let request;

    try {
      request = http.get({
        host: reachableAddress(host),
        port,
        path: '/api/health',
        agent: false,
        headers: {host: `127.0.0.1:${port}`},
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        let text = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', () => resolve(null));
        response.on('end', () => {
          try {
            const health = response.statusCode >= 200 && response.statusCode < 300 ? JSON.parse(text) : null;
            resolve(health?.status === 'ok' && health?.app === app ? health : null);
          } catch {
            resolve(null);
          }
        });
      });
    } catch {
      // A port that is not a port, say.
      resolve(null);
      return;
    }

    request.on('error', () => resolve(null));
  });
}

// The tracker tracker.json names, when its process is alive: `running` when it answers as that
// tracker, `starting` when it claimed the file moments ago, and otherwise `unresponsive`, which is a
// tracker that hangs or, more likely, a pid that now belongs to another process. A tracker from
// before 2026-09-24 does not report its pid, and counts as running when it answers.
export async function findRunningTracker() {
  const record = readTrackerRecord();

  if (!record || !isProcessAlive(record.pid)) {
    return null;
  }

  const health = await trackerHealth(record);

  if (health && (health.pid === undefined || health.pid === record.pid)) {
    return {record, state: 'running', health};
  }

  const startedAt = Date.parse(record.startedAt);

  if (Number.isFinite(startedAt) && Date.now() - startedAt < STARTING_GRACE_MS) {
    return {record, state: 'starting'};
  }

  return {record, state: 'unresponsive'};
}

function sameRecord(left, right) {
  return Boolean(left && right) && left.pid === right.pid && left.startedAt === right.startedAt;
}

// Makes `record` the tracker of record, unless another live process holds tracker.json. The check
// and the write happen under the state lock, so of two trackers starting together one wins.
// `replacing` is a record the caller found unresponsive; that one may be replaced.
export function claimTracker(record, replacing = null) {
  return withStateLock(() => {
    const current = readTrackerRecord();

    if (current && current.pid !== record.pid && isProcessAlive(current.pid) && !sameRecord(current, replacing)) {
      return {claimed: false, current};
    }

    writeTrackerRecord(record);
    return {claimed: true};
  });
}

// Updates the record of the tracker `pid`, if it is still the tracker of record. A busy lock skips it.
export function updateTrackerRecord(pid, patch) {
  try {
    return withStateLock(() => {
      const current = readTrackerRecord();

      if (current?.pid !== pid) {
        return false;
      }

      writeTrackerRecord({...current, ...patch});
      return true;
    }, {lockTimeoutMs: UPDATE_LOCK_TIMEOUT_MS});
  } catch {
    return false;
  }
}

// Removes tracker.json if it names `pid`, or, with no pid, if its process is gone.
export function releaseTracker(pid = null) {
  try {
    const current = readTrackerRecord();

    if (current && (pid === null ? !isProcessAlive(current.pid) : current.pid === pid)) {
      fs.rmSync(TRACKER_PATH, {force: true});
    }
  } catch {
    // Nothing to remove.
  }
}
