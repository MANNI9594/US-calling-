/**
 * Safely converts an ExcelJS cell value into plain text, regardless of
 * which internal shape ExcelJS chose to represent it as.
 *
 * Extracted after a real, confirmed bug: a header cell in a real uploaded
 * file ("Marine Invasive Species Program...") was represented by ExcelJS
 * as a rich-text object (`{ richText: [{ text: '...' }, ...] }`) rather
 * than a plain string — even though the exact same file, read via
 * openpyxl, showed it as a plain string. `String(cell.value)` on that
 * object produces the literal text "[object Object]", not the header
 * text, which would have silently broken column matching for that header
 * exactly the way a prior, already-fixed bug (a curly apostrophe in
 * "Operator's Name in COFR") did.
 *
 * This same vulnerable pattern (`String(cell.value ?? '')`) was found
 * copy-pasted across three separate readers in this codebase — this
 * utility replaces all of them, rather than patching only the one file
 * that happened to trigger the bug.
 */
export function extractCellText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);

  if (typeof raw === 'object') {
    const obj = raw as { richText?: Array<{ text?: string }>; result?: string | number; text?: string };
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((run) => run.text ?? '').join('');
    }
    if (obj.result !== undefined && obj.result !== null) {
      return String(obj.result);
    }
    if (typeof obj.text === 'string') {
      return obj.text;
    }
  }

  return String(raw);
}
