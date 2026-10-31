import {Worker} from 'node:worker_threads';

// Runs the tracker's scans in a worker thread (scan-worker.mjs), one at a time, in the order asked.
// A worker that fails is replaced at the next request; `onError` hears about the failure.
export function createScanner({onError} = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function failPending(error) {
    for (const {reject} of pending.values()) {
      reject(error);
    }

    pending.clear();
  }

  function start() {
    const thread = new Worker(new URL('./scan-worker.mjs', import.meta.url));
    // The tracker's server keeps the process alive; a scan in progress must not.
    thread.unref();

    thread.on('message', ({id, ok, result, error}) => {
      const request = pending.get(id);

      if (!request) {
        return;
      }

      pending.delete(id);

      if (ok) {
        request.resolve(result);
      } else {
        request.reject(Object.assign(new Error(error.message), {code: error.code}));
      }
    });

    const stopped = (error) => {
      if (worker !== thread) {
        return;
      }

      worker = null;
      onError?.(error);
      failPending(error);
    };

    thread.on('error', stopped);
    thread.on('exit', (code) => stopped(new Error(`the scan worker stopped with exit code ${code}`)));
    worker = thread;
  }

  function request(message) {
    if (!worker) {
      start();
    }

    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      worker.postMessage({...message, id});
    });
  }

  return {
    // `since` is the git position the project's snapshot recorded: a Git project's read is checked
    // against it (source-snapshot.mjs readProjectScan).
    read({root, sourceType, changedPaths = null, since}) {
      return request({kind: 'read', root, sourceType, changedPaths, since});
    },
    git({root}) {
      return request({kind: 'git', root});
    },
    async close() {
      const thread = worker;
      worker = null;
      failPending(new Error('the scanner closed'));
      await thread?.terminate();
    },
  };
}
