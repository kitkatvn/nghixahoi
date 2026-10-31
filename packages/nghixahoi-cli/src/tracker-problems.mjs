// What Kit=Code says when its tracker is stopped or degraded, in fixed words: the prompt hook tells the
// agent (hook-prompt.mjs), and the dashboard tells the user (apps/web). tracker.json and /api/health
// give problem codes only, and a code this version does not know gets the general sentence, so nothing
// written into either becomes text. Its one import, since 2026-10-29, the command this build runs as (nghixahoi in production,
// nghixahoi in a tester build), from integration-spec.mjs, which a browser can bundle too; until then it imported nothing.
import {CLI_GLOBAL_COMMAND} from './integration-spec.mjs';

export const TRACKER_STOPPED = `Kit=Code tracker is stopped, so focus time is not being counted; \`${CLI_GLOBAL_COMMAND} track\` starts it.`;

const PROBLEM_SENTENCES = {
  'watch-failed': 'Kit=Code tracker could not watch a project folder, so it checks that folder every few seconds instead.',
  'project-missing': 'A Kit=Code project folder is missing, so nothing in it is counted.',
  'scan-failed': 'Kit=Code tracker could not read a project, so its = are not being counted.',
  'git-locked': 'A Kit=Code project\'s git index has stayed locked (index.lock in its .git folder), so nothing in it is counted until the lock goes; a git command that crashed can leave that file behind.',
  'git-unfinished': 'A Kit=Code project has an unfinished git operation (a merge, rebase, cherry-pick, revert, am or squash merge), so nothing in it is counted until that operation is finished or aborted.',
};
const UNKNOWN_PROBLEM = 'Kit=Code tracker is working with a problem; its log is ~/.nghixahoi/tracker.log.';

// A problem code fit to print in a terminal. The tracker's own codes are short identifiers
// (watch-failed); anything with other characters came from a process squatting the port
// (docs/security.md), so only identifier characters are kept and the rest is dropped, and the length
// is capped, so no escape or control sequence reaches the terminal.
export function safeProblemCode(code) {
  const cleaned = String(code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned || 'unknown';
}

// One sentence per kind of problem, in the order first seen; the general one when there is none.
export function problemSentences(problems) {
  const codes = (Array.isArray(problems) ? problems : []).map((problem) => problem?.code);
  const sentences = new Set(codes.map((code) => (Object.hasOwn(PROBLEM_SENTENCES, code) ? PROBLEM_SENTENCES[code] : UNKNOWN_PROBLEM)));
  return [...(sentences.size > 0 ? sentences : [UNKNOWN_PROBLEM])];
}
