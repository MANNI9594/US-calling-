import { describe, it, expect } from 'vitest';
import { extractCellText } from '../src/services/excel/extractCellText';

describe('extractCellText', () => {
  it('CRITICAL: extracts real text from a rich-text cell value, not "[object Object]" — the exact bug found in a real uploaded file', () => {
    const richTextValue = {
      richText: [
        { text: 'Marine Invasive Species Program Annual Vessel Reporting Form submitted to California State Lands Commission' },
        { font: { size: 12 }, text: ' ' },
      ],
    };
    expect(extractCellText(richTextValue)).toBe(
      'Marine Invasive Species Program Annual Vessel Reporting Form submitted to California State Lands Commission ',
    );
  });

  it('never produces the literal string "[object Object]" for any object-shaped cell value', () => {
    const shapes = [
      { richText: [{ text: 'hello' }] },
      { result: 'cached formula result' },
      { text: 'hyperlink display text' },
    ];
    for (const shape of shapes) {
      expect(extractCellText(shape)).not.toBe('[object Object]');
    }
  });

  it('handles a plain string unchanged', () => {
    expect(extractCellText('Operator Name')).toBe('Operator Name');
  });

  it('handles a plain number by stringifying it', () => {
    expect(extractCellText(42)).toBe('42');
  });

  it('handles null and undefined as empty string', () => {
    expect(extractCellText(null)).toBe('');
    expect(extractCellText(undefined)).toBe('');
  });

  it("extracts a formula cell's cached result", () => {
    expect(extractCellText({ result: 'computed value' })).toBe('computed value');
  });

  it("extracts a hyperlink cell's display text", () => {
    expect(extractCellText({ text: 'Click here', hyperlink: 'https://example.com' })).toBe('Click here');
  });
});
