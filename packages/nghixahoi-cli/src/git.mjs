import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {CLI_GLOBAL_COMMAND} from './integration-spec.mjs';

// A listing of a large repository is long; git's own limits apply, not Node's 1 MB default.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// `input` is written to git's stdin. Exit codes in `okStatus` besides 0 return stdout instead of
// throwing. GIT_OPTIONAL_LOCKS=0 keeps `git status` from rewriting the user's index, and from holding
// index.lock while the user runs git: Kit=Code only ever reads a repository.
export function runGit(repoRoot, args, {input, okStatus = [], trim = true} = {}) {
  let output;

  try {
    output = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      input,
      maxBuffer: GIT_MAX_BUFFER,
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    if (!okStatus.includes(error.status)) {
      throw error;
    }

    output = String(error.stdout ?? '');
  }

  return trim ? output.trim() : output;
}

export function detectRepoRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error(`Not inside a git repository. Run \`${CLI_GLOBAL_COMMAND} add\` from a project repo.`);
  }
}

export function tryDetectRepoRoot(cwd) {
  try {
    return detectRepoRoot(cwd);
  } catch {
    return null;
  }
}

export function readRemote(repoRoot) {
  try {
    return runGit(repoRoot, ['config', '--get', 'remote.origin.url']);
  } catch {
    return '';
  }
}

export function createProjectId(repoRoot) {
  return crypto.createHash('sha256').update(`${repoRoot}\n${readRemote(repoRoot)}`).digest('hex').slice(0, 16);
}

export function createFolderProjectId(folderRoot) {
  return crypto.createHash('sha256').update(`vibe\n${folderRoot}`).digest('hex').slice(0, 16);
}

export function countCommits(repoRoot) {
  try {
    return Number(runGit(repoRoot, ['rev-list', '--count', 'HEAD'])) || 0;
  } catch {
    return 0;
  }
}

// The worktrees of the repository at `repoRoot`, as `git worktree list --porcelain` names them, the main one first: each with its
// folder, and whether git calls it bare (a repository with no files of its own) or prunable (its folder, or its link to the
// repository, is gone). Throws when git cannot list them.
export function listWorktrees(repoRoot) {
  const worktrees = [];

  for (const line of runGit(repoRoot, ['worktree', 'list', '--porcelain'], {trim: false}).split('\n').map((text) => text.replace(/\r$/, ''))) {
    if (line.startsWith('worktree ')) {
      worktrees.push({path: line.slice('worktree '.length), bare: false, prunable: false});
    } else if (worktrees.length > 0 && line === 'bare') {
      worktrees.at(-1).bare = true;
    } else if (worktrees.length > 0 && (line === 'prunable' || line.startsWith('prunable '))) {
      worktrees.at(-1).prunable = true;
    }
  }

  return worktrees;
}

// `git status --porcelain=v1 -z`: each entry is two status letters, a space and a path, and a rename
// or a copy is followed by the path it came from. Paths come as they are, never quoted.
function statusEntries(output) {
  const fields = output.split('\0');
  const entries = [];

  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index].length < 4) {
      continue;
    }

    const entry = {text: fields[index], paths: [fields[index].slice(3)]};

    if (/[RC]/.test(fields[index].slice(0, 2)) && index + 1 < fields.length) {
      index += 1;
      entry.text += `\0${fields[index]}`;
      entry.paths.push(fields[index]);
    }

    entries.push(entry);
  }

  return entries;
}

// HEAD and the working tree's status: it changes when the user commits, checks out or stages. null
// when git cannot describe the repository, which is never activity. (Until 2026-09-24 a failure
// returned the time, so a repository with no commits yet looked changed at every poll.)
//
// An entry whose every path `isIgnored` matches is left out, so a change to a file the scanner does
// not read, such as a lockfile an install rewrote, is not activity either (since 2026-09-24). An
// untracked folder git shows as one entry is judged by the folder's own name.
export function getGitSignature(repoRoot, isIgnored = () => false) {
  let status;

  try {
    status = runGit(repoRoot, ['status', '--porcelain=v1', '-z'], {trim: false});
  } catch {
    return null;
  }

  let head = '';

  try {
    head = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    // No commits yet: there is no HEAD to name.
  }

  const seen = statusEntries(status).filter((entry) => !entry.paths.every((entryPath) => isIgnored(entryPath)));

  return `${head}\n${seen.map((entry) => entry.text).join('\0')}`;
}

function nulSeparated(output) {
  return [...new Set(output.split('\0').filter(Boolean))];
}

