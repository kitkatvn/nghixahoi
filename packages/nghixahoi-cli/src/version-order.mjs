// Which of two Kit=Code versions is older, for the update notice (docs/plans/2026-10-29-production-rename-nghixahoi.md, phase 2): the
// dashboard's, which compares the tracker's /api/health `version` with the CLI_VERSION it bundles (apps/web src/lib/update-notice.ts),
// and the tracker's, which compares its own with the newest version the claim backend signs (src/newest-version.mjs). One rule for
// both, in a file that imports nothing, since the dashboard bundles it as it bundles integration-spec.mjs.
//
// Only versions of production's form compare, x.y.z, each part 0 or a whole number of one to nine digits with no leading zero, the
// contract's pattern (packages/claim-contract/newest-version.v1.schema.json): a tester build's version, 0.3.0-staging.25, a build's
// metadata, or anything a tracker sends that is not a version, compares as nothing, and no notice shows. So a staging build never says
// a newer version is out (the operator, 2026-10-29: "Never in a staging build").
const PLAIN_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;

// The three parts of a plain version, as numbers, or null for anything else.
export function plainVersion(value) {
  const match = typeof value === 'string' ? PLAIN_VERSION.exec(value) : null;
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Whether `installed` is older than `newest`, both plain: false when they are equal, when `installed` is newer, and when either is not
// a plain version.
export function isOlderVersion(installed, newest) {
  const a = plainVersion(installed);
  const b = plainVersion(newest);

  if (a === null || b === null) {
    return false;
  }

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index];
    }
  }

  return false;
}
