import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Writes a file so that no reader, and no crash, can ever see it half-written: the data goes to a
// temporary file in the same folder, is flushed to disk, and is then renamed over the target in
// one step. The file gets exactly `mode`, whatever the umask.
export function writeFileAtomically(filePath, data, {mode}) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);

  try {
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    renameIntoPlace(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, {force: true});
    throw error;
  }

  syncDirectory(directory);
}

// Windows will not replace a file another process has open: the rename fails with EPERM, EACCES or
// EBUSY until that process closes it, as a reader of state.json does within milliseconds (the first
// Windows CI run, 2026-09-29, "a reader never sees a partial file while a writer saves"). There the
// rename is tried again, every 50 ms for up to a second, and the target keeps its previous content until
// one succeeds. macOS and Linux replace an open file, and never wait.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 20;
const RENAME_RETRY_MS = 50;

function renameIntoPlace(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }

      // The write is synchronous, and so is its wait.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
    }
  }
}

// Temporary files a crashed writeFileAtomically left next to `filePath`. Only safe to remove while
// nothing else can be writing that file.
export function leftoverTempFiles(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.`;

  try {
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

export function syncDirectory(directory) {
  let fd;

  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some platforms cannot open or flush a folder (Windows cannot). The rename is atomic anyway;
    // this only makes it durable sooner.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
