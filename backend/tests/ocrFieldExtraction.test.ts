import { describe, it, expect } from 'vitest';
import { extractEvidenceFields } from '../src/services/evidenceRepair/ocrFieldExtraction';

// This is the ACTUAL OCR output captured (via tesseract.js) from a real
// evidence image extracted from the reference workbook — not a hand-written
// idealized fixture. It includes real OCR noise: "Ciassincation" instead of
// "Classification", "FUKLJIN" instead of "FUKUJIN", a misread digit in the
// registered owner's code (1816096 vs the true 1816098 confirmed by visual
// inspection in Phase 1), and stray symbols from a misread bullet icon.
const REAL_OCR_SAMPLE = `
© Ciassincation society: American Bureau of Shipping
'@ Registered owner: MAGNUS LINE INC (1816096)
© Ship manager: NORDEN AS DAMPSKIBSSELSKABET (6176243)
(© Group beneficial owner: | FUKLJIN KISEN KK (0208451)
© Operator NORDEN AS DAMPSKIBSSELSKABET (6176243)
`;

describe('extractEvidenceFields (against real captured OCR output)', () => {
  it('extracts the registered owner name despite noise, tolerating the misread digit rather than correcting it', () => {
    const result = extractEvidenceFields(REAL_OCR_SAMPLE);
    expect(result.registeredOwner).toContain('MAGNUS LINE INC');
    expect(result.registeredOwner).toContain('1816096'); // the OCR'd value, NOT silently corrected to 1816098
  });

  it('extracts ship manager correctly', () => {
    const result = extractEvidenceFields(REAL_OCR_SAMPLE);
    expect(result.shipManager).toContain('NORDEN AS DAMPSKIBSSELSKABET');
  });

  it('extracts group beneficial owner despite leading noise characters and a misread word', () => {
    const result = extractEvidenceFields(REAL_OCR_SAMPLE);
    expect(result.groupBeneficialOwner).toContain('FUKLJIN KISEN KK'); // real OCR error preserved, not corrected
  });

  it('extracts operator even without a colon after the label (real OCR dropped it)', () => {
    const result = extractEvidenceFields(REAL_OCR_SAMPLE);
    expect(result.operator).toContain('NORDEN AS DAMPSKIBSSELSKABET');
  });

  it('collects all parenthesized numeric codes found in the text', () => {
    const result = extractEvidenceFields(REAL_OCR_SAMPLE);
    expect(result.numericCodes).toContain('1816096');
    expect(result.numericCodes).toContain('6176243');
    expect(result.numericCodes).toContain('0208451');
  });

  it('returns nulls gracefully for text with no recognizable fields (e.g. OCR on a blank/garbled image)', () => {
    const result = extractEvidenceFields('asdkj 23984 !!! garbage');
    expect(result.registeredOwner).toBeNull();
    expect(result.shipManager).toBeNull();
    expect(result.numericCodes).toEqual([]);
  });
});
