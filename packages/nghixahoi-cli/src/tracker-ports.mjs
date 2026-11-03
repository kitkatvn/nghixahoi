import {execFile} from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

// The ports the tracker takes when it is given none (docs/security.md, "The local API"; docs/lessons-learned.md F23): 4747, or,
// when another program holds it, the next free one up to 4751. The dashboard asks them in the same order. Until 0.2.16 the
// tracker took 4747 alone, and did not start when another program held it.
export const DEFAULT_PORT = 4747;
const PORT_COUNT = 5;

// The five ports, from 4747. NGHIXAHOI_FIRST_PORT moves them for the tests alone, which must never take 4747 from a developer's
// own tracker: the dashboard never looks anywhere but 4747 to 4751.
export function trackerPorts(first = Number(process.env.NGHIXAHOI_FIRST_PORT) || DEFAULT_PORT) {
  const start = Number.isInteger(first) && first > 0 && first + PORT_COUNT - 1 <= 65_535 ? first : DEFAULT_PORT;
  return Array.from({length: PORT_COUNT}, (_, index) => start + index);
}

// Listens on the first of `ports` that no other program holds: `listen(port)` starts a server listening there. Returns the
// server, its port, and the ports found in use before it. When every one is in use, throws EADDRINUSE with them all as `inUse`.
export async function listenOnFirstFree(listen, ports) {
  const inUse = [];

  for (const port of ports) {
    try {
      const server = await new Promise((resolve, reject) => {
        const candidate = listen(port);
        const failed = (error) => {
          candidate.off('listening', listening);
          reject(error);
        };
        const listening = () => {
          candidate.off('error', failed);
          resolve(candidate);
        };
        candidate.once('error', failed);
        candidate.once('listening', listening);
      });

      return {server, port, inUse};
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }

      inUse.push(port);
    }
  }

  throw Object.assign(new Error(`ports ${ports.join(', ')} are all in use`), {code: 'EADDRINUSE', inUse});
}

// The first of `ports` that no other program holds on `host` now, or null when another holds every one. A port that fails for any
// other reason (an address this machine does not have, say) is not called held: the tracker tries it, and says why it failed.
// Another program can take a port a moment later: the tracker checks again as it listens (listenOnFirstFree).
export async function firstFreePort(host, ports) {
  for (const port of ports) {
    const held = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', (error) => resolve(error?.code === 'EADDRINUSE'));
      probe.listen(port, host, () => probe.close(() => resolve(false)));
    });

    if (!held) {
      return port;
    }
  }

  return null;
}

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, {timeout: 1500, windowsHide: true, encoding: 'utf8'}, (error, stdout) => resolve(error ? '' : String(stdout ?? '')));
    } catch {
      resolve('');
    }
  });
}

// The program listening on `port`, as the OS says, {pid, name}; null when it does not say (no lsof or ss, another user's
// process, or a timeout). It names it to the person, never to the agent: the prompt hook does not read it.
export async function portHolder(port) {
  if (process.platform === 'win32') {
    const listening = (await run('netstat', ['-ano', '-p', 'TCP'])).split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .find((parts) => parts.length >= 5 && /^LISTEN/iu.test(parts[3]) && parts[1].endsWith(`:${port}`));
    const pid = Number(listening?.at(-1));

    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    return {pid, name: /^"([^"]+)"/u.exec((await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).trim())?.[1] ?? null};
  }

  const lsof = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = Number(/^p(\d+)$/mu.exec(lsof)?.[1]);

  if (Number.isInteger(pid) && pid > 0) {
    return {pid, name: /^c(.+)$/mu.exec(lsof)?.[1] ?? null};
  }

  const ss = /users:\(\("([^"]+)",pid=(\d+)/u.exec(await run('ss', ['-ltnpH', `sport = :${port}`]));
  return ss ? {pid: Number(ss[2]), name: ss[1]} : null;
}

// A holder as the person reads it: its name, printable and short, and its process.
export function describeHolder(holder) {
  if (!holder || !Number.isInteger(holder.pid)) {
    return null;
  }

  const name = String(holder.name ?? '').replace(/[^\x20-\x7e]/gu, '').trim().slice(0, 64);
  return name ? `${name} (process ${holder.pid})` : `process ${holder.pid}`;
}
