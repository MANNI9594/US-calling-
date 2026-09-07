import { prisma } from '../../db/prisma';
import type { Prisma } from '@prisma/client';
import { storage } from '../storage';
import { recognizeText, shutdownOcrWorker } from './ocrService';
import { extractEvidenceFields } from './ocrFieldExtraction';
import { rankVesselMatches, type VesselMatchCandidate } from './vesselMatchScoring';
import { logAudit } from '../audit/auditService';

/**
 * The minimum score to propose a match at all (as NEEDS_REVIEW, never
 * CONFIRMED). Chosen empirically against the real OCR sample captured
 * during development (a correct match scored ~0.85-1.0; a genuinely
 * unrelated vessel scored <0.15 — see tests/vesselMatchScoring.test.ts).
 * 0.35 leaves real headroom below a true match while still surfacing
 * "owner matched but IMO didn't extract cleanly" cases for human review
 * rather than dropping them straight to Unassigned.
 */
const MATCH_SUGGESTION_THRESHOLD = 0.35;

export interface EvidenceRepairSummary {
  processed: number;
  suggested: number;
  leftUnassigned: number;
  failed: number;
  errors: string[];
}

/**
 * Runs OCR + matching against every currently-UNASSIGNED evidence record
 * (optionally scoped to one import batch) and records a suggestion where
 * one is found. This NEVER sets reviewStatus to CONFIRMED and NEVER
 * deletes or overwrites the original image — it only populates
 * ocrExtractedText/ocrExtractedFields and, if a decent match is found,
 * proposes a vesselId with associationMethod = OCR_AUTO_MATCH and
 * reviewStatus = NEEDS_REVIEW, leaving final confirmation to the human
 * review workflow (public/evidence-review.html).
 *
 * Each evidence record is processed and saved independently — one image's
 * OCR failure (corrupt file, engine error) does not abort the whole batch,
 * unlike Master Import's all-or-nothing transaction. A partial repair run
 * is genuinely fine here: worst case, some images just don't get a
 * suggestion yet and remain in Unassigned exactly as before.
 */
export async function runEvidenceRepair(importBatchId?: string): Promise<EvidenceRepairSummary> {
  const summary: EvidenceRepairSummary = { processed: 0, suggested: 0, leftUnassigned: 0, failed: 0, errors: [] };

  const unassigned = await prisma.vesselEvidence.findMany({
    where: {
      isActive: true,
      reviewStatus: 'UNASSIGNED',
      ...(importBatchId ? { sourceImportBatchId: importBatchId } : {}),
    },
  });

  if (unassigned.length === 0) {
    return summary;
  }

  const candidateVessels = await prisma.vessel.findMany({
    select: {
      id: true,
      imoNumber: true,
      registeredOwnerPerCor: true,
      registeredOwnerPerCsr: true,
      operatorNameInCofr: true,
    },
  });
  const candidates: VesselMatchCandidate[] = candidateVessels.map(
    (v: {
      id: string;
      imoNumber: string | null;
      registeredOwnerPerCor: string | null;
      registeredOwnerPerCsr: string | null;
      operatorNameInCofr: string | null;
    }) => ({
      vesselId: v.id,
      imoNumber: v.imoNumber,
      registeredOwnerPerCor: v.registeredOwnerPerCor,
      registeredOwnerPerCsr: v.registeredOwnerPerCsr,
      operatorNameInCofr: v.operatorNameInCofr,
    }),
  );

  try {
    for (const evidence of unassigned) {
      summary.processed += 1;
      try {
        const buffer = await storage.get(evidence.storageKey);
        const ocrText = await recognizeText(buffer);
        const fields = extractEvidenceFields(ocrText);
        const ranked = rankVesselMatches(fields, candidates);
        const best = ranked[0];

        if (best && best.score >= MATCH_SUGGESTION_THRESHOLD) {
          await prisma.vesselEvidence.update({
            where: { id: evidence.id },
            data: {
              vesselId: best.vesselId,
              associationMethod: 'OCR_AUTO_MATCH',
              reviewStatus: 'NEEDS_REVIEW',
              associationConfidence: best.score,
              ocrExtractedText: ocrText,
              ocrExtractedFields: fields as unknown as Prisma.InputJsonValue,
            },
          });
          summary.suggested += 1;
        } else {
          // No confident match — still save the OCR text/fields so a human
          // reviewing the Unassigned pool has something to go on, and so a
          // future repair run (or a smarter matcher later) doesn't have to
          // re-run OCR on this image.
          await prisma.vesselEvidence.update({
            where: { id: evidence.id },
            data: {
              ocrExtractedText: ocrText,
              ocrExtractedFields: fields as unknown as Prisma.InputJsonValue,
            },
          });
          summary.leftUnassigned += 1;
        }
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(`Evidence ${evidence.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    // Release the OCR worker's WASM instance once the batch is done rather
    // than holding it open indefinitely between infrequent repair runs.
    await shutdownOcrWorker();
  }

  await logAudit({
    eventType: 'MANUAL_EDIT',
    summary: `OCR evidence repair run: ${summary.suggested} suggested, ${summary.leftUnassigned} left unassigned, ${summary.failed} failed`,
    detail: summary as unknown as Prisma.InputJsonValue,
  });

  return summary;
}
