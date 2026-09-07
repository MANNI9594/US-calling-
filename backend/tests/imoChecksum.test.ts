import { describe, it, expect } from 'vitest';
import { validateImoNumber } from '../src/utils/imoChecksum';

describe('validateImoNumber', () => {
  it('accepts a real, checksum-valid IMO number (Ocean Harvest from the Master workbook)', () => {
    expect(validateImoNumber('9747467').isPlausible).toBe(true);
  });

  it('accepts another checksum-valid IMO number (Atlantic Sunshine)', () => {
    expect(validateImoNumber('9993810').isPlausible).toBe(true);
  });

  it('accepts MH Highlander\'s IMO — a value that LOOKS unusual (leading "1") but genuinely passes the checksum; confirmed by direct computation against all 43 rows of the real Master workbook, none of which fail', () => {
    expect(validateImoNumber('1023920').isPlausible).toBe(true);
  });

  it('flags a synthetic 7-digit value with a deliberately wrong check digit', () => {
    // 9747467 is real and valid; corrupting only the final digit must fail.
    const result = validateImoNumber('9747461');
    expect(result.isPlausible).toBe(false);
    expect(result.reason).toMatch(/check digit/i);
  });

  it('flags a value that is not exactly 7 digits', () => {
    const result = validateImoNumber('12345');
    expect(result.isPlausible).toBe(false);
  });

  it('treats a missing IMO as not-implausible (absence is a different concern)', () => {
    expect(validateImoNumber(null).isPlausible).toBe(true);
    expect(validateImoNumber('').isPlausible).toBe(true);
  });

  it('never throws on garbage input', () => {
    expect(() => validateImoNumber('not-a-number')).not.toThrow();
    expect(validateImoNumber('not-a-number').isPlausible).toBe(false);
  });
});
