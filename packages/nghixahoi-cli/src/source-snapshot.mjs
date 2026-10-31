import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {gitArrival, ignoredPaths, listRepositoryFiles} from './git.mjs';

// Folders never read, at any depth (docs/reward-rules.md §5.4): version control, dependencies and
// build output, and tool caches. Unity writes Library, Temp, Logs and obj; the rest are PHP and Go
// vendoring, Python environments and bytecode, Rust and Maven output, Gradle, CocoaPods, Turborepo
// and generic caches.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'Library',
  'Temp',
  'Logs',
  'obj',
  'vendor',
  '.venv',
  'venv',
  'target',
  '__pycache__',
  '.gradle',
  'Pods',
  '.turbo',
  '.cache',
]);
// SSH key files, whatever follows the name: .pub, -cert.pub, _sk, a backup's .old (operator decision,
// 2026-09-24). Until then every file named id_* was left out, source such as id_utils.js included.
const SSH_KEY_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
// Files a tool writes, whose lines would otherwise pass the real-code-line test: lockfiles (a base64
// integrity value ends in ==, so installing a dependency earned =), minified files and source maps
// (operator decision, 2026-09-24; docs/reward-rules.md §5.4). Names in lower case.
const LOCKFILE_NAMES = new Set([
  // JavaScript
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  // PHP, Rust, Ruby, Python, Go, Elixir, Dart, CocoaPods, NuGet, Gradle, Nix
  'composer.lock', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'go.sum', 'mix.lock',
  'pubspec.lock', 'podfile.lock', 'packages.lock.json', 'gradle.lockfile', 'flake.lock',
]);
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.map'];
const MAX_FILE_BYTES = 1024 * 1024;

// A snapshot's format (docs/reward-rules.md §5.2). Format 1, which Kit=Code wrote until 2026-09-25,
// keyed each line by its whole sha256, 64 hex characters. Format 2 keys it by the first 16, and
// records the counting rules the snapshot was taken under.
export const SNAPSHOT_FORMAT = 2;
const LINE_KEY_LENGTH = 16;
const FULL_KEY = /^[0-9a-f]{64}$/;
const LINE_KEY = /^[0-9a-f]{16}$/;

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// At least 4 word characters ([A-Za-z0-9_]), and more than 40 % of the line.
function isRealCodeLine(line) {
  let wordChars = 0;

  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);

    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) {
      wordChars += 1;
    }
  }

  return wordChars >= 4 && wordChars > line.length * 0.4;
}

function countEquals(line) {
  return line.match(/=/g)?.length ?? 0;
}

// The most = one line earns, since rules version 2 (operator decision Q3, 2026-09-25).
const MAX_EQUALS_PER_LINE = 3;

