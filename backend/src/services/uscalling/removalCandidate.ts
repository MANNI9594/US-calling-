/**
 * Decides whether a single VECS vessel should be treated as a removal
 * (archive) candidate when "Apply to VECS List" runs. Extracted as a pure
 * function specifically so this exact rule — which controls an automatic
 * archiving decision — can be unit-tested directly with synthetic data,
 * rather than only being exercised indirectly through a database-backed
 * integration path this sandbox can't run.
 *
 * Rule (deliberately conservative, per explicit user requirement): only a
 * candidate if ALL of:
 *   1. The vessel is currently ACTIVE (never re-touch an already-archived one)
 *   2. Its normalized name does NOT appear anywhere in the current US
 *      Calling List entries
 *   3. Its current ETA is NOT a genuine future date (null/unparseable, or
 *      today/in the past) — a vessel with a real future ETA is assumed to
 *      simply not have reached the US Calling List's near-term window yet,
 *      not to have departed.
 */
export interface RemovalCandidateInput {
  status: 'ACTIVE' | 'ARCHIVED';
  vesselNameNormalized: string;
  etaParsedMs: number | null; // vessel's current ETA as epoch ms, or null if unparseable/absent
}

export function isRemovalCandidate(
  vessel: RemovalCandidateInput,
  matchedNormalizedNames: ReadonlySet<string>,
  nowMs: number,
): boolean {
  if (vessel.status !== 'ACTIVE') return false;
  if (matchedNormalizedNames.has(vessel.vesselNameNormalized)) return false;

  const isFutureEta = vessel.etaParsedMs !== null && vessel.etaParsedMs > nowMs;
  if (isFutureEta) return false;

  return true;
}
