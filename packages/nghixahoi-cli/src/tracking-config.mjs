import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {writeFileAtomically} from './atomic-file.mjs';
import {cycleReceiptKey} from './cycle-receipt.mjs';
import {CYCLE_RECEIPT_PUBLIC_KEY, DASHBOARD_URL, NGHIXAHOI_DISPLAY_MILESTONES, NGHIXAHOI_REWARD_TIERS} from './integration-spec.mjs';
import {STORE_DIR} from './store.mjs';

// The campaign's targets and its end, from the server (docs/plans/2026-10-22-server-tracking-config.md, THE TRACKER; docs/backend.md,
// "The tracking config"; docs/reward-rules.md §2). The claim backend serves one signed document at the dashboard's address plus
// /v1/tracking-config: the six milestone targets in force and when the campaign ends. A tracker of a build that carries the claim
// backend's public key fetches it about once an hour, checks its signature, and counts by it; so a change of targets reaches every
// install within the hour, with no new version of Kit=Code to install. Nothing else fetches it: never the prompt hook, a command or a
// window (hard rule 7). The repository's own build carries no key, and so never fetches, and counts by the table it bundles (R22.1).
//
//   <payload>.<signature>
//
// `payload` is base64url (no padding) of the UTF-8 JSON {"v":1,"issuedAt":…,"milestones":[{"percent":30,"focusSeconds":…,"equals":…},
// {"percent":50,…},{"percent":100,…}],"campaignEndsAt":…|null}, those four fields alone; `signature`, base64url of the 64-byte Ed25519
// signature of the ASCII text `nghixahoi-tracking-config-1.` followed by `payload` as it stands, with the cycle receipts' key
// (cycle-receipt.mjs), whose text is `nghixahoi-cycle-receipt-1.`: a receipt never passes for a config, or a config for a receipt. The
// contract is packages/claim-contract/tracking-config.mjs, which only tests read; this reader is the CLI's own, held to the
// contract's fixtures by test/tracking-config.test.mjs, problem for problem, in the contract's order.
//
// What the tracker took is kept in memory, and in ~/.nghixahoi/tracking-config.json, its last good copy: written whole, 0600, never
// state.json (hard rule 4), and never deleted or written over by anything but a later good document. The targets in force are,
// in order: the copy the tracker took this run, the last good copy on disk, then the table this Kit=Code bundles
// (integration-spec.mjs). The prompt hook and the commands read the copy on disk and check its shape and bounds, never its
// signature, which only the tracker checks, as it fetched it; and `targets.source` says which of the three is in force, so that a
// fallback never looks like the healthy path.

export const TRACKING_CONFIG_CONTEXT = 'nghixahoi-tracking-config-1.';
export const TRACKING_CONFIG_PATH = path.join(STORE_DIR, 'tracking-config.json');
export const TRACKING_CONFIG_DISPLAY_PATH = '~/.nghixahoi/tracking-config.json';
// The longest document read, in characters, and the most of a body the tracker reads, in bytes: 2 KiB. A document is about 430.
export const MAX_TRACKING_CONFIG_LENGTH = 2048;
// The bounds (the operator's decision D2 of 2026-10-22): the percents 30, 50 and 100, in that order; each milestone's focus time
// 60 to 172,800 s and its = 1 to 100,000; each milestone's targets at least the one before's.
export const TRACKING_CONFIG_PERCENTS = Object.freeze([30, 50, 100]);
export const TRACKING_CONFIG_BOUNDS = Object.freeze({
  focusSeconds: Object.freeze({min: 60, max: 172_800}),
  equals: Object.freeze({min: 1, max: 100_000}),
});

// When the tracker fetches: a random moment 5 to 120 s after it starts, so that a fleet started together does not ask at once;
// then whenever its last try is over an hour old, which it checks every minute; and at once when it finds the computer has slept,
// a check that came three minutes or more after the one before. 10 s for the whole answer, its body included.
export const FIRST_FETCH_MS = Object.freeze({min: 5_000, max: 120_000});
export const FETCH_AGAIN_AFTER_MS = 60 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 1000;
export const WOKE_AFTER_MS = 3 * CHECK_EVERY_MS;
export const FETCH_TIMEOUT_MS = 10_000;

