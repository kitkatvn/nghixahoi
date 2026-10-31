// The CLI's own package.json, for its name and its version, which live there alone (hard rule 6). From 2026-10-22
// (production/1-cli) to 2026-10-30 the production setup prompt installed this version by number; since then no setup prompt names
// a version (CLI_INSTALL_COMMAND, below). The dashboard, which bundles this file, takes both from here, for its update notice: a
// JSON module, which Node loads without a warning from 22.12.0, the engines floor, and of which Vite bundles only the two fields
// read. Until 2026-10-22 this file imported nothing.
import cliPackage from '../package.json' with {type: 'json'};

// The package: package.json's name and version, production's, whose releases are under npm's `latest`. Since 2026-10-30 (the
// operator, in the naming plan of 2026-10-29 in docs/plans) it holds production versions alone: a tester build, 0.3.0-staging.<N>,
// is the staging package, under `staging`, named in the tester build's own copy of package.json, and so read here in it. Nothing in this file names that package: the staging prompt's caller gives it (stagingSetupPromptFor, below).
// On 2026-10-29 alone both builds were to be this one package.
export const CLI_PACKAGE_NAME = cliPackage.name;
export const CLI_VERSION = cliPackage.version;
export const CLI_PACKAGE_COMMAND = `npx ${CLI_PACKAGE_NAME}`;
export const CLI_GLOBAL_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE_NAME}`;
// What a setup prompt installs, and what Kit=Code says to install it again with: this package at its channel's npm dist-tag, never a
// version. A release, <x>.<y>.<z>, is `latest`'s; a tester build, <x>.<y>.<z>-staging.<N>, whose copy of package.json names the
// staging package, is `staging`'s, so its copy says `@staging` with no line changed here.
//
// 2026-10-30, the operator: "ok go with the latest approach for both staging and production", because "this prompt will be required
// in the TC, if in case we update the version, the version name will change so it will contradict with the TC and cause legal
// issues". So the setup prompts' text is the same in every release. From 2026-10-22 (production/1-cli) until then the production
// prompt installed this version by number, CLI_PINNED_INSTALL_COMMAND, `${CLI_GLOBAL_INSTALL_COMMAND}@${CLI_VERSION}`, so that the
// dashboard and the CLI it installed were one commit's. Now, between the operator's approval on npm and the deploy of the same
// release, the prompt installs the new CLI beside the previous release's dashboard and claim backend: the release order is approve,
// then deploy at once (docs/way-of-working.md, "Releasing"), and test/previous-release.test.mjs holds this CLI to the previous
// release's local API, claim bundle and signed documents.
export const CLI_DIST_TAG = /-staging\.[1-9][0-9]*$/u.test(CLI_VERSION) ? 'staging' : 'latest';
export const CLI_INSTALL_COMMAND = `${CLI_GLOBAL_INSTALL_COMMAND}@${CLI_DIST_TAG}`;
// The command Kit=Code runs as, in both builds, and its runner's name (RUNNER_PATH_PARTS, below): what package.json's bin names.
// Everything the CLI says of a command is built from it. The hooks and the runner an install from before 2026-10-29 left are
// recognised by src/legacy.mjs alone, and replaced.
export const CLI_GLOBAL_COMMAND = 'nghixahoi';
// Production's dashboard since 2026-10-22 (production/1-cli): what `nghixahoi dashboard` opens, and the origin every tracker
// `nghixahoi track` starts allows (src/cors.mjs, bin/nghixahoi.mjs). A tester build's copy names the staging site here. Until then the previous project's site, which is not ours. Since ops/3-domain-input it is on production's domain, deploy/production/domain's
// (or, while that file names a previous domain, the previous one): a release under latest writes the domain's here, in its own
// copy, when the commit names another (scripts/release.mjs), and so does the dashboard's build, in the copy it bundles
// (apps/web vite.config.ts, productionSite), so that the setup prompts a page copies name the page they are copied from.
export const DASHBOARD_URL = 'https://nghixahoi.vn/';
// Where a tester build sends Kit=Code's own diagnostics (src/diagnostics.mjs; docs/backend.md, "Tester diagnostics"): the
// staging dashboard's /v1/diagnostics, which a tester build alone writes here, as it writes DASHBOARD_URL. null in
// the repository, and so in every release of it: such a CLI collects, writes and sends no diagnostics at all.
export const DIAGNOSTICS_URL = null;
// The claim backend's public key for cycle receipts (src/cycle-receipt.mjs; docs/backend.md, "The cycle receipt"): base64url of
// the 32 raw bytes of the Ed25519 key whose private half exists on the claim backend's server alone. The tracker begins a
// cycle only on a receipt it signed (api.mjs, POST /api/claim/receipt). Public, as the repository is, and written here by
// a tester build, from the key the staging server printed, as it writes DIAGNOSTICS_URL; and since 2026-10-22 (production/1-cli) by scripts/release.mjs in a production release's copy, from the key
// the production server printed (deploy/production/cycle-receipt.pub). null in the repository: a CLI run from it takes no
// receipt, and never begins a second cycle.
export const CYCLE_RECEIPT_PUBLIC_KEY = null;
export const LOCAL_SERVER_URL = 'http://127.0.0.1:4747';
// The state folder, ~/.nghixahoi, in both builds since 2026-10-29 (the plan of that day): the user's progress, the tracker's record,
// the runner. src/store.mjs resolves it.
export const STATE_DIR_NAME = '.nghixahoi';
export const STATE_DISPLAY_PATH = `~/${STATE_DIR_NAME}/state.json`;
// The runner the hooks run, named as the command is, in the state folder.
export const RUNNER_PATH_PARTS = [STATE_DIR_NAME, 'bin', CLI_GLOBAL_COMMAND];
export const RUNNER_DISPLAY_PATH = `~/${RUNNER_PATH_PARTS.join('/')}`;

// The milestones and the = each needs (docs/reward-rules.md §2). Until 2026-10-01 each had a break code, one fixed line of
// code shown to everyone; the operator's decision 6 of that day replaced them with a message the claim backend's
// settings give each milestone, which the dashboard shows. A tier holds a record in the state file: the hook's
// announcements, and a code shown before then.
//
// Since 2026-10-08 (rewards/1-milestones-bar; the operator: "change milestone to: 30% - 50% - 100%") the milestones are
// 30, 50 and 100 %, each with the targets it had: 30 % the one tier, 50 and 100 % shown and never announced, as before.
// Until then 10 % (3 =, 6 min) and 20 % (6 =, 12 min) were tiers too. A record an earlier version kept of either, an
// announcement, a code shown or the time it was reached, stays in the file as it is, and nothing reads it.
//
// Since 2026-10-20 (rewards/2-no-stack; the plan of that day, decisions 1 and 4) each milestone's targets, its focus time
// and its =, are counted fresh from the moment the milestone before it was reached, the first's from install, and each
// milestone names its own focus time, where 3600 s × its percent was the time target until then (reward.mjs). Two tables,
// both public: the tester table, the short one, which every build of this repository and every tester build counts by,
// its numbers the ones the milestones had; and the production table, whose numbers are DRAFTS until the client gives the
// campaign's length: 3 h and 300 =, 5 h and 500 =, 10 h and 1,000 =, so 18 h and 1,800 = in all to reach 100 %.
// MILESTONE_TABLE names the one in force: 'tester' here, and so in every tester build; a production release's copy alone
// says 'production', which scripts/release.mjs writes there, one line, checked line by line, as a tester build writes
// DASHBOARD_URL.
//
// Since 2026-10-21 both tables hold the operator's numbers of that day ("change the progress to 30% - 3h - 300 = / 50% -
// 5h - 500 = / 100% - 8h - 1000 =", then "1. staging too 2. as written"): 3 h and 300 =, 5 h and 500 =, 8 h and 1,000 =,
// so 16 h and 1,800 = in all to reach 100 %. Tester builds have no short targets any more, which reverses the plan's
// decision 4 for the tester table; the production table's numbers are no longer drafts, and its 100 % is 8 h where the
// draft said 10. The two tables stay two, equal, so that production's can differ again by one table's edit (a ruling,
// docs/reward-rules.md §2). Until then the tester table was 1080 s and 9 =, 1800 s and 12 =, 3600 s and 15 =.
//
// Since 2026-10-22 the tester table is that short one again (the operator: "scale down the focus time and = requirements as
// the previous time for staging for testing easier, keep the same for production"): 18 minutes and 9 =, 30 and 12, 60 and
// 15, so 108 minutes and 36 = in all to reach 100 %, each still counted fresh. The production table keeps the operator's
// numbers of 2026-10-21, and the two differ again. The claim backend holds a claim to its own MILESTONE_* settings, which
// staging's server sets to the tester table by hand (docs/deployment-target.md).
//
// Since 2026-10-29 the production table is the client's, through the operator ("change the tracking to this config in production",
// then "counted fresh, 10h total"): 2 h and 200 =, 3 h and 400 =, 5 h and 600 =; the tester table is unchanged. Until then it was
// 3 h and 300 =, 5 h and 500 =, 8 h and 1,000 =.
//
// Later on 2026-10-29 (rewards/5-cumulative; docs/plans/2026-10-29-milestones-cumulative.md; the operator: "so total they only need
// 600 = and max 5 hours to get to 100%, not stack like this") every number in both tables is a threshold on the cycle's totals, the
// focus time and the = counted since the cycle began, not a segment counted fresh from the milestone before: 100 % is reached at 5 h
// and 600 = in all in the production table, where it took 10 h and 1,200 = counted fresh, and at 60 minutes and 15 = in the tester
// table, where it took 108 minutes and 36 =. The numbers did not move; their meaning did (reward.mjs decideMilestones).
export const MILESTONE_TABLES = Object.freeze({
  tester: Object.freeze([
    Object.freeze({percent: 30, requiredSeconds: 1080, requiredEquals: 9}),
    Object.freeze({percent: 50, requiredSeconds: 1800, requiredEquals: 12}),
    Object.freeze({percent: 100, requiredSeconds: 3600, requiredEquals: 15}),
  ]),
  production: Object.freeze([
    Object.freeze({percent: 30, requiredSeconds: 7200, requiredEquals: 200}),
    Object.freeze({percent: 50, requiredSeconds: 10800, requiredEquals: 400}),
    Object.freeze({percent: 100, requiredSeconds: 18000, requiredEquals: 600}),
  ]),
});

export const MILESTONE_TABLE = 'tester';

const MILESTONE_TARGETS = MILESTONE_TABLES[MILESTONE_TABLE];

if (!Array.isArray(MILESTONE_TARGETS)) {
  throw new Error(`MILESTONE_TABLE is ${JSON.stringify(MILESTONE_TABLE)}, which is not one of the milestone tables: ${Object.keys(MILESTONE_TABLES).join(', ')}.`);
}

// 30 %, the first milestone, is the one tier; 50 and 100 % are shown alone.
export const NGHIXAHOI_REWARD_TIERS = MILESTONE_TARGETS.slice(0, 1).map((milestone) => ({...milestone}));

export const NGHIXAHOI_DISPLAY_MILESTONES = MILESTONE_TARGETS.slice(1).map((milestone) => ({...milestone, displayOnly: true}));

export const AGENT_SPECS = {
  codex: {
    source: 'codex',
    agentName: 'Codex',
    setupCommand: `${CLI_GLOBAL_COMMAND} codex on`,
    statusCommand: `${CLI_GLOBAL_COMMAND} codex status`,
    offCommand: `${CLI_GLOBAL_COMMAND} codex off`,
    skillPathParts: ['.codex', 'skills', 'nghixahoi', 'SKILL.md'],
    hookConfigPathParts: ['.codex', 'hooks.json'],
    hookEventName: 'UserPromptSubmit',
  },
  claude: {
    source: 'claude',
    agentName: 'Claude',
    setupCommand: `${CLI_GLOBAL_COMMAND} claude on`,
    statusCommand: `${CLI_GLOBAL_COMMAND} claude status`,
    offCommand: `${CLI_GLOBAL_COMMAND} claude off`,
    skillPathParts: ['.claude', 'skills', 'nghixahoi', 'SKILL.md'],
    hookConfigPathParts: ['.claude', 'settings.json'],
    hookEventName: 'UserPromptSubmit',
  },
};

export function nghixahoiCommand(command = '') {
  return command ? `${CLI_PACKAGE_COMMAND} ${command}` : CLI_PACKAGE_COMMAND;
}

export function globalNghixahoiCommand(command = '') {
  return command ? `${CLI_GLOBAL_COMMAND} ${command}` : CLI_GLOBAL_COMMAND;
}

export function sourceConfig(source) {
  const config = AGENT_SPECS[source];

  if (!config) {
    throw new Error(`Unsupported Kit=Code integration source: ${source}`);
  }

  return config;
}

export function displayHomePath(pathParts) {
  return `~/${pathParts.join('/')}`;
}

export function shellQuote(value) {
  const text = String(value);

  if (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(text)) {
    return text;
  }

  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

// On Windows, Claude Code runs a hook's command in Git Bash, or in PowerShell when Git Bash is not
// installed, and Codex runs it in PowerShell (docs/security.md, "The prompt hook on Windows"). A command
// a shell cannot parse fails there, and one bash cannot parse exits 2, which blocks the user's prompt and
// erases it. So on Windows the command is one both shells read the same way: `node`, which both find on
// PATH, then the runner module beside the runner (runner-installer.mjs), as one quoted argument with
// forward slashes, which both take in a path and neither reads as an escape. It is in double quotes,
// unless the path holds $ or a backtick, which both expand there, or a quote PowerShell ends them with;
// then in single quotes, in which neither expands anything, unless the path also holds a quote either
// shell ends those with. Such a path keeps the command macOS and Linux have, which bash parses whatever
// the path, and so never exits 2 for.
const DOUBLE_QUOTED_UNSAFE = /[$`"“”„]/u;
const SINGLE_QUOTED_UNSAFE = /['‘’‚‛]/u;

function windowsRunnerArgument(runnerPath) {
  const runnerModule = `${runnerPath.replaceAll('\\', '/')}.mjs`;

  if (!DOUBLE_QUOTED_UNSAFE.test(runnerModule)) {
    return `"${runnerModule}"`;
  }

  return SINGLE_QUOTED_UNSAFE.test(runnerModule) ? null : `'${runnerModule}'`;
}

export function hookCommandFor(source, options = {}) {
  sourceConfig(source);

  const runnerPath = options.runnerPath ?? RUNNER_DISPLAY_PATH;
  // globalThis: the dashboard bundles this file for its setup prompts, and a browser has no process.
  const platform = options.platform ?? globalThis.process?.platform;
  const windowsArgument = platform === 'win32' && options.runnerPath !== undefined ? windowsRunnerArgument(runnerPath) : null;

  // Everywhere else, and in the display form the setup prompts show, the command Kit=Code has always
  // written: Codex makes its users approve a hook again whenever its command changes (docs/security.md).
  return windowsArgument === null
    ? `${shellQuote(runnerPath)} hook prompt --source ${source}`
    : `node ${windowsArgument} hook prompt --source ${source}`;
}

export function hookConfigFor(source, options = {}) {
  return {
    type: 'command',
    command: hookCommandFor(source, options),
    timeout: 5,
  };
}

const REMOTE_SESSION_REDIRECT = {
  codex: 'Run commands on my local machine shell, not a remote sandbox. If you only have a remote session, tell me to paste this prompt into Codex Task or a Codex project chat instead.',
  claude: 'Run commands on my local machine shell, not a remote sandbox. If you only have a remote session, tell me to paste this prompt into Claude Code instead.',
};

export function nghixahoiSkillMarkdown(source) {
  const config = sourceConfig(source);
  const skillPath = displayHomePath(config.skillPathParts);

  return [
    '---',
    'name: nghixahoi',
    `description: "KitKat Have-a-break -- local-first reward companion for ${config.agentName}. Use for Kit=Code setup, tracker status, rewards, and dashboard requests. Use Kit=Code CLI and hook context as the source of truth; do not calculate or mutate rewards yourself."`,
    '---',
    '',
    '# Kit=Code',
    '',
    'Use this skill only as an opt-in break reward. Never block, gate, delay, or nag about work.',
    '',
    'Kit=Code is local-first. The CLI owns tracking and reward state. The durable local state lives at:',
    '',
    `    ${STATE_DISPLAY_PATH}`,
    '',
    'The local dashboard reads from the Kit=Code server at:',
    '',
    `    ${LOCAL_SERVER_URL}`,
    '',
    'When Kit=Code hook context says a milestone was reached, briefly tell the user they can open:',
    '',
    `    ${RUNNER_DISPLAY_PATH} dashboard`,
    '',
    'The prompt hook runs after each prompt submit and may add compact progress context such as total `=` counted, active time, next break remaining (`=` left and time left), or milestones reached. Treat that hook context as authoritative.',
    'When hook context includes remaining equals and time to the next break milestone, briefly mention both in one short line after your normal answer on every turn (for example: `Break next: 120 = to break · 1h 20m to break (30%).`). Do not calculate these values yourself.',
    '',
    'Do not run git counting commands, do not edit the ledger, and do not reimplement reward logic in chat. Use the Kit=Code CLI/server/hook output as the authority.',
    '',
    '## Chat actions',
    '',
    'When the user directly asks to open a Kit=Code surface, run the matching command without asking for confirmation. These actions are opt-in and local:',
    '',
    `- Open dashboard — for “mở dashboard”, “xem tiến độ”, “show my Kit=Code progress”, or equivalent: \`${RUNNER_DISPLAY_PATH} dashboard\`.`,
    '',
    `When the user starts a message with \`/${CLI_GLOBAL_COMMAND}\`, treat it as a Kit=Code management shortcut and run the matching local CLI command:`,
    '',
    `- \`/${CLI_GLOBAL_COMMAND} track\` or \`/${CLI_GLOBAL_COMMAND} start\` — run \`${RUNNER_DISPLAY_PATH} track\`.`,
    `- \`/${CLI_GLOBAL_COMMAND} summary\`, \`/${CLI_GLOBAL_COMMAND} progress\`, or \`/${CLI_GLOBAL_COMMAND} status\` — run \`${RUNNER_DISPLAY_PATH} summary\` or \`${RUNNER_DISPLAY_PATH} status\`.`,
    `- \`/${CLI_GLOBAL_COMMAND} award\`, \`/${CLI_GLOBAL_COMMAND} awards\`, or \`/${CLI_GLOBAL_COMMAND} rewards\` — run \`${RUNNER_DISPLAY_PATH} awards\`.`,
    `- \`/${CLI_GLOBAL_COMMAND} dashboard\` — run \`${RUNNER_DISPLAY_PATH} dashboard\`.`,
    `- \`/${CLI_GLOBAL_COMMAND} setup\` — run \`${RUNNER_DISPLAY_PATH} setup\`.`,
    '',
    'If the tracker is not running, run the requested command first and report its CLI error; only start it with the user’s explicit request to start tracking.',
    '',
    'Useful checks:',
    '',
    `    ${RUNNER_DISPLAY_PATH} ${source} status`,
    `    ${RUNNER_DISPLAY_PATH} track`,
    `    ${RUNNER_DISPLAY_PATH} status`,
    `    ${RUNNER_DISPLAY_PATH} summary`,
    `    ${RUNNER_DISPLAY_PATH} awards`,
    `    ${RUNNER_DISPLAY_PATH} dashboard`,
    `    ${RUNNER_DISPLAY_PATH} list`,
    '',
    'Uninstall:',
    '',
    `    ${globalNghixahoiCommand('uninstall')}`,
    '',
    `Or turn off only this integration: ${config.offCommand}`,
    '',
    `This skill is installed at ${skillPath}.`,
    '',
  ].join('\n');
}

// A milestone's time as the setup prompt says it: whole hours as "3h", and otherwise as next-break-reminder.mjs writes a time
// left, "2h 30m", "18m". Here, since this file imports none of the CLI's modules (the dashboard bundles it).
function targetTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

// Since 2026-10-20 each line says where its milestone counts from: until 2026-10-29 install for the first, and for each other the
// moment the one before it was reached (docs/reward-rules.md §2); since 2026-10-29 the same for every milestone, the totals since
// install, each milestone a threshold on them. Since 2026-10-21 each names its time, "3h of tracked time", where it said "enough
// tracked time": with the operator's targets of that day a milestone's time is 3 to 8 hours. Since 2026-10-22 the tester table's
// times read "18m", "30m" and "1h", the production table's "2h", "3h" and "5h" since 2026-10-29 ("3h", "5h" and "8h" until then).
function milestoneLines() {
  const milestones = [...NGHIXAHOI_REWARD_TIERS, ...NGHIXAHOI_DISPLAY_MILESTONES];

  return milestones
    .map((milestone) => `- ${milestone.percent}% milestone: reached after ${targetTime(milestone.requiredSeconds)} of tracked time and ${milestone.requiredEquals} counted = characters, both totals since install, as for every milestone; the dashboard shows its message.`)
    .join('\n');
}

// The lines of step 2 that name what is installed: this package at `latest`, and the version check, against npm's own answer for it
// (since 2026-10-30, the operator's "ok go with the latest approach for both staging and production": no prompt names a version, so
// that its text is the same in every release; until then this version, by number, and `nghixahoi --version` printing it). The staging
// prompt (below) changes these two, and the untrack line, and nothing else of step 2; since 2026-10-30 its install is three lines,
// production's package removed before the tester build's is installed (stagingInstallLines). Since 2026-10-29 (the naming plan of
// that day, ruling 1) the production prompt's step 2 removes no other package: one an earlier Kit=Code installed has a command of its own, so npm
// installs this one beside it, and it is inert once its hooks are replaced and its tracker stopped (src/legacy.mjs), which `untrack`
// and `<agent> on` do. An earlier Kit=Code's tracker, which keeps running after its package is gone, is stopped by the untrack line.
const commandOf = (command) => (rest = '') => (rest ? `${command} ${rest}` : command);
const installLine = (command) => `2. Once Node.js 22.12+ is ready, install Kit=Code globally with: ${command}`;
// `npm view <package> version` prints the version `latest` names, and `npm view <package>@staging version` the one `staging` names:
// what the install just took, from the same registry and its cache.
const versionCheckLine = (cli, packageAtTag) => `- Check that ${cli('--version')} prints the same version as: npm view ${packageAtTag} version. If it does not, or if either command fails, report exactly what each printed, and do not go on to step 3.`;
// The stop of a tracker a Kit=Code installed before left running, in the production prompt's words. The staging prompt has said it
// in its own since 2026-09-30 (stagingUntrackLine, below), words the dashboard's checks hold to a staging build alone.
const productionUntrackLine = (cli) => `- Then run: ${cli('untrack')}. It stops a Kit=Code tracker that a Kit=Code installed before left running, so that the tracker Welcome starts is this version's; when none is running, it only says so.`;
// The prompts' last section, since 2026-10-29 (the rename plan of that day, phase 1, in the operator's words of its preview):
// Kit=Code does not update itself, and an update is the setup prompt again, pasted from the dashboard it was copied from, which
// installs the newest version and keeps the progress in the state folder. The production prompt names DASHBOARD_URL there, as its
// first paragraph does; the staging prompt, its staging dashboard's own address (stagingSetupPromptFor, below).
const UPDATES_HEADING = 'Updates, for later:';
const updatesLine = (dashboardUrl) => `- Kit=Code does not update itself. When Kit=Code says a newer version is available (on its dashboard, in its Mini window, or in the Kit=Code context of my prompts), tell me, and to update, paste the setup prompt from ${dashboardUrl} again: it installs the newest version, and my progress stays in ~/${STATE_DIR_NAME}.`;

// The production setup prompt, which the dashboard copies for each agent (apps/web src/components/project-gateway.tsx).
//
// It installs the package at `latest` (since 2026-10-30; this commit's version, by number, from 2026-10-22 until then); stops unless
// `nghixahoi --version` prints the version npm says `latest` is; and then stops a tracker
// a Kit=Code installed before left running, as the staging prompt has done since 2026-09-30 in words of its own. It holds one URL,
// the dashboard's, DASHBOARD_URL, twice: in its first paragraph and in its last section, "Updates, for later" (hard rule 5, F5).
// Since 2026-10-29 (the naming plan of that day) it removes no earlier package first.
export function assistantSetupPromptFor(source) {
  const config = sourceConfig(source);
  const cli = commandOf(CLI_GLOBAL_COMMAND);

  return [
    'Set up Kit=Code on my local computer.',
    '',
    'This works in any chat, project, or cowork conversation. Do not require repo context to begin.',
    REMOTE_SESSION_REDIRECT[source],
    '',
    `Kit=Code by KitKat is a local-first break companion for coding. I copied this prompt from its dashboard, ${DASHBOARD_URL}, and step 2 installs Kit=Code from npm, the package ${CLI_PACKAGE_NAME}.`,
    '',
    'Phase 1 — assistant setup (machine prep only):',
    '1. Check whether Node.js 22.12+ is available.',
    '   - If it is missing or too old, explain the shortest safe install option for this OS and ask for my confirmation before installing or upgrading it.',
    installLine(`${CLI_GLOBAL_INSTALL_COMMAND}@latest`),
    '- Always run this command. Do not skip it because Kit=Code may already be installed.',
    `- After install, use the global ${cli()} command for all following steps (not npx).`,
    versionCheckLine(cli, CLI_PACKAGE_NAME),
    productionUntrackLine(cli),
    `3. Run this command yourself once from the project directory when you are in a project chat: ${cli(`${source} on`)}`,
    '- When setup is still incomplete, this command already opens the Kit=Code Welcome window and prints "Opening Kit=Code Welcome...".',
    '- In a project chat, run it with the project folder as the working directory so Welcome can pre-add that folder.',
    `- This installs a Kit=Code skill plus a UserPromptSubmit hook for ${config.agentName}. The hook should run after each submitted prompt, fail open, and add compact Kit=Code context when tracking is active.`,
    `4. Verify integration with: ${cli(`${source} status`)}`,
    `- Do NOT run ${cli('setup')} if step 3 printed "Opening Kit=Code Welcome..." and did not report a Welcome launch failure. That means Welcome is already open.`,
    `- Run ${cli('setup')} only once, and only if step 3 did not print "Opening Kit=Code Welcome..." and I confirm Welcome never appeared.`,
    '- If Welcome launch fails (Electron missing or exits immediately), report the exact error. Do NOT tell me Welcome is open, and do NOT ask me to complete a window that never appeared.',
    '- Never open Welcome twice. If unsure whether Welcome opened, ask me before running setup.',
    '- Welcome should open as a single stable desktop window without flashing a terminal or other Kit=Code surface first.',
    `- If step 2's ${cli('untrack')} printed "Kit=Code tracker stopped." and step 3 did not print "Opening Kit=Code Welcome...", setup was already complete: run ${cli('track')} once, so that the tracker it stopped runs again, this version's. Otherwise do not run it.`,
    '',
    'Do NOT during Phase 1:',
    `- Do NOT run ${cli('add')}, and do NOT run ${cli('track')} but as step 4 says.`,
    '- Do NOT manually edit Kit=Code state or calculate rewards.',
    '',
    'Phase 2 — human setup (required for success):',
    '- Only after Welcome actually opened: I must complete the Kit=Code Welcome window: confirm project folder(s) and background tracking YES/NO.',
    '- In a project chat, Welcome should already list the current project folder. Outside a project chat, I add folder(s) manually.',
    '- Setup is not complete until I save Welcome with at least one project folder.',
    '',
    'Actually execute the commands. Do not stop after printing instructions for me to run in another terminal.',
    '- If a command fails, report the exact failure after attempting it and continue with any safe local checks that can unblock setup.',
    '',
    'After Phase 1, tell me to finish Welcome only if Welcome actually opened. Only then is Kit=Code ready to track.',
    '',
    UPDATES_HEADING,
    updatesLine(DASHBOARD_URL),
  ].join('\n');
}

// What the staging setup prompt says of the tester build's diagnostics (src/diagnostics.mjs; the operator's decision 2 of
// the voucher scheme's phase 4, 2026-10-01): that it sends them, where to, and what they never hold. In the tester's own
// voice, as the prompt is, and with no URL in it, as the prompt has none.
export const STAGING_DIAGNOSTICS_NOTICE = 'The tester build sends diagnostic logs to Kit=Code\'s staging server: Kit=Code\'s own events and errors, such as the tracker starting or a hook failing, and never my code, my files, my prompts or my project names.';

// The staging prompt's step 2 install, since 2026-10-30: this package, production's, removed first, since the tester build's
// package installs the same command and npm refuses a second package's (EEXIST); then the tester build, from npm's staging tag.
// The removal of a package that is not installed is npm's "up to date", and the progress in the state folder is untouched.
const NPM_SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;
const stagingInstallLines = (cli, testerPackage) => [
  `2. Once Node.js 22.12+ is ready, first remove Kit=Code's production package, if an earlier setup installed it: npm uninstall -g ${CLI_PACKAGE_NAME}`,
  `- It installs the same ${cli()} command as the tester build, so npm cannot install the tester build beside it, and my progress stays in ~/${STATE_DIR_NAME}. When it is not installed, npm says it is up to date: go on.`,
  `- Then install Kit=Code globally with: npm install -g ${testerPackage}@staging`,
];

// The staging prompt's stop of a tracker an earlier build left running, in the words it has had since 2026-09-30.
const stagingUntrackLine = (cli) => `- Then, before step 3, run: ${cli('untrack')}. It stops a Kit=Code tracker that an earlier build left running, so that the tracker Welcome starts is this build's; when none is running, it only says so.`;

// The setup prompt a staging dashboard copies for its invited testers (apps/web src/lib/staging-prompts.ts): the one above, line
// for line, with five changes and no other. The paragraph that names the dashboard gives way to the round's line and, since the
// voucher scheme's phase 4, the diagnostics notice (STAGING_DIAGNOSTICS_NOTICE); step 2 installs the round's tester build from npm's
// `staging` tag, and checks its version against npm's answer for that tag (since 2026-10-30, as the production prompt: no version in
// its text; until then the tester build's, given), and since 2026-10-30 first removes this package, production's, which installs the same
// command, so that npm would refuse the tester build beside it (EEXIST); the stop of a tracker an earlier build left running is in its own words, as it has been
// since 2026-09-30; and "Updates, for later" names the staging dashboard the tester copied it from, dashboardUrl, so that a tester
// updates from the staging site, to the next tester build. That address is the one URL it holds, the staging site's, which answers
// publicly behind its shared login. Its caller gives it, as the staging build's own origin (apps/web src/lib/staging-prompts.ts):
// the dashboard's bundle has production's DASHBOARD_URL in every build (apps/web vite.config.ts). It is made from the prompt above
// as it stands, so that the two cannot drift: a line it changes that is not there once throws, and check-integration-spec.mjs runs
// both.
//
// Until 2026-10-02 it could install a file the tester downloaded from the staging site instead. The operator's rule of that day is
// npm alone, "never let user download file even as tester, must be via npm package only": it takes the tester build's package
// (since 2026-10-30) and the staging dashboard's address and nothing else, and refuses an option it does not know, so that a caller
// still asking for the file is told so rather than given npm in silence. The package is the caller's, so that this file, which ships
// in production's package and is bundled in production's dashboard, names no other. Since 2026-10-30 (the operator, "ok go with
// the latest approach for both staging and production") it takes no version either, and refuses one: the round's tester build is
// whatever npm's `staging` tag names, which staging's deploy proves is the tarball CI made of the tagged commit.
export function stagingSetupPromptFor(source, options) {
  const {testerPackage, dashboardUrl, ...others} = options;

  if (Object.keys(others).length > 0) {
    throw new Error(`stagingSetupPromptFor takes the tester build's package and its staging dashboard's address alone, and installs it from npm's staging tag, by no version: it does not know ${Object.keys(others).join(', ')}.`);
  }

  if (typeof testerPackage !== 'string' || !NPM_SCOPED_PACKAGE.test(testerPackage) || testerPackage === CLI_PACKAGE_NAME) {
    throw new Error(`stagingSetupPromptFor needs the tester build's package as testerPackage, a scoped npm package other than ${CLI_PACKAGE_NAME}, which its step 2 removes first (found ${JSON.stringify(testerPackage)}).`);
  }

  let dashboard = null;

  try {
    dashboard = new URL(dashboardUrl);
  } catch {
    // Refused below.
  }

  if (dashboard === null || !['https:', 'http:'].includes(dashboard.protocol) || dashboardUrl !== `${dashboard.origin}/`) {
    throw new Error(`stagingSetupPromptFor needs the staging dashboard's address as dashboardUrl, an origin with its final slash, such as https://staging.example.com/, which its last section tells the tester to paste the setup prompt from again (found ${JSON.stringify(dashboardUrl)}).`);
  }

  const cli = commandOf(CLI_GLOBAL_COMMAND);
  const lines = assistantSetupPromptFor(source).split('\n');
  const onlyLine = (matches, what) => {
    const found = lines.flatMap((line, index) => (matches(line) ? [index] : []));

    if (found.length !== 1) {
      throw new Error(`stagingSetupPromptFor found ${what} ${found.length} times in the setup prompt, not once: assistantSetupPromptFor changed, and stagingSetupPromptFor must follow it.`);
    }

    return found[0];
  };

  // The paragraph that names the dashboard, to the blank line after it, gives way to one line about the round.
  const intro = onlyLine((line) => line.startsWith('Kit=Code by KitKat is a local-first break companion for coding.'), 'the dashboard\'s paragraph');
  const introEnd = lines.indexOf('', intro);

  if (introEnd === -1) {
    throw new Error('stagingSetupPromptFor found no blank line after the dashboard\'s paragraph: assistantSetupPromptFor changed, and stagingSetupPromptFor must follow it.');
  }

  lines.splice(intro, introEnd - intro, 'Kit=Code is a local-first project. I am an invited tester of its staging round, which needs Kit=Code\'s tester build: step 2 installs it.', STAGING_DIAGNOSTICS_NOTICE);

  // Step 2's install, found once, gives way to the removal of this package, a line on why, and the install of the tester build's.
  lines.splice(onlyLine((line) => line === installLine(`${CLI_GLOBAL_INSTALL_COMMAND}@latest`), 'the install'), 1, ...stagingInstallLines(cli, testerPackage));

  // The other line of step 2 that names a version, its stop of an earlier tracker, and the line that names where an
  // update comes from, found once, and replaced.
  for (const [production, staging, what] of [
    [versionCheckLine(cli, CLI_PACKAGE_NAME), versionCheckLine(cli, `${testerPackage}@staging`), 'the version check'],
    [productionUntrackLine(cli), stagingUntrackLine(cli), 'the stop of an earlier tracker'],
    [updatesLine(DASHBOARD_URL), updatesLine(dashboardUrl), 'the dashboard an update comes from'],
  ]) {
    lines[onlyLine((line) => line === production, what)] = staging;
  }

  return lines.join('\n');
}

// The longer setup prompt, which ships in the package and which only check-integration-spec.mjs calls (docs/security.md, "The
// setup prompt: F5"). It follows the production prompt above: no GitHub link, since none resolves publicly; its channel's dist-tag
// installed (since 2026-10-30; this version, by number, until then), and checked against npm's answer. Its URLs are the dashboard's
// and the tracker's own address on this machine.
export function setupPromptFor(source) {
  const config = sourceConfig(source);
  const hookCommand = hookCommandFor(source);
  const expectedHook = hookConfigFor(source);

  return [
    'Welcome to Kit=Code.',
    '',
    `You are ${config.agentName} helping me set up Kit=Code skills and hooks.`,
    '',
    'Mission:',
    `- Set up Kit=Code for ${config.agentName} on the current local machine.`,
    '- This works in any chat context. Do not require repo context or infer a project path to begin.',
    '- Do not assume a fixed operating system. Infer paths from the environment.',
    '- If the OS or home directory cannot be inferred, ask one short question before editing.',
    '- Keep the setup local-first, opt-in, and non-blocking.',
    '',
    'What Kit=Code does:',
    `- Project folders are registered in the Kit=Code Welcome window or later with: ${globalNghixahoiCommand('add')}`,
    `- Background tracking starts from Welcome or later with: ${globalNghixahoiCommand('track')}`,
    `- During initial setup, do NOT run ${globalNghixahoiCommand('add')} or ${globalNghixahoiCommand('track')}.`,
    `- The tracker serves local data at: ${LOCAL_SERVER_URL}`,
    `- The web dashboard reads local tracking and reward data from that server.`,
    `- Tracking and reward state is stored in: ${STATE_DISPLAY_PATH}`,
    '- Git Mode tracks commit totals and source-change batches; Vibe Mode tracks the same source-change batches without git metadata.',
    '- The CLI/package is the source of truth for tracking, the milestones reached, and hook output.',
    '',
    'Reward model:',
    milestoneLines(),
    '- Do not reimplement reward calculations manually. Use Kit=Code CLI output and state.',
    '',
    'Required checks:',
    '- Node.js 22.12+ is required.',
    '- Git is required for Git Mode.',
    `- Install Kit=Code globally with: ${CLI_INSTALL_COMMAND}`,
    '- Always run this command. Do not skip it because Kit=Code may already be installed.',
    `- After install, use the global ${CLI_GLOBAL_COMMAND} command for all following steps (not npx).`,
    `- Check that ${globalNghixahoiCommand('--version')} prints the same version as: npm view ${CLI_DIST_TAG === 'latest' ? CLI_PACKAGE_NAME : `${CLI_PACKAGE_NAME}@${CLI_DIST_TAG}`} version. If it does not, or if either command fails, report exactly what each printed, and stop there.`,
    '',
    `${config.agentName} setup:`,
    `- Prefer the CLI installer from the project directory in a project chat: ${config.setupCommand}`,
    `- When onboarding is incomplete, ${config.setupCommand} opens Welcome and pre-adds the current project folder from the working directory.`,
    `- The installer creates or updates the ${config.agentName} skill file at: ${displayHomePath(config.skillPathParts)}`,
    `- The installer creates or updates the ${config.hookEventName} hook config at: ${displayHomePath(config.hookConfigPathParts)}`,
    `- The installer creates a durable local runner at: ${RUNNER_DISPLAY_PATH}`,
    `- The hook command should be: ${hookCommand}`,
    '- The hook must fail open and must never block prompts.',
    `- After ${config.setupCommand}, the Kit=Code Welcome window should open when onboarding is incomplete.`,
    `- If Welcome launch fails (Electron missing or exits immediately), report the exact error and do NOT ask me to complete a window that never appeared.`,
    `- If Welcome did not open and there was no clear launch failure message, run: ${globalNghixahoiCommand('setup')}`,
    '- Setup is not complete until I save Welcome with at least one project folder.',
    '',
    'Expected hook command object:',
    JSON.stringify(expectedHook, null, 2),
    '',
    `SKILL.md content for ${displayHomePath(config.skillPathParts)}:`,
    '----- BEGIN SKILL.md -----',
    nghixahoiSkillMarkdown(source),
    '----- END SKILL.md -----',
    '',
    'How to check after setup:',
    `- Integration status: ${config.statusCommand}`,
    '- Finish Kit=Code Welcome only after it actually opened: choose project folder(s) and background tracking.',
    `- After Welcome is saved, tracker and dashboard checks: ${globalNghixahoiCommand('track')}`,
    `- Dashboard: ${globalNghixahoiCommand('dashboard')}`,
    `- Added projects: ${globalNghixahoiCommand('list')}`,
    `- Compact progress: ${globalNghixahoiCommand('summary')}`,
    `- Reward and milestone readiness: ${globalNghixahoiCommand('awards')}`,
    `- Local state file: ${STATE_DISPLAY_PATH}`,
    `- Dashboard: ${DASHBOARD_URL}`,
    '',
    'How to uninstall:',
    `- Remove everything locally: ${globalNghixahoiCommand('uninstall')}`,
    `- Or turn off only this integration: ${config.offCommand}`,
    '',
    'Finish with a concise summary of files changed, commands run, and anything I should run next.',
  ].join('\n');
}
