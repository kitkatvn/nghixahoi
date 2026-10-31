import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {syncDirectory} from './atomic-file.mjs';
import {STORE_DIR} from './store.mjs';

// The install id the claim bundle carries (docs/backend.md, "The contract"): a random version 4 UUID,
// made once per HOME, in ~/.nghixahoi/install-id. It says which claims came from one install; it names no
// person, machine or project.
//
// It has a file of its own, and is not in state.json, because 0.1.39 rewrites state.json from a copy
// holding only the fields it knows (its runtime.mjs normalizeState keeps version, projects and
// onboarding), so a field added there is gone the first time 0.1.39 runs `add`, `list` or `status`, or
// its tracker saves. 0.1.39 never opens this file. `nghixahoi uninstall` deletes it with the rest of
// ~/.nghixahoi.
export const INSTALL_ID_PATH = path.join(STORE_DIR, 'install-id');
export const INSTALL_ID_DISPLAY_PATH = '~/.nghixahoi/install-id';

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALL_ID_MODE = 0o600;

// An install-id file that cannot be read, or does not hold an install id.
export class InstallIdError extends Error {
  constructor(problem, cause) {
    super(`Kit=Code cannot read ${INSTALL_ID_PATH}: ${problem}. Kit=Code has left it as it is: a new id would make this install look like another.`, {cause});
    this.name = 'InstallIdError';
  }
}

// The install id, or null when there is none yet. A file that cannot be read, or does not hold an
// install id, throws an InstallIdError, and is never replaced.
export function readInstallId() {
  let text;

  try {
    text = fs.readFileSync(INSTALL_ID_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw new InstallIdError(error.code ? `${error.code}` : String(error), error);
  }

  const id = text.endsWith('\n') ? text.slice(0, -1) : text;

  if (!INSTALL_ID.test(id)) {
    throw new InstallIdError('it does not hold an install id');
  }

  return id;
}

// Makes the install id, once per HOME, and returns it; one already made is returned as it is. Of two
// processes making it at once, one id is kept: each writes its id whole to a temporary file, then links
// that into place, which the filesystem refuses once the name is taken, and the one refused reads the
// other's. The file is never written over, so no reader ever sees half an id or a second one.
export function ensureInstallId() {
  const existing = readInstallId();

  if (existing !== null) {
    return existing;
  }

  fs.mkdirSync(STORE_DIR, {recursive: true});
  const id = crypto.randomUUID();
  const tempPath = path.join(STORE_DIR, `.install-id.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', INSTALL_ID_MODE);

  try {
    try {
      fs.fchmodSync(fd, INSTALL_ID_MODE);
      fs.writeFileSync(fd, `${id}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.linkSync(tempPath, INSTALL_ID_PATH);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      return readInstallId();
    }

    syncDirectory(STORE_DIR);
    return id;
  } finally {
    fs.rmSync(tempPath, {force: true});
  }
}
