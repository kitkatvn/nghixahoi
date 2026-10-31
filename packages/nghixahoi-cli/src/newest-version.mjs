import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {writeFileAtomically} from './atomic-file.mjs';
import {cycleReceiptKey} from './cycle-receipt.mjs';
import {CLI_VERSION, CYCLE_RECEIPT_PUBLIC_KEY, DASHBOARD_URL} from './integration-spec.mjs';
import {STORE_DIR} from './store.mjs';
import {FETCH_TIMEOUT_MS, readLimited} from './tracking-config.mjs';
import {isOlderVersion, plainVersion} from './version-order.mjs';

// The newest Kit=Code, from the server (docs/plans/2026-10-29-production-rename-nghixahoi.md, phase 2; docs/backend.md, "The newest
// version"): the claim backend serves one small signed document of its own at the dashboard's address plus /v1/newest-version, beside
// the tracking config, whose one field is the version the deployed release's own CLI is. Never a field of the tracking config, which
// a 0.2.x tracker reads strictly. The tracker fetches it with the tracking config, in the same try, about once an hour
// (tracking-config.mjs, startTrackingConfigLoop's `alongside`), and keeps the last good copy in ~/.nghixahoi/newest-version.json. It
// never acts on it: no download, no install, no update of itself. While the copy names a version newer than this one, the Mini says so
// in its title bar (/api/summary's `update`), and the prompt hook adds one line to its context, so that Codex or Claude tells the user;
// both read the copy alone, with no network (hard rule 7). The dashboard says it too, by the tracker's own version and the one it
// bundles, with no document (apps/web src/lib/update-notice.ts).
//
//   <payload>.<signature>
//
// `payload` is base64url (no padding) of the UTF-8 JSON {"version":"x.y.z"}, that one field alone; `signature`, base64url of the
// 64-byte Ed25519 signature of the ASCII text `nghixahoi-newest-version-1.` followed by `payload` as it stands, with the cycle receipts'
// key, whose other documents have contexts of their own, `nghixahoi-tracking-config-1.` and `nghixahoi-cycle-receipt-1.`. The
// contract is packages/claim-contract/newest-version.mjs, which only tests read; this reader is the CLI's own, held to the contract's
// fixtures by test/newest-version.test.mjs. Only a build that carries the key fetches, and reads the copy: the repository's own build
// never does, and a tester build's version, 0.3.0-staging.<N>, is never older than anything (version-order.mjs), so it never says so.

export const NEWEST_VERSION_CONTEXT = 'nghixahoi-newest-version-1.';
export const NEWEST_VERSION_PATH = path.join(STORE_DIR, 'newest-version.json');
export const NEWEST_VERSION_DISPLAY_PATH = '~/.nghixahoi/newest-version.json';
// The longest document read, in characters, and the most of a body the tracker reads, in bytes. A document is 114 for 0.2.11.
export const MAX_NEWEST_VERSION_LENGTH = 256;

const FILE_MODE = 0o600;
const DOCUMENT_TEXT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/u;
const SILENT_LOG = {info() {}, warn() {}, error() {}};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Whether `words`, a payload as JSON.parse reads it, is a newest version: {ok: true, version}, or {ok: false, problem: 'unreadable'}:
// not an object of exactly one field, `version`, a plain x.y.z. Pure.
export function judgeNewestVersion(words) {
  return isObject(words) && Object.keys(words).length === 1 && plainVersion(words.version) !== null
    ? {ok: true, version: words.version}
    : {ok: false, problem: 'unreadable'};
}

// The public key a build carries: the cycle receipts' own (integration-spec.mjs). Null when it is not one.
export function newestVersionKey(text = CYCLE_RECEIPT_PUBLIC_KEY) {
  return cycleReceiptKey(text);
}

