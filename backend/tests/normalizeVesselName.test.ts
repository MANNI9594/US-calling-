import { describe, it, expect } from 'vitest';
import { normalizeVesselName, namesMatchExactly } from '../src/utils/normalizeVesselName';

describe('normalizeVesselName / namesMatchExactly', () => {
  it('treats case, spacing, and trailing-space variants as the same name (spec example)', () => {
    const variants = ['Atlantic Sunshine', 'ATLANTIC SUNSHINE', 'Atlantic Sunshine ', 'Atlantic  Sunshine'];
    const normalized = variants.map(normalizeVesselName);
    expect(new Set(normalized).size).toBe(1);
  });

  it('does NOT treat similar-but-different vessel names as the same (spec example: must not merge)', () => {
    expect(namesMatchExactly('Atlantic Sunshine', 'Atlantic Sunflower')).toBe(false);
  });

  it('matches every real vessel name from the Master workbook against itself after normalization', () => {
    const realNames = [
      'Ocean Harvest', 'Nord Valkyrie', 'MH Highlander', 'Athens C', 'YM Tranquility',
      'CL Agatha Christie', 'Celsius Guadeloupe',
    ];
    for (const name of realNames) {
      expect(namesMatchExactly(name, name.toUpperCase())).toBe(true);
      expect(namesMatchExactly(name, `  ${name}  `)).toBe(true);
    }
  });
});
