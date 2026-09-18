import { describe, it, expect } from 'vitest';
import { toTitleCase } from '../src/utils/toTitleCase';

describe('toTitleCase (backend port, must match public/text-format.js exactly)', () => {
  it('converts all-caps names to proper title case', () => {
    expect(toTitleCase('MANOJ KUMAR')).toBe('Manoj Kumar');
    expect(toTitleCase('KINYRAS')).toBe('Kinyras');
  });

  it('converts all-lowercase to title case', () => {
    expect(toTitleCase('marine shipping corp')).toBe('Marine Shipping Corp');
  });

  it('handles a name with parentheses correctly', () => {
    expect(toTitleCase('COSCO SHIPPING (HONG KONG) CO., LTD.')).toBe('Cosco Shipping (Hong Kong) Co., Ltd.');
  });

  it('handles apostrophes and hyphens correctly', () => {
    expect(toTitleCase("o'brien shipping")).toBe("O'Brien Shipping");
    expect(toTitleCase('xi-an port')).toBe('Xi-An Port');
  });

  it('collapses accidental double spaces from pasted text', () => {
    expect(toTitleCase('  extra   spaces  ')).toBe('Extra Spaces');
  });

  it('passes through null/undefined/empty unchanged', () => {
    expect(toTitleCase(null)).toBe(null);
    expect(toTitleCase(undefined)).toBe(undefined);
    expect(toTitleCase('')).toBe('');
  });
});
