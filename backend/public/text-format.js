// Shared text-formatting helper, loaded by every list page. Converts
// free-text input (typed OR pasted, in any case — "MANOJ KUMAR",
// "marine shipping corp", "mArInE") into a consistent, readable form:
// first letter of each word capitalized, the rest lowercased.
//
// Applied only to genuine free-text name/place fields (vessel names,
// owners, ports, flags, etc.) — never to dates, dropdown values, ID
// numbers, or the "NA"/"-"/"Not Eligible" status values used on the
// US Calling list, since title-casing those would either be meaningless
// (numbers) or actively wrong (a dropdown's exact stored value must match
// one of its defined options).
function toTitleCase(value) {
  if (!value || typeof value !== 'string') return value;
  return value
    .trim()
    .replace(/\s+/g, ' ') // collapse accidental double spaces from pasted text
    .split(' ')
    .map((word) => {
      if (word.length === 0) return word;
      // Preserve a leading hyphen/apostrophe-joined word's own capitalization
      // pattern for compound names (e.g. "O'Brien", "Xi'An") by capitalizing
      // after those separators too, not just at the very start of the word.
      return word
        .split(/([-'(])/)
        .map((part) => (part === '-' || part === "'" || part === '(' ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
        .join('');
    })
    .join(' ');
}
