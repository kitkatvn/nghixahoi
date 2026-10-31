import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {writeFileAtomically} from './atomic-file.mjs';
import {STORE_DIR} from './store.mjs';

// How `nghixahoi untrack` and `nghixahoi uninstall` stop the tracker. On macOS and Linux they send SIGTERM,
// and the tracker's handler scans the changes still waiting, saves, and logs that it stopped. Windows has
// no SIGTERM: Node ends the process there at once, and no handler runs, so what the last periodic save
// missed was lost, and the log never said the tracker stopped (the first Windows CI run, 2026-09-29;
// docs/lessons-learned.md). There they leave a stop request instead, which the tracker reads every second
// and answers as it answers SIGTERM (the operator's decision, 2026-09-29).
//
// Only a process running as the user can write ~/.nghixahoi, and such a process can end the tracker anyway:
// the request opens no new way in. It names one tracker, by the process and the moment tracker.json says
// it started, because Windows soon reuses a process id: a request left behind never stops a tracker
// started later, and whichever tracker finds it removes it.
export const STOP_REQUEST_PATH = path.join(STORE_DIR, 'tracker-stop.json');

const STOP_REQUEST_MODE = 0o600;
const STOP_CHECK_MS = 1000;

// Asks the tracker `record` describes (tracker.json) to stop, as this platform allows. Throws what
// process.kill throws, ESRCH when the process has gone, or, on Windows, what writing the request throws.
export function askTrackerToStop(record, platform = process.platform) {
  if (platform === 'win32') {
    writeFileAtomically(STOP_REQUEST_PATH, `${JSON.stringify({pid: record.pid, startedAt: record.startedAt})}\n`, {mode: STOP_REQUEST_MODE});
    return;
  }

  process.kill(record.pid, 'SIGTERM');
}

// The request waiting, removed as it is read: null when there is none. One that cannot be read, or is not
// JSON, reads as a request for no tracker. Nothing here throws, since it runs inside the tracker.
function takeStopRequest() {
  if (!fs.existsSync(STOP_REQUEST_PATH)) {
    return null;
  }

  let request = {};

  try {
    request = JSON.parse(fs.readFileSync(STOP_REQUEST_PATH, 'utf8'));
  } catch {
    // Read as a request for no tracker, and removed below.
  }

  try {
    fs.rmSync(STOP_REQUEST_PATH, {force: true});
  } catch {
    // Removed at the next check.
  }

  return request;
}

// Run by the tracker, with its own record: calls `onStop` once, when a request names it. Every request it
// finds is removed, its own and any other, since one tracker runs per HOME: a request for another tracker
// is one left behind.
export function watchForStopRequest(record, onStop) {
  const timer = setInterval(() => {
    const request = takeStopRequest();

    if (request?.pid === record.pid && request?.startedAt === record.startedAt) {
      clearInterval(timer);
      onStop();
    }
  }, STOP_CHECK_MS);

  timer.unref();
  return () => clearInterval(timer);
}
