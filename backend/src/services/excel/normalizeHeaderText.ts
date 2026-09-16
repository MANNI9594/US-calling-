/**
 * Normalizes Excel header text so a lookup key written in code (using
 * plain ASCII characters) reliably matches whatever a real workbook
 * actually contains — which may use typographic/curly quotes, a
 * non-breaking space, or irregular whitespace instead.
 *
 * Extracted as a shared utility after a real, confirmed bug: the Master
 * workbook's actual header used a curly apostrophe in "Operator's Name in
 * COFR" while the import code's lookup key used a straight one, so the
 * Operator field silently imported as blank for every vessel. Every Excel
 * reader in this app should normalize headers through this one function
 * rather than re-implementing (and potentially missing part of) this
 * logic — confirmed empirically that JavaScript's `\s` already matches a
 * non-breaking space (U+00A0), which a second real-world header
 * ("...Checklist sent\u00a0to vessel") depends on.
 */
export function normalizeHeaderText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u0060]/g, "'") // curly single quotes + backtick -> straight apostrophe
    .replace(/\s+/g, ' ') // collapses any whitespace run, including non-breaking spaces, to one regular space
    .trim();
}
