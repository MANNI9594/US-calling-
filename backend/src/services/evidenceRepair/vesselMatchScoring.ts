import type { ExtractedEvidenceFields } from './ocrFieldExtraction';

/**
 * Scores how well OCR-extracted evidence fields match a candidate vessel's
 * permanent profile. This produces a CONFIDENCE SCORE for a human to review
 * — it never decides anything on its own. See EVIDENCE_MAPPING.md: no
 * automated process may set reviewStatus = CONFIRMED, regardless of score.
 *
 * Design principles:
 *  - An exact IMO match is the strongest possible signal (two different
 *    vessels essentially cannot share an IMO), so it dominates the score.
 *  - Owner/operator name comparison must tolerate real OCR noise (a
 *    misread character or two) without becoming so loose that unrelated
 *    companies with vaguely similar names score highly. Token-overlap on
 *    normalized text is used rather than edit-distance on the whole
 *    string, because company names vary in suffix ("INC" vs "LTD" vs
 *    nothing) far more than they vary in OCR noise on individual letters.
 *  - No single weak signal (e.g. one matching token in a long name) should
 *    be enough to cross the review threshold on its own.
 */

export interface VesselMatchCandidate {
  vesselId: string;
  imoNumber: string | null;
  registeredOwnerPerCor: string | null;
  registeredOwnerPerCsr: string | null;
  operatorNameInCofr: string | null;
}

export interface MatchScoreResult {
  vesselId: string;
  score: number; // 0..1
  reasons: string[];
}

function normalizeCompanyText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(INC|LTD|LLC|CO|CORP|SA|AS|KK|GMBH|PTE|PVT)\b/g, '') // common corporate suffixes vary independently of OCR quality
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapRatio(a: string, b: string): number {
  const tokensA = new Set(normalizeCompanyText(a).split(' ').filter((t) => t.length > 1));
  const tokensB = new Set(normalizeCompanyText(b).split(' ').filter((t) => t.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared += 1;

  // Ratio relative to the SMALLER set — a short name fully contained in a
  // longer one should still score well (e.g. "NORDEN AS" vs "NORDEN AS
  // DAMPSKIBSSELSKABET").
  return shared / Math.min(tokensA.size, tokensB.size);
}

export function scoreVesselMatch(fields: ExtractedEvidenceFields, vessel: VesselMatchCandidate): MatchScoreResult {
  const reasons: string[] = [];
  let score = 0;

  // Strongest signal: an IMO-like number extracted from the screenshot
  // exactly matches this vessel's IMO. Screenshots may show IMO numbers
  // for other referenced companies too, so this alone doesn't guarantee
  // correctness — but it's the single most reliable field.
  if (vessel.imoNumber && fields.numericCodes.includes(vessel.imoNumber)) {
    score += 0.5;
    reasons.push(`Extracted numeric code matches vessel IMO ${vessel.imoNumber}`);
  }

  const ownerFields = [fields.registeredOwner, fields.groupBeneficialOwner].filter((f): f is string => Boolean(f));
  const vesselOwnerFields = [vessel.registeredOwnerPerCor, vessel.registeredOwnerPerCsr].filter(
    (f): f is string => Boolean(f),
  );

  let bestOwnerOverlap = 0;
  for (const ocrOwner of ownerFields) {
    for (const vesselOwner of vesselOwnerFields) {
      const overlap = tokenOverlapRatio(ocrOwner, vesselOwner);
      if (overlap > bestOwnerOverlap) bestOwnerOverlap = overlap;
    }
  }
  if (bestOwnerOverlap > 0) {
    score += bestOwnerOverlap * 0.3;
    if (bestOwnerOverlap >= 0.5) reasons.push(`Owner name overlaps vessel's registered owner (${Math.round(bestOwnerOverlap * 100)}% token match)`);
  }

  if (fields.operator && vessel.operatorNameInCofr) {
    const operatorOverlap = tokenOverlapRatio(fields.operator, vessel.operatorNameInCofr);
    if (operatorOverlap > 0) {
      score += operatorOverlap * 0.2;
      if (operatorOverlap >= 0.5) reasons.push(`Operator name overlaps vessel's operator (${Math.round(operatorOverlap * 100)}% token match)`);
    }
  }

  return { vesselId: vessel.vesselId, score: Math.min(score, 1), reasons };
}

/**
 * Scores a set of extracted fields against every candidate vessel and
 * returns them sorted best-first. Callers decide the confirmation
 * threshold — this function only ranks, never decides.
 */
export function rankVesselMatches(fields: ExtractedEvidenceFields, candidates: VesselMatchCandidate[]): MatchScoreResult[] {
  return candidates
    .map((v) => scoreVesselMatch(fields, v))
    .sort((a, b) => b.score - a.score);
}
