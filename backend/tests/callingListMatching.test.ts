import { describe, it, expect } from 'vitest';
import { matchCallingListRow, type CallingListVesselCandidate } from '../src/services/uscalling/callingListMatching';
import { normalizeVesselName } from '../src/utils/normalizeVesselName';

function candidate(vesselName: string, status: 'ACTIVE' | 'ARCHIVED', id = vesselName): CallingListVesselCandidate {
  return { id, vesselName, vesselNameNormalized: normalizeVesselName(vesselName), status };
}

// Real vessel names from the reference workbook (Phase 1 inspection).
const REAL_VESSELS: CallingListVesselCandidate[] = [
  candidate('Ocean Harvest', 'ACTIVE'),
  candidate('MH Highlander', 'ACTIVE'),
  candidate('Athens C', 'ACTIVE'),
  candidate('Nord Valkyrie', 'ARCHIVED'),
];

describe('matchCallingListRow', () => {
  it('matches an active vessel by exact normalized name (spec example: Athens C)', () => {
    const result = matchCallingListRow('Athens C', REAL_VESSELS);
    expect(result.status).toBe('ACTIVE_MATCH');
    expect(result.matchedVesselName).toBe('Athens C');
  });

  it('matches regardless of case/spacing differences (spec example variants)', () => {
    const result = matchCallingListRow('  ATHENS   C  ', REAL_VESSELS);
    expect(result.status).toBe('ACTIVE_MATCH');
  });

  it('CRITICAL: does not merge "Atlantic Sunshine" and "Atlantic Sunflower" as the same vessel', () => {
    const candidates = [candidate('Atlantic Sunshine', 'ACTIVE'), candidate('Atlantic Sunflower', 'ACTIVE')];
    const resultForSunshine = matchCallingListRow('Atlantic Sunshine', candidates);
    expect(resultForSunshine.matchedVesselName).toBe('Atlantic Sunshine');
    expect(resultForSunshine.status).toBe('ACTIVE_MATCH');

    const resultForSunflower = matchCallingListRow('Atlantic Sunflower', candidates);
    expect(resultForSunflower.matchedVesselName).toBe('Atlantic Sunflower');
    expect(resultForSunflower.status).toBe('ACTIVE_MATCH');
  });

  it('classifies a vessel not in the database as NEW_UNKNOWN', () => {
    const result = matchCallingListRow('Some Brand New Vessel', REAL_VESSELS);
    expect(result.status).toBe('NEW_UNKNOWN');
    expect(result.matchedVesselId).toBeNull();
  });

  it('classifies a match against an archived vessel as ARCHIVED_MATCH, not a normal update', () => {
    const result = matchCallingListRow('Nord Valkyrie', REAL_VESSELS);
    expect(result.status).toBe('ARCHIVED_MATCH');
    expect(result.matchedVesselName).toBe('Nord Valkyrie');
  });

  it('classifies a genuinely duplicated vessel name in the database as AMBIGUOUS, never silently picking one', () => {
    const duplicated = [candidate('Duplicate Name', 'ACTIVE', 'id-1'), candidate('Duplicate Name', 'ACTIVE', 'id-2')];
    const result = matchCallingListRow('Duplicate Name', duplicated);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matchedVesselId).toBeNull();
    expect(result.ambiguousCandidates).toHaveLength(2);
  });
});
