const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const HARNESS_VERSION_POLICIES = Object.freeze(["exact", "minimum"]);

function parseVersion(value) {
  const match = typeof value === "string" ? VERSION_PATTERN.exec(value) : null;
  if (!match) return null;
  return {
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : (difference < 0n ? -1 : 1);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

/**
 * Compares two semantic versions with prerelease precedence, or returns null when either cannot be parsed.
 */
export function compareHarnessVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }
  return 0;
}

export function isComparableHarnessVersion(value) {
  return parseVersion(value) !== null;
}

/**
 * Selects the profile for a harness version among profiles that already match every other session dimension.
 * A version with an `exact` profile is limited to the exact profiles that accept the session.
 * Otherwise the newest `minimum` profile at or below the version covers it until a later verified profile replaces it.
 */
export function selectVersionedProfile(profiles, harnessVersion, accepts = () => true) {
  const atVersion = profiles.filter((profile) => profile.match.harnessVersion === harnessVersion);
  const reviewedExactly = atVersion.some((profile) => profile.match.harnessVersionPolicy === "exact");
  const exact = atVersion.filter(accepts);
  if (exact.length > 1) {
    throw new Error("The session tuple matches more than one profile.");
  }
  if (exact.length === 1 || reviewedExactly) return exact[0] ?? null;
  let selected = null;
  for (const profile of profiles) {
    if (profile.match.harnessVersionPolicy !== "minimum" || !accepts(profile)) continue;
    const order = compareHarnessVersions(profile.match.harnessVersion, harnessVersion);
    if (order === null || order > 0) continue;
    if (!selected || compareHarnessVersions(profile.match.harnessVersion, selected.match.harnessVersion) > 0) {
      selected = profile;
    }
  }
  return selected;
}