// Reads `text` with `publicKey`: {ok: true, version}, or {ok: false, problem}, the first of the contract's, in its order: 'oversized',
// longer than MAX_NEWEST_VERSION_LENGTH; 'unreadable', not two base64url parts joined by a dot; 'signature', not signed over the
// context and the payload with the key's pair, checked over the bytes as they came, before anything in them is read; 'unreadable', not
// judgeNewestVersion's one field.
export function readNewestVersion(text, publicKey) {
  if (typeof text !== 'string') {
    return {ok: false, problem: 'unreadable'};
  }

  if (text.length > MAX_NEWEST_VERSION_LENGTH) {
    return {ok: false, problem: 'oversized'};
  }

  const parts = DOCUMENT_TEXT.exec(text);

  if (parts === null) {
    return {ok: false, problem: 'unreadable'};
  }

  const [, payload, signature] = parts;
  let signed;

  try {
    signed = crypto.verify(null, Buffer.from(`${NEWEST_VERSION_CONTEXT}${payload}`, 'ascii'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    signed = false;
  }

  if (!signed) {
    return {ok: false, problem: 'signature'};
  }

  try {
    return judgeNewestVersion(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return {ok: false, problem: 'unreadable'};
  }
}

// Where this build fetches: DASHBOARD_URL plus v1/newest-version, an https URL, or, for this repository's tests, an http one on this
// machine; and only in a build that carries a key. Null otherwise: such a build never fetches, and never reads a copy either.
export function newestVersionUrl({dashboardUrl = DASHBOARD_URL, publicKey = CYCLE_RECEIPT_PUBLIC_KEY} = {}) {
  if (newestVersionKey(publicKey) === null || typeof dashboardUrl !== 'string') {
    return null;
  }

  try {
    const url = new URL('v1/newest-version', dashboardUrl);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

// Whether this build reads a copy at all, worked out once: the key and the address are the build's own.
let fetches;

function buildFetches() {
  fetches ??= newestVersionUrl() !== null;
  return fetches;
}

// The last good copy as last read, by the file's identity, so that a summary built every second reads the file again only once it
// has changed.
let savedRead = {identity: null, copy: null};

function fileIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// The last good copy on disk, {document, version, receivedAt}, its version checked to be plain, not its signature, which only the
// tracker checks, as it fetched it; null when there is none, or it cannot be read, or it is not one. Never throws, never writes.
export function readSavedNewestVersion() {
  const identity = fileIdentity(NEWEST_VERSION_PATH);

  if (identity === savedRead.identity) {
    return savedRead.copy;
  }

  let copy = null;

  try {
    const stored = JSON.parse(fs.readFileSync(NEWEST_VERSION_PATH, 'utf8'));

    if (isObject(stored) && plainVersion(stored.version) !== null) {
      copy = {
        document: typeof stored.document === 'string' ? stored.document : null,
        version: stored.version,
        receivedAt: typeof stored.receivedAt === 'string' ? stored.receivedAt : null,
      };
    }
  } catch {
    copy = null;
  }

  savedRead = {identity, copy};
  return copy;
}

// Writes the last good copy: the document as it came, its version, and when this tracker took it. Whole, 0600; throws what the write
// throws, and the copy before stays as it was.
export function saveNewestVersion({version, document}, receivedAt = new Date()) {
  fs.mkdirSync(STORE_DIR, {recursive: true});
  writeFileAtomically(NEWEST_VERSION_PATH, `${JSON.stringify({document, version, receivedAt: receivedAt.toISOString()}, null, 2)}\n`, {mode: FILE_MODE});
}

// The update this install could take: {version}, the newest the last good copy names, while this Kit=Code's own version, `installed`,
// is older; null otherwise, in a build that never fetches, and whenever the copy cannot be read. Never throws: the prompt hook and
// every summary call it.
export function updateAvailable({installed = CLI_VERSION} = {}) {
  try {
    if (!buildFetches()) {
      return null;
    }

    const saved = readSavedNewestVersion();
    return saved !== null && isOlderVersion(installed, saved.version) ? {version: saved.version} : null;
  } catch {
    return null;
  }
}

// For this repository's tests alone: forgets the copy this process read, as a process that has just started.
export function forgetSavedNewestVersion() {
  savedRead = {identity: null, copy: null};
}

// One try: one GET of `url`, with no redirect followed, no cookie, and nothing of this install, the user or this Kit=Code's version
// in it; `timeoutMs` for the whole answer, its body at most MAX_NEWEST_VERSION_LENGTH bytes. A version taken is saved, unless the copy
// on disk holds this very document already; a refusal or a failure keeps the copy as it is. Returns {outcome: 'taken', version};
// {outcome: 'refused', problem, status?}: 'status', not 200 (a redirect among them); 'oversized'; the reader's problems; or
// {outcome: 'failed', problem}: 'timeout', 'unreachable', or 'save' when the copy could not be written. Each but 'taken' of an unchanged
// copy is one line of tracker.log, in fixed words, the address and the version alone. Never throws.
export async function tryNewestVersion({url = newestVersionUrl(), publicKey = newestVersionKey(), fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, signal, log = SILENT_LOG, now = () => Date.now()} = {}) {
  if (url === null || publicKey === null) {
    return {outcome: 'disabled'};
  }

  const result = await fetchNewestVersion({url, publicKey, fetchImpl, timeoutMs, signal});
  const where = `${url}`;

  try {
    if (result.outcome === 'taken') {
      const saved = readSavedNewestVersion();

      if (saved === null || saved.document !== result.document) {
        try {
          saveNewestVersion(result, new Date(now()));
        } catch (error) {
          log.warn(`Kit=Code could not save the newest version, ${result.version}, to ${NEWEST_VERSION_DISPLAY_PATH} (${error?.code ?? error?.name ?? 'error'}); it tries again at its next fetch.`);
          return {outcome: 'failed', problem: 'save'};
        }

        log.info(`took the newest Kit=Code version, ${result.version}, from ${where}${isOlderVersion(CLI_VERSION, result.version) ? `: this one is ${CLI_VERSION}, and says so until it is updated` : ''}.`);
      }

      return {outcome: 'taken', version: result.version};
    }

    const kept = readSavedNewestVersion();
    const keeps = `Kit=Code keeps ${kept === null ? 'no newest version' : `the newest version it had, ${kept.version}`}`;
    log.warn(result.outcome === 'refused'
      ? `refused the newest version's answer from ${where} (${result.problem}${result.status === undefined ? '' : ` ${result.status}`}); ${keeps}.`
      : `could not fetch the newest version from ${where} (${result.problem}); ${keeps}.`);
    return result;
  } catch {
    return {outcome: 'failed', problem: 'error'};
  }
}

// The fetch alone: {outcome: 'taken', version, document}, {outcome: 'refused', problem, status?} or {outcome: 'failed', problem}.
export async function fetchNewestVersion({url, publicKey, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, signal} = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  try {
    const response = await fetchImpl(url, {method: 'GET', redirect: 'manual', credentials: 'omit', signal: abort});

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return {outcome: 'refused', problem: 'status', status: response.status};
    }

    const text = await readLimited(response, MAX_NEWEST_VERSION_LENGTH);

    if (text === null) {
      return {outcome: 'refused', problem: 'oversized'};
    }

    const read = readNewestVersion(text, publicKey);
    return read.ok ? {outcome: 'taken', version: read.version, document: text} : {outcome: 'refused', problem: read.problem};
  } catch (error) {
    return {outcome: 'failed', problem: deadline.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'unreachable'};
  }
}
