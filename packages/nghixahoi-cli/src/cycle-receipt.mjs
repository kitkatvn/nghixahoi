import crypto from 'node:crypto';

// A cycle receipt (docs/backend.md, "The cycle receipt"; the plan of 2026-10-21, phase 2): what the claim backend signs once it
// has issued a voucher, and the dashboard hands to this tracker, so that the tracker begins the next cycle, whose milestones
// count fresh from that moment (decision 1). Its words are the server's: the install id the claim's bundle carried, the cycle
// the server counted for it, the claim's id and when its voucher was issued, signed with an Ed25519 key that exists on the
// claim backend's server alone. This file only reads one, with the matching public key, which a tester build carries
// (integration-spec.mjs, CYCLE_RECEIPT_PUBLIC_KEY). Pure: it reads no file, keeps nothing, and asks nothing of the network;
// whether the receipt is this install's, and of the cycle it is in, is the caller's to judge, against the record
// (milestones-reached.mjs, beginNextCycle).
//
//   <payload>.<signature>
//
// `payload` is base64url (no padding) of the UTF-8 JSON {"v":1,"installId":…,"cycle":…,"claimId":…,"issuedAt":…}, those five
// fields alone; `signature`, base64url of the 64-byte Ed25519 signature of the ASCII text `nghixahoi-cycle-receipt-1.` followed
// by `payload` as it stands. The signature is checked over the bytes as they came, before anything in them is read: nothing is
// put in a canonical form, and no field the server did not sign is read. The text names what it is, so that the key signs
// nothing else that could pass for one. The server's side is apps/api/src/cycle-receipts.ts.

export const CYCLE_RECEIPT_CONTEXT = 'nghixahoi-cycle-receipt-1.';

// The longest text read: a receipt is about 300 characters.
export const MAX_CYCLE_RECEIPT_LENGTH = 1024;

const RECEIPT_TEXT = /^([A-Za-z0-9_-]{16,900})\.([A-Za-z0-9_-]{86})$/u;
const PUBLIC_KEY_TEXT = /^[A-Za-z0-9_-]{43}$/u;
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PAYLOAD_KEYS = ['v', 'installId', 'cycle', 'claimId', 'issuedAt'];

function isInstant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) {
    return false;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

// The public key a build carries: base64url of its 32 raw bytes, the JWK's `x`. Null when it is not one.
export function cycleReceiptKey(text) {
  if (typeof text !== 'string' || !PUBLIC_KEY_TEXT.test(text)) {
    return null;
  }

  try {
    const key = crypto.createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x: text}, format: 'jwk'});
    return key.asymmetricKeyType === 'ed25519' && key.export({format: 'jwk'}).x === text ? key : null;
  } catch {
    return null;
  }
}

// Reads `text` with `publicKey` (a KeyObject, cycleReceiptKey's): {ok: true, receipt: {installId, cycle, claimId, issuedAt}},
// or {ok: false, problem}: 'unreadable', not the shape of a receipt, or its signed words not a receipt's; 'signature', not
// signed with the key's pair.
export function readCycleReceipt(text, publicKey) {
  const parts = typeof text === 'string' && text.length <= MAX_CYCLE_RECEIPT_LENGTH ? RECEIPT_TEXT.exec(text) : null;

  if (parts === null) {
    return {ok: false, problem: 'unreadable'};
  }

  const [, payload, signature] = parts;
  let signed;

  try {
    signed = crypto.verify(null, Buffer.from(`${CYCLE_RECEIPT_CONTEXT}${payload}`, 'ascii'), publicKey, Buffer.from(signature, 'base64url'));
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

  const shaped = words !== null && typeof words === 'object' && !Array.isArray(words)
    && Object.keys(words).length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => Object.hasOwn(words, key))
    && words.v === 1
    && typeof words.installId === 'string' && INSTALL_ID.test(words.installId)
    && Number.isSafeInteger(words.cycle) && words.cycle >= 1
    && typeof words.claimId === 'string' && CLAIM_ID.test(words.claimId)
    && isInstant(words.issuedAt);

  return shaped
    ? {ok: true, receipt: {installId: words.installId, cycle: words.cycle, claimId: words.claimId, issuedAt: words.issuedAt}}
    : {ok: false, problem: 'unreadable'};
}
