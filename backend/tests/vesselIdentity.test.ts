import { describe, it, expect } from 'vitest';
import { resolveVesselIdentity } from '../src/services/import/vesselIdentity';

describe('resolveVesselIdentity', () => {
  it('uses IMO_THEN_NAME for a real vessel with a valid IMO (Ocean Harvest)', () => {
    const identity = resolveVesselIdentity('Ocean Harvest', 9747467);
    expect(identity.imoNumber).toBe('9747467');
    expect(identity.imoPlausible).toBe(true);
    expect(identity.lookupStrategy).toBe('IMO_THEN_NAME');
    expect(identity.vesselNameNormalized).toBe('OCEAN HARVEST');
  });

  it('still uses IMO_THEN_NAME for the "unusual-looking" but checksum-valid IMOs (MH Highlander)', () => {
    const identity = resolveVesselIdentity('MH Highlander', 1023920);
    expect(identity.imoPlausible).toBe(true);
    expect(identity.lookupStrategy).toBe('IMO_THEN_NAME');
  });

  it('falls back to NAME_ONLY when IMO is missing', () => {
    const identity = resolveVesselIdentity('Some Vessel', null);
    expect(identity.imoNumber).toBeNull();
    expect(identity.lookupStrategy).toBe('NAME_ONLY');
  });

  it('falls back to NAME_ONLY when IMO fails checksum, but still retains the raw value', () => {
    const identity = resolveVesselIdentity('Some Vessel', '9747461'); // corrupted check digit
    expect(identity.imoNumber).toBe('9747461'); // preserved, never discarded
    expect(identity.imoPlausible).toBe(false);
    expect(identity.lookupStrategy).toBe('NAME_ONLY');
  });

  it('normalizes the name consistently regardless of IMO presence', () => {
    const a = resolveVesselIdentity('Atlantic  Sunshine ', 9993810);
    const b = resolveVesselIdentity('ATLANTIC SUNSHINE', null);
    expect(a.vesselNameNormalized).toBe(b.vesselNameNormalized);
  });
});
