// The tracker's scanning thread (scanner.mjs starts it). Listing a project, reading and hashing its
// files, and asking git for its state all block, so they happen here, and the tracker's own thread
// keeps answering the local API meanwhile. It only reads: every result goes back to the tracker,
// which folds it into state.json under the state lock. A Git project's read is checked against git
// here too, since the git position its snapshot recorded (readProjectScan): waiting for a git command
// to finish writing the index blocks this thread, not the tracker's.
import {parentPort} from 'node:worker_threads';
import {countCommits, getGitSignature} from './git.mjs';
import {readProjectScan, shouldIgnoreRelativePath} from './source-snapshot.mjs';

parentPort.on('message', ({id, kind, root, sourceType, changedPaths, since}) => {
  try {
    // The status of files the scanner leaves out (a lockfile, say) is not part of the signature, so
    // changing one is not activity.
    const result = kind === 'git'
      ? {signature: getGitSignature(root, shouldIgnoreRelativePath), commitCount: countCommits(root)}
      : readProjectScan(root, {sourceType, changedPaths, since});

    parentPort.postMessage({id, ok: true, result});
  } catch (error) {
    parentPort.postMessage({id, ok: false, error: {message: error.message, code: error.code}});
  }
});
