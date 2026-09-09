import { describe, it, expect } from 'vitest';
import { computeServiceFeesExemption } from '../src/services/vessel/serviceFeesExemption';

describe('computeServiceFeesExemption', () => {
  it('EXACT USER EXAMPLE: "Trustn Trader" — over 80,000 DWT bulk carrier, but in ballast — exempt', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '85000', ballastOrLoaded: 'Ballast' });
    expect(result.suggestion).toBe('NO');
    expect(result.reason).toMatch(/ballast/i);
  });

  it('EXACT USER EXAMPLE: "Progress Trader" — 82,221 DWT, confirmed in ballast — exempt', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '82,221', ballastOrLoaded: 'Ballast' });
    expect(result.suggestion).toBe('NO');
    expect(result.reason).toMatch(/ballast/i);
  });

  it('ballast exemption applies regardless of vessel type or unparseable capacity', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Container Vessel', capacityRaw: 'unknown', ballastOrLoaded: 'ballast' }); // lowercase, should still match
    expect(result.suggestion).toBe('NO');
  });

  it('ballast exemption does NOT carry the voyage-distance caveat (it overrides everything, including distance)', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '85000', ballastOrLoaded: 'Ballast' });
    expect(result.voyageDistanceCaveatApplies).toBe(false);
  });

  it('a loaded bulk carrier over the 80,000 DWT threshold is APPLICABLE', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '85000', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('YES');
  });

  it('a loaded bulk carrier at exactly 80,000 DWT is exempt (threshold is inclusive: "80000 DWT or less")', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '80000', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('NO');
  });

  it('a loaded container vessel under 4,000 TEU is exempt', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Container Vessel', capacityRaw: '146931 / 3900 TEU', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('NO');
    expect(result.reason).toMatch(/3,900 TEU/);
  });

  it('a loaded container vessel over 4,000 TEU is applicable — correctly parses TEU out of a mixed DWT/TEU string', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Container Vessel', capacityRaw: '146931 / 13900 TEU', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('YES');
    expect(result.reason).toMatch(/13,900 TEU/);
  });

  it('a loaded chemical tanker uses the "other vessel types" 55,000 DWT threshold, not the bulk carrier one', () => {
    const exempt = computeServiceFeesExemption({ vesselType: 'Chemical Tanker', capacityRaw: '50000', ballastOrLoaded: 'Loaded' });
    expect(exempt.suggestion).toBe('NO');

    const applicable = computeServiceFeesExemption({ vesselType: 'Chemical Tanker', capacityRaw: '60000', ballastOrLoaded: 'Loaded' });
    expect(applicable.suggestion).toBe('YES');
  });

  it('a loaded oil tanker (another "other" type) at 55,000 DWT is exempt', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Oil Tanker', capacityRaw: '55000', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('NO');
  });

  it('returns UNKNOWN (never guesses) when the capacity field cannot be parsed at all', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: 'N/A', ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when vessel type or capacity is entirely missing', () => {
    const result = computeServiceFeesExemption({ vesselType: null, capacityRaw: null, ballastOrLoaded: 'Loaded' });
    expect(result.suggestion).toBe('UNKNOWN');
  });

  it('every non-ballast result carries the voyage-distance caveat, since that criterion is never actually checked', () => {
    const result = computeServiceFeesExemption({ vesselType: 'Bulk Carrier', capacityRaw: '85000', ballastOrLoaded: 'Loaded' });
    expect(result.voyageDistanceCaveatApplies).toBe(true);
  });
});
