// Production's domain, read from deploy/production/domain, the one input every production name derives from (docs/plans/
// 2026-10-26-production-domain-change.md, phase 1; docs/deployment-target.md, "Production's domain"): the CLI a release under
// `latest` writes (packages/nghixahoi-cli/scripts/release.mjs), the dashboard's build (apps/web/vite.config.ts and
// src/lib/production-site.ts), deploy.sh's names and checks from outside, and provision.sh --env production's names, nginx files,
// certificate and settings. It is a file in the tagged commit, never a workflow's input or a setting on the server: a tag names
// the domain it was made for.
//
// The file is one line:
//
//   <domain>                     production answers <domain>, www.<domain>, claims.<domain> and admin.<domain>
//   <domain> from <previous>     and, while it says so, the previous domain's four names, each a 301 to the same path on the
//                                same name of <domain>, but for <previous>/v1/tracking-config, which the backend answers there
//                                as it did (the 0.2.x trackers fetch it with redirect: 'manual', and take no 301), and Let's
//                                Encrypt's challenge, kept for the previous certificate's renewal
//
// each a lower-case name of two labels or more, a label of letters, digits and hyphens, at most 63, its last one starting with a
// letter, and none of the four names staging's, which staging's own domain file names: the caller reads that file and gives its
// names. Nothing here reads a file or imports a module, so that the dashboard's bundle takes it as it is:
// it bundles parseDomainLine alone, the build having read the file whole with parseProductionDomain as it starts, so that no
// staging name reaches a production bundle. provision.sh reads the line with a bash reading of its own, production_domain_parse,
// which apps/api/test/production-domain.test.ts holds to this one, input by input. Since 2026-10-29 staging's names have a line
// of their own, read by the same rules (parseDomainLine, with staging's file and names).

// Where the input is, from the repository's top.
export const PRODUCTION_DOMAIN_FILE = 'deploy/production/domain';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`, 'u');
// claims.<domain> is the longest of the four names, and a name is at most 253 characters.
const MAX_DOMAIN_LENGTH = 253 - 'claims.'.length;

// The four names a domain gives production, in the order the nginx files and the certificate name them.
export function productionNames(domain) {
  return Object.freeze({dashboard: domain, www: `www.${domain}`, claims: `claims.${domain}`, admin: `admin.${domain}`});
}

export function namesOf(domain) {
  const names = productionNames(domain);
  return [names.dashboard, names.www, names.claims, names.admin];
}

// Why a name cannot be production's domain, or null.
function nameProblem(name, what) {
  if (!NAME.test(name)) {
    return `${what} "${name}" is not a lower-case name of two labels or more (letters, digits and hyphens, no dot at the end)`;
  }

  if (name.length > MAX_DOMAIN_LENGTH) {
    return `${what} "${name}" is longer than ${MAX_DOMAIN_LENGTH} characters, so claims.${name} would be no name`;
  }

  if (!/^[a-z]/u.test(name.slice(name.lastIndexOf('.') + 1))) {
    return `${what} "${name}" ends in a label that does not start with a letter, which no top-level domain does`;
  }

  return null;
}

// The file's text, read: {domain, previous}, previous null when the line names none. Throws, saying why, for anything else,
// staging's names among it: `stagingNames`, every name staging's domain file gives staging, its previous names included. Since
// 2026-10-31, null where the tree holds no staging at all, as the public repository's does: the private repository, which holds
// both, checked the same file against staging's names before it was exported. Never an empty list, which is a caller that forgot
// them.
export function parseProductionDomain(text, stagingNames) {
  if (stagingNames !== null && (!Array.isArray(stagingNames) || stagingNames.length === 0)) {
    throw new Error(`parseProductionDomain needs staging's names, from staging's domain file, to refuse a production name that is one of them`);
  }

  const read = parseDomainLine(text);

  for (const [name, what] of [[read.domain, 'the domain'], ...(read.previous === null ? [] : [[read.previous, 'the previous domain']])]) {
    const staging = stagingNames === null ? [] : namesOf(name).filter((production) => stagingNames.includes(production));

    if (staging.length > 0) {
      throw new Error(`${PRODUCTION_DOMAIN_FILE}: ${what} "${name}" would give production ${staging.join(', ')}, which is staging's`);
    }
  }

  return read;
}

// The same, but for staging's names, which it does not look for: what the dashboard's bundle reads the file with, once the build
// has read it with parseProductionDomain (apps/web vite.config.ts). Since 2026-10-29 also staging's own line, the same rules for
// its file and its names: `file` names the file in what it throws, and `names` gives a name's names.
export function parseDomainLine(text, file = PRODUCTION_DOMAIN_FILE, names = namesOf) {
  if (typeof text !== 'string' || !/^[^\r\n]*(?:\r?\n)?$/u.test(text)) {
    throw new Error(`${file} must be one line: "<domain>", or "<domain> from <previous domain>"`);
  }

  const line = text.replace(/\r?\n$/u, '');
  const words = /^(\S+)(?: from (\S+))?$/u.exec(line);

  if (line === '' || words === null) {
    throw new Error(`${file} holds ${JSON.stringify(line)}, where it must hold "<domain>", or "<domain> from <previous domain>", one space apart`);
  }

  const [, domain, previous = null] = words;

  for (const [name, what] of [[domain, 'the domain'], ...(previous === null ? [] : [[previous, 'the previous domain']])]) {
    const problem = nameProblem(name, what);

    if (problem !== null) {
      throw new Error(`${file}: ${problem}`);
    }
  }

  if (previous !== null) {
    const shared = names(domain).filter((name) => names(previous).includes(name));

    if (shared.length > 0) {
      throw new Error(`${file}: the domain "${domain}" and the previous domain "${previous}" share ${shared.join(', ')}: a name cannot both answer and send on`);
    }
  }

  return Object.freeze({domain, previous});
}
