import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';

export const vesselsRouter = Router();
vesselsRouter.use(requireAuth);

/**
 * NOTE ON SCOPE: this file intentionally only covers read access for now.
 * Vessel creation happens exclusively through Master Import (Phase 3) or
 * the Add/Restore workflow (Phase 7) — both of which need the matching
 * engine and evidence-review flow to exist first, per the explicit
 * instruction not to rush ahead of the data model. Wiring a bare
 * `POST /vessels` here would let a vessel be created with no calling
 * record, no evidence review, and no audit trail context — exactly the
 * kind of shortcut the spec asks us to avoid.
 */

const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  search: z.string().trim().min(1).optional(),
  sortBy: z.enum(['eta', 'vesselName']).default('eta'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

vesselsRouter.get('/', asyncHandler(async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    return;
  }
  const { status, search } = parsed.data;

  const vessels = await prisma.vessel.findMany({
    where: {
      status,
      ...(search
        ? {
            OR: [
              { vesselName: { contains: search, mode: 'insensitive' } },
              { imoNumber: { contains: search } },
            ],
          }
        : {}),
    },
    include: {
      callingRecords: { where: { isCurrent: true }, take: 1 },
      evidence: { where: { isActive: true }, select: { id: true, reviewStatus: true } },
      dataQualityIssues: { where: { status: 'OPEN' } },
    },
  });

  // Sorting by ETA happens in application code because it depends on the
  // *parsed* date of the current calling record, which sits one relation
  // away — not something a single Prisma orderBy can express cleanly here.
  const sorted = [...vessels].sort((a, b) => {
    if (parsed.data.sortBy === 'vesselName') {
      const cmp = a.vesselName.localeCompare(b.vesselName);
      return parsed.data.sortDir === 'asc' ? cmp : -cmp;
    }
    const aEta = a.callingRecords[0]?.etaParsed?.getTime() ?? Number.POSITIVE_INFINITY;
    const bEta = b.callingRecords[0]?.etaParsed?.getTime() ?? Number.POSITIVE_INFINITY;
    return parsed.data.sortDir === 'asc' ? aEta - bEta : bEta - aEta;
  });

  res.json({ vessels: sorted, count: sorted.length });
}));

vesselsRouter.get('/:id', asyncHandler(async (req, res) => {
  const vessel = await prisma.vessel.findUnique({
    where: { id: req.params.id },
    include: {
      callingRecords: { orderBy: { createdAt: 'desc' } },
      evidence: { where: { isActive: true } },
      dataQualityIssues: true,
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });

  if (!vessel) {
    res.status(404).json({ error: 'Vessel not found' });
    return;
  }

  res.json({ vessel });
}));