// The files git would show the user: tracked, and untracked but not ignored by .gitignore,
// .git/info/exclude or the user's global excludes. Paths are relative to the root, with `/`. Folders
// named in `excludeFolders` are not even walked. Throws when git cannot list the repository.
export function listRepositoryFiles(repoRoot, excludeFolders = []) {
  return nulSeparated(runGit(repoRoot, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    ...excludeFolders.map((folder) => `--exclude=${folder}/`),
  ], {trim: false}));
}

// The paths among `relativePaths` that the repository's ignore rules match. A tracked file is never
// ignored, as in git itself. Throws when git cannot check.
export function ignoredPaths(repoRoot, relativePaths) {
  if (relativePaths.length === 0) {
    return [];
  }

  return nulSeparated(runGit(repoRoot, ['check-ignore', '-z', '--stdin'], {
    input: `${relativePaths.join('\0')}\0`,
    okStatus: [1],
    trim: false,
  }));
}

// ---------------------------------------------------------------------------------------------------
// Code that arrives through git (docs/reward-rules.md §5.8; operator decision Q2, 2026-09-25). A scan of
// a Git project asks gitArrival what can have arrived through git since the last scan, from HEAD's
// reflog, and is a baseline when anything can have. The position it returns is recorded on the
// snapshot, so the scan that follows starts where this one ended: the tracker's 15 s git poll plays no
// part in it.

// The user's own commits, by the HEAD reflog's message: a commit, `commit: <subject>`; an amended one,
// `commit (amend): <subject>`; a repository's first, `commit (initial): <subject>`. With no subject git
// writes `commit:`. Every other message is another way HEAD moved: a pull, a merge, a checkout or a
// switch, a rebase, a reset, a cherry-pick, a revert, am, a commit that ends a merge or a cherry-pick
// (`commit (merge)`, `commit (cherry-pick)`), a clone, a tool. test/git-arrivals.test.mjs locks these
// formats against git itself.
const OWN_COMMIT = /^commit(?: \((?:amend|initial)\))?:(?: |$)/;

// A line of a reflog as git's files backend writes it: `<old> <new> <name> <<email>> <time> <zone>`, a
// tab, and the message on one line; with no message (update-ref without -m), no tab either. Object
// names are 40 hex characters, or 64 in a SHA-256 repository.
const REFLOG_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [^\t]*(?:\t(.*))?$/;

// The files git leaves while an operation waits for the user, the ones git itself goes by to say that one
// is in progress (wt-status.c): a merge (a pull's, too) stopped on a conflict or run with --no-commit,
// MERGE_HEAD; a cherry-pick, CHERRY_PICK_HEAD; a revert, REVERT_HEAD; a rebase, rebase-merge/, or
// rebase-apply/ with the apply backend; `git am`, rebase-apply/. What they brought is in the working tree
// before any reflog line says so. Each goes when the operation is finished, aborted or quit, and for as
// long as it stays git says the operation is in progress. Until 2026-10-01 REBASE_HEAD was among them: git
// writes it when a rebase stops, and leaves it behind when the rebase ends after its last pick stopped
// (--continue, --skip) or is left with --quit. Of the everyday commands only the next rebase removes it, a
// commit, a checkout or a reset does not, while git says no rebase is in progress, and every scan of the
// project was a baseline (docs/lessons-learned.md F22).
const WAITING_OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
// A squash merge leaves no MERGE_HEAD and moves no HEAD: what it brought waits in the index, and SQUASH_MSG
// is the message git offers the commit that records it. git leaves SQUASH_MSG behind when that is restored
// away (git restore, git checkout -- <path>), and says nothing is in progress; the next commit, a reset or a
// switch of branch removes it. So SQUASH_MSG says a squash merge waits only while the index differs from
// HEAD.
const SQUASH_MESSAGE = 'SQUASH_MSG';
const GIT_PATHS = ['logs/HEAD', 'index', 'index.lock', ...WAITING_OPERATIONS, SQUASH_MESSAGE];

// A command writing the index (a checkout, a merge, add, commit) holds index.lock while it writes the
// working tree, and moves HEAD and writes its reflog line just after it lets go. A lock is waited for
// this long; the index having just been written, this long again for the reflog line.
const LOCK_WAIT_MS = 1000;
const LOCK_POLL_MS = 25;
const SETTLE_MS = 200;
const FRESH_INDEX_MS = 1000;
// How much of the reflog's end is read to find its last line.
const REFLOG_TAIL_BYTES = 64 * 1024;

// One line of a HEAD reflog: the commit HEAD pointed at before, and after, and the message. null for a
// line git does not write.
export function parseReflogLine(line) {
  const match = REFLOG_LINE.exec(line);
  return match ? {old: match[1], new: match[2], message: match[3] ?? ''} : null;
}

