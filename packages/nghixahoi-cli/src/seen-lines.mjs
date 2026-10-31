import fs from 'node:fs';
import {leftoverTempFiles, writeFileAtomically} from './atomic-file.mjs';

// The format of ~/.nghixahoi/seen-lines, every line Kit=Code has seen in any of the user's projects
// (docs/security.md, "The seen-lines file"). A line is the first 8 bytes of its sha256: its key in a
// snapshot, 16 hex characters, as bytes. The file is a 16-byte header, "KCSEEN01" and the number of
// lines as an unsigned 64-bit big-endian integer, then the lines, 8 bytes each, in ascending order and
// each once, so that a line is found by binary search. The store (store.mjs) reads and writes it,
// under the state lock.
const MAGIC = Buffer.from('KCSEEN01', 'latin1');
const HEADER_BYTES = 16;
const LINE_BYTES = 8;
const LINE_KEY = /^[0-9a-f]{16}$/;
const FILE_MODE = 0o600;

export const NO_SEEN_LINES = Buffer.alloc(0);

// Bytes that are not a seen-lines file.
export class SeenLinesFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeenLinesFormatError';
  }
}

function lineAt(lines, index) {
  return lines.subarray(index * LINE_BYTES, (index + 1) * LINE_BYTES);
}

// The lines of a seen-lines file, packed 8 bytes each and sorted, after checking the header, the
// length and the order. Throws a SeenLinesFormatError for anything else.
export function decodeSeenLines(bytes) {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SeenLinesFormatError('it does not start as a Kit=Code seen-lines file does');
  }

  const count = bytes.readBigUInt64BE(MAGIC.length);
  const held = bytes.length - HEADER_BYTES;

  if (BigInt(held) !== count * BigInt(LINE_BYTES)) {
    throw new SeenLinesFormatError(`its header names ${count} lines, and it holds ${held} bytes of lines`);
  }

  const lines = bytes.subarray(HEADER_BYTES);

  for (let index = 1; index < held / LINE_BYTES; index += 1) {
    if (Buffer.compare(lineAt(lines, index - 1), lineAt(lines, index)) >= 0) {
      throw new SeenLinesFormatError(`its lines are not in ascending order at line ${index + 1}`);
    }
  }

  return lines;
}

export function encodeSeenLines(lines) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeBigUInt64BE(BigInt(lines.length / LINE_BYTES), MAGIC.length);
  return Buffer.concat([header, lines]);
}

// The first line index at or after `from` whose line is not below `bytes`.
function lowerBound(lines, bytes, from = 0) {
  let low = from;
  let high = lines.length / LINE_BYTES;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (Buffer.compare(lineAt(lines, middle), bytes) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function keyBytes(key) {
  if (!LINE_KEY.test(key)) {
    throw new TypeError(`${JSON.stringify(key)} is not a line key of 16 hexadecimal characters`);
  }

  return Buffer.from(key, 'hex');
}

// Whether the line with snapshot key `key` is among `lines`.
export function hasSeenLine(lines, key) {
  const bytes = keyBytes(key);
  const index = lowerBound(lines, bytes);
  return index < lines.length / LINE_BYTES && lineAt(lines, index).equals(bytes);
}

// `lines` with the lines of `keys` among them, still sorted and each once. When every one is there
// already, `lines` itself comes back, so the caller can tell nothing was added.
export function addSeenLines(lines, keys) {
  const added = [...new Set(keys)].sort().map(keyBytes).filter((bytes) => {
    const index = lowerBound(lines, bytes);
    return !(index < lines.length / LINE_BYTES && lineAt(lines, index).equals(bytes));
  });

  if (added.length === 0) {
    return lines;
  }

  const merged = Buffer.alloc(lines.length + added.length * LINE_BYTES);
  let copied = 0;
  let written = 0;

  for (const bytes of added) {
    const index = lowerBound(lines, bytes, copied);
    written += lines.copy(merged, written, copied * LINE_BYTES, index * LINE_BYTES);
    written += bytes.copy(merged, written);
    copied = index;
  }

  lines.copy(merged, written, copied * LINE_BYTES);
  return merged;
}

// The lines in the file at `filePath`, or null when there is none. Throws a SeenLinesFormatError when
// the file is not a seen-lines file, and the read's own error when it cannot be read.
export function readSeenLinesFile(filePath) {
  let bytes;

  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  return decodeSeenLines(bytes);
}

// Writes `lines` to `filePath` atomically, 0600. Only under the state lock: a temporary file left
// next to it then belongs to a writer that died.
export function writeSeenLinesFile(filePath, lines) {
  for (const tempPath of leftoverTempFiles(filePath)) {
    fs.rmSync(tempPath, {force: true});
  }

  writeFileAtomically(filePath, encodeSeenLines(lines), {mode: FILE_MODE});
}
