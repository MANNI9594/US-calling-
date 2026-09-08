import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { storage } from '../services/storage';
import { logAudit } from '../services/audit/auditService';
import { AppError } from '../middleware/errorHandler';
import { asyncHandler } from '../middleware/asyncHandler';
import { runEvidenceRepair } from '../services/evidenceRepair/evidenceRepairService';
import { broadcast } from '../services/realtime/eventBus';

export const evidenceRouter = Router();
evidenceRouter.use(requireAuth);

/**
 * The review workflow the user explicitly asked for:
 *   - list evidence by review status (NEEDS_REVIEW / UNASSIGNED / CONFIRMED / rejected)
 *   - view the image itself
 *   - manually assign/reassign to a vessel
 *   - confirm an automatic (OCR) association
 *   - reject as duplicate or irrelevant — never deletes the underlying asset
 *
 * The OCR auto-matching that PRODUCES NEEDS_REVIEW rows in the first place
 * is Phase 7 business logic (it needs the Master Import pipeline to exist).
 * This file is the review surface those results land on.
 */

const listQuerySchema = z.object({
  status: z.enum(['CONFIRMED', 'NEEDS_REVIEW', 'UNASSIGNED', 'REJECTED_DUPLICATE', 'REJECTED_IRRELEVANT']).optional(),
  vesselId: z.string().uuid().optional(),
});

