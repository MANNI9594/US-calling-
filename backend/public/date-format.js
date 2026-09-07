/**
 * Client-side display helper: normalizes a raw ETA/ETD string to DD-MM-YYYY
 * for consistent display, WITHOUT touching the underlying stored value.
 * The Master workbook stores dates as DD.MM.YYYY, the US Calling List as
 * DD-MM-YYYY — both are parsed here and reformatted the same way so tables
 * don't show a visually inconsistent mix. A value that doesn't match either
 * known format (e.g. the real malformed "06.09.026" case) is returned
 * unchanged, flagged with a warning marker — never silently guessed at.
 */
function formatDateForDisplay(raw) {
  if (!raw) return { text: '—', warning: false };

  const dotMatch = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const dashMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const match = dotMatch || dashMatch;

  if (!match) {
    return { text: raw, warning: true };
  }

  const [, dd, mm, yyyy] = match;
  // Basic sanity check (real calendar validity, not just shape) — mirrors
  // the server-side parseOperationalDate rules closely enough for display
  // purposes without needing a full date library on the client.
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { text: raw, warning: true };
  }

  return { text: `${dd}-${mm}-${yyyy}`, warning: false };
}
