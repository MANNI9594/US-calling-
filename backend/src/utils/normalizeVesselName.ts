/**
 * Normalizes a vessel name for matching purposes ONLY.
 *
 * IMPORTANT: normalization is for comparing "is this the same string,
 * formatted differently" — it must NOT make different vessels look the same.
 * "Atlantic Sunshine" and "Atlantic Sunflower" must remain distinct after
 * normalization. Do not add fuzzy/phonetic matching here; that belongs in
 * the (separate, human-reviewed) similarity-scoring step in the matching
 * engine, never in this deterministic normalizer.
 */
export function normalizeVesselName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[.,'"`’‘]/g, '') // harmless punctuation differences
    .replace(/\s+/g, ' '); // collapse multiple/leading/trailing whitespace
}

/**
 * Exact-match comparison after normalization. This is matching-hierarchy
 * tier 2/3 ("exact normalized name"). It deliberately does NOT catch
 * near-misses like "Sunshine" vs "Sunflower" — those must go to manual
 * review, never be auto-merged.
 */
export function namesMatchExactly(a: string, b: string): boolean {
  return normalizeVesselName(a) === normalizeVesselName(b);
}