const FILE_MODE = 0o600;
const PAYLOAD_KEYS = ['v', 'issuedAt', 'milestones', 'campaignEndsAt'];
const MILESTONE_KEYS = ['percent', 'focusSeconds', 'equals'];
const DOCUMENT_TEXT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SILENT_LOG = {info() {}, warn() {}, error() {}};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactly(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isInstantText(value) {
  return typeof value === 'string' && INSTANT.test(value);
}

function isRealInstant(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function within(value, {min, max}) {
  return value >= min && value <= max;
}

// Whether `words`, a payload as JSON.parse reads it, is a tracking config: {ok: true, config: {issuedAt, milestones, campaignEndsAt}},
// a copy of its words, or {ok: false, problem}, the contract's: 'version', a `v` present and not 1, a later version, refused whole;
// 'unreadable', not the contract's shape, or an instant that is not a real one; 'bounds', outside the bounds above. Pure. What the
// tracker holds a signed document to, and what the hook and the commands hold the last good copy's words to.
export function judgeTrackingConfig(words) {
  if (!isObject(words)) {
    return {ok: false, problem: 'unreadable'};
  }

  if (Object.hasOwn(words, 'v') && words.v !== 1) {
    return {ok: false, problem: 'version'};
  }

  const shaped = hasExactly(words, PAYLOAD_KEYS)
    && isInstantText(words.issuedAt)
    && (words.campaignEndsAt === null || isInstantText(words.campaignEndsAt))
    && Array.isArray(words.milestones) && words.milestones.length === TRACKING_CONFIG_PERCENTS.length
    && words.milestones.every((milestone) => hasExactly(milestone, MILESTONE_KEYS) && MILESTONE_KEYS.every((key) => Number.isInteger(milestone[key])));

  if (!shaped || !isRealInstant(words.issuedAt) || (words.campaignEndsAt !== null && !isRealInstant(words.campaignEndsAt))) {
    return {ok: false, problem: 'unreadable'};
  }

  const inBounds = words.milestones.every((milestone, index) => {
    const before = words.milestones[index - 1];

    return milestone.percent === TRACKING_CONFIG_PERCENTS[index]
      && within(milestone.focusSeconds, TRACKING_CONFIG_BOUNDS.focusSeconds)
      && within(milestone.equals, TRACKING_CONFIG_BOUNDS.equals)
      && (before === undefined || (milestone.focusSeconds >= before.focusSeconds && milestone.equals >= before.equals));
  });

  if (!inBounds) {
    return {ok: false, problem: 'bounds'};
  }

  return {
    ok: true,
    config: {
      issuedAt: words.issuedAt,
      milestones: words.milestones.map(({percent, focusSeconds, equals}) => ({percent, focusSeconds, equals})),
      campaignEndsAt: words.campaignEndsAt,
    },
  };
}

// The public key a build carries: the cycle receipts' own (integration-spec.mjs, CYCLE_RECEIPT_PUBLIC_KEY). Null when it is not one.
export function trackingConfigKey(text = CYCLE_RECEIPT_PUBLIC_KEY) {
  return cycleReceiptKey(text);
}

// Reads `text` with `publicKey` (a KeyObject, trackingConfigKey's): {ok: true, config}, or {ok: false, problem}, the first of the
// contract's, in its order: 'oversized', longer than MAX_TRACKING_CONFIG_LENGTH; 'unreadable', not two base64url parts joined by a
// dot; 'signature', not signed over the context and the payload with the key's pair, checked over the bytes as they came, before
// anything in them is read; then judgeTrackingConfig's; and 'stale', an issuedAt no later than `after`, the issuedAt of the last
// document taken: an older one replayed, or the same one again.
export function readTrackingConfig(text, publicKey, {after = null} = {}) {
  if (after !== null && !(isInstantText(after) && isRealInstant(after))) {
    throw new TypeError(`after must be an instant, as toISOString writes it, or null: ${String(after)}`);
  }

  if (typeof text !== 'string') {
    return {ok: false, problem: 'unreadable'};
  }

  if (text.length > MAX_TRACKING_CONFIG_LENGTH) {
    return {ok: false, problem: 'oversized'};
  }

  const parts = DOCUMENT_TEXT.exec(text);

  if (parts === null) {
    return {ok: false, problem: 'unreadable'};
  }

  const [, payload, signature] = parts;
  let signed;

  try {
    signed = crypto.verify(null, Buffer.from(`${TRACKING_CONFIG_CONTEXT}${payload}`, 'ascii'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    signed = false;
  }

  if (!signed) {
    return {ok: false, problem: 'signature'};
  }

  let words;

  try {
    words = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {ok: false, problem: 'unreadable'};
  }

  const judged = judgeTrackingConfig(words);

  if (!judged.ok) {
    return judged;
  }

  if (after !== null && Date.parse(judged.config.issuedAt) <= Date.parse(after)) {
    return {ok: false, problem: 'stale'};
  }

  return judged;
}

// Where this build fetches: DASHBOARD_URL plus v1/tracking-config, an https URL, or, for this repository's tests, an http one on this
// machine; and only in a build that carries a key. Null otherwise: such a build never fetches, and never reads a copy either.
export function trackingConfigUrl({dashboardUrl = DASHBOARD_URL, publicKey = CYCLE_RECEIPT_PUBLIC_KEY} = {}) {
  if (trackingConfigKey(publicKey) === null || typeof dashboardUrl !== 'string') {
    return null;
  }

  try {
    const url = new URL('v1/tracking-config', dashboardUrl);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

// --- The targets in force ----------------------------------------------------------------------------------------------------

// The table this Kit=Code bundles, in the document's words: the milestone table in force (integration-spec.mjs, MILESTONE_TABLE).
export const BUNDLED_TRACKING_CONFIG = Object.freeze({
  issuedAt: null,
  milestones: Object.freeze([...NGHIXAHOI_REWARD_TIERS, ...NGHIXAHOI_DISPLAY_MILESTONES]
    .map(({percent, requiredSeconds, requiredEquals}) => Object.freeze({percent, focusSeconds: requiredSeconds, equals: requiredEquals}))),
  campaignEndsAt: null,
});

// What the tracker took this run: {config, document}. Only the tracker's loop sets it, once a document is taken; nothing else in
// any process does.
let held = null;
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

// The last good copy on disk, {document, issuedAt, milestones, campaignEndsAt, receivedAt}, its words checked against the shape and
// the bounds, not its signature; null when there is none, or it cannot be read, or its words are not a tracking config's. Never
// throws, never writes: a copy that is not one is left as it is, and the bundled table counts.
export function readSavedTrackingConfig() {
  const identity = fileIdentity(TRACKING_CONFIG_PATH);

  if (identity === savedRead.identity) {
    return savedRead.copy;
  }

  let copy = null;

  try {
    const stored = JSON.parse(fs.readFileSync(TRACKING_CONFIG_PATH, 'utf8'));
    const judged = isObject(stored)
      ? judgeTrackingConfig({v: 1, issuedAt: stored.issuedAt, milestones: stored.milestones, campaignEndsAt: stored.campaignEndsAt})
      : {ok: false};

    if (judged.ok) {
      copy = {
        document: typeof stored.document === 'string' ? stored.document : null,
        ...judged.config,
        receivedAt: typeof stored.receivedAt === 'string' ? stored.receivedAt : null,
      };
    }
  } catch {
    copy = null;
  }

  savedRead = {identity, copy};
  return copy;
}

// Writes the last good copy: the document as it came, its words, and when this tracker took it. Whole, 0600; throws what the write
// throws, and the copy before stays as it was.
export function saveTrackingConfig({config, document}, receivedAt = new Date()) {
  fs.mkdirSync(STORE_DIR, {recursive: true});
  const copy = {document, issuedAt: config.issuedAt, milestones: config.milestones, campaignEndsAt: config.campaignEndsAt, receivedAt: receivedAt.toISOString()};
  writeFileAtomically(TRACKING_CONFIG_PATH, `${JSON.stringify(copy, null, 2)}\n`, {mode: FILE_MODE});
}

// Whether this build fetches, worked out once: the key and the address are the build's own, and never change while it runs.
let fetches;

function buildFetches() {
  fetches ??= trackingConfigUrl() !== null;
  return fetches;
}

// The targets and the end in force now: {source, issuedAt, milestones, campaignEndsAt}, `source` 'server' for the document this
// tracker took this run, 'saved' for the last good copy, 'bundled' for the table this Kit=Code bundles; `milestones` in the
// document's words, {percent, focusSeconds, equals}. A build that never fetches counts by the bundled table alone.
export function trackingConfigInForce() {
  if (!buildFetches()) {
    return {source: 'bundled', ...BUNDLED_TRACKING_CONFIG};
  }

  if (held !== null) {
    return {source: 'server', ...held.config};
  }

  const saved = readSavedTrackingConfig();

  if (saved !== null) {
    return {source: 'saved', issuedAt: saved.issuedAt, milestones: saved.milestones, campaignEndsAt: saved.campaignEndsAt};
  }

  return {source: 'bundled', ...BUNDLED_TRACKING_CONFIG};
}

// Whether the campaign has ended by `now`, the user's clock: an end set, and reached.
export function campaignEnded(config, now = Date.now()) {
  return typeof config?.campaignEndsAt === 'string' && Date.parse(config.campaignEndsAt) <= now;
}

// For this repository's tests alone: forgets what this process took, as a tracker that has just started.
export function forgetHeldTrackingConfig() {
  held = null;
  savedRead = {identity: null, copy: null};
}

// --- The fetch ---------------------------------------------------------------------------------------------------------------

// The body, at most `limit` bytes, or null past it: a length declared above it is refused before a byte is read, and a body
// that grows past it is cancelled as it does. Since 2026-10-30 the newest version's fetch reads its body with it too
// (newest-version.mjs).
export async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const {done, value} = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

// One try: one GET of `url`, with no redirect followed, no cookie, and nothing of this install, the user or this Kit=Code's version
// in it; `timeoutMs` for the whole answer. The document is judged against what this tracker holds, `current`, {config, document}
// or null. Returns {outcome: 'taken', config, document}; {outcome: 'unchanged'}, the very document `current` holds, fetched again;
// {outcome: 'refused', problem, status?}, an answer that is not a document to take, for the first of: 'status', not 200 (a
// redirect among them); 'oversized', a body over 2 KiB; the reader's problems; or {outcome: 'failed', problem}: 'timeout', or
// 'unreachable'. Never throws.
export async function fetchTrackingConfig({url, publicKey, current = null, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, signal} = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  try {
    const response = await fetchImpl(url, {method: 'GET', redirect: 'manual', credentials: 'omit', signal: abort});

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return {outcome: 'refused', problem: 'status', status: response.status};
    }

    const text = await readLimited(response, MAX_TRACKING_CONFIG_LENGTH);

    if (text === null) {
      return {outcome: 'refused', problem: 'oversized'};
    }

    if (current !== null && text === current.document) {
      return {outcome: 'unchanged'};
    }

    const read = readTrackingConfig(text, publicKey, {after: current?.config.issuedAt ?? null});
    return read.ok ? {outcome: 'taken', config: read.config, document: text} : {outcome: 'refused', problem: read.problem};
  } catch (error) {
    return {outcome: 'failed', problem: deadline.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'unreachable'};
  }
}

// What a try did, for tracker.log: fixed words, the address and the instants alone.
function describeTry(result, url, inForce) {
  const kept = `Kit=Code keeps the targets it had (${inForce.source}${inForce.issuedAt ? `, issued ${inForce.issuedAt}` : ''})`;

  switch (result.outcome) {
    case 'taken':
      return `took the campaign's targets issued ${result.config.issuedAt} from ${url}${result.config.campaignEndsAt ? `, the campaign ending ${result.config.campaignEndsAt}` : ', no end set'}.`;
    case 'unchanged':
      return `the campaign's targets from ${url} are unchanged (issued ${inForce.issuedAt}).`;
    case 'refused':
      return `refused the answer from ${url} (${result.problem}${result.status === undefined ? '' : ` ${result.status}`}); ${kept}.`;
    default:
      return `could not fetch the campaign's targets from ${url} (${result.problem}); ${kept}.`;
  }
}

// While the tracker runs (bin/nghixahoi.mjs, runDaemon): the fetches, as above, each try alone, and none of them able to stop, block or
// slow the tracker; every failure stays here, in tracker.log. A document taken is saved, then held: the tracker counts by it at once.
// In a build that never fetches it does nothing. `now`, the wall clock, which tells a sleep from a minute; `random`, for the first
// fetch's moment. Returns {stop, tryNow}: `stop` ends the loop and any try under way; `tryNow`, a try at once, for tests.
//
// `alongside`, since 2026-10-30 (web/7-update-notice): what else the try fetches, after the tracking config and whatever became of it,
// given the loop's abort signal: the newest version (newest-version.mjs, tryNewestVersion), which the tracker fetches with the
// tracking config, never in the config itself. Whatever it does or throws stays with it: the try's result is the tracking config's.
export function startTrackingConfigLoop({log = SILENT_LOG, fetchImpl = globalThis.fetch, now = () => Date.now(), random = Math.random, url = trackingConfigUrl(), publicKey = trackingConfigKey(), timeoutMs = FETCH_TIMEOUT_MS, alongside = null} = {}) {
  if (url === null || publicKey === null) {
    return {stop: async () => {}, tryNow: async () => ({outcome: 'disabled'})};
  }

  const controller = new AbortController();
  let lastTry = null;
  let lastCheck = now();
  let trying = null;
  let stopped = false;

  // The copy this try is judged against: what this run took, or the last good copy, whose issuedAt a document must be later than.
  const current = () => {
    if (held !== null) {
      return held;
    }

    const saved = readSavedTrackingConfig();
    return saved === null ? null : {config: {issuedAt: saved.issuedAt, milestones: saved.milestones, campaignEndsAt: saved.campaignEndsAt}, document: saved.document};
  };

  const attempt = async () => {
    const before = current();
    const result = await fetchTrackingConfig({url, publicKey, current: before, fetchImpl, timeoutMs, signal: controller.signal});

    if (result.outcome === 'taken' || result.outcome === 'unchanged') {
      const taken = result.outcome === 'taken' ? {config: result.config, document: result.document} : before;
      const saved = readSavedTrackingConfig();

      // Saved first, unless the copy on disk is this one already; held whatever the save does, so that the tracker counts by what
      // it checked, and a save that failed is tried again at the next try.
      if (saved === null || saved.document !== taken.document) {
        try {
          saveTrackingConfig(taken, new Date(now()));
        } catch (error) {
          log.warn(`Kit=Code could not save the campaign's targets to ${TRACKING_CONFIG_DISPLAY_PATH} (${error?.code ?? error?.name ?? 'error'}); it counts by them until it stops, and tries again at its next fetch.`);
        }
      }

      held = taken;
    }

    (result.outcome === 'taken' ? log.info : result.outcome === 'unchanged' ? () => {} : log.warn)(describeTry(result, url.href, trackingConfigInForce()));
    return result;
  };

  const tryNow = () => {
    if (trying !== null) {
      return trying;
    }

    lastTry = now();
    trying = attempt().catch(() => ({outcome: 'failed', problem: 'error'})).then(async (result) => {
      if (alongside !== null && !stopped) {
        try {
          await alongside({signal: controller.signal});
        } catch {
          // Its own to report: the tracking config's try is done, and its result stands.
        }
      }

      return result;
    }).finally(() => {
      trying = null;
    });
    return trying;
  };

  const first = setTimeout(() => {
    if (!stopped && lastTry === null) {
      tryNow();
    }
  }, FIRST_FETCH_MS.min + Math.floor(random() * (FIRST_FETCH_MS.max - FIRST_FETCH_MS.min + 1)));

  const check = setInterval(() => {
    const at = now();
    const woke = at - lastCheck >= WOKE_AFTER_MS;
    lastCheck = at;

    if (stopped || trying !== null) {
      return;
    }

    // Before the first try, only a wake brings it forward. After it: a try over an hour old, a wake, or a clock moved back past it.
    if (lastTry === null ? woke : woke || at - lastTry > FETCH_AGAIN_AFTER_MS || at < lastTry) {
      tryNow();
    }
  }, CHECK_EVERY_MS);

  first.unref?.();
  check.unref?.();

  return {
    tryNow,
    async stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(check);
      controller.abort();
      await trying?.catch(() => {});
    },
  };
}
