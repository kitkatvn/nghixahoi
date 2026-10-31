// The release of the CLI from a pushed tag (docs/way-of-working.md, "Releasing"; the operator's decisions of 2026-09-30,
// docs/project-overview.md). .github/workflows/release.yml runs it on a tag cli-v<version>, and
// .github/workflows/release-verify.yml once a maintainer has approved what it staged. A release under `latest` is production's, the
// commit's own package.json's name, @kitkatvn/nghixahoi, which holds production versions alone, and each version stays on its own
// channel's dist-tag. A tester build under `staging` is made and staged in the private repository alone, by release-staging.mjs, which
// this script loads for a staging tag where it exists (since 2026-10-31: the public repository releases production alone).
//
//   node packages/nghixahoi-cli/scripts/release.mjs check-npm
//   node packages/nghixahoi-cli/scripts/release.mjs pack --tag cli-v<version> --out <folder outside the repository>
//   node packages/nghixahoi-cli/scripts/release.mjs stage --out <that folder>
//   node packages/nghixahoi-cli/scripts/release.mjs verify --version <version> --records <folder>
//
// pack makes the tarball from the tagged commit, never from a working tree. A version <x>.<y>.<z> is the commit's own
// CLI, and must be its package.json's version; since 2026-10-20 with one line changed, its milestone table set to the
// production table, MILESTONE_TABLE in src/integration-spec.mjs (the plan of 2026-10-20, decision 4), and since 2026-10-22 a
// second, CYCLE_RECEIPT_PUBLIC_KEY set to the production claim backend's key, from the tagged commit's
// deploy/production/cycle-receipt.pub; <x>.<y>.<z>-staging.<N> is the commit's tester build, made by release-staging.mjs where it
// exists, which keeps the commit's, the tester table.
// It checks the tarball against a pack of the commit, then writes it, its SHA-256 and a record,
// release.json, which names its npm integrity. stage puts that tarball in npm's staging area with `npm stage publish` and
// an explicit dist-tag, `staging` or `latest`: nothing staged is public until a maintainer approves it with 2FA. Nothing
// here runs `npm publish`. verify, after the approval, checks that the registry serves the version with the integrity
// staged and that its dist-tag points at it: until it passes, a version is staged, not released.
//
// Since ops/3-domain-input (2026-10-26), production's dashboard is on the domain the tagged commit's deploy/production/domain names,
// the one input every production name derives from: a release under `latest` opens https://<domain>/ and allows it alone. The
// commit's CLI names production's domain, or while that file names a previous domain, the previous one, and the release writes
// the domain's into its own copy, in the three lines that name it (DASHBOARD_URL, the allow-list's hosted origin and the
// trackers' fallback), as it writes the key; a commit that names the domain already ships those three as they are.
//
// It never runs the CLI (hard rule 2): the only modules it loads, cors.mjs and integration-spec.mjs, import nothing but the
// CLI's own package.json, which integration-spec.mjs reads its name and version from, and write no file; deploy/production/domain.mjs,
// which imports nothing; and release-staging.mjs, where it exists, which imports the staging domain's reader alone.
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {PRODUCTION_DOMAIN_FILE, parseProductionDomain} from '../../../deploy/production/domain.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_DIR = 'packages/nghixahoi-cli';
const TAG_PREFIX = 'cli-v';
// Written last by pack: a folder whose record is there holds the whole release.
const RECORD = 'release.json';
const REGISTRY = 'https://registry.npmjs.org';

// Each channel's package, pinned here and checked against what the tarball's package.json says: production's, the commit's own,
// for `latest`; and, for `staging`, the staging package, release-staging.mjs's. verify checks each version as its channel's, so a
// version of a package Kit=Code had before is refused. And the command, the same in both, what the package.json's bin names alone,
// and its CLI_GLOBAL_COMMAND says.
const PRODUCTION_PACKAGE = '@kitkatvn/nghixahoi';
const COMMAND = 'nghixahoi';
const packageOf = (release) => (release.staging ? staging?.STAGING_PACKAGE : PRODUCTION_PACKAGE);
// Production's dashboard (since 2026-10-22) is https://<domain>, the domain of the tagged commit's deploy/production/domain (since
// ops/3-domain-input; productionDomainIn): a release under `latest` opens it, and its trackers allow it.
// Since 2026-10-22 (production/1-cli): the public half of the production claim backend's key for cycle receipts, as its
// operator's command printed it on the production server, one line, in the tagged commit. A release under `latest` carries it,
// written into its copy alone, as a tester build carries the staging one; a commit carries none.
const PRODUCTION_RECEIPT_KEY_FILE = 'deploy/production/cycle-receipt.pub';
// An Ed25519 public key as a build carries it: base64url of its 32 raw bytes, a JWK's `x`.
const RECEIPT_KEY = /^[A-Za-z0-9_-]{43}$/u;
const NO_RECEIPT_KEY_LINE = 'export const CYCLE_RECEIPT_PUBLIC_KEY = null;';
// The local development servers' origins, which every allow-list holds beside its one hosted dashboard (src/cors.mjs).
const isLocalOrigin = (origin) => /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u.test(origin);
// The files a tester build changes (its CHANGED_FILES). If it comes to change others, this list follows it, in the same change: what
// reaches npm is pinned here as well as there.
const TESTER_BUILD_CHANGES = ['bin/nghixahoi.mjs', 'package.json', 'src/cors.mjs', 'src/integration-spec.mjs'];
// The lines a production release changes, in one file: the milestone table, from the tester table every commit counts by to
// the production table (the plan of 2026-10-20, decision 4); and since 2026-10-22 the key for cycle receipts, from none to the
// production claim backend's. Both tables are in the commit, public, and the line names which is in force. Until 2026-10-21
// the production table's numbers were drafts; from 2026-10-21 both tables held the operator's numbers of that day, the same in
// each; since 2026-10-22 (rewards/4-staging-targets) they differ again: the tester table is the short one, 18 minutes and 9 =,
// 30 and 12, 60 and 15, and the production table keeps the operator's, 3 h and 300 =, 5 h and 500 =, 8 h and 1,000 =
// (docs/reward-rules.md §2).
const SPEC_FILE = 'src/integration-spec.mjs';
const TESTER_TABLE_LINE = "export const MILESTONE_TABLE = 'tester';";
const PRODUCTION_TABLE_LINE = "export const MILESTONE_TABLE = 'production';";
const LATEST_CHANGES = [SPEC_FILE];
// Since ops/3-domain-input: the three lines that name the CLI's dashboard, each in its file, as the commit writes them; a release
// whose commit names another origin than the tagged commit's deploy/production/domain (its previous domain, while that file
// names one) writes the domain's in their place, and changes these files too, in these lines alone.
const CORS_FILE = 'src/cors.mjs';
const BIN_FILE = 'bin/nghixahoi.mjs';
const DOMAIN_LINES = [
  [SPEC_FILE, (origin) => `export const DASHBOARD_URL = '${origin}/';`],
  [CORS_FILE, (origin) => `  '${origin}',`],
  [BIN_FILE, (origin) => `    origins.add('${origin}');`],
];
const LATEST_DOMAIN_CHANGES = [BIN_FILE, CORS_FILE, SPEC_FILE];

