/**
 * Parses OCR text extracted from an evidence screenshot (an IMO
 * vessel-lookup website crop) into structured candidate fields.
 *
 * Pure function — no OCR engine, no I/O — so it can be tested directly
 * against real captured OCR output (see tests/ocrFieldExtraction.test.ts,
 * which uses actual OCR text captured from the reference workbook's
 * evidence images, including real OCR noise like misread characters).
 *
 * The screenshots consistently contain lines like:
 *   "Registered owner: MAGNUS LINE INC (1816098)"
 *   "Ship manager: NORDEN AS DAMPSKIBSSELSKABET (6176243)"
 * OCR frequently mangles the leading bullet/icon character and occasionally
 * a digit or letter within the value — this extraction is deliberately
 * tolerant of leading-character noise but does NOT attempt to "correct"
 * misread digits; that's exactly the kind of silent guessing the data
 * model is designed to avoid. A misread IMO digit simply won't match
 * during scoring, which is the correct, honest outcome.
 */

export interface ExtractedEvidenceFields {
  registeredOwner: string | null;
  shipManager: string | null;
  groupBeneficialOwner: string | null;
  operator: string | null;
  /** Any parenthesized numeric codes found near owner/operator lines — may include IMO-like numbers. */
  numericCodes: string[];
}

const FIELD_PATTERNS: Array<{ key: keyof Omit<ExtractedEvidenceFields, 'numericCodes'>; pattern: RegExp }> = [
  { key: 'registeredOwner', pattern: /registered\s*owner\s*:?\s*(.+)/i },
  { key: 'shipManager', pattern: /ship\s*manager\s*:?\s*(.+)/i },
  { key: 'groupBeneficialOwner', pattern: /group\s*beneficial\s*owner\s*:?\s*(.+)/i },
  { key: 'operator', pattern: /^[^a-z]*operator\s*:?\s*(.+)/i },
];

function cleanValue(raw: string): string {
  return raw
    .replace(/[|_~]+/g, ' ') // common OCR artifacts around table borders
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEvidenceFields(ocrText: string): ExtractedEvidenceFields {
  const lines = ocrText.split(/\r?\n/);
  const result: ExtractedEvidenceFields = {
    registeredOwner: null,
    shipManager: null,
    groupBeneficialOwner: null,
    operator: null,
    numericCodes: [],
  };

  for (const line of lines) {
    for (const { key, pattern } of FIELD_PATTERNS) {
      // Only fill each field once — first match wins, later false-positive
      // matches on noisy lines don't overwrite a good earlier extraction.
      if (result[key] !== null) continue;
      const match = line.match(pattern);
      if (match) {
        result[key] = cleanValue(match[1]);
      }
    }

    const codeMatches = line.matchAll(/\((\d{5,8})\)/g);
    for (const m of codeMatches) {
      result.numericCodes.push(m[1]);
    }
  }

  return result;
}
