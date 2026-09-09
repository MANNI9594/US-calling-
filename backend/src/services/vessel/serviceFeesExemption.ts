/**
 * Computes a SUGGESTED Service Fees Applicable value from Annex II
 * exemption criteria. This is deliberately a SUGGESTION, never a silent
 * final answer — one real exemption criterion (voyage distance from the
 * furthest foreign port of call) cannot be computed from data this app
 * tracks (no port-of-call history), so the result always says so
 * explicitly when it might matter, and the caller (the Add Vessel form)
 * always leaves the field editable rather than locking it.
 *
 * Rule summary, as specified by the user (default is APPLICABLE — "YES" —
 * unless an exemption applies):
 *   1. Vessel arriving empty or in ballast (no cargo/passengers) -> EXEMPT,
 *      regardless of type or size. This takes priority over everything
 *      else — confirmed by the user's own worked examples (a vessel over
 *      80,000 DWT is still exempt if in ballast).
 *   2. Container vessel, capacity <= 4000 TEU -> EXEMPT.
 *   3. Bulk carrier (liquid or dry), capacity <= 80,000 DWT -> EXEMPT.
 *   4. Any other vessel type (including chemical tankers — the spec
 *      explicitly clarifies chemical tankers fall in this bucket, not a
 *      separate one), capacity <= 55,000 DWT -> EXEMPT.
 *   5. Voyage < 2000 nautical miles from the furthest foreign port of call
 *      -> EXEMPT. NOT COMPUTABLE HERE — this app has no route/port-of-call
 *      tracking. Always surfaced as a caveat, never silently ignored.
 *   Otherwise -> APPLICABLE.
 */

export type ServiceFeesSuggestion = 'YES' | 'NO' | 'UNKNOWN';

export interface ServiceFeesExemptionInput {
  vesselType: string | null | undefined;
  capacityRaw: string | null | undefined;
  ballastOrLoaded: string | null | undefined;
}

export interface ServiceFeesExemptionResult {
  suggestion: ServiceFeesSuggestion;
  reason: string;
  voyageDistanceCaveatApplies: boolean;
}

function isBallast(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'ballast';
}

function isContainerType(vesselType: string): boolean {
  return vesselType.toLowerCase().includes('container');
}

function isBulkCarrierType(vesselType: string): boolean {
  return vesselType.toLowerCase().includes('bulk');
}

function extractTeu(raw: string): number | null {
  const match = raw.match(/([\d,]+)\s*TEU/i);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function extractDwt(raw: string): number | null {
  const withoutTeu = raw.replace(/([\d,]+)\s*TEU/i, '');
  const match = withoutTeu.match(/([\d,]+)/);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

export function computeServiceFeesExemption(input: ServiceFeesExemptionInput): ServiceFeesExemptionResult {
  const { vesselType, capacityRaw, ballastOrLoaded } = input;

  if (isBallast(ballastOrLoaded)) {
    return { suggestion: 'NO', reason: 'Exempt: vessel is in ballast (no cargo/passengers on board).', voyageDistanceCaveatApplies: false };
  }

  const type = (vesselType ?? '').trim();
  const capacity = (capacityRaw ?? '').trim();

  if (!type || !capacity) {
    return {
      suggestion: 'UNKNOWN',
      reason: 'Not enough information to auto-determine (need Vessel Type and Summer Deadweight/TEU). Please set manually.',
      voyageDistanceCaveatApplies: true,
    };
  }

  if (isContainerType(type)) {
    const teu = extractTeu(capacity) ?? extractDwt(capacity);
    if (teu === null) {
      return { suggestion: 'UNKNOWN', reason: 'Could not parse a TEU figure from the capacity field. Please set manually.', voyageDistanceCaveatApplies: true };
    }
    if (teu <= 4000) {
      return { suggestion: 'NO', reason: `Exempt: container vessel at ${teu.toLocaleString()} TEU (threshold: 4,000 TEU or less).`, voyageDistanceCaveatApplies: true };
    }
    return { suggestion: 'YES', reason: `Applicable: container vessel at ${teu.toLocaleString()} TEU exceeds the 4,000 TEU exemption threshold.`, voyageDistanceCaveatApplies: true };
  }

  if (isBulkCarrierType(type)) {
    const dwt = extractDwt(capacity);
    if (dwt === null) {
      return { suggestion: 'UNKNOWN', reason: 'Could not parse a DWT figure from the capacity field. Please set manually.', voyageDistanceCaveatApplies: true };
    }
    if (dwt <= 80_000) {
      return { suggestion: 'NO', reason: `Exempt: bulk carrier at ${dwt.toLocaleString()} DWT (threshold: 80,000 DWT or less).`, voyageDistanceCaveatApplies: true };
    }
    return { suggestion: 'YES', reason: `Applicable: bulk carrier at ${dwt.toLocaleString()} DWT exceeds the 80,000 DWT exemption threshold.`, voyageDistanceCaveatApplies: true };
  }

  const dwt = extractDwt(capacity);
  if (dwt === null) {
    return { suggestion: 'UNKNOWN', reason: 'Could not parse a DWT figure from the capacity field. Please set manually.', voyageDistanceCaveatApplies: true };
  }
  if (dwt <= 55_000) {
    return { suggestion: 'NO', reason: `Exempt: ${type || 'vessel'} at ${dwt.toLocaleString()} DWT (threshold for other vessel types: 55,000 DWT or less).`, voyageDistanceCaveatApplies: true };
  }
  return { suggestion: 'YES', reason: `Applicable: ${type || 'vessel'} at ${dwt.toLocaleString()} DWT exceeds the 55,000 DWT exemption threshold.`, voyageDistanceCaveatApplies: true };
}