// What `npm stage` needs (docs.npmjs.com, "Staged publishing").
const NPM_FLOOR = [11, 15, 0];
const NODE_FLOOR = [22, 14, 0];

// <x>.<y>.<z> is released under `latest`; <x>.<y>.<z>-staging.<N>, the tagged commit's tester build, under `staging`, N a whole
// number from 1, of at most six digits. No other version is released.
const LATEST_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const STAGING_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-staging\.([1-9][0-9]{0,5})$/u;

const USAGE = `Usage: node packages/nghixahoi-cli/scripts/release.mjs <command> [options]

The release of the CLI from a pushed tag, run by .github/workflows/release.yml and release-verify.yml
(docs/way-of-working.md, "Releasing"): ${PRODUCTION_PACKAGE} under latest, and, where this repository makes them, its
tester builds under staging. Nothing here runs npm publish.

  check-npm                      Whether this npm and Node can stage: npm ${NPM_FLOOR.join('.')} and Node ${NODE_FLOOR.join('.')} or later.
  pack --tag <tag> --out <folder>
                                 Makes the release of the tagged commit checked out, into <folder>, outside the
                                 repository: the tarball, its SHA-256, and ${RECORD}. cli-v<x>.<y>.<z> is package.json's
                                 version of ${PRODUCTION_PACKAGE}, for the dist-tag latest, with the key in
                                 ${PRODUCTION_RECEIPT_KEY_FILE} and the dashboard on the domain in
                                 ${PRODUCTION_DOMAIN_FILE}; cli-v<x>.<y>.<z>-staging.<N> is the commit's tester build,
                                 for the dist-tag staging, where this repository makes them.
  stage --out <folder>           Stages what pack wrote there, with npm stage publish: in the release workflow only.
  verify --version <version> --records <folder> [--registry <url>]
                                 Once a maintainer has approved it: whether the registry serves <version> with the
                                 integrity a release run recorded under <folder>, and its dist-tag points at it.
  -h, --help                     Print this help.`;

// A refusal is thrown, so that the temporary folder goes whatever stops the command.
class Refusal extends Error {}

// The staging half (release-staging.mjs), where this repository holds it: the private one does, the public one does not (since
// 2026-10-31, scripts/export-public-cli.mjs). Without it a staging tag is refused.
const STAGING_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-staging.mjs');
const staging = fs.existsSync(STAGING_MODULE)
  ? (await import(pathToFileURL(STAGING_MODULE).href)).stagingOf({run, refuse, repoRoot, cliDir: CLI_DIR})
  : null;

function refuse(problem) {
  throw new Refusal(problem);
}

function parseArguments(argv, names) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.startsWith('--') && argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined];

    if (!names.includes(name)) {
      refuse(/^--?[a-z][a-z-]*$/u.test(name) ? `it does not know ${name} here. Run it with --help.` : 'it does not know one of its arguments. Run it with --help.');
    }

    if (inline === undefined && index + 1 >= argv.length) {
      refuse(`${name} needs a value.`);
    }

    options[name.slice(2)] = inline ?? argv[(index += 1)];
  }

  return options;
}

// { version, distTag, staging, number }, or null for a version that is neither channel's.
function releaseOf(version) {
  if (LATEST_VERSION.test(version)) {
    return {version, distTag: 'latest', staging: false};
  }

  const tester = STAGING_VERSION.exec(version);
  return tester ? {version, distTag: 'staging', staging: true, number: tester[4]} : null;
}

function atLeast(version, floor) {
  for (let index = 0; index < floor.length; index += 1) {
    if (version[index] !== floor[index]) {
      return version[index] > floor[index];
    }
  }

  return true;
}

function run(command, args, options = {}) {
  // npm is npm.cmd on Windows, which Node runs only through a shell: it gets one command line, each argument quoted,
  // as a tester build's maker runs it (DEP0190).
  const shell = process.platform === 'win32' && command === 'npm';
  const spawnOptions = {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell, ...options};
  const result = shell
    ? spawnSync(['npm.cmd', ...args.map((arg) => `"${arg}"`)].join(' '), spawnOptions)
    : spawnSync(command, args, spawnOptions);

  if (result.error) {
    refuse(`${command} could not run: ${result.error.message}`);
  }

  return result;
}

function git(args) {
  const result = run('git', args, {cwd: repoRoot});

  if (result.status !== 0) {
    refuse(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function readJsonFile(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`${what} could not be read as JSON: ${error.message}`);
  }
}

// Every file under `folder`, as paths relative to it with forward slashes, sorted.
function filesUnder(folder, prefix = '') {
  return fs.readdirSync(path.join(folder, prefix), {withFileTypes: true}).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(folder, relative) : [relative];
  }).sort();
}

// What npm puts in a tarball of `folder`, by its own rules (`files`, and what it always leaves out): a dry run lists
// it, and a pack into `destination` writes it too.
function packedFiles(folder, destination = null) {
  const args = destination === null ? ['pack', '--dry-run', '--json', '--ignore-scripts'] : ['pack', '--json', '--ignore-scripts', '--pack-destination', destination];
  const result = run('npm', args, {cwd: folder});

  if (result.status !== 0) {
    refuse(`npm pack failed:\n${result.stderr.trim()}`);
  }

  let packed;

  try {
    [packed] = JSON.parse(result.stdout);
  } catch {
    refuse(`npm pack printed something other than its JSON:\n${result.stdout.trim()}`);
  }

  return {filename: packed.filename, files: packed.files.map((entry) => entry.path).sort()};
}

async function importFresh(file) {
  return import(`${pathToFileURL(file).href}?release-${crypto.randomUUID()}`);
}

