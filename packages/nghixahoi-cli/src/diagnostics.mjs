import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {writeFileAtomically} from './atomic-file.mjs';
import {ensureInstallId, readInstallId} from './install-id.mjs';
import {DIAGNOSTICS_URL} from './integration-spec.mjs';
import {STORE_DIR} from './store.mjs';

// Tester diagnostics (docs/backend.md, "Tester diagnostics"; docs/security.md, "Tester diagnostics"; the voucher scheme's
// phase 4): a tester build tells its staging server about Kit=Code itself, so that the operator can trace a tester's
// problem without asking them for its symptoms. Only a tester build: DIAGNOSTICS_URL is null in the repository and in every
// release of it, and then nothing here collects, writes or sends anything (diagnosticsEnabled is false, and every function
// below returns at once).
//
// What is collected is Kit=Code's own events, in the contract's closed vocabulary (packages/claim-contract,
// diagnostics.v1.schema.json): which, when, and fields of known shapes. Never a path, a file or project name, a user or
// host name, a prompt, code, a git ref or a commit; an error only by its code and name, never its message or its stack,
// which hold paths, and paths hold the user's name. A project is an opaque reference, a keyed hash of Kit=Code's project id
// under a key that never leaves this computer, since that id is a hash of the project's path, which a guess could confirm.
//
// Each event is its own small file in ~/.nghixahoi/diagnostics/queue, written whole and then renamed into place, so that the
// prompt hook, the tracker and a command can each add one, and send and remove them, without a lock and without losing
// another's: a file is removed only once the server has said it stored it (or refused it for good). The queue is bounded,
// by count and by bytes, its oldest events dropped first, and every drop counted in an event of its own. Nothing here is
// ever in state.json, whose shape this does not change (hard rule 4).
//
// Nothing here ever throws to its caller: the hook must fail open and finish well inside its 5 s (hard rule 7), and the
// tracker must count whatever happens to its diagnostics.

