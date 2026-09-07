/**
 * Parses ETA/ETD values as found in the two known source documents:
 *  - Master workbook:      DD.MM.YYYY   (dots)   e.g. "20.08.2026"
 *  - US Calling List:      DD-MM-YYYY   (dashes) e.g. "06-09-2026"
 *
 * Design rule (non-negotiable per product spec): never silently "fix" or
 * guess a malformed date (e.g. a truncated year). If the input doesn't
 * cleanly match an expected pattern, return parsed: null and a reason —
 * the caller is responsible for raising a DataQualityIssue and keeping the
 * raw string. We do NOT attempt to interpret "06.09.026" as 2026; that is
 * exactly the silent-guessing behavior the spec prohibits.
 */

export interface DateParseResult {
  parsed: Date | null;
  reason?: string;
}

const DOT_FORMAT = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const DASH_FORMAT = /^(\d{2})-(\d{2})-(\d{4})$/;

function buildUtcDate(day: number, month: number, year: number): DateParseResult {
  if (month < 1 || month > 12) {
    return { parsed: null, reason: `Month out of range (${month})` };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  // Guard against JS's date rollover (e.g. day=31 in a 30-day month silently
  // becoming the 1st of the next month) — verify the round-trip matches.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { parsed: null, reason: `Day ${day} is not valid for month ${month}/${year}` };
  }
  return { parsed: date };
}

export function parseOperationalDate(raw: string | null | undefined): DateParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { parsed: null, reason: 'Empty value' };
  }

  const trimmed = raw.trim();

  const dotMatch = trimmed.match(DOT_FORMAT);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return buildUtcDate(Number(dd), Number(mm), Number(yyyy));
  }

  const dashMatch = trimmed.match(DASH_FORMAT);
  if (dashMatch) {
    const [, dd, mm, yyyy] = dashMatch;
    return buildUtcDate(Number(dd), Number(mm), Number(yyyy));
  }

  // Catches things like "06.09.026" (3-digit year) or any other shape —
  // explicitly NOT guessed at, per spec.
  return {
    parsed: null,
    reason: `Value "${trimmed}" does not match expected DD.MM.YYYY or DD-MM-YYYY format`,
  };
}

/** Formats a Date back to the Master workbook's DD.MM.YYYY convention. */
export function formatAsMasterDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}