evidenceRouter.get('/', asyncHandler(async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    return;
  }

  const evidence = await prisma.vesselEvidence.findMany({
    where: {
      isActive: true,
      reviewStatus: parsed.data.status,
      vesselId: parsed.data.vesselId,
    },
    include: { vessel: { select: { id: true, vesselName: true, imoNumber: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ evidence, count: evidence.length });
}));

evidenceRouter.get('/:id/image', asyncHandler(async (req, res) => {
  const record = await prisma.vesselEvidence.findUnique({ where: { id: req.params.id } });
  if (!record) {
    res.status(404).json({ error: 'Evidence record not found' });
    return;
  }
  const buffer = await storage.get(record.storageKey);
  res.setHeader('Content-Type', record.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buffer);
}));

const assignSchema = z.object({ vesselId: z.string().uuid() });

evidenceRouter.post('/:id/assign', asyncHandler(async (req, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const evidence = await prisma.vesselEvidence.findUnique({ where: { id: req.params.id } });
  if (!evidence) throw new AppError(404, 'Evidence record not found');

  const vessel = await prisma.vessel.findUnique({ where: { id: parsed.data.vesselId } });
  if (!vessel) throw new AppError(404, 'Target vessel not found');

  const wasAssignedElsewhere = evidence.vesselId && evidence.vesselId !== parsed.data.vesselId;

  const updated = await prisma.vesselEvidence.update({
    where: { id: evidence.id },
    data: {
      vesselId: parsed.data.vesselId,
      associationMethod: 'MANUAL',
      reviewStatus: 'CONFIRMED',
      reviewedByUserId: req.userId,
      reviewedAt: new Date(),
    },
  });

  await logAudit({
    eventType: wasAssignedElsewhere ? 'EVIDENCE_REASSIGNED' : 'EVIDENCE_ASSIGNED',
    vesselId: vessel.id,
    actorUserId: req.userId,
    summary: `Evidence ${evidence.id} manually ${wasAssignedElsewhere ? 're' : ''}assigned to ${vessel.vesselName}`,
    detail: { evidenceId: evidence.id, previousVesselId: evidence.vesselId, newVesselId: vessel.id },
  });

  res.json({ evidence: updated });
  broadcast('vessels-changed');
}));

evidenceRouter.post('/:id/confirm', asyncHandler(async (req, res) => {
  const evidence = await prisma.vesselEvidence.findUnique({ where: { id: req.params.id } });
  if (!evidence) throw new AppError(404, 'Evidence record not found');
  if (!evidence.vesselId) {
    throw new AppError(400, 'Cannot confirm an evidence record with no vessel association — assign it first');
  }

  const updated = await prisma.vesselEvidence.update({
    where: { id: evidence.id },
    data: { reviewStatus: 'CONFIRMED', reviewedByUserId: req.userId, reviewedAt: new Date() },
  });

  await logAudit({
    eventType: 'EVIDENCE_ASSIGNED',
    vesselId: evidence.vesselId,
    actorUserId: req.userId,
    summary: `Evidence ${evidence.id} association confirmed by user`,
  });

  res.json({ evidence: updated });
  broadcast('vessels-changed');
}));

/**
 * Bulk-confirms every NEEDS_REVIEW evidence record whose association came
 * from a clean, single-image anchor in the original Master workbook
 * (associationMethod = ORIGINAL_ANCHOR) — the highest-trust category,
 * since it means exactly one image was anchored to exactly one vessel's
 * row with no ambiguity. This deliberately does NOT touch OCR-suggested
 * (OCR_AUTO_MATCH) or manually-pending associations — those still require
 * individual review. Added specifically because requiring one-by-one
 * confirmation of 30+ high-confidence images before the Export feature
 * would include any of them was real friction with no real safety benefit
 * for this specific category.
 */
evidenceRouter.post('/bulk-confirm-clean-anchors', asyncHandler(async (req, res) => {
  const candidates = await prisma.vesselEvidence.findMany({
    where: { isActive: true, reviewStatus: 'NEEDS_REVIEW', associationMethod: 'ORIGINAL_ANCHOR', vesselId: { not: null } },
    select: { id: true, vesselId: true },
  });

  if (candidates.length === 0) {
    res.json({ confirmed: 0 });
    return;
  }

  await prisma.vesselEvidence.updateMany({
    where: { id: { in: candidates.map((c: { id: string }) => c.id) } },
    data: { reviewStatus: 'CONFIRMED', reviewedByUserId: req.userId, reviewedAt: new Date() },
  });

  await logAudit({
    eventType: 'EVIDENCE_ASSIGNED',
    actorUserId: req.userId,
    summary: `Bulk-confirmed ${candidates.length} clean-anchor evidence records`,
    detail: { count: candidates.length, evidenceIds: candidates.map((c: { id: string }) => c.id) },
  });

  res.json({ confirmed: candidates.length });
  broadcast('vessels-changed');
}));

const rejectSchema = z.object({ reason: z.enum(['DUPLICATE', 'IRRELEVANT']) });
evidenceRouter.post('/:id/reject', asyncHandler(async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const evidence = await prisma.vesselEvidence.findUnique({ where: { id: req.params.id } });
  if (!evidence) throw new AppError(404, 'Evidence record not found');

  // Rejecting NEVER deletes the underlying stored asset — only marks the
  // record so it stops appearing in review queues. The file stays in
  // storage and the DB row stays, satisfying "never delete or overwrite an
  // image simply because it cannot identify it."
  const updated = await prisma.vesselEvidence.update({
    where: { id: evidence.id },
    data: {
      reviewStatus: parsed.data.reason === 'DUPLICATE' ? 'REJECTED_DUPLICATE' : 'REJECTED_IRRELEVANT',
      reviewedByUserId: req.userId,
      reviewedAt: new Date(),
    },
  });

  await logAudit({
    eventType: 'EVIDENCE_REJECTED',
    vesselId: evidence.vesselId ?? undefined,
    actorUserId: req.userId,
    summary: `Evidence ${evidence.id} marked as ${parsed.data.reason.toLowerCase()}`,
  });

  res.json({ evidence: updated });
  broadcast('vessels-changed');
}));

const ocrRepairSchema = z.object({ importBatchId: z.string().uuid().optional() });

/**
 * Triggers an OCR-based repair pass over currently-UNASSIGNED evidence
 * (see docs/EVIDENCE_MAPPING.md "Phase 4 plan"). Runs synchronously — for a
 * personal single-user tool with ~17-50 pileup images this completes in
 * well under a minute, so a background job queue would be over-engineering
 * for the actual scale involved. If evidence volume grows much larger,
 * this is the point to revisit that tradeoff.
 */
evidenceRouter.post('/ocr-repair', asyncHandler(async (req, res) => {
  const parsed = ocrRepairSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const summary = await runEvidenceRepair(parsed.data.importBatchId);
  res.json({ summary });
}));
