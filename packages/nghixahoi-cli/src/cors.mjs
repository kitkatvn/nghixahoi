// The origins a tracker allows with nothing configured: the hosted dashboard's and the local development
// servers'. Pinned by local-api.test.mjs. Since 2026-10-22 (production/1-cli) the hosted dashboard is production's, where it
// was the previous project's site; a tester build's copy has the staging site's in its place. Since
// ops/3-domain-input it is DASHBOARD_URL's origin, on production's domain (deploy/production/domain): a release under latest
// writes the domain's on its line, when the commit names another (scripts/release.mjs).
export const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost:8686',
  'http://127.0.0.1:8686',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://nghixahoi.vn',
]);

function configuredOrigins() {
  if (!process.env.NGHIXAHOI_ALLOWED_ORIGINS) {
    return [];
  }

  return process.env.NGHIXAHOI_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin) {
  return Boolean(origin) && (DEFAULT_ALLOWED_ORIGINS.has(origin) || configuredOrigins().includes(origin));
}

// Only an allow-listed origin is told anything: whether it may read, and whether it may reach this
// private-network address at all. Any other origin gets none of these headers. The one thing any page
// may read is a refusal, which carries fixed words only (api-access.mjs).
export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  res.setHeader('Vary', 'Origin');

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Private-Network-Access-ID', '4b:69:74:43:6f:64');
    res.setHeader('Private-Network-Access-Name', 'nghixahoi-local');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