// A line as rules version 2 compares it (operator decision Q3, 2026-09-25; docs/reward-rules.md §5.1):
// every whitespace character removed, the quotes " and ` written as ', and one trailing ; or ,
// dropped. Re-indenting, re-spacing and re-quoting a line, and the ; or , a formatter adds or takes
// away, leave it the same line.
function normalizeLine(line) {
  return line.replace(/\s+/g, '').replace(/["`]/g, '\'').replace(/[;,]$/, '');
}

// The counting rules, by version (docs/reward-rules.md §5). A snapshot records the version it was
// taken under, and a scan is compared only with a snapshot taken under the same rules: a change of
// rules goes through the rules switch (runtime.mjs switchProjectRules, §5.6). Each set says how a
// line is normalised before anything else looks at it (none: its exact text), its key, whether it
// counts, the = it earns, and whether it earns them once per user, ever (`oncePerUser`), or once per
// copy added.
export const RULES = Object.freeze({
  // Version 1, the rules of 0.1.39, and of this code until hardening phase 2: a line is its exact
  // text, it counts when it passes the real-code-line test, and every = on it counts, for every copy.
  1: Object.freeze({
    version: 1,
    lineKey: (line) => hashValue(line).slice(0, LINE_KEY_LENGTH),
    isCountedLine: isRealCodeLine,
    equalsOn: countEquals,
  }),
  // Version 2 (operator decision Q3, 2026-09-25): a line is its normalised text, it counts when that
  // passes the real-code-line test, at most 3 of its = count, and they count once per user, ever,
  // across every project: against ~/.nghixahoi/seen-lines (applySourceScan).
  2: Object.freeze({
    version: 2,
    normalize: normalizeLine,
    lineKey: (line) => hashValue(line).slice(0, LINE_KEY_LENGTH),
    isCountedLine: isRealCodeLine,
    equalsOn: (line) => Math.min(MAX_EQUALS_PER_LINE, countEquals(line)),
    oncePerUser: true,
  }),
});
export const RULES_VERSION = 2;
const CURRENT_RULES = RULES[RULES_VERSION];

export function emptySnapshot(rulesVersion = RULES_VERSION) {
  return {version: SNAPSHOT_FORMAT, rulesVersion, files: {}};
}

// A snapshot that cannot be counted against: damaged, or written by a newer Kit=Code (`newer`).
export class SnapshotError extends Error {
  constructor(message, {newer = false} = {}) {
    super(message);
    this.name = 'SnapshotError';
    this.newer = newer;
  }
}

function snapshotFormat(snapshot) {
  return snapshot.version === undefined ? 1 : snapshot.version;
}

// The version of the rules `snapshot` was taken under, from its marks alone: a format 1 snapshot was
// taken under version 1. Throws a SnapshotError when the marks, or its files, are not what Kit=Code
// writes, or when they are newer than `newest`.
export function snapshotRules(snapshot, {newest = RULES_VERSION} = {}) {
  if (!isObject(snapshot)) {
    throw new SnapshotError('it is not an object');
  }

  const format = snapshotFormat(snapshot);

  if (format !== 1 && format !== SNAPSHOT_FORMAT) {
    throw Number.isSafeInteger(format) && format > SNAPSHOT_FORMAT
      ? new SnapshotError(`its format is ${format}, and this Kit=Code knows formats up to ${SNAPSHOT_FORMAT}`, {newer: true})
      : new SnapshotError(`its format, ${JSON.stringify(format)}, is not one Kit=Code writes`);
  }

  if (!isObject(snapshot.files)) {
    throw new SnapshotError('its files are not an object');
  }

  if (format === 1) {
    return 1;
  }

  const rules = snapshot.rulesVersion;

  if (!Number.isSafeInteger(rules) || rules < 1) {
    throw new SnapshotError(`its rules version, ${JSON.stringify(rules)}, is not one Kit=Code writes`);
  }

  if (rules > newest) {
    throw new SnapshotError(`it was taken under counting rules ${rules}, and this Kit=Code knows rules up to ${newest}`, {newer: true});
  }

  return rules;
}

// `snapshot` in this version's format, checked line by line. One an older Kit=Code wrote, format 1, is
// converted by cutting each line key to its first 16 characters: every line keeps its identity, so
// the conversion counts nothing and loses nothing. Two keys of one file that then coincide become one,
// with their counts added (`collisions` says how many). A format 2 snapshot comes back as it is.
// Fields this version does not know are kept. Throws a SnapshotError when a key or a count is not what
// Kit=Code writes.
export function convertSnapshot(snapshot, {newest = RULES_VERSION} = {}) {
  snapshotRules(snapshot, {newest});
  const format = snapshotFormat(snapshot);
  const keyPattern = format === 1 ? FULL_KEY : LINE_KEY;
  const files = {};
  let collisions = 0;

  for (const [fileKey, entry] of Object.entries(snapshot.files)) {
    if (!isObject(entry) || !isObject(entry.lineCounts)) {
      throw new SnapshotError(`the line map of file ${fileKey.slice(0, LINE_KEY_LENGTH)}… is not an object`);
    }

    const lineCounts = {};

    for (const [key, count] of Object.entries(entry.lineCounts)) {
      if (!keyPattern.test(key)) {
        throw new SnapshotError(`its line key ${JSON.stringify(key)} is not ${format === 1 ? 'a 64-character sha256' : 'the 16 hexadecimal characters of a line key'}`);
      }

      if (!Number.isSafeInteger(count) || count < 1) {
        throw new SnapshotError(`the count of its line ${key.slice(0, LINE_KEY_LENGTH)} is ${JSON.stringify(count)}, not a whole number above 0`);
      }

      const lineKey = key.slice(0, LINE_KEY_LENGTH);
      collisions += Object.hasOwn(lineCounts, lineKey) ? 1 : 0;
      lineCounts[lineKey] = (lineCounts[lineKey] ?? 0) + count;
    }

    files[fileKey] = {...entry, lineCounts};
  }

  if (format === SNAPSHOT_FORMAT) {
    return {snapshot, converted: false, collisions: 0};
  }

  const {version, rulesVersion, files: formerFiles, ...rest} = snapshot;
  return {snapshot: {version: SNAPSHOT_FORMAT, rulesVersion: 1, files, ...rest}, converted: true, collisions};
}

// Every line key in `snapshot`, of every file, or of the files `fileKeys` names.
export function snapshotLineKeys(snapshot, fileKeys = null) {
  return Object.entries(snapshot.files)
    .filter(([fileKey]) => !fileKeys || fileKeys.has(fileKey))
    .flatMap(([, entry]) => Object.keys(entry.lineCounts));
}

// The line maps state.json writes on one line each: those of snapshots in this version's format
// (store.mjs). An older snapshot is written as it always was, two spaces a level, until it is converted.
export function lineMapsWrittenOnOneLine(state) {
  const maps = new Set();

  for (const project of Object.values(isObject(state?.projects) ? state.projects : {})) {
    const snapshot = project?.sourceSnapshot;

    if (isObject(snapshot) && snapshot.version === SNAPSHOT_FORMAT && isObject(snapshot.files)) {
      for (const entry of Object.values(snapshot.files)) {
        if (isObject(entry?.lineCounts)) {
          maps.add(entry.lineCounts);
        }
      }
    }
  }

  return maps;
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function safeRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

// True when a folder on the way from `root` to `relativePath` is a symbolic link. The OS follows a
// link in a non-final path component during resolution, so a listing such as git's index can name a
// file under a linked folder that resolves outside the project. Only components below `root` are
// checked, so a symlink standing above the project root (a /tmp that points at /private/tmp) is not
// mistaken for one inside it. A linked file itself is caught by lstat in readSourceEntry.
function pathCrossesSymlink(root, relativePath) {
  const parts = String(relativePath).split('/').filter(Boolean);
  let current = root;

  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);

    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function fileKeyForRelative(relativePath) {
  return hashValue(relativePath);
}

// Files whose contents are never read or hashed, and whose paths are never stored: .env files,
// certificates and keys, and SSH keys (docs/security.md, "The state file"). Matched on the file's
// own name, in any case.
export function isSecretFileName(name) {
  const lower = String(name).toLowerCase();

  return lower.startsWith('.env') || lower.endsWith('.pem') || lower.endsWith('.key') || SSH_KEY_NAMES.some((key) => lower.startsWith(key));
}

// Lockfiles, minified files and source maps: never counted, and a change to one is not activity.
// Matched on the file's own name, in any case.
export function isGeneratedFileName(name) {
  const lower = String(name).toLowerCase();

  return LOCKFILE_NAMES.has(lower) || GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function shouldIgnoreRelativePath(relativePath) {
  const parts = String(relativePath).split(/[\\/]+/).filter(Boolean);

  return parts.some((part) => IGNORED_DIRS.has(part))
    || (parts.length > 0 && (isSecretFileName(parts.at(-1)) || isGeneratedFileName(parts.at(-1))));
}

// Every file under `root` a scan may read, without git: ignored folders are not entered, and
// symbolic links, to files or to folders, are skipped. A folder that cannot be listed is left out,
// unless the failure may be passing (too many open files, an I/O error): then the walk throws, so
// that a scan never mistakes a failed listing for deleted files.
function walkFiles(root, current = root, files = []) {
  let entries;

  try {
    entries = fs.readdirSync(current, {withFileTypes: true});
  } catch (error) {
    if (current !== root && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
      return files;
    }

    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFiles(root, fullPath, files);
      }
    } else if (entry.isFile() && !isSecretFileName(entry.name)) {
      files.push(safeRelative(root, fullPath));
    }
  }

  return files;
}

// The files of a project, relative to its root. In a Git project these are the files git lists:
// tracked, or untracked and not ignored, so .gitignore is honoured. Throws when they cannot be
// listed; a scan must then leave the snapshot as it is.
export function listProjectFiles(root, {sourceType = 'vibe'} = {}) {
  if (!fs.statSync(root).isDirectory()) {
    throw Object.assign(new Error(`${root} is not a folder`), {code: 'ENOTDIR'});
  }

  const files = sourceType === 'git' ? listRepositoryFiles(root, [...IGNORED_DIRS]) : walkFiles(root);
  return files.filter((relativePath) => !shouldIgnoreRelativePath(relativePath));
}

// The file keys of what a full scan of `root` would list now, or null when it cannot be listed.
export function listedFileKeys(root, {sourceType = 'vibe'} = {}) {
  try {
    return new Set(listProjectFiles(root, {sourceType}).map(fileKeyForRelative));
  } catch {
    return null;
  }
}

// Each counted line of `source`, normalised and keyed as `rules` normalise and key it, with how often
// it occurs, and the = on it. Two lines with one key (the same text, or text that differs only in what
// the rules ignore) are one line: their counts are added, and the = are those of the first.
function lineCountsForSource(source, rules) {
  const counts = new Map();

  for (const text of source.split(/\r?\n/)) {
    const line = rules.normalize ? rules.normalize(text) : text;

    if (rules.isCountedLine(line)) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const lineCounts = {};
  const equalsByHash = {};

  for (const [line, count] of counts) {
    const lineKey = rules.lineKey(line);
    lineCounts[lineKey] = (lineCounts[lineKey] ?? 0) + count;
    equalsByHash[lineKey] ??= rules.equalsOn(line);
  }

  return {equalsByHash, lineCounts};
}

// One file's text, read for a scan. A symbolic link is never followed, in any scan: not the file
// itself (lstat rejects it, since a link is not a regular file), and, when `checkPath` is set, not a
// folder on its path either (pathCrossesSymlink), since a listing may name a file under a linked
// folder that resolves outside the project. Files over 1 MiB, binary files and files that are gone
// come back `missing`. `checkPath` is by component, not by comparing resolved paths, so a case-only
// difference on a case-insensitive filesystem (git tracks Foo.js, the disk holds foo.js) is still read.
function readSourceText(root, relativePath, {checkPath = false} = {}) {
  const fileKey = fileKeyForRelative(relativePath);
  const missing = {relativePath, fileKey, missing: true};

  if (checkPath && pathCrossesSymlink(root, relativePath)) {
    return missing;
  }

  const fullPath = path.join(root, relativePath);
  let stat;

  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return missing;
  }

  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return missing;
  }

  let buffer;

  try {
    buffer = fs.readFileSync(fullPath);
  } catch {
    return missing;
  }

  if (isBinary(buffer)) {
    return missing;
  }

  return {relativePath, fileKey, text: buffer.toString('utf8')};
}

// One file, read for a scan and counted under `rules`: see readSourceText for what is never read.
export function readSourceEntry(root, relativePath, {checkPath = false, rules = CURRENT_RULES} = {}) {
  const source = readSourceText(root, relativePath, {checkPath});

  return source.missing ? source : {relativePath, fileKey: source.fileKey, ...lineCountsForSource(source.text, rules)};
}

function normalizeChangedPath(root, changedPath) {
  const relativePath = safeRelative(root, path.resolve(root, String(changedPath)));

  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? relativePath : null;
}

// What a read made under `rules` says about itself: the version, and, under rules that credit a line
// once per user, `oncePerUser`, so that the scan is credited as those rules say (applySourceScan).
function readUnder(rules, complete) {
  return {complete, rulesVersion: rules.version, ...(rules.oncePerUser ? {oncePerUser: true} : {}), files: []};
}

// Reads a project for a scan, counted under `rules`, without touching any snapshot. With
// `changedPaths`, only those files: a path an ignore rule now matches comes back `missing` and
// `ignored`, so its old entry is dropped. Without, every file: `complete`, and files it did not list
// are gone from the snapshot. The read carries its `rulesVersion`. Throws when the project cannot be
// listed.
export function readProjectSources(root, {sourceType = 'vibe', changedPaths = null, rules = CURRENT_RULES} = {}) {
  if (!Array.isArray(changedPaths)) {
    return readProjectSourcesUnder(root, {sourceType, rules: [rules]})[0];
  }

  const candidates = [...new Set(changedPaths.map((changedPath) => normalizeChangedPath(root, changedPath)).filter(Boolean))]
    .filter((relativePath) => !shouldIgnoreRelativePath(relativePath));
  const ignored = new Set(sourceType === 'git' ? ignoredPaths(root, candidates) : []);

  return {
    ...readUnder(rules, false),
    files: candidates.map((relativePath) => (
      ignored.has(relativePath)
        ? {relativePath, fileKey: fileKeyForRelative(relativePath), missing: true, ignored: true}
        : readSourceEntry(root, relativePath, {checkPath: true, rules})
    )),
  };
}

// Every file of a project, listed once and read once, and counted under each of `rules`: one complete
// read per set of rules, all of the same content. The rules switch needs a read under the old rules
// and one under the new that no edit can fall between.
export function readProjectSourcesUnder(root, {sourceType = 'vibe', rules}) {
  const reads = rules.map((ruleSet) => readUnder(ruleSet, true));

  // A Git project's listing (git ls-files) is trusted for which files exist, but not for where they
  // resolve: checkPath drops any path that crosses a symlinked folder. A vibe walk already skips
  // links, so checkPath only confirms it there.
  for (const relativePath of listProjectFiles(root, {sourceType})) {
    const source = readSourceText(root, relativePath, {checkPath: true});

    if (!source.missing) {
      rules.forEach((ruleSet, index) => {
        reads[index].files.push({relativePath, fileKey: source.fileKey, ...lineCountsForSource(source.text, ruleSet)});
      });
    }
  }

  return reads;
}

// `read` made, then checked against git in a Git project (docs/reward-rules.md §5.8; operator decision
// Q2, 2026-09-25): git is asked what can have arrived through it since `since`, the position the last
// scan recorded (git.mjs gitArrival). When anything can have, the read is a baseline, and `baseline`
// says why. When HEAD moved some other way than by the user's own commit, or the reflog cannot say
// how it got where it is, the whole project is read again with `readAll`, after git was asked: a file
// git wrote after the first read of it, or whose change this scan was not told of, is in it then. Each
// read carries `git`, the position now, for the snapshot to record. A folder project's read is left as
// it is.
//
// A read in which git did anything but the user's own commits carries `gitOperation`: what it found
// changed is git's, and not activity (operator decision Q4, 2026-09-25). A baseline always does; so does
// a read after git acted without moving HEAD, as a stash does, which is read whole too, like a move, so
// that none of what git changed is left for a later scan to take for the user's. A read that is a
// baseline because an operation waits for the user carries `gitWaiting` too, the files git left for it,
// for the tracker's log (since 2026-10-01).
function checkedAgainstGit(root, sourceType, since, read, readAll) {
  const first = read();

  if (sourceType !== 'git') {
    return first;
  }

  const {arrival, operation, position, waiting} = gitArrival(root, since);
  const reads = arrival === 'moved' || arrival === 'unexplained' || (arrival === null && operation) ? readAll() : first;
  const mark = (entry) => ({
    ...entry,
    git: position,
    ...(arrival ? {baseline: arrival} : {}),
    ...(waiting ? {gitWaiting: waiting} : {}),
    ...(operation ? {gitOperation: true} : {}),
  });

  return Array.isArray(reads) ? reads.map(mark) : mark(reads);
}

// readProjectSources, checked against git (checkedAgainstGit): what a scan reads.
export function readProjectScan(root, {sourceType = 'vibe', changedPaths = null, rules = CURRENT_RULES, since} = {}) {
  return checkedAgainstGit(
    root,
    sourceType,
    since,
    () => readProjectSources(root, {sourceType, changedPaths, rules}),
    () => readProjectSources(root, {sourceType, rules}),
  );
}

// readProjectSourcesUnder, checked against git: what the rules switch reads. When one read is a
// baseline, every one is.
export function readProjectScanUnder(root, {sourceType = 'vibe', rules, since}) {
  const readAll = () => readProjectSourcesUnder(root, {sourceType, rules});
  return checkedAgainstGit(root, sourceType, since, readAll, readAll);
}

// A snapshot in this version's format, for a scan to be folded into: one in format 1 is converted
// (convertSnapshot). A format 2 snapshot is taken as it is, and one with no files as empty.
function currentSnapshot(snapshot, rulesVersion) {
  if (isObject(snapshot) && snapshotFormat(snapshot) === 1 && isObject(snapshot.files)) {
    return convertSnapshot(snapshot).snapshot;
  }

  return {
    ...(isObject(snapshot) ? snapshot : {}),
    version: SNAPSHOT_FORMAT,
    rulesVersion: isObject(snapshot) && snapshot.rulesVersion !== undefined ? snapshot.rulesVersion : rulesVersion,
    files: isObject(snapshot?.files) ? snapshot.files : {},
  };
}

function sameCounts(left = {}, right = {}) {
  const leftKeys = Object.keys(left);

  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

function lineCountsChanged(previousCounts = {}, nextCounts = {}) {
  return !sameCounts(previousCounts, nextCounts);
}

// Whether a file's snapshot entry holds any counted line.
function hasLines(entry) {
  return isObject(entry?.lineCounts) && Object.keys(entry.lineCounts).length > 0;
}

// Whether two snapshots' files hold the same lines, as often.
export function sameSnapshotFiles(left, right) {
  const fileKeys = Object.keys(left);

  return fileKeys.length === Object.keys(right).length
    && fileKeys.every((fileKey) => Object.hasOwn(right, fileKey) && sameCounts(left[fileKey]?.lineCounts, right[fileKey]?.lineCounts));
}

// The = on the lines whose count went up, and those lines' keys. Each copy added earns the line's =,
// unless `once` is given, for rules that credit a line once per user, ever: then a line earns once,
// however many copies were added, and only if it is new to this file, not credited earlier in this
// scan (`once.credited`), and not `once.seen` before, in any file of any project.
function countAddedEquals(previousCounts, equalsByHash, lineCounts, addedKeys, once) {
  let equalsAdded = 0;

  for (const [lineHash, currentCount] of Object.entries(lineCounts)) {
    const before = previousCounts[lineHash] ?? 0;

    if (currentCount <= before) {
      continue;
    }

    addedKeys.add(lineHash);

    if (!once) {
      equalsAdded += (currentCount - before) * (equalsByHash[lineHash] ?? 0);
    } else if (before === 0 && !once.credited.has(lineHash) && !once.seen(lineHash)) {
      once.credited.add(lineHash);
      equalsAdded += equalsByHash[lineHash] ?? 0;
    }
  }

  return equalsAdded;
}

// Whether two recorded git positions are the same (gitArrival).
function sameGitPosition(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// Folds a read into `stored`, the snapshot as it is now. It returns the next snapshot, the = on
// lines added since `stored`, the keys of those lines (`addedKeys`: every line of a new baseline), how
// many files changed, and `linesChanged`: the keys of the files whose normalised lines changed, lines
// added or removed, which is what activity is made of (operator decision Q4, 2026-09-25). A file whose
// lines are all the same after the read, however its text changed, is not among them, and neither is an
// empty file made or deleted. Only the scanner of record calls it: under the state lock, against the
// snapshot on disk, so that no two scans count the same line. The read must be under the rules the
// snapshot was taken under.
//
// A read made under rules that credit a line once per user asks `seen` whether a line has been seen
// before: the store's ~/.nghixahoi/seen-lines. Without it, the lines of `stored` are the lines seen. A
// read that is a `baseline` (checkedAgainstGit: code can have arrived through git) credits nothing,
// and its lines join the snapshot and seen-lines all the same. The read's git position, when it has
// one, is recorded on the snapshot (`gitMoved` says it changed).
//
// `base` is the snapshot the read started from. A file whose entry in `stored` differs from `base`
// was changed by another writer meanwhile, so the read may be older than that change: it is read
// again with `reread` rather than trusted, and in a full scan an entry it did not list is kept.
// Fields this version does not know, on the snapshot and on each file, are kept.
export function applySourceScan(stored, read, {base = stored, reread = null, seen = null} = {}) {
  const previous = currentSnapshot(stored, read.rulesVersion);

  if (previous.rulesVersion !== read.rulesVersion) {
    throw new Error(`A snapshot taken under counting rules ${previous.rulesVersion} cannot be compared with a scan under rules ${read.rulesVersion}.`);
  }

  const before = currentSnapshot(base, read.rulesVersion).files;
  const files = read.complete ? {} : {...previous.files};
  const listed = new Set();
  const addedKeys = new Set();
  let known = null;
  const once = read.oncePerUser
    ? {credited: new Set(), seen: seen ?? ((key) => (known ??= new Set(snapshotLineKeys(previous))).has(key))}
    : null;
  let equalsAdded = 0;
  let changedFiles = 0;
  const linesChanged = [];

  for (const readEntry of read.files) {
    const current = previous.files[readEntry.fileKey];
    const entry = reread && !readEntry.ignored && !sameCounts(current?.lineCounts, before[readEntry.fileKey]?.lineCounts)
      ? reread(readEntry.relativePath)
      : readEntry;
    listed.add(entry.fileKey);

    if (entry.missing) {
      if (current) {
        delete files[entry.fileKey];
        changedFiles += 1;

        // A file an ignore rule now matches leaves the snapshot, but its content did not change.
        if (hasLines(current) && !entry.ignored) {
          linesChanged.push(entry.fileKey);
        }
      }

      continue;
    }

    files[entry.fileKey] = {...(current && typeof current === 'object' ? current : {}), lineCounts: entry.lineCounts};
    equalsAdded += countAddedEquals(current?.lineCounts ?? {}, entry.equalsByHash, entry.lineCounts, addedKeys, once);

    if (lineCountsChanged(current?.lineCounts, entry.lineCounts)) {
      changedFiles += 1;
      linesChanged.push(entry.fileKey);
    }
  }

  if (read.complete) {
    for (const [fileKey, entry] of Object.entries(previous.files)) {
      if (listed.has(fileKey)) {
        continue;
      }

      if (reread && !sameCounts(entry?.lineCounts, before[fileKey]?.lineCounts)) {
        files[fileKey] = entry;
      } else {
        changedFiles += 1;

        if (hasLines(entry)) {
          linesChanged.push(fileKey);
        }
      }
    }
  }

  const git = read.git === undefined ? {} : {git: read.git};

  return {
    changedFiles,
    linesChanged,
    equalsAdded: read.baseline ? 0 : equalsAdded,
    addedKeys: [...addedKeys],
    gitMoved: read.git !== undefined && !sameGitPosition(previous.git, read.git),
    snapshot: {...previous, files, ...git},
  };
}

export function createSourceSnapshot(root, {sourceType = 'vibe', rules = CURRENT_RULES} = {}) {
  return applySourceScan(emptySnapshot(rules.version), readProjectScan(root, {sourceType, rules})).snapshot;
}

// A scan of `root` against `previousSnapshot`, checked against git in a Git project. `options.seen`
// says whether a line was seen before, as the store's seen-lines does; without it, the lines of
// `previousSnapshot` are the lines seen.
export function scanSourceChanges(root, previousSnapshot = emptySnapshot(), options = {}) {
  const read = readProjectScan(root, {
    sourceType: options.sourceType ?? 'vibe',
    changedPaths: Array.isArray(options.changedPaths) ? options.changedPaths : null,
    rules: options.rules ?? CURRENT_RULES,
    since: previousSnapshot?.git,
  });

  return applySourceScan(previousSnapshot, read, {seen: options.seen ?? null});
}