// isAllowedOrigin reads NGHIXAHOI_ALLOWED_ORIGINS when it is called: without it, it answers for the list alone.
function allowedByListAlone(cors, origin) {
  const configured = process.env.NGHIXAHOI_ALLOWED_ORIGINS;
  delete process.env.NGHIXAHOI_ALLOWED_ORIGINS;

  try {
    return cors.isAllowedOrigin(origin);
  } finally {
    if (configured !== undefined) {
      process.env.NGHIXAHOI_ALLOWED_ORIGINS = configured;
    }
  }
}

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// The integrity npm records for a tarball, dist.integrity on the registry: the SHA-512 of its bytes, in base64.
function integrityOf(bytes) {
  return `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
}

// Written beside its final name, then renamed: a file that has its name is whole.
function writeInto(folder, name, write) {
  const partial = path.join(folder, `.${name}.partial`);
  write(partial);
  fs.renameSync(partial, path.join(folder, name));
}

function summarize(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

// The lines `after` differs from `before` by, as `git diff --no-index` finds them: those it removes and those it adds, each
// in the file's order (as a tester build's maker reads them).
function lineChanges(before, after) {
  const result = run('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=0', '--', before, after]);

  if (result.status !== 0 && result.status !== 1) {
    refuse(`git diff could not compare ${path.basename(before)}: ${result.stderr.trim()}`);
  }

  const removed = [];
  const added = [];
  let inHunk = false;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('-')) {
      removed.push(line.slice(1));
    } else if (inHunk && line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }

  return {removed, added};
}

// The milestone tables a CLI's integration spec holds, and the one in force, as its CLI reads them.
async function milestoneTableOf(cli) {
  const spec = await importFresh(path.join(cli, SPEC_FILE));
  return {name: spec.MILESTONE_TABLE, tables: spec.MILESTONE_TABLES, inForce: [...(spec.NGHIXAHOI_REWARD_TIERS ?? []), ...(spec.NGHIXAHOI_DISPLAY_MILESTONES ?? [])].map(({percent, requiredSeconds, requiredEquals}) => ({percent, requiredSeconds, requiredEquals}))};
}

// The line a production release writes for the production claim backend's key for cycle receipts, as a tester build writes
// the staging one's.
const productionReceiptKeyLine = (key) => `export const CYCLE_RECEIPT_PUBLIC_KEY = ${JSON.stringify(key)};`;

// The line `from` replaced by `to` in a file of a copy of the CLI: found once, or nothing is made.
function replaceLineOnce(cli, file, from, to, why) {
  const target = path.join(cli, file);
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  const found = lines.flatMap((line, index) => (line === from ? [index] : []));

  if (found.length !== 1) {
    refuse(`the commit's ${CLI_DIR}/${file} holds ${JSON.stringify(from)} ${found.length} times, not once: ${why}.`);
  }

  lines[found[0]] = to;
  fs.writeFileSync(target, lines.join('\n'));
}

// The lines a release writes into its copy, by file, each [the commit's, the release's], in the file's order: the production
// table and the production claim backend's key, since 2026-10-22; and since ops/3-domain-input, when the commit's dashboard is not
// on the domain of deploy/production/domain, the three lines that name it.
function productionLines(commitCli, receiptKey, {from, to}) {
  const changes = new Map([[SPEC_FILE, [
    [TESTER_TABLE_LINE, PRODUCTION_TABLE_LINE, 'a commit counts by the tester table, and a production release sets the production table in its own copy alone'],
    [NO_RECEIPT_KEY_LINE, productionReceiptKeyLine(receiptKey), 'a commit carries no key for cycle receipts, and a production release writes the production one in its own copy alone'],
  ]]]);

  if (from !== to) {
    for (const [file, line] of DOMAIN_LINES) {
      const entry = [line(from), line(to), `it names the commit's dashboard, ${from}, there, and a production release writes ${to}'s, deploy/production/domain's, in its own copy alone`];
      changes.set(file, [...(changes.get(file) ?? []), entry]);
    }
  }

  // Each file's in its order, as git diff reads them.
  for (const [file, entries] of changes) {
    const lines = fs.readFileSync(path.join(commitCli, file), 'utf8').split('\n');
    entries.sort((a, b) => lines.indexOf(a[0]) - lines.indexOf(b[0]));
  }

  return changes;
}

// A production release's copy of the commit, each of its lines set in it: each found once, or nothing is made.
function setProductionLines(cli, changes) {
  for (const [file, entries] of changes) {
    for (const [from, to, why] of entries) {
      replaceLineOnce(cli, file, from, to, why);
    }
  }
}

// The npm on PATH, if it and this Node can run `npm stage`; otherwise a refusal that says why. Its version is compared
// as numbers: as text, 11.9.0 sorts after 11.15.0.
function npmThatCanStage() {
  const node = process.versions.node.split('.').map(Number);

  if (!atLeast(node, NODE_FLOOR)) {
    refuse(`Node ${process.versions.node} is older than ${NODE_FLOOR.join('.')}, which npm stage needs.`);
  }

  const result = run('npm', ['--version']);
  const printed = result.stdout.trim();

  if (result.status !== 0) {
    refuse(`npm --version exited ${result.status ?? result.signal}: ${result.stderr.trim()}`);
  }

  const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(printed);

  if (!version) {
    refuse(`npm --version printed ${JSON.stringify(printed.slice(0, 40))}, not <x>.<y>.<z>.`);
  }

  if (!atLeast(version.slice(1).map(Number), NPM_FLOOR)) {
    refuse(`npm ${printed} is older than ${NPM_FLOOR.join('.')}, which npm stage needs.`);
  }

  return printed;
}

function checkNpm() {
  const npm = npmThatCanStage();
  console.log(`npm ${npm} and Node ${process.versions.node} can stage: npm stage needs npm ${NPM_FLOOR.join('.')} and Node ${NODE_FLOOR.join('.')} or later.`);
}

// --out: a folder outside the repository, new or empty, so that nothing left there can be staged by mistake and the
// working tree stays clean.
function outFolder(setting) {
  if (setting === undefined || setting === '') {
    refuse('give the folder to write the release into with --out, outside the repository.');
  }

  const out = path.resolve(setting);
  // Compared as real paths: on macOS /tmp is /private/tmp, and a folder inside the repository can be named either way.
  const parent = realPath(path.dirname(out));
  const relative = path.relative(realPath(repoRoot) ?? repoRoot, parent === null ? out : path.join(parent, path.basename(out)));

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    refuse(`--out ${out} is inside the repository: give a folder outside it.`);
  }

  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) {
    refuse(`--out ${out} is there already, and not an empty folder: a release is written into a new one.`);
  }

  return out;
}

// The commit the tag names, which must be what is checked out, with nothing changed.
function taggedCommit(tag) {
  if (realPath(git(['rev-parse', '--show-toplevel']).trim()) !== realPath(repoRoot)) {
    refuse(`${repoRoot} is not the top of a git checkout.`);
  }

  const changes = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);

  if (changes.length > 0) {
    refuse(`the working tree has changes, and a release is made from a tagged commit only:\n${changes.slice(0, 20).map((line) => `  ${line}`).join('\n')}${changes.length > 20 ? `\n  … and ${changes.length - 20} more` : ''}`);
  }

  const tagged = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {cwd: repoRoot});

  if (tagged.status !== 0) {
    refuse(`there is no tag ${tag} in this checkout.`);
  }

  const commit = tagged.stdout.trim();
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();

  if (commit !== head) {
    refuse(`${tag} is commit ${commit}, and the checkout is ${head}: check out the tag.`);
  }

  return commit;
}

// Production's domain, from the tagged commit's deploy/production/domain (since ops/3-domain-input): {domain, previous, origin},
// read as deploy/production/domain.mjs reads it, or a refusal that says why.
function productionDomainIn(commit) {
  const shown = run('git', ['show', `${commit}:${PRODUCTION_DOMAIN_FILE}`], {cwd: repoRoot});

  if (shown.status !== 0) {
    refuse(`the tagged commit holds no ${PRODUCTION_DOMAIN_FILE}: a latest release opens and allows production's dashboard, on the domain that file names (docs/deployment-target.md, "Production's domain").`);
  }

  try {
    const {domain, previous} = parseProductionDomain(shown.stdout, staging === null ? null : staging.namesAt(commit));
    return {domain, previous, origin: `https://${domain}`};
  } catch (error) {
    return refuse(`the tagged commit's ${error.message}.`);
  }
}

