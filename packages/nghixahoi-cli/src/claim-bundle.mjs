import {equalsLedgerFrom} from './equals-ledger.mjs';
import {focusTimeFrom} from './focus-clock.mjs';
import {milestonesReachedFrom} from './milestones-reached.mjs';
import {RULES_VERSION} from './source-snapshot.mjs';

// The claim bundle (docs/backend.md, "The contract"): what a claim for the 100 % milestone carries, in the shape of the
// contract's schema version 5 (packages/claim-contract) since 2026-10-29, version 4's fields, each milestone a threshold on the
// cycle's totals, counted from the cycle's start, so each milestone carries its `end` and no `start` of its own
// (docs/plans/2026-10-29-milestones-cumulative.md); version 4
// from 2026-10-22, the milestones of the cycle counted in, with the cycle and where it began, `cycle` and `cycleStart`, each
// milestone counted fresh from the one before it; version 3 from 2026-10-20, whose milestones, 30, 50 and 100 %, each
// carry the totals they counted from and were reached at, `start` and `end`; version 2 from 2026-10-08, the same milestones
// without them; until then version 1, with 10, 20, 30, 50 and 100 %. Totals only: the focus time
// and the = counted, when each milestone was reached, the counting rules, the CLI's version and the
// install id, with when the bundle and the milestone record were made.
//
// Each field is picked out below, by name. Nothing is copied from the state wholesale, so no project,
// path, file, line, hash or commit can ride along, and the contract refuses any field it does not name.
// The CLI never sends it anywhere: the local API gives it to the dashboard, which carries it on in a later
// phase.

export const CLAIM_BUNDLE_SCHEMA_VERSION = 5;

// The bundle for `state`, the user's state.json as read. Pure: it reads nothing else, and writes nothing.
// A milestone record that is not what Kit=Code writes throws (milestones-reached.mjs).
export function claimBundleFromState(state, {installId, cliVersion, createdAt}) {
  const ledger = equalsLedgerFrom(state);
  const {recordingSince, cycle, cycleStart, milestones} = milestonesReachedFrom(state);

  return {
    schemaVersion: CLAIM_BUNDLE_SCHEMA_VERSION,
    createdAt,
    installId,
    cliVersion,
    rulesVersion: RULES_VERSION,
    totals: {
      focusSeconds: Math.floor(focusTimeFrom(state).activeSeconds),
      equals: ledger.total_equals,
    },
    recordingSince,
    // The cycle counted in, and where it began: picked by name, as everything here is.
    cycle,
    cycleStart: {at: cycleStart.at, focusSeconds: cycleStart.focusSeconds, equals: cycleStart.equals},
    // Picked by name too: each milestone's end is totals, {focusSeconds, equals}, or null. Since version 5 no start: every
    // milestone counts from the cycle's start, cycleStart.
    milestones: milestones.map(({percent, status, reachedAt, end}) => ({
      percent,
      status,
      reachedAt,
      end: end === null ? null : {focusSeconds: end.focusSeconds, equals: end.equals},
    })),
  };
}