// How one reflog entry moved HEAD: 'same' when HEAD points at the commit it pointed at before
// (checkout -b, a stash, reset --hard HEAD), 'own' for the user's own commit, 'other' for any other move.
export function headMove(entry) {
  if (entry.old === entry.new) {
    return 'same';
  }

  return OWN_COMMIT.test(entry.message) ? 'own' : 'other';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lineHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

// A position gitArrival returned: HEAD's commit, or null when there was none yet, and where HEAD's
// reflog ended, or null when there was no reflog.
function isPosition(value) {
  return isObject(value)
    && (value.head === null || typeof value.head === 'string')
    && (value.reflog === null || (isObject(value.reflog)
      && Number.isSafeInteger(value.reflog.bytes) && value.reflog.bytes >= 0
      && (value.reflog.last === null || typeof value.reflog.last === 'string')));
}

// HEAD's commit (null when there is none yet), and where git keeps the files gitArrival reads, asked
// with --git-path so that a linked worktree's own are found.
function headAndPaths(repoRoot) {
  const lines = runGit(repoRoot, ['rev-parse', ...GIT_PATHS.flatMap((name) => ['--git-path', name]), '--verify', '--quiet', 'HEAD'], {okStatus: [1], trim: false}).split('\n');

  if (lines.length < GIT_PATHS.length + 1) {
    throw new Error('git rev-parse did not name every path Kit=Code asked for');
  }

  return {
    head: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(lines[GIT_PATHS.length]) ? lines[GIT_PATHS.length] : null,
    paths: Object.fromEntries(GIT_PATHS.map((name, index) => [name, path.resolve(repoRoot, lines[index])])),
  };
}

function modifiedAt(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Waits, up to LOCK_WAIT_MS, for a command writing the index to finish, and, when one did or the index
// has just been written, SETTLE_MS more for its reflog line. `writing` when the lock is still held.
function waitForIndex(paths) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waited = false;

  while (fs.existsSync(paths['index.lock'])) {
    if (Date.now() >= deadline) {
      return {writing: true, settled: false};
    }

    waited = true;
    sleepSync(LOCK_POLL_MS);
  }

  const written = modifiedAt(paths.index);

  if (waited || (written !== null && Date.now() - written < FRESH_INDEX_MS)) {
    sleepSync(SETTLE_MS);
    return {writing: false, settled: true};
  }

  return {writing: false, settled: false};
}

// `bytes` of the file at `fd`, from `start` to `end`.
function readRange(fd, start, end) {
  const buffer = Buffer.alloc(end - start);
  let done = 0;

  while (done < buffer.length) {
    const read = fs.readSync(fd, buffer, done, buffer.length - done, start + done);

    if (read === 0) {
      break;
    }

    done += read;
  }

  return buffer.subarray(0, done);
}

// The start, in `buffer` (which begins at `offset` in the file), of the line that ends just before
// `end`, or -1 when that line starts before the buffer does.
function lineStart(buffer, offset, end) {
  if (end - offset < 1) {
    return offset === 0 ? 0 : -1;
  }

  const newline = end - offset >= 2 ? buffer.lastIndexOf(0x0a, end - offset - 2) : -1;
  return newline >= 0 ? offset + newline + 1 : (offset === 0 ? 0 : -1);
}

// HEAD's reflog: where it ends now (`bytes`, up to the end of its last complete line, and `last`, a hash
// of that line), and, when `from` is given (a position's reflog, or null for "from its start"), the
// complete lines after it. `rewritten` when it no longer holds, at `from`, the line it held then: git
// expired entries, or it is not the same repository. null when there is no reflog.
function readReflog(logPath, from) {
  let fd;

  try {
    fd = fs.openSync(logPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  try {
    const size = fs.fstatSync(fd).size;
    const since = from === undefined ? null : (from?.bytes ?? 0);
    let offset = Math.max(0, Math.min(since ?? size, size) - REFLOG_TAIL_BYTES);

    for (;;) {
      const buffer = readRange(fd, offset, size);
      const end = offset + buffer.lastIndexOf(0x0a) + 1;
      const lastStart = end > offset ? lineStart(buffer, offset, end) : (offset === 0 ? 0 : -1);
      const sinceStart = since !== null && since > 0 && since <= size ? lineStart(buffer, offset, since) : 0;

      // A line longer than the part read: read it all.
      if ((end === offset && offset > 0) || lastStart < 0 || sinceStart < 0) {
        offset = 0;
        continue;
      }

      const position = {bytes: end, last: end > lastStart ? lineHash(buffer.subarray(lastStart - offset, end - offset - 1)) : null};

      if (since === null) {
        return {...position, lines: null, rewritten: false};
      }

      const aligned = since === 0
        ? from?.last == null
        : since <= end && buffer[since - offset - 1] === 0x0a && lineHash(buffer.subarray(sinceStart - offset, since - offset - 1)) === from.last;

      if (!aligned) {
        return {...position, lines: null, rewritten: true};
      }

      const lines = buffer.subarray(since - offset, end - offset).toString('utf8').split('\n').filter(Boolean);
      return {...position, lines, rewritten: false};
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Whether the index differs from HEAD: anything staged, a conflict too. When git cannot say (no commit
// yet, say), it is taken to: when in doubt, a baseline. diff-index reads the index and HEAD's tree, and
// writes nothing.
function indexDiffersFromHead(repoRoot) {
  try {
    runGit(repoRoot, ['diff-index', '--cached', '--quiet', 'HEAD', '--']);
    return false;
  } catch {
    return true;
  }
}

// The operations waiting for the user, by the files git leaves for them: none, or their names.
function waitingOperations(repoRoot, paths) {
  const waiting = WAITING_OPERATIONS.filter((name) => fs.existsSync(paths[name]));

  if (fs.existsSync(paths[SQUASH_MESSAGE]) && indexDiffersFromHead(repoRoot)) {
    waiting.push(SQUASH_MESSAGE);
  }

  return waiting;
}

// Whether the reflog explains how HEAD got from `since` to `now`, and how. `arrival`: null when HEAD did
// not move, or moved only by the user's own commits; 'moved' when it moved some other way; 'unexplained'
// when the reflog was rewritten, is gone, or does not lead from one to the other (HEAD moved with no
// entry). `operation`: whether git did anything to HEAD but the user's own commit, even without moving
// it (a stash, `reset --hard HEAD`, `checkout -b`).
function arrivalFromReflog(since, now, log) {
  if (!log) {
    return since.reflog === null && since.head === now.head ? {arrival: null, operation: false} : {arrival: 'unexplained', operation: true};
  }

  if (log.rewritten || log.lines === null) {
    return {arrival: 'unexplained', operation: true};
  }

  let head = since.head;
  let moved = false;
  let operation = false;

  for (const line of log.lines) {
    const entry = parseReflogLine(line);

    if (!entry || !(entry.old === head || (head === null && /^0+$/.test(entry.old)))) {
      return {arrival: 'unexplained', operation: true};
    }

    const move = headMove(entry);
    moved ||= move === 'other';
    operation ||= move !== 'own';
    head = entry.new;
  }

  if (head !== now.head) {
    return {arrival: 'unexplained', operation: true};
  }

  return {arrival: moved ? 'moved' : null, operation};
}

// What can have arrived through git in `repoRoot` since `since`, a position this function returned
// before, and the position now, for the next scan to start from. `arrival`:
//   null           nothing: HEAD is where it was, or moved only by the user's own commits;
//   'moved'        HEAD moved some other way: a pull, a merge, a checkout, a rebase, a reset …;
//   'waiting'      a merge, a cherry-pick, a revert, a rebase, am or a squash merge waits for the user,
//                  and `waiting` names the files git left for it (the tracker reports it, runtime.mjs
//                  noteGitWaiting, since 2026-10-01);
//   'locked'       index.lock stayed for longer than LOCK_WAIT_MS: a long command, or a git that died
//                  holding it, which git itself refuses to run past until the file is removed (until
//                  2026-09-25 this was 'waiting'; the tracker now reports it, runtime.mjs noteGitLock);
//   'unexplained'  the reflog cannot say how HEAD got here: rewritten, gone, or no entry for a move;
//   'unrecorded'   there is no position to compare with.
// Anything but null makes a scan a baseline. `operation` says whether git did anything since `since` but
// the user's own commits: true whenever `arrival` is not null, and also when HEAD's reflog shows git
// acting without moving HEAD, as a stash does (it takes the user's changes away, and writes `reset:
// moving to HEAD`). What changed in the working tree then is git's, and is not activity (operator
// decision Q4, 2026-09-25). Throws when git cannot describe the repository.
export function gitArrival(repoRoot, since) {
  let {head, paths} = headAndPaths(repoRoot);
  const index = waitForIndex(paths);

  if (index.settled) {
    ({head} = headAndPaths(repoRoot));
  }

  const recorded = isPosition(since);
  const log = readReflog(paths['logs/HEAD'], recorded ? since.reflog : undefined);
  const position = {head, reflog: log ? {bytes: log.bytes, last: log.last} : null};
  const reflog = recorded ? arrivalFromReflog(since, position, log) : {arrival: 'unrecorded', operation: true};

  if (index.writing) {
    return {arrival: 'locked', operation: true, position};
  }

  const waiting = waitingOperations(repoRoot, paths);

  if (waiting.length > 0) {
    return {arrival: 'waiting', operation: true, position, waiting};
  }

  return {...reflog, position};
}
