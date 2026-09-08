import { describe, it, expect } from 'vitest';
import { isRemovalCandidate } from '../src/services/uscalling/removalCandidate';

const NOW = new Date('2026-09-07T00:00:00.000Z').getTime();
const YESTERDAY = new Date('2026-09-06T00:00:00.000Z').getTime();
const IN_TWO_WEEKS = new Date('2026-09-21T00:00:00.000Z').getTime();

describe('isRemovalCandidate', () => {
  it('CRITICAL: does NOT flag a vessel with a genuine future ETA, even if missing from the US Calling List', () => {
    const vessel = { status: 'ACTIVE' as const, vesselNameNormalized: 'FUTURE VESSEL', etaParsedMs: IN_TWO_WEEKS };
    const matchedNames = new Set<string>();
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(false);
  });

  it('flags a vessel missing from the list whose ETA has already passed', () => {
    const vessel = { status: 'ACTIVE' as const, vesselNameNormalized: 'DEPARTED VESSEL', etaParsedMs: YESTERDAY };
    const matchedNames = new Set<string>();
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(true);
  });

  it('flags a vessel missing from the list with no parseable ETA at all', () => {
    const vessel = { status: 'ACTIVE' as const, vesselNameNormalized: 'UNKNOWN DATE VESSEL', etaParsedMs: null };
    const matchedNames = new Set<string>();
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(true);
  });

  it('never flags a vessel that IS present in the current US Calling List, regardless of its ETA', () => {
    const vessel = { status: 'ACTIVE' as const, vesselNameNormalized: 'STILL CALLING', etaParsedMs: YESTERDAY };
    const matchedNames = new Set(['STILL CALLING']);
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(false);
  });

  it('never flags a vessel that is already ARCHIVED', () => {
    const vessel = { status: 'ARCHIVED' as const, vesselNameNormalized: 'ALREADY GONE', etaParsedMs: YESTERDAY };
    const matchedNames = new Set<string>();
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(false);
  });

  it('flags a vessel whose ETA is exactly "now" (boundary case, not strictly future)', () => {
    const vessel = { status: 'ACTIVE' as const, vesselNameNormalized: 'RIGHT NOW', etaParsedMs: NOW };
    const matchedNames = new Set<string>();
    expect(isRemovalCandidate(vessel, matchedNames, NOW)).toBe(true);
  });
});
