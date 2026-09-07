import { describe, it, expect } from 'vitest';
import { parseOperationalDate, formatAsMasterDate } from '../src/utils/parseOperationalDate';

describe('parseOperationalDate', () => {
  it('parses the Master workbook dot format correctly (Ocean Harvest ETA)', () => {
    const result = parseOperationalDate('20.08.2026');
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.getUTCFullYear()).toBe(2026);
    expect(result.parsed?.getUTCMonth()).toBe(7); // August = index 7
    expect(result.parsed?.getUTCDate()).toBe(20);
  });

  it('parses the US Calling List dash format correctly', () => {
    const result = parseOperationalDate('06-09-2026');
    expect(result.parsed?.getUTCFullYear()).toBe(2026);
    expect(result.parsed?.getUTCMonth()).toBe(8); // September = index 8
    expect(result.parsed?.getUTCDate()).toBe(6);
  });

  it('does NOT interpret DD-MM as MM-DD (06-09-2026 must be 6 September, never June 9)', () => {
    const result = parseOperationalDate('06-09-2026');
    expect(result.parsed?.getUTCMonth()).toBe(8); // September, not June (month index 5)
  });

  it('refuses to guess on the real malformed value found in the Master workbook (Athens C ETD)', () => {
    const result = parseOperationalDate('06.09.026');
    expect(result.parsed).toBeNull();
    expect(result.reason).toMatch(/does not match expected/i);
  });

  it('rejects an impossible calendar date rather than silently rolling it over', () => {
    const result = parseOperationalDate('31.04.2026'); // April has 30 days
    expect(result.parsed).toBeNull();
  });

  it('treats empty/missing values as unparsed, not as an error to throw', () => {
    expect(parseOperationalDate('').parsed).toBeNull();
    expect(parseOperationalDate(null).parsed).toBeNull();
    expect(parseOperationalDate(undefined).parsed).toBeNull();
  });

  it('round-trips back to the Master DD.MM.YYYY format', () => {
    const { parsed } = parseOperationalDate('20.08.2026');
    expect(formatAsMasterDate(parsed as Date)).toBe('20.08.2026');
  });
});