// A `latest` release is what `npm install @kitkatvn/nghixahoi` gets. Until 2026-10-22 it waited for a production dashboard of
// ours, and refused a CLI that opened the previous project's site or let it read the tracker. Since then (production/1-cli) it
// is production's: the production package, opening production's dashboard and allowing it. Since 2026-10-23 (0.2.4) its allow-list
// holds no hosted origin but production's, where it refused the previous project's site by name. Since ops/3-domain-input the
// commit's CLI opens and allows production's domain, deploy/production/domain's, or while that file names a previous domain, the
// previous one, which the release then writes the domain's over. Its dashboard's origin, which the release's copy replaces.
async function refuseNotProduction(commitCli, commitPackage, production) {
  const spec = await importFresh(path.join(commitCli, 'src/integration-spec.mjs'));
  const cors = await importFresh(path.join(commitCli, 'src/cors.mjs'));
  const named = [production.origin, ...(production.previous === null ? [] : [`https://${production.previous}`])];
  const which = production.previous === null ? `production's dashboard, ${production.origin}/ (${PRODUCTION_DOMAIN_FILE})` : `production's dashboard, ${production.origin}/, or its previous domain's, https://${production.previous}/ (${PRODUCTION_DOMAIN_FILE})`;
  let dashboard;

  if (commitPackage.name !== PRODUCTION_PACKAGE) {
    refuse(`a latest release is ${PRODUCTION_PACKAGE}, and the commit's ${CLI_DIR}/package.json names ${commitPackage.name}.`);
  }

  try {
    dashboard = new URL(spec.DASHBOARD_URL).origin;
  } catch {
    refuse('the commit\'s DASHBOARD_URL is not a URL.');
  }

  const opensNamed = named.includes(dashboard) && spec.DASHBOARD_URL === `${dashboard}/`;

  if (!opensNamed || !allowedByListAlone(cors, dashboard)) {
    refuse(`a latest release's commit opens and allows ${which}, and this commit's CLI ${opensNamed ? 'does not allow it' : 'opens another'} (its DASHBOARD_URL and allow-list, src/integration-spec.mjs and src/cors.mjs).`);
  }

  const otherHosted = [...cors.DEFAULT_ALLOWED_ORIGINS].filter((origin) => origin !== dashboard && !isLocalOrigin(origin));

  if (otherHosted.length > 0) {
    refuse(`a latest release allows no hosted origin but production's dashboard, ${production.origin}, and the local development servers, and this commit's CLI allows ${otherHosted.join(', ')} beside its dashboard, ${dashboard} (its allow-list, src/cors.mjs).`);
  }

  // A latest release sends nothing (the voucher scheme's phase 4): only a tester build names where its diagnostics go.
  if (spec.DIAGNOSTICS_URL !== null) {
    refuse('a latest release sends no diagnostics, and this commit\'s CLI names a destination for them (DIAGNOSTICS_URL, src/integration-spec.mjs): only a tester build sets it.');
  }

  // The commit carries no key for cycle receipts: the release writes production's into its own copy, from the commit's
  // deploy/production/cycle-receipt.pub, and only a tester build carries the staging one's. Until 2026-10-22, a key in the
  // commit was refused as a latest release that takes a receipt, since no production claim backend had a key.
  if (spec.CYCLE_RECEIPT_PUBLIC_KEY !== null) {
    refuse('the commit\'s CLI carries a key for cycle receipts (CYCLE_RECEIPT_PUBLIC_KEY, src/integration-spec.mjs): a commit carries none, and a latest release writes the production claim backend\'s into its own copy, from deploy/production/cycle-receipt.pub, as a tester build writes the staging one\'s.');
  }

  return dashboard;
}

// A claim backend's public key for cycle receipts, from the tagged commit: one line, the key alone, and an Ed25519 public key.
// The staging one's is release-staging.mjs's, which a staging release needs; since 2026-10-22 production's is in
// deploy/production/cycle-receipt.pub, which a release under `latest` needs. Each is made once by the operator on the server.
function receiptKeyIn(commit, file, needs) {
  const shown = run('git', ['show', `${commit}:${file}`], {cwd: repoRoot});

  if (shown.status !== 0) {
    refuse(`the tagged commit holds no ${file}: ${needs}, which the operator makes once on the server and commits there (docs/deployment-target.md, "Cycle receipts: the operator's steps").`);
  }

  const lines = shown.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);

  if (lines.length !== 1 || !RECEIPT_KEY.test(lines[0])) {
    refuse(`the tagged commit's ${file} is not one line holding a public key as the server prints it, 43 characters of base64url.`);
  }

  try {
    const key = crypto.createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x: lines[0]}, format: 'jwk'});

    if (key.asymmetricKeyType !== 'ed25519' || key.export({format: 'jwk'}).x !== lines[0]) {
      throw new Error('not the key given');
    }
  } catch {
    refuse(`the tagged commit's ${file} is not an Ed25519 public key.`);
  }

  return lines[0];
}

const PRODUCTION_KEY_NEEDS = 'a latest release carries the production claim backend\'s public key for cycle receipts';

