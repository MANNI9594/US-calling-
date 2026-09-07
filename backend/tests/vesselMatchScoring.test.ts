import { describe, it, expect } from 'vitest';
import { extractEvidenceFields } from '../src/services/evidenceRepair/ocrFieldExtraction';
import { scoreVesselMatch, rankVesselMatches, type VesselMatchCandidate } from '../src/services/evidenceRepair/vesselMatchScoring';

const REAL_OCR_SAMPLE = `
© Ciassincation society: American Bureau of Shipping
'@ Registered owner: MAGNUS LINE INC (1816096)
© Ship manager: NORDEN AS DAMPSKIBSSELSKABET (6176243)
(© Group beneficial owner: | FUKLJIN KISEN KK (0208451)
© Operator NORDEN AS DAMPSKIBSSELSKABET (6176243)
`;

describe('scoreVesselMatch / rankVesselMatches', () => {
  const correctVessel: VesselMatchCandidate = {
    vesselId: 'vessel-correct',
    imoNumber: '1816096', // matches the OCR'd (noisy) code exactly
    registeredOwnerPerCor: 'Magnus Line Inc',
    registeredOwnerPerCsr: 'Magnus Line Inc',
    operatorNameInCofr: 'Norden As Dampskibsselskabet',
  };

  const unrelatedVessel: VesselMatchCandidate = {
    vesselId: 'vessel-unrelated',
    imoNumber: '9747467', // Ocean Harvest's real IMO — deliberately does not match
    registeredOwnerPerCor: 'Confidence Shipping Inc. Taiwan China',
    registeredOwnerPerCsr: 'Confidence Shipping Inc. Taiwan, China',
    operatorNameInCofr: 'Confidence Shipping Inc.',
  };

  it('scores the correct vessel highly when IMO, owner, and operator all line up', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE);
    const result = scoreVesselMatch(fields, correctVessel);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.reasons.some((r) => r.includes('IMO'))).toBe(true);
  });

  it('scores a genuinely unrelated vessel (different owner, different IMO) very low', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE);
    const result = scoreVesselMatch(fields, unrelatedVessel);
    expect(result.score).toBeLessThan(0.15);
  });

  it('ranks the correct vessel above the unrelated one when both are candidates', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE);
    const ranked = rankVesselMatches(fields, [unrelatedVessel, correctVessel]);
    expect(ranked[0].vesselId).toBe('vessel-correct');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('still scores reasonably well on owner+operator alone even if the IMO digit was misread by OCR', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE); // OCR'd IMO is 1816096
    const vesselWithTrueImo: VesselMatchCandidate = {
      ...correctVessel,
      imoNumber: '1816098', // the TRUE IMO, one digit different from what OCR read
    };
    const result = scoreVesselMatch(fields, vesselWithTrueImo);
    // No IMO bonus (the digit genuinely doesn't match), but owner+operator
    // overlap alone should still produce a moderate, reviewable score —
    // not zero, and not so high it looks confirmed.
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.score).toBeLessThan(0.8);
  });

  it('never returns a score above 1 even with a suspiciously perfect match', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE);
    const result = scoreVesselMatch(fields, correctVessel);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('handles a vessel with no permanent fields populated at all without throwing', () => {
    const fields = extractEvidenceFields(REAL_OCR_SAMPLE);
    const emptyVessel: VesselMatchCandidate = {
      vesselId: 'empty',
      imoNumber: null,
      registeredOwnerPerCor: null,
      registeredOwnerPerCsr: null,
      operatorNameInCofr: null,
    };
    expect(() => scoreVesselMatch(fields, emptyVessel)).not.toThrow();
    expect(scoreVesselMatch(fields, emptyVessel).score).toBe(0);
  });
});
