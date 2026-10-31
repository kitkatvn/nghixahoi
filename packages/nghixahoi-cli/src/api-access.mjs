import net from 'node:net';
import {isAllowedOrigin} from './cors.mjs';

// Who may use the local API (docs/security.md, "The local API"). There is no login: these checks
// stop web pages, which cannot choose their Host or Origin headers. A program on this machine can
// send any header it likes; it can also edit ~/.nghixahoi/state.json directly.

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Event streams one tracker keeps open at once: the Mini holds one, a preview tab another.
export const MAX_EVENT_STREAMS = 8;

// A refusal any page may read: fixed words, nothing of the user's and no local path, with
// `Access-Control-Allow-Origin: *` and no credentials. A dashboard at an address this tracker does not
// accept can then tell the person to update Kit=Code, where it could only say that nothing answered.
// An answer that carries data goes to allow-listed origins alone (cors.mjs).
function refuse(res, status, error) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json({error});
}

// Every route: the Host header must be 127.0.0.1 or localhost on the port this request arrived on.
// A page whose domain was rebound to 127.0.0.1 sends its own domain as Host, and is refused.
export function requireLoopbackHost(req, res, next) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const port = req.socket.localPort;

  if (LOOPBACK_NAMES.some((name) => host === `${name}:${port}`)) {
    next();
    return;
  }

  refuse(res, 403, `Kit=Code answers only to 127.0.0.1:${port} and localhost:${port}.`);
}

// Every read that names an Origin: an allow-listed one, or the tracker's own, which only a page it
// served can have. Any other page is refused in words it can read, rather than answered with data its
// browser keeps from it. A read with no Origin, a program's or the Mini's, is answered as before.
// Preflights never get here: cors.mjs answers them.
export function requireDashboardRead(req, res, next) {
  const origin = req.headers.origin;
  const ownOrigin = `http://${String(req.headers.host ?? '').toLowerCase()}`;

  if (!READ_METHODS.has(req.method) || origin === undefined || origin === ownOrigin || isAllowedOrigin(origin)) {
    next();
    return;
  }

  refuse(res, 403, 'Kit=Code answers only its dashboard.');
}

// Every route that can change something: a JSON body from an allow-listed Origin. A website can send
// a text/plain or form POST without asking first; a JSON one needs a CORS preflight, which only an
// allow-listed origin passes (cors.mjs).
export function requireDashboardWrite(req, res, next) {
  if (READ_METHODS.has(req.method)) {
    next();
    return;
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    refuse(res, 403, 'Kit=Code accepts changes only from its dashboard.');
    return;
  }

  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

  if (type !== 'application/json') {
    refuse(res, 415, 'Kit=Code accepts changes only as application/json.');
    return;
  }

  next();
}

// A read only the dashboard may make: the claim bundle (docs/security.md, "The local API"). It needs an
// allow-listed Origin, as a write does. The other reads answer a request with no Origin too, which is
// how the Mini, served by the tracker itself, reads them; a page can send no Origin only from the
// tracker's own origin, or through a request whose answer it cannot read.
export function requireDashboardOrigin(req, res, next) {
  if (isAllowedOrigin(req.headers.origin)) {
    next();
    return;
  }

  refuse(res, 403, 'Kit=Code gives the claim bundle only to its dashboard.');
}

// Addresses only this machine can reach. A name other than localhost may resolve anywhere.
export function isLoopbackAddress(host) {
  const value = String(host ?? '').trim().toLowerCase();

  if (value === 'localhost') {
    return true;
  }

  if (net.isIPv4(value)) {
    return value.split('.')[0] === '127';
  }

  if (net.isIPv6(value)) {
    return value === '::1' || /^::ffff:127\./.test(value);
  }

  return false;
}

// The address Kit=Code itself uses to reach a tracker bound to `host`. One bound to every interface
// is reached on 127.0.0.1; the API answers no other Host, and Windows cannot connect to 0.0.0.0.
export function reachableAddress(host) {
  const value = String(host ?? '').trim();

  if (value === '' || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }

  return value === '::1' ? 'localhost' : value;
}
