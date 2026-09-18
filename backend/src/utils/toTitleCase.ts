/**
 * Server-side port of public/text-format.js's toTitleCase — kept
 * logically identical to the client-side version (same word-splitting,
 * same treatment of hyphens/apostrophes/parentheses), so a value entered
 * before this feature existed backfills to exactly what it would have
 * been saved as if typed today.
 */
export function toTitleCase(value: string | null | undefined): string | null | undefined {
  if (!value || typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      if (word.length === 0) return word;
      return word
        .split(/([-'(])/)
        .map((part) => (part === '-' || part === "'" || part === '(' ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
        .join('');
    })
    .join(' ');
}