// The tarball, unpacked, against the commit: the files a pack of the commit holds, the commit's bytes in each but the
// files a tester build changes, and its package.json's version the tag's; a tester build's, the commit's own with its version
// and gitHead, the commit, alone changed (and from 2026-10-22 until 2026-10-29 its name, then the staging package's); a release's,
// the commit's own, with its two lines of the integration spec changed, the production key among them.
async function checkTarball(candidate, {work, commitCli, commitPackage, release, commit, receiptKey, production, changes}) {
  const expectedFiles = packedFiles(commitCli).files;
  fs.mkdirSync(path.join(work, 'check'));
  // By a path relative to the work folder, with forward slashes, as a tester build's maker unpacks: the GNU tar that Git for
  // Windows puts on PATH reads a drive letter's "D:" as a host, and a backslash as part of a name.
  const unpacked = run('tar', ['-xzf', path.relative(work, candidate).split(path.sep).join('/'), '-C', 'check'], {cwd: work});

  if (unpacked.status !== 0) {
    refuse(`tar could not unpack the tarball: ${unpacked.stderr.trim()}`);
  }

  const shipped = path.join(work, 'check', 'package');

  if (!fs.existsSync(path.join(shipped, 'package.json'))) {
    refuse('the tarball holds no package/package.json, as every npm tarball does.');
  }

  const shippedFiles = filesUnder(shipped);

  if (!isDeepStrictEqual(shippedFiles, expectedFiles)) {
    const extra = shippedFiles.filter((file) => !expectedFiles.includes(file));
    const missing = expectedFiles.filter((file) => !shippedFiles.includes(file));
    refuse(`the tarball holds other files than a pack of the commit's CLI: ${[...extra.map((file) => `${file}, which the commit's pack does not hold`), ...missing.map((file) => `no ${file}`)].join('; ')}.`);
  }

  const changed = shippedFiles.filter((file) => !fs.readFileSync(path.join(shipped, file)).equals(fs.readFileSync(path.join(commitCli, file))));
  const allowed = release.staging ? TESTER_BUILD_CHANGES : changes.size === 1 ? LATEST_CHANGES : LATEST_DOMAIN_CHANGES;

  if (!isDeepStrictEqual(changed, allowed)) {
    refuse(release.staging
      ? `the tester build differs from the commit in ${changed.join(', ') || 'no file'}, where a tester build changes ${allowed.join(', ')} alone. If the tester build now changes others, release.mjs's list must follow it, in the same change.`
      : `the tarball differs from the commit in ${changed.join(', ') || 'no file'}: a release ships the commit's files as they are, but ${allowed.join(', ')}: its milestone table and its key for cycle receipts set to production's${changes.size === 1 ? '' : `, and its dashboard to ${production.origin}/, deploy/production/domain's`}.`);
  }

  // A release names the staging package in no file it ships (since 2026-10-30): production's package holds production versions
  // alone, and nothing in it sends a user to a tester build.
  // Where this repository knows the staging package (release-staging.mjs); the public repository's export holds no file that names it.
  if (!release.staging && staging !== null) {
    const naming = shippedFiles.filter((file) => fs.readFileSync(path.join(shipped, file), 'latin1').includes(staging.STAGING_PACKAGE));

    if (naming.length > 0) {
      refuse(`the tarball names the staging package, ${staging.STAGING_PACKAGE}, in ${naming.join(', ')}: a release names none (the staging prompt's caller gives it).`);
    }
  }

  // The milestone table: a tester build counts by the commit's, the tester table; a release by the production table, the
  // one line changed for it, nothing else in the file.
  const expectedTable = release.staging ? 'tester' : 'production';
  const shippedTable = await milestoneTableOf(shipped);

  if (shippedTable.name !== expectedTable || !isDeepStrictEqual(shippedTable.inForce, (shippedTable.tables?.[expectedTable] ?? []).map((milestone) => ({...milestone})))) {
    refuse(`the tarball's milestone table is ${JSON.stringify(shippedTable.name)}, where ${release.staging ? 'a tester build counts by the tester table' : 'a release counts by the production table'} (MILESTONE_TABLE, ${SPEC_FILE}).`);
  }

  const shippedSpec = await importFresh(path.join(shipped, SPEC_FILE));

  if (!release.staging) {
    // Each file in the lines the release writes alone, in the file's order: the key, then the table; and since ops/3-domain-input,
    // when the commit's dashboard is not the domain's, the line that names it.
    for (const [file, entries] of changes) {
      if (!isDeepStrictEqual(lineChanges(path.join(commitCli, file), path.join(shipped, file)), {removed: entries.map(([from]) => from), added: entries.map(([, to]) => to)})) {
        refuse(`the tarball's ${file} differs from the commit's in other lines than ${file === SPEC_FILE ? 'CYCLE_RECEIPT_PUBLIC_KEY\'s and MILESTONE_TABLE\'s' : 'the dashboard\'s'}${file === SPEC_FILE && changes.size > 1 ? ', and DASHBOARD_URL\'s' : ''}.`);
      }
    }

    // What its CLI opens and allows: production's dashboard alone, on the domain of the tagged commit's deploy/production/domain.
    const shippedCors = await importFresh(path.join(shipped, CORS_FILE));
    const hosted = [...shippedCors.DEFAULT_ALLOWED_ORIGINS].filter((origin) => !isLocalOrigin(origin));

    if (shippedSpec.DASHBOARD_URL !== `${production.origin}/` || !isDeepStrictEqual(hosted, [production.origin]) || !allowedByListAlone(shippedCors, production.origin)) {
      refuse(`the tarball's CLI opens ${shippedSpec.DASHBOARD_URL} and allows ${hosted.join(', ') || 'no hosted origin'}, where a latest release opens and allows ${production.origin}/ alone, the domain of the tagged commit's ${PRODUCTION_DOMAIN_FILE}.`);
    }
  }

  // The key it takes a cycle receipt by: the one in the tagged commit, the staging claim backend's for a tester build, and
  // production's for a release.
  if (shippedSpec.CYCLE_RECEIPT_PUBLIC_KEY !== receiptKey) {
    refuse(`the tarball's CYCLE_RECEIPT_PUBLIC_KEY is not the key in the commit's ${release.staging ? staging.STAGING_RECEIPT_KEY_FILE : PRODUCTION_RECEIPT_KEY_FILE}.`);
  }

  const shippedPackage = readJsonFile(path.join(shipped, 'package.json'), 'the tarball\'s package.json');
  // Since 2026-10-31 a tester build's copy also names the repository it is staged from (release-staging.mjs, STAGING_REPOSITORY), where
  // the commit names the public one.
  const {name, version, gitHead, bin, ...shippedAll} = shippedPackage;
  const {name: _commitName, version: _commitVersion, gitHead: _commitGitHead, bin: commitBin, ...commitAll} = commitPackage;
  const withoutRepository = ({repository: _repository, ...rest}) => rest;
  const shippedRest = release.staging ? withoutRepository(shippedAll) : shippedAll;
  const commitRest = release.staging ? withoutRepository(commitAll) : commitAll;

  if (version !== release.version) {
    refuse(`the tarball's version is ${version}, not the tag's ${release.version}.`);
  }

  // A release is the commit's own package, production's; a tester build the staging package, renamed in its copy (since 2026-10-30).
  // Each refuses the other's.
  if (name !== packageOf(release) || (!release.staging && name !== commitPackage.name)) {
    refuse(`the tarball is ${name ?? 'no package'}, where ${release.staging ? `a tester build is the staging package, ${staging.STAGING_PACKAGE}` : `a release is the commit's own package, ${PRODUCTION_PACKAGE}`}.`);
  }

  // The name and version its CLI reads from that package.json, as its runner's fallback and its setup prompts name them.
  if (shippedSpec.CLI_PACKAGE_NAME !== name || shippedSpec.CLI_VERSION !== version) {
    refuse(`the tarball's CLI reads itself as ${shippedSpec.CLI_PACKAGE_NAME}@${shippedSpec.CLI_VERSION}, not ${name}@${version}.`);
  }

  // The command it runs as: its bin names that alone, the commit's, and its CLI says the same.
  if (!isDeepStrictEqual(bin, {[COMMAND]: `bin/${COMMAND}.mjs`}) || !isDeepStrictEqual(bin, commitBin) || shippedSpec.CLI_GLOBAL_COMMAND !== COMMAND) {
    refuse(`the tarball runs as ${shippedSpec.CLI_GLOBAL_COMMAND}, its bin ${JSON.stringify(bin)}, where ${release.staging ? 'a tester build' : 'a release'} runs as ${COMMAND} alone, the commit's bin/${COMMAND}.mjs.`);
  }

  if (release.staging && gitHead !== commit) {
    refuse(`the tester build records ${gitHead ?? 'no commit'} as its gitHead, not the tagged commit ${commit}.`);
  }

  if (!isDeepStrictEqual(shippedRest, commitRest)) {
    refuse(`the tarball's package.json differs from the commit's in more than ${release.staging ? 'its name, its repository, ' : ''}its version and gitHead.`);
  }

  return {name, command: COMMAND, repository: typeof shippedPackage.repository?.url === 'string' ? shippedPackage.repository.url : null, table: shippedTable, dashboard: shippedSpec.DASHBOARD_URL};
}

// A milestone table as a line says it: each milestone's focus time and =, since 2026-10-29 each a threshold on the cycle's totals
// (until then "each counted fresh").
function describeTable(table) {
  return `the ${table.name} table, ${table.inForce.map(({percent, requiredSeconds, requiredEquals}) => `${percent} % at ${requiredSeconds} s and ${requiredEquals} =`).join(', ')}, each a threshold on the cycle's totals`;
}

async function pack(options) {
  const tag = options.tag;

  if (tag === undefined || tag === '') {
    refuse('give the tag with --tag, such as cli-v0.2.0-staging.3.');
  }

  const release = tag.startsWith(TAG_PREFIX) ? releaseOf(tag.slice(TAG_PREFIX.length)) : null;

  if (release === null) {
    refuse(`${JSON.stringify(tag)} is not a release tag: cli-v<x>.<y>.<z> releases that version under latest, and cli-v<x>.<y>.<z>-staging.<N> a tester build under staging.`);
  }

  const out = outFolder(options.out);
  const commit = taggedCommit(tag);
  console.log(`Release ${release.version}, for the dist-tag ${release.distTag}, from ${tag}: commit ${commit} (${git(['log', '-1', '--format=%s', commit]).trim()}).`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nghixahoi-release-'));

  try {
    // The commit's CLI: as it is, to compare with, and for a release a second copy to pack.
    git(['archive', '--format=tar', '-o', path.join(work, 'cli.tar'), commit, CLI_DIR]);
    const copies = release.staging ? ['commit'] : ['commit', 'release'];

    for (const copy of copies) {
      fs.mkdirSync(path.join(work, copy));
      const extracted = run('tar', ['-xf', 'cli.tar', '-C', copy], {cwd: work});

      if (extracted.status !== 0) {
        refuse(`tar could not unpack the commit's CLI: ${extracted.stderr.trim()}`);
      }
    }

    const commitCli = path.join(work, 'commit', CLI_DIR);
    const commitPackage = readJsonFile(path.join(commitCli, 'package.json'), `the commit's ${CLI_DIR}/package.json`);
    let tarball;
    let receiptKey;
    let production = null;
    let changes = null;
    let commitDashboard = null;

    if (release.staging) {
      if (staging === null) {
        refuse(`${tag} is a tester build's tag, and this repository releases ${PRODUCTION_PACKAGE} alone: tester builds are made and staged in the private repository.`);
      }

      receiptKey = receiptKeyIn(commit, staging.STAGING_RECEIPT_KEY_FILE, staging.STAGING_KEY_NEEDS);
      if (commitPackage.name !== PRODUCTION_PACKAGE) {
        refuse(`a tester build is made from a commit of ${PRODUCTION_PACKAGE}, and the commit's ${CLI_DIR}/package.json names ${commitPackage.name}.`);
      }

      tarball = staging.testerBuild(release, receiptKey, staging.originAt(commit));
    } else {
      // In a release workflow, a latest release is made only in the repository its package.json names, the one npm's trusted
      // publisher takes it from (since 2026-10-31 the public one): elsewhere it is refused here, before the pack, not at the stage.
      if (process.env.GITHUB_ACTIONS === 'true' && repositoryAddress(commitPackage.repository?.url) !== `https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}`) {
        refuse(`${tag} releases ${PRODUCTION_PACKAGE}, whose package.json names ${commitPackage.repository?.url ?? 'no repository'}, and this run is in https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}: a latest release is made in that repository alone.`);
      }

      if (commitPackage.version !== release.version) {
        refuse(`${tag} names ${release.version}, and the commit's ${CLI_DIR}/package.json says ${commitPackage.version}: a release is tagged with its package.json's version, the one place it lives.`);
      }

      production = productionDomainIn(commit);
      commitDashboard = await refuseNotProduction(commitCli, commitPackage, production);
      receiptKey = receiptKeyIn(commit, PRODUCTION_RECEIPT_KEY_FILE, PRODUCTION_KEY_NEEDS);
      // The production table and the production key, in the release's copy alone (the plan of 2026-10-20, decision 4; since
      // 2026-10-22, production/1-cli, the key); and since ops/3-domain-input, the domain's dashboard, when the commit names another.
      changes = productionLines(commitCli, receiptKey, {from: commitDashboard, to: production.origin});
      setProductionLines(path.join(work, 'release', CLI_DIR), changes);
      fs.mkdirSync(path.join(work, 'packed'));
      const packed = packedFiles(path.join(work, 'release', CLI_DIR), path.join(work, 'packed'));
      tarball = path.join(work, 'packed', packed.filename);
    }

    // The bytes checked are the bytes written: a copy in the work folder, checked, then copied out.
    const candidate = path.join(work, 'candidate.tgz');
    fs.copyFileSync(tarball, candidate);
    const {name, command, repository, table, dashboard} = await checkTarball(candidate, {work, commitCli, commitPackage, release, commit, receiptKey, production, changes});

    const fileName = `nghixahoi-${release.version}.tgz`;
    fs.mkdirSync(out, {recursive: true});
    writeInto(out, fileName, (partial) => fs.copyFileSync(candidate, partial));
    const bytes = fs.readFileSync(path.join(out, fileName));
    const sha256 = sha256Of(bytes);
    const integrity = integrityOf(bytes);
    // The sha256sum format, which `shasum -a 256 -c` and `sha256sum -c` read.
    writeInto(out, `${fileName}.sha256`, (partial) => fs.writeFileSync(partial, `${sha256}  ${fileName}\n`));
    const record = {package: name, version: release.version, distTag: release.distTag, tag, commit, tarball: fileName, sha256, integrity, repository};
    writeInto(out, RECORD, (partial) => fs.writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`));

    console.log(`Packed ${name}@${release.version} for the dist-tag ${release.distTag}`);
    console.log(`  commit: ${commit}`);
    console.log(`  command: ${command}`);
    console.log(`  dashboard: ${dashboard}`);

    if (production !== null) {
      console.log(`  domain: ${production.domain}, from ${PRODUCTION_DOMAIN_FILE}${production.previous === null ? '' : `, moved from ${production.previous}`}; ${changes.size === 1 ? 'the commit\'s CLI names it already' : `written over ${commitDashboard}, which the commit's CLI names, in its three lines (${DOMAIN_LINES.map(([file]) => file).join(', ')})`}`);
    }
    console.log(`  milestones: ${describeTable(table)}`);
    // Since 2026-10-23 (tracking/2-cli): where its tracker fetches the campaign's targets and end, the same key's (src/tracking-config.mjs),
    // DASHBOARD_URL's own address, which this script has nothing to swap for.
    console.log(`  campaign targets: fetched by the tracker from ${new URL('v1/tracking-config', dashboard).href} about once an hour, taken when signed with the key whose public half is ${receiptKey}; the milestones above until one is`);
    console.log(`  cycle receipts: taken when signed with the key whose public half is ${receiptKey}, the ${release.staging ? 'staging' : 'production'} claim backend's (${release.staging ? staging.STAGING_RECEIPT_KEY_FILE : PRODUCTION_RECEIPT_KEY_FILE})`);
    console.log(`  tarball: ${path.join(out, fileName)} (${bytes.length} bytes)`);
    console.log(`  sha256: ${sha256}`);
    console.log(`  integrity: ${integrity}`);
    console.log(`Staged by: npm stage publish ${fileName} --tag ${release.distTag}, from the release workflow alone.`);
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

// A release run's record, checked against itself and against the tarball beside it.
function readRecordIn(folder) {
  const file = path.join(folder, RECORD);
  const record = readJsonFile(file, file);
  const release = typeof record?.version === 'string' ? releaseOf(record.version) : null;
  const valid = release !== null
    && typeof record.package === 'string' && record.package !== ''
    && record.distTag === release.distTag
    && record.tag === `${TAG_PREFIX}${record.version}`
    && typeof record.commit === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(record.commit)
    && record.tarball === `nghixahoi-${record.version}.tgz`
    && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.sha256)
    && typeof record.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity)
    && (record.repository === null || typeof record.repository === 'string');

  if (!valid) {
    refuse(`${file} is not a record pack writes: its version, dist-tag, tag, commit, tarball, SHA-256 and integrity must agree.`);
  }

  const tarball = path.join(folder, record.tarball);

  if (!fs.existsSync(tarball)) {
    refuse(`${tarball}, which ${file} names, is not there.`);
  }

  const bytes = fs.readFileSync(tarball);

  if (sha256Of(bytes) !== record.sha256 || integrityOf(bytes) !== record.integrity) {
    refuse(`${tarball} does not match its record: it is not the tarball pack checked.`);
  }

  return {...record, release, folder};
}

// git+https://github.com/<owner>/<repository>.git, as package.json writes it, as the repository's address.
function repositoryAddress(url) {
  return typeof url === 'string' ? url.replace(/^git\+/u, '').replace(/\.git$/u, '') : null;
}

async function stage(options) {
  if (options.out === undefined || options.out === '') {
    refuse('give the folder pack wrote with --out.');
  }

  const out = path.resolve(options.out);
  const record = readRecordIn(out);

  // Only the release workflow stages, and only the tag it was pushed for: a release comes from a pushed tag, through CI.
  if (process.env.GITHUB_ACTIONS !== 'true') {
    refuse('a release is staged by .github/workflows/release.yml alone, from a pushed tag. The first stage of a package that does not exist yet is the operator\'s, by hand, from a release run\'s artifact (docs/way-of-working.md, "Releasing").');
  }

  if (process.env.GITHUB_REF !== `refs/tags/${record.tag}`) {
    refuse(`this run is for ${process.env.GITHUB_REF || 'no ref'}, and the record for refs/tags/${record.tag}.`);
  }

  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();

  if (head !== record.commit) {
    refuse(`the checkout is ${head}, and the record was packed from ${record.commit}.`);
  }

  // npm's trusted publishing takes a package only from the repository its package.json names (docs.npmjs.com, "Trusted
  // publishing for npm packages").
  const repository = `https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}`;

  if (repositoryAddress(record.repository) !== repository) {
    refuse(`the package's repository.url is ${record.repository ?? 'not set'}, and this run is in ${repository}: npm's trusted publishing takes a package only from the repository it names.`);
  }

  npmThatCanStage();

  const tarball = path.join(out, record.tarball);
  const args = ['stage', 'publish', tarball, '--tag', record.distTag, '--json'];
  console.log(`npm ${args.join(' ')}`);
  const staged = run('npm', args, {cwd: out});
  // npm's own log, whatever happened.
  process.stderr.write(staged.stderr);

  if (staged.status !== 0) {
    process.stdout.write(staged.stdout);
    refuse(`npm stage publish exited ${staged.status ?? staged.signal}, and nothing is staged unless npm stage list says so. A package's first stage, before it has a trusted publisher, is the operator's by hand from this run's artifact (docs/way-of-working.md, "Releasing").`);
  }

  let answer;

  try {
    answer = JSON.parse(staged.stdout)?.[record.package];
  } catch {
    answer = undefined;
  }

  if (answer?.name !== record.package || answer?.version !== record.version || answer?.integrity !== record.integrity) {
    process.stdout.write(staged.stdout);
    refuse(`npm staged, and its answer does not name ${record.package}@${record.version} with the integrity checked, ${record.integrity}. Do not approve it: compare npm stage download with this run's SHA-256, and reject a stage that differs (npm stage reject).`);
  }

  const stageId = typeof answer.stageId === 'string' && answer.stageId !== '' ? answer.stageId : null;
  const lines = [
    `Staged, not released: ${record.package}@${record.version}, for the dist-tag ${record.distTag}.`,
    `  stage id: ${stageId ?? '(npm named none: npm stage list ' + record.package + ')'}`,
    `  commit: ${record.commit}`,
    `  sha256: ${record.sha256}`,
    `  integrity: ${record.integrity}`,
    'Nothing is public until a maintainer approves it with 2FA; then release-verify.yml says whether it is released (docs/way-of-working.md, "Releasing").',
  ];
  console.log(lines.join('\n'));
  summarize([`### Staged, not released: ${record.package}@${record.version}`, '', '```', ...lines.slice(1, 5), '```', '', lines[5]]);
}

// Every record under `folder`, where a release run's artifacts were downloaded, at any depth up to four.
function recordsUnder(setting) {
  if (setting === undefined || setting === '') {
    refuse('give the folder the release runs\' artifacts were downloaded into with --records.');
  }

  const folder = path.resolve(setting);

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    refuse(`${folder} is not a folder.`);
  }

  const found = [];
  const walk = (current, depth) => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      if (entry.isFile() && entry.name === RECORD) {
        found.push(current);
      } else if (entry.isDirectory() && depth < 4) {
        walk(path.join(current, entry.name), depth + 1);
      }
    }
  };
  walk(folder, 0);

  return found.sort().map(readRecordIn);
}

async function fetchFrom(url, what, accept) {
  try {
    return await fetch(url, {headers: {accept}, redirect: 'error', signal: AbortSignal.timeout(60_000)});
  } catch (error) {
    return refuse(`${what} could not be read from ${url}: ${error.cause?.message ?? error.message}`);
  }
}

// A refusal after an answer whose body is not read: the body is let go first, since an unread one holds its connection,
// and with it the process, until the server closes it (six seconds for a 404 that carried a tarball, measured).
async function refuseAnswer(answer, problem) {
  await answer.body?.cancel().catch(() => {});
  refuse(problem);
}

async function verify(options) {
  const release = typeof options.version === 'string' ? releaseOf(options.version) : null;

  if (release === null) {
    refuse('give the version a maintainer approved with --version: <x>.<y>.<z>, or <x>.<y>.<z>-staging.<N>.');
  }

  const records = recordsUnder(options.records);

  if (records.length === 0) {
    refuse(`there is no ${RECORD} under ${path.resolve(options.records)}: a release run keeps it in its artifact.`);
  }

  const agreed = ({package: name, version, distTag, commit, sha256, integrity}) => ({name, version, distTag, commit, sha256, integrity});
  const [record] = records;

  if (record.version !== release.version) {
    refuse(`the record is for ${record.version}, not ${release.version}.`);
  }

  if (records.some((other) => !isDeepStrictEqual(agreed(other), agreed(record)))) {
    refuse(`the release runs' records disagree, so which tarball was staged is not known: ${records.map((other) => `${path.relative(path.resolve(options.records), other.folder) || '.'}: ${other.version} ${other.integrity}`).join('; ')}.`);
  }

  // Each channel's package: release-verify.yml runs this from the default branch, whose package.json is production's, for a staging
  // version too. One package for both on 2026-10-29 alone; two since 2026-10-30, as from 2026-10-22 until then.
  const packageName = packageOf(release);

  if (record.package !== packageName) {
    refuse(`the record is for ${record.package}, not ${packageName}, the ${release.distTag} channel's package.`);
  }

  let registry;

  try {
    registry = new URL(options.registry ?? REGISTRY);
  } catch {
    refuse('--registry is not a URL.');
  }

  if (registry.protocol !== 'https:' && registry.protocol !== 'http:') {
    refuse('--registry is not an http or https URL.');
  }

  // The whole document, not the abbreviated one installs read: it holds each version's gitHead.
  const documentUrl = new URL(`${registry.pathname.replace(/\/$/u, '')}/${record.package.replace('/', '%2f')}`, registry.origin);
  const answer = await fetchFrom(documentUrl, `${record.package}'s document`, 'application/json');

  if (answer.status === 404) {
    await refuseAnswer(answer, `the registry has no ${record.package} (404 from ${documentUrl}): ${record.version} is not released.`);
  }

  if (answer.status !== 200) {
    await refuseAnswer(answer, `the registry answered ${answer.status} for ${documentUrl}.`);
  }

  let packument;

  try {
    packument = await answer.json();
  } catch {
    refuse(`the registry's answer for ${documentUrl} is not JSON.`);
  }

  const published = packument?.versions?.[record.version];

  if (!published) {
    refuse(`the registry does not serve ${record.package}@${record.version}: it is staged and not approved, or rejected, and in either case not released.`);
  }

  if (published.dist?.integrity !== record.integrity) {
    refuse(`the registry serves ${record.version} with the integrity ${published.dist?.integrity ?? '(none)'}, not the one staged, ${record.integrity}.`);
  }

  const tagged = packument['dist-tags']?.[record.distTag];

  if (tagged !== record.version) {
    refuse(`the dist-tag ${record.distTag} points at ${tagged ?? 'nothing'}, not ${record.version}.`);
  }

  // Each package's dist-tags on its own channel's versions: production's `latest` on a release, never a tester build, which would give
  // a bare `npm install` a build that sends diagnostics to staging, and no `staging` tag at all, since it holds production versions
  // alone; the staging package's `staging` on a tester build. Its `latest` is the operator's to move, as it has been since 2026-10-02.
  const channels = release.staging ? [['staging', true]] : [['latest', false], ['staging', false]];

  for (const [distTag, testerChannel] of channels) {
    const pointed = packument['dist-tags']?.[distTag];

    if (!release.staging && distTag === 'staging' && pointed !== undefined) {
      refuse(`${record.package} has a dist-tag staging, at ${pointed}: it holds production versions alone, and tester builds are ${staging?.STAGING_PACKAGE ?? 'the staging package'}'s. Remove it with npm dist-tag rm ${record.package} staging, with 2FA (docs/way-of-working.md, "Undoing a bad release").`);
    }

    if (pointed !== undefined && releaseOf(pointed)?.staging !== testerChannel) {
      refuse(`the dist-tag ${distTag} points at ${pointed}, which is ${testerChannel ? 'not a tester build, <x>.<y>.<z>-staging.<N>' : 'not a release, <x>.<y>.<z>'}: each version stays on its own channel's dist-tag. Move it back with npm dist-tag add ${record.package}@<the last good version> ${distTag}, with 2FA (docs/way-of-working.md, "Undoing a bad release").`);
    }
  }

  if (release.staging && published.gitHead !== record.commit) {
    refuse(`the registry's ${record.version} names ${published.gitHead ?? 'no commit'} as its gitHead, not the tagged commit ${record.commit}.`);
  }

  let tarballUrl;

  try {
    tarballUrl = new URL(published.dist.tarball);
  } catch {
    refuse(`the registry names no tarball URL for ${record.version}.`);
  }

  if (tarballUrl.origin !== registry.origin) {
    refuse(`the registry names its tarball at ${tarballUrl.origin}, not at the registry, ${registry.origin}.`);
  }

  const download = await fetchFrom(tarballUrl, `the tarball of ${record.version}`, 'application/octet-stream');

  if (download.status !== 200) {
    await refuseAnswer(download, `the registry answered ${download.status} for the tarball, ${tarballUrl}.`);
  }

  const bytes = Buffer.from(await download.arrayBuffer());
  const sha256 = sha256Of(bytes);

  if (integrityOf(bytes) !== record.integrity || sha256 !== record.sha256) {
    refuse(`the tarball the registry serves at ${tarballUrl} is not the one staged: its SHA-256 is ${sha256}, and the record's ${record.sha256}.`);
  }

  const latest = packument['dist-tags']?.latest;
  const lines = [
    `Released: ${record.package}@${record.version}, and the dist-tag ${record.distTag} points at it.`,
    `  commit: ${record.commit}`,
    `  sha256: ${sha256}, of the tarball the registry serves`,
    `  integrity: ${record.integrity}`,
    `  latest: ${latest ?? '(no latest)'}${record.distTag === 'latest' ? '' : `, which npm install ${record.package} installs`}`,
  ];
  console.log(lines.join('\n'));
  summarize([`### Released: ${record.package}@${record.version}`, '', '```', ...lines.slice(1), '```']);
}

const COMMANDS = {
  'check-npm': {options: [], run: checkNpm, refused: 'npm cannot stage'},
  pack: {options: ['--tag', '--out'], run: pack, refused: 'Not packed'},
  stage: {options: ['--out'], run: stage, refused: 'Not staged'},
  verify: {options: ['--version', '--records', '--registry'], run: verify, refused: 'Not released'},
};

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || name === '--help' || name === '-h' || rest.includes('--help') || rest.includes('-h')) {
  console.log(USAGE);
} else if (!Object.hasOwn(COMMANDS, name)) {
  console.error(`${/^[a-z][a-z-]*$/u.test(name) ? `There is no command ${name}.` : 'That is not a command.'} Run it with --help.`);
  process.exitCode = 2;
} else {
  try {
    await COMMANDS[name].run(parseArguments(rest, COMMANDS[name].options));
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }

    console.error(`${COMMANDS[name].refused}: ${error.message}`);
    process.exitCode = 1;
  }
}