export const DIAGNOSTICS_DIR = path.join(STORE_DIR, 'diagnostics');
export const DIAGNOSTICS_DISPLAY_PATH = '~/.nghixahoi/diagnostics';
const QUEUE_DIR = path.join(DIAGNOSTICS_DIR, 'queue');
const HOOK_DIR = path.join(DIAGNOSTICS_DIR, 'hook');
const KEY_PATH = path.join(DIAGNOSTICS_DIR, 'key');
const INVITED_EMAIL_PATH = path.join(DIAGNOSTICS_DIR, 'invited-email');
const CLOSED_PATH = path.join(DIAGNOSTICS_DIR, 'closed-until');
const LAST_SEND_PATH = path.join(DIAGNOSTICS_DIR, 'last-send.json');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// The queue's caps: at most this many events, and this many bytes, the oldest dropped first. An event is a few hundred
// bytes; one larger than MAX_EVENT_BYTES is not written at all.
export const MAX_QUEUED_EVENTS = 500;
export const MAX_QUEUE_BYTES = 512 * 1024;
export const MAX_EVENT_BYTES = 2048;
// A batch: at most the contract's 100 events, and this many bytes, under the server's 64 KiB.
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 48 * 1024;
// A hook run this slow is recorded: its agent waits 5 s for it.
export const HOOK_SLOW_MS = 2000;
// A hook run's start marker still there this long after it began, its process gone, is a run that never finished: its agent
// stopped it at its 5 s timeout, or it crashed. Still there this long, process or not, it hung.
export const HOOK_UNFINISHED_MS = 10_000;
export const HOOK_HUNG_MS = 60_000;
// The server said it takes no diagnostics now (410): the round is over, or paused. Sending waits this long before it tries
// again, whatever process tries, unless the tester asks to send now.
export const CLOSED_PAUSE_MS = 24 * 60 * 60 * 1000;

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUEUED_NAME = /^([0-9]{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const MARKER_NAME = /^([0-9]{13})-([0-9]{1,10})-(claude|codex|unknown)-[0-9a-f]{8}$/u;
const AGENTS = new Set(['claude', 'codex']);
const OPERATING_SYSTEMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);
const ARCHITECTURES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64']);
// What the contract takes for an email typed in Welcome (diagnostics.v1.schema.json, invitedEmail).
const INVITED_EMAIL = /^[^\s@"<>]{1,64}@[^\s@"<>]{1,189}$/u;

// Where this build sends: DIAGNOSTICS_URL, an https URL, or, for this repository's tests, an http one on this machine;
// anything else, null above all, is no destination, and diagnostics are off.
export function diagnosticsDestination(setting = DIAGNOSTICS_URL) {
  if (typeof setting !== 'string') {
    return null;
  }

  try {
    const url = new URL(setting);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

export function diagnosticsEnabled() {
  return diagnosticsDestination() !== null;
}

function agentOf(source) {
  return AGENTS.has(source) ? source : 'unknown';
}

// An error's code and its name, of the shapes the contract takes, and never its message or its stack.
export function errorCodeOf(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/u.test(code) ? code : null;
}

export function errorNameOf(error) {
  const name = error?.name;
  return typeof name === 'string' && /^[A-Z][A-Za-z0-9]{0,39}$/u.test(name) ? name : null;
}

// Why the hook installer left an agent's settings as they are (hook-installers.mjs, ConfigFileError), as a fixed code: its
// words name the file, and can quote it.
export function configProblemCode(error) {
  if (error === undefined || error === null) {
    return 'none';
  }

  if (error.readOnly) {
    return 'read-only';
  }

  const problem = String(error.problem ?? '');
  const codes = [
    [/^is not a regular file/u, 'not-a-file'],
    [/^could not be read/u, 'unreadable'],
    [/^is not valid JSON/u, 'not-json'],
    [/^does not hold a JSON object/u, 'not-an-object'],
    [/^has a "hooks" value/u, 'hooks-not-an-object'],
    [/^has a "hooks\.UserPromptSubmit" value/u, 'hooks-not-a-list'],
    [/^changed while Kit=Code/u, 'changed'],
    [/^could not be written/u, 'unwritable'],
  ];

  return codes.find(([pattern]) => pattern.test(problem))?.[1] ?? 'other';
}

function ensureDir(folder) {
  fs.mkdirSync(folder, {recursive: true, mode: DIR_MODE});
}

// The key a project's reference is made with: 32 random bytes, made once per HOME, 0600, never sent anywhere. Written whole,
// then linked into place, as the install id is, so that two processes making it at once keep one.
function diagnosticsKey() {
  try {
    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return null;
    }
  }

  try {
    ensureDir(DIAGNOSTICS_DIR);
    const temporary = path.join(DIAGNOSTICS_DIR, `.key.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(temporary, `${crypto.randomBytes(32).toString('hex')}\n`, {mode: FILE_MODE, flag: 'wx'});

    try {
      fs.linkSync(temporary, KEY_PATH);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    } finally {
      fs.rmSync(temporary, {force: true});
    }

    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  } catch {
    return null;
  }
}

// A key for this process alone, when the file's cannot be read or made: references then hold within the process.
let processKey = null;

// A project's reference: the first 12 hex characters of an HMAC-SHA-256 of Kit=Code's project id, under the key above. It
// tells one project of this install from another, and nothing more: without the key, which stays here, no guess of a
// project's path can be checked against it.
export function projectRef(projectId) {
  let key = diagnosticsKey();

  if (key === null || key.length !== 32) {
    processKey ??= crypto.randomBytes(32);
    key = processKey;
  }

  return crypto.createHmac('sha256', key).update(String(projectId)).digest('hex').slice(0, 12);
}

function eventName(at, id) {
  return `${String(at.getTime()).padStart(13, '0')}-${id}.json`;
}

// Writes one event into the queue, whole: to a temporary file in the queue's folder, then renamed into place.
function writeEvent(event) {
  const text = `${JSON.stringify(event)}\n`;

  if (Buffer.byteLength(text) > MAX_EVENT_BYTES) {
    return false;
  }

  ensureDir(QUEUE_DIR);
  writeFileAtomically(path.join(QUEUE_DIR, eventName(new Date(event.at), event.id)), text, {mode: FILE_MODE});
  return true;
}

function queuedNames() {
  try {
    return fs.readdirSync(QUEUE_DIR).filter((name) => QUEUED_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

function removeQueued(names) {
  for (const name of names) {
    try {
      fs.rmSync(path.join(QUEUE_DIR, name), {force: true});
    } catch {
      // Windows will not remove a file another process holds open: another sender, reading it. It is sent again, and the
      // server, which has it, says so; then it goes.
    }
  }
}

// Keeps the queue under its caps, by count and, with `bytes`, by size, with room for one event more and the record of a
// drop: once a cap is reached, the oldest tenth of the queue goes, so that a queue kept full by a stream of events drops in
// chunks, each counted in one event of its own, which stays, rather than writing a record for every event it drops. The
// prompt hook counts only, which costs one listing of a folder of at most MAX_QUEUED_EVENTS names; the tracker and the
// commands that send measure the bytes too.
export function enforceQueueCaps({source, bytes = true} = {}) {
  if (!diagnosticsEnabled()) {
    return 0;
  }

  try {
    let names = queuedNames();
    let dropped = 0;
    let reason = 'count-cap';

    if (names.length + 2 > MAX_QUEUED_EVENTS) {
      const over = names.slice(0, Math.max(names.length + 2 - MAX_QUEUED_EVENTS, MAX_QUEUED_EVENTS / 10));
      removeQueued(over);
      dropped += over.length;
      names = names.slice(over.length);
    }

    if (bytes) {
      const sizes = names.map((name) => {
        try {
          return fs.statSync(path.join(QUEUE_DIR, name)).size;
        } catch {
          return 0;
        }
      });
      let total = sizes.reduce((sum, size) => sum + size, 0);

      if (total + 2 * MAX_EVENT_BYTES > MAX_QUEUE_BYTES) {
        let first = 0;

        while (total + 2 * MAX_EVENT_BYTES > MAX_QUEUE_BYTES * 0.9 && first < names.length) {
          total -= sizes[first];
          first += 1;
        }

        removeQueued(names.slice(0, first));
        dropped += first;
        reason = dropped === first ? 'size-cap' : reason;
      }
    }

    if (dropped > 0) {
      writeEvent(newEvent('diagnostics-dropped', {count: dropped, reason}, {source}));
    }

    return dropped;
  } catch {
    return 0;
  }
}

function newEvent(type, fields, {source, now = new Date()}) {
  return {id: crypto.randomUUID(), at: now.toISOString(), source, type, ...fields};
}

// Records one event, of `type` and its fields, from `source` (tracker, command or hook): written into the queue, which is
// kept under its caps. Returns whether it was written. Off unless this is a tester build; never throws.
export function recordEvent(type, fields, {source, now = new Date(), bytes = true} = {}) {
  if (!diagnosticsEnabled()) {
    return false;
  }

  try {
    enforceQueueCaps({source, bytes});
    return writeEvent(newEvent(type, fields, {source, now}));
  } catch {
    return false;
  }
}

// The queue, oldest first: each event as it was written, with its file. A file that does not hold one is removed: only a
// person, or another program, could have written it.
export function queuedEvents() {
  const events = [];

  for (const name of queuedNames()) {
    try {
      const event = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8'));

      if (event !== null && typeof event === 'object' && EVENT_ID.test(event.id ?? '')) {
        events.push({name, event});
        continue;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
    }

    removeQueued([name]);
  }

  return events;
}

// --- The prompt hook --------------------------------------------------------------------------------------------------

// A run of the hook begins: a start marker, an empty file named for the time, the process and the agent. hookFinished
// removes it; one left behind is a run that never finished (sweepHookMarkers). Returns its path, or null.
export function hookStarted(source, now = Date.now()) {
  if (!diagnosticsEnabled()) {
    return null;
  }

  const marker = path.join(HOOK_DIR, `${String(now).padStart(13, '0')}-${process.pid}-${agentOf(source)}-${crypto.randomBytes(4).toString('hex')}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(marker, '', {mode: FILE_MODE, flag: 'wx'});
      return marker;
    } catch (error) {
      if (error?.code !== 'ENOENT' || attempt > 0) {
        return null;
      }

      try {
        ensureDir(HOOK_DIR);
      } catch {
        return null;
      }
    }
  }

  return null;
}

// The run ends, however it went: its marker goes, and one event at most is recorded: `failure`, an error it met, logged in
// hook.log and failed open on, by its code and name alone; or else a run past HOOK_SLOW_MS. It never throws.
export function hookFinished(marker, source, ms, failure = null) {
  if (marker !== null) {
    try {
      fs.rmSync(marker, {force: true});
    } catch {
      // Left behind, it is swept as a run that never finished: wrongly, and harmlessly.
    }
  }

  if (failure !== null) {
    hookFailed(source, failure, ms);
  } else if (ms >= HOOK_SLOW_MS) {
    recordEvent('hook-slow', {agent: agentOf(source), ms: Math.min(3_600_000, Math.round(ms))}, {source: 'hook', bytes: false});
  }
}

export function hookFailed(source, error, ms) {
  recordEvent('hook-failed', {agent: agentOf(source), errorCode: errorCodeOf(error), errorName: errorNameOf(error), ms: Math.min(3_600_000, Math.round(ms))}, {source: 'hook', bytes: false});
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// The start markers runs of the hook left behind: each one older than HOOK_UNFINISHED_MS whose process is gone, or older
// than HOOK_HUNG_MS whatever its process, is a run that never finished, recorded and removed. Run by the tracker, and by the
// commands that send, since the hook itself cannot record its own end once its agent has stopped it.
export function sweepHookMarkers({source, now = Date.now()} = {}) {
  if (!diagnosticsEnabled()) {
    return 0;
  }

  let names;

  try {
    names = fs.readdirSync(HOOK_DIR);
  } catch {
    return 0;
  }

  let found = 0;

  for (const name of names) {
    const marker = path.join(HOOK_DIR, name);
    const match = MARKER_NAME.exec(name);

    try {
      if (match === null) {
        // Not a marker: the hook leaves nothing else here, so it is no one's.
        fs.rmSync(marker, {force: true, recursive: true});
        continue;
      }

      const startedMs = Number(match[1]);
      const age = now - startedMs;

      if (age < HOOK_UNFINISHED_MS || (age < HOOK_HUNG_MS && isAlive(Number(match[2])))) {
        continue;
      }

      // The run may have ended between the listing and now, and taken its marker with it: then it finished.
      if (!fs.existsSync(marker)) {
        continue;
      }

      fs.rmSync(marker, {force: true});
      recordEvent('hook-unfinished', {agent: match[3], startedAt: new Date(startedMs).toISOString(), ageSeconds: Math.max(0, Math.floor(age / 1000))}, {source});
      found += 1;
    } catch {
      // The next sweep tries it again.
    }
  }

  return found;
}

// --- The invited email, from Welcome ----------------------------------------------------------------------------------

// The address a tester typed in Welcome, so that staff can find their logs by it: trimmed and lower-cased; null for none;
// undefined for one the contract would not take.
export function normalizeInvitedEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();

  if (email === '') {
    return null;
  }

  return email.length <= 254 && INVITED_EMAIL.test(email) ? email : undefined;
}

export function readInvitedEmail() {
  if (!diagnosticsEnabled()) {
    return null;
  }

  try {
    return normalizeInvitedEmail(fs.readFileSync(INVITED_EMAIL_PATH, 'utf8')) ?? null;
  } catch {
    return null;
  }
}

// Keeps the address typed in Welcome, outside state.json, in a file of its own, 0600; an empty one removes it. Returns
// {ok: true, email} or {ok: false}, for an address the contract would not take, and keeps nothing then.
export function setInvitedEmail(value) {
  if (!diagnosticsEnabled()) {
    return {ok: true, email: null};
  }

  const email = normalizeInvitedEmail(value);

  if (email === undefined) {
    return {ok: false};
  }

  try {
    if (email === null) {
      fs.rmSync(INVITED_EMAIL_PATH, {force: true});
    } else {
      ensureDir(DIAGNOSTICS_DIR);
      writeFileAtomically(INVITED_EMAIL_PATH, `${email}\n`, {mode: FILE_MODE});
    }

    return {ok: true, email};
  } catch {
    return {ok: false};
  }
}

// --- Sending ----------------------------------------------------------------------------------------------------------

function cliVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// What sent the batch: the CLI's version, and the platform, each of a shape the contract takes; never a host or user name.
export function clientInfo() {
  const release = os.release();
  return {
    kind: 'cli',
    version: cliVersion(),
    os: OPERATING_SYSTEMS.has(process.platform) ? process.platform : 'other',
    osRelease: /^[0-9]{1,5}(\.[0-9]{1,6}){0,4}([-+._][0-9A-Za-z]{1,24}){0,6}$/u.test(release) && release.length <= 40 ? release : '0',
    arch: ARCHITECTURES.has(process.arch) ? process.arch : 'other',
    node: /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u.test(process.version) ? process.version : 'v0.0.0',
  };
}

// The install id the batch is linked by: the claim bundle's. A tester build makes it when there is none yet, so that a
// command that fails before any tracker ever started is linked to the same install as everything after.
function installIdForBatch() {
  try {
    return readInstallId() ?? ensureInstallId();
  } catch {
    return null;
  }
}

export function closedUntil(now = new Date()) {
  try {
    const until = new Date(fs.readFileSync(CLOSED_PATH, 'utf8').trim());
    return Number.isFinite(until.getTime()) && until > now ? until : null;
  } catch {
    return null;
  }
}

function setClosed(until) {
  try {
    ensureDir(DIAGNOSTICS_DIR);
    writeFileAtomically(CLOSED_PATH, `${until.toISOString()}\n`, {mode: FILE_MODE});
  } catch {
    // Without it, the next process tries again, and is told again.
  }
}

export function readLastSend() {
  try {
    const last = JSON.parse(fs.readFileSync(LAST_SEND_PATH, 'utf8'));
    return last !== null && typeof last === 'object' ? last : null;
  } catch {
    return null;
  }
}

function writeLastSend(outcome, now) {
  try {
    ensureDir(DIAGNOSTICS_DIR);
    writeFileAtomically(LAST_SEND_PATH, `${JSON.stringify({at: now.toISOString(), ...outcome})}\n`, {mode: FILE_MODE});
  } catch {
    // The next send writes it.
  }
}

// The batches the queue makes, oldest events first: each at most MAX_BATCH_EVENTS events and MAX_BATCH_BYTES bytes.
function batchOf(queued, envelope) {
  const events = [];
  let bytes = Buffer.byteLength(JSON.stringify({...envelope, events: []}));

  for (const entry of queued) {
    const size = Buffer.byteLength(JSON.stringify(entry.event)) + 1;

    if (events.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES) {
      break;
    }

    events.push(entry);
    bytes += size;
  }

  return events;
}

// The server's answer to a batch: the ids it stored, those it had stored already, and the events it refused, by their place
// in the batch. Anything else, or ids it was not sent, is no answer.
function answerOf(body, sent) {
  const ids = new Set(sent.map((entry) => entry.event.id));
  const isIdList = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string' && ids.has(id));

  if (body === null || typeof body !== 'object' || !isIdList(body.stored) || !isIdList(body.duplicates) || !Array.isArray(body.refused)) {
    return null;
  }

  const refused = body.refused.map((refusal) => refusal?.index);

  if (!refused.every((index) => Number.isInteger(index) && index >= 0 && index < sent.length)) {
    return null;
  }

  return {stored: new Set(body.stored), duplicates: new Set(body.duplicates), refused: new Set(refused)};
}

async function readBody(response) {
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > 256 * 1024) {
    return null;
  }

  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

// Sends the queue, oldest first, in at most `maxBatches` batches, each POSTed to the destination with `timeoutMs` to answer.
// An event leaves the queue only once the server says it stored it, had it already, or refused it for good. Returns what
// happened, in the shape describeOutcome puts in words; never throws. `manual`: the tester asked to send now, which tries
// even while the server has said it is closed.
export async function sendQueued({timeoutMs = 10_000, maxBatches = 1, manual = false, fetchImpl = globalThis.fetch, now = () => new Date(), source = 'command'} = {}) {
  const destination = diagnosticsDestination();

  if (destination === null) {
    return {outcome: 'disabled'};
  }

  try {
    const pausedUntil = closedUntil(now());

    if (pausedUntil !== null && !manual) {
      return {outcome: 'closed', until: pausedUntil.toISOString(), queued: queuedNames().length};
    }

    enforceQueueCaps({source});
    const totals = {stored: 0, duplicates: 0, refused: 0};

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const queued = queuedEvents();

      if (queued.length === 0) {
        break;
      }

      const envelope = {schemaVersion: 1, installId: installIdForBatch(), client: clientInfo(), invitedEmail: readInvitedEmail(), sentAt: now().toISOString()};
      const sent = batchOf(queued, envelope);
      let response;

      try {
        response = await fetchImpl(destination, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({...envelope, events: sent.map((entry) => entry.event)}),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return finish({outcome: 'failed', reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable', ...totals});
      }

      if (response.status === 200) {
        const answer = answerOf(await readBody(response), sent);

        if (answer === null) {
          return finish({outcome: 'failed', reason: 'bad-answer', ...totals});
        }

        removeQueued(sent.filter((entry, index) => answer.stored.has(entry.event.id) || answer.duplicates.has(entry.event.id) || answer.refused.has(index)).map((entry) => entry.name));
        totals.stored += answer.stored.size;
        totals.duplicates += answer.duplicates.size;
        totals.refused += answer.refused.size;
        continue;
      }

      if (response.status === 410) {
        setClosed(new Date(now().getTime() + CLOSED_PAUSE_MS));
        return finish({outcome: 'closed', until: closedUntil(now())?.toISOString() ?? null, ...totals});
      }

      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        return finish({outcome: 'rate-limited', retryAfterSeconds: Number.isInteger(seconds) && seconds > 0 ? seconds : 60, ...totals});
      }

      if (response.status === 404) {
        return finish({outcome: 'failed', reason: 'not-found', status: 404, ...totals});
      }

      // A login, or a path not forwarded, in front of the route: the staging site's nginx before it forwards the path (the
      // shared login answers 401), not the batch. The route itself never answers a CLI's post with these, so the batch
      // waits for the next send, as for a 404, and is not dropped.
      if (response.status === 401 || response.status === 403 || response.status === 405) {
        return finish({outcome: 'failed', reason: 'not-let-through', status: response.status, ...totals});
      }

      // Any other refusal of the batch is for good: sending it again would be refused again (the ingest-hot-path skill, §7).
      if (response.status >= 400 && response.status < 500) {
        removeQueued(sent.map((entry) => entry.name));
        return finish({outcome: 'refused', status: response.status, dropped: sent.length, ...totals});
      }

      return finish({outcome: 'failed', reason: 'server-error', status: response.status, ...totals});
    }

    return finish(totals.stored + totals.duplicates + totals.refused > 0 ? {outcome: 'stored', ...totals} : {outcome: 'nothing', ...totals});
  } catch {
    return finish({outcome: 'failed', reason: 'error', stored: 0, duplicates: 0, refused: 0});
  }

  function finish(outcome) {
    const result = {...outcome, queued: queuedNames().length};
    writeLastSend(result, now());
    return result;
  }
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// What a send did, in plain words, for `nghixahoi diagnostics send` and the dashboard's Send logs now: exactly what the
// server confirmed, or why nothing was sent, and what waits.
export function describeOutcome(result) {
  const waiting = result.queued === undefined ? '' : ` ${result.queued === 0 ? 'Nothing waits to be sent.' : `${plural(result.queued, 'event')} ${result.queued === 1 ? 'waits' : 'wait'}, and ${result.queued === 1 ? 'is' : 'are'} sent later.`}`;
  const sentSoFar = result.stored + result.duplicates > 0 ? ` Before that, it stored ${plural(result.stored + result.duplicates, 'event')}.` : '';

  switch (result.outcome) {
    case 'disabled':
      return 'This Kit=Code is not a tester build: it collects, writes and sends no diagnostics.';
    case 'nothing':
      return 'Nothing to send: no event waits.';
    case 'stored': {
      const before = result.duplicates > 0 ? ` (${result.duplicates} of them it had already)` : '';
      const refused = result.refused > 0 ? ` It refused ${plural(result.refused, 'event')} it does not know, which ${result.refused === 1 ? 'is' : 'are'} dropped.` : '';
      return `Sent: the staging server stored ${plural(result.stored + result.duplicates, 'event')}${before}.${refused}${waiting}`;
    }
    case 'closed':
      return `Not sent: the staging server is not taking diagnostics now; the test round may be over.${result.until ? ` Kit=Code tries again after ${result.until}.` : ''}${sentSoFar}${waiting}`;
    case 'rate-limited':
      return `Not sent: the staging server asked Kit=Code to wait ${plural(result.retryAfterSeconds, 'second')}.${sentSoFar}${waiting}`;
    case 'refused':
      return `Not sent: the staging server refused the batch (HTTP ${result.status}), so its ${plural(result.dropped, 'event')} ${result.dropped === 1 ? 'is' : 'are'} dropped: sending ${result.dropped === 1 ? 'it' : 'them'} again would not help.${sentSoFar}${waiting}`;
    default: {
      const why = {
        unreachable: 'the staging server could not be reached',
        timeout: 'the staging server did not answer in time',
        'server-error': `the staging server failed (HTTP ${result.status})`,
        'not-found': 'the staging server has no place for diagnostics (HTTP 404)',
        'not-let-through': `the staging site did not let it through to its server (HTTP ${result.status})`,
        'bad-answer': 'the staging server\'s answer could not be read',
      }[result.reason] ?? 'something went wrong on this computer';
      return `Not sent: ${why}.${sentSoFar}${waiting}`;
    }
  }
}

// What `nghixahoi diagnostics status` and the dashboard show: whether this build sends, where to, what waits, the last send.
export function diagnosticsStatus(now = new Date()) {
  const destination = diagnosticsDestination();

  if (destination === null) {
    return {enabled: false};
  }

  let installId = null;

  try {
    installId = readInstallId();
  } catch {
    // Shown as none: the bundle route says what is wrong with the file.
  }

  return {
    enabled: true,
    destination: destination.origin,
    installId,
    invitedEmail: readInvitedEmail(),
    queued: queuedNames().length,
    closedUntil: closedUntil(now)?.toISOString() ?? null,
    lastSend: readLastSend(),
  };
}

// --- The tracker's loop -----------------------------------------------------------------------------------------------

// While the tracker runs: every `intervalMs`, the hook's markers swept and the queue sent, a batch at a time while there is
// more, backing off after a failure (from a minute to an hour, with full jitter), and waiting as the server asks; every
// `heartbeatMs`, a heartbeat. `snapshot()` says how the tracker is doing, for the heartbeat. Nothing here can stop, block or
// slow the tracker: each round runs alone, its send has its own timeout, and every failure stays here.
export function startDiagnosticsLoop({snapshot, intervalMs = 60_000, heartbeatMs = 60 * 60 * 1000, fetchImpl = globalThis.fetch, now = () => new Date(), random = Math.random} = {}) {
  if (!diagnosticsEnabled()) {
    return {stop: async () => {}, sendNow: async () => ({outcome: 'disabled'})};
  }

  const startedAt = now();
  let failures = 0;
  let nextAttemptAt = 0;
  let sending = null;
  let stopped = false;

  const heartbeat = () => {
    try {
      const status = snapshot?.() ?? {projects: 0, tracking: 'ok', problems: []};
      recordEvent('tracker-heartbeat', {
        uptimeSeconds: Math.max(0, Math.floor((now().getTime() - startedAt.getTime()) / 1000)),
        projects: status.projects,
        tracking: status.tracking,
        problems: [...new Set(status.problems)].slice(0, 5),
      }, {source: 'tracker'});
    } catch {
      // The next one is an hour away.
    }
  };

  const send = async ({manual = false, timeoutMs = 10_000, maxBatches = 1} = {}) => {
    if (sending !== null) {
      await sending.catch(() => {});
    }

    const attempt = (async () => {
      sweepHookMarkers({source: 'tracker'});
      const result = await sendQueued({timeoutMs, maxBatches, manual, fetchImpl, now, source: 'tracker'});

      if (result.outcome === 'failed') {
        failures += 1;
        const ceiling = Math.min(60 * 60 * 1000, intervalMs * 2 ** Math.min(failures, 10));
        nextAttemptAt = now().getTime() + Math.floor(random() * ceiling);
      } else if (result.outcome === 'rate-limited') {
        nextAttemptAt = now().getTime() + result.retryAfterSeconds * 1000;
      } else {
        failures = 0;
        nextAttemptAt = 0;
      }

      return result;
    })();

    sending = attempt;

    try {
      return await attempt;
    } finally {
      if (sending === attempt) {
        sending = null;
      }
    }
  };

  const round = () => {
    if (stopped || sending !== null || now().getTime() < nextAttemptAt) {
      return;
    }

    send().catch(() => {});
  };

  const interval = setInterval(round, intervalMs);
  const beats = setInterval(heartbeat, heartbeatMs);
  interval.unref?.();
  beats.unref?.();

  return {
    // The tester's Send logs now: every waiting event, past any backoff, a batch at a time, up to five.
    sendNow: () => send({manual: true, maxBatches: 5}),
    // As the tracker stops: one last batch, whatever the backoff says, so that its stop reaches the server. 5 s to answer,
    // well inside the 10 s `untrack` waits for the tracker to end; one not answered by then is sent by the next send.
    async stop({finalSend = true, timeoutMs = 5000} = {}) {
      stopped = true;
      clearInterval(interval);
      clearInterval(beats);

      if (finalSend) {
        try {
          await send({timeoutMs, maxBatches: 1});
        } catch {
          // Sent by the next process that sends.
        }
      }
    },
  };
}
