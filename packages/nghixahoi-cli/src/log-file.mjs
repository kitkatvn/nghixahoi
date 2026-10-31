import fs from 'node:fs';
import path from 'node:path';

// Kit=Code's own logs, ~/.nghixahoi/hook.log and tracker.log, are bounded. When a log reaches
// LOG_MAX_BYTES, its last LOG_MAX_BYTES become <file>.1, replacing the one before, and the log starts
// again: the two hold about twice that at most, even after a version that had no limit. They name
// local paths, so they are private to their user.
export const LOG_MAX_BYTES = 256 * 1024;
const LOG_FILE_MODE = 0o600;

function rotate(filePath, maxBytes) {
  let size;

  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }

  if (size < maxBytes) {
    return;
  }

  const tail = Buffer.alloc(maxBytes);
  const fd = fs.openSync(filePath, 'r');
  let length;

  try {
    length = fs.readSync(fd, tail, 0, maxBytes, size - maxBytes);
  } finally {
    fs.closeSync(fd);
  }

  // From the first whole line on.
  const kept = tail.subarray(0, length);
  const firstLine = size > maxBytes ? kept.indexOf(0x0a) + 1 : 0;
  fs.writeFileSync(`${filePath}.1`, kept.subarray(firstLine), {mode: LOG_FILE_MODE});
  fs.chmodSync(`${filePath}.1`, LOG_FILE_MODE);
  fs.rmSync(filePath, {force: true});
}

// Appends one line, stamped with the time. It never throws: a log that cannot be written must not
// stop the prompt hook or the tracker.
export function appendLogLine(filePath, text, {maxBytes = LOG_MAX_BYTES} = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    rotate(filePath, maxBytes);
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${text}\n`, {mode: LOG_FILE_MODE});
  } catch {
    // Nothing else to do.
  }
}

export function createLog(filePath, options) {
  return {
    info: (text) => appendLogLine(filePath, `info ${text}`, options),
    warn: (text) => appendLogLine(filePath, `warn ${text}`, options),
    error: (text) => appendLogLine(filePath, `error ${text}`, options),
  };
}
