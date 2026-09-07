import { normalizeVesselName } from '../../utils/normalizeVesselName';

/**
 * Decides what an incoming US Calling List row means relative to the
 * current vessel database. Pure function — takes a lightweight candidate
 * list, returns a classification — so it's testable without a database
 * (see tests/callingListMatching.test.ts).
 *
 * The US Calling List has no IMO column (per the user's spec), so matching
 * is primarily by normalized vessel name. This deliberately does NOT do
 * fuzzy/similarity matching — "Atlantic Sunshine" and "Atlantic Sunflower"
 * must never be treated as the same vessel just because they're similar.
 */

export type CallingListMatchStatus =
  | 'ACTIVE_MATCH' // matches exactly one currently-ACTIVE vessel — normal update
  | 'ARCHIVED_MATCH' // matches exactly one currently-ARCHIVED vessel — candidate for restore
  | 'NEW_UNKNOWN' // matches no existing vessel at all
  | 'AMBIGUOUS'; // matches more than one vessel (a data-integrity situation, not a normal case)

export interface CallingListVesselCandidate {
  id: string;
  vesselName: string;
  vesselNameNormalized: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface CallingListMatchResult {
  status: CallingListMatchStatus;
  matchedVesselId: string | null;
  matchedVesselName: string | null;
  /** Populated only when status is AMBIGUOUS — every vessel that matched. */
  ambiguousCandidates: CallingListVesselCandidate[];
}

export function matchCallingListRow(rawVesselName: string, candidates: CallingListVesselCandidate[]): CallingListMatchResult {
  const normalized = normalizeVesselName(rawVesselName);
  const matches = candidates.filter((c) => c.vesselNameNormalized === normalized);

  if (matches.length === 0) {
    return { status: 'NEW_UNKNOWN', matchedVesselId: null, matchedVesselName: null, ambiguousCandidates: [] };
  }

  if (matches.length > 1) {
    return { status: 'AMBIGUOUS', matchedVesselId: null, matchedVesselName: null, ambiguousCandidates: matches };
  }

  const match = matches[0];
  return {
    status: match.status === 'ACTIVE' ? 'ACTIVE_MATCH' : 'ARCHIVED_MATCH',
    matchedVesselId: match.id,
    matchedVesselName: match.vesselName,
    ambiguousCandidates: [],
  };
}
