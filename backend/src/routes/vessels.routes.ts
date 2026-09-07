import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { resolveVesselIdentity } from '../services/import/vesselIdentity';
import { checkAndRecordDate, checkEtdBeforeEta, checkPastEtd, checkImoPlausibility } from '../services/dataQuality/dataQualityService';
import { logAudit } from '../services/audit/auditService';

export const vesselsRouter = Router();
vesselsRouter.use(requireAuth);

/**
 * NOTE ON SCOPE: besides the manual-creation endpoint below (for the
 * specific "New/Unknown vessel found in a US Calling List" case — see
 * POST '/'), vessel creation otherwise happens exclusively through Master
 * Import (Phase 3). This endpoint deliberately requires a human to supply
 * the permanent profile fields rather than inventing them from an
 * operational-data-only row, per the spec's explicit instruction not to
 * auto-create a full permanent profile from incomplete data.
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

const createVesselSchema = z.object({
  vesselName: z.string().trim().min(1),
  imoNumber: z.string().trim().optional(),
  flag: z.string().trim().optional(),
  vesselType: z.string().trim().optional(),
  summerDeadweightOrTeu: z.string().trim().optional(),
  registeredOwnerPerCor: z.string().trim().optional(),
  registeredOwnerPerCsr: z.string().trim().optional(),
  operatorNameInCofr: z.string().trim().optional(),
  bridgeLetter: z.string().trim().optional(),
  builtLocation: z.string().trim().optional(),
  serviceFeesApplicable: z.enum(['YES', 'NO', 'NA', 'UNKNOWN']).optional(),
  // Optional initial operational data — lets a vessel discovered via a
  // US Calling List "New/Unknown" row be created AND immediately given its
  // current ETA/ETD/Port in one step, rather than requiring a second
  // upload pass afterward.
  arrivalPort: z.string().trim().optional(),
  etaRaw: z.string().trim().optional(),
  etdRaw: z.string().trim().optional(),
  voyageType: z.string().trim().optional(),
  transactionType: z.string().trim().optional(),
  sendTo: z.string().trim().optional(),
});

/**
 * Creates a new vessel profile. Used specifically for the "New/Unknown
 * vessel" case surfaced by US Calling List processing — the permanent
 * profile fields must be supplied by a human (this endpoint does not
 * accept operational-data-only input and silently invent the rest).
 *
 * Duplicate-safe: uses the same IMO-first-else-normalized-name identity
 * resolution as Master Import, and rejects with 409 if a vessel already
 * exists under that identity rather than creating a second copy.
 */
vesselsRouter.post('/', asyncHandler(async (req, res) => {
  const parsed = createVesselSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const identity = resolveVesselIdentity(input.vesselName, input.imoNumber ?? null);

  const existing = await prisma.vessel.findFirst({
    where:
      identity.lookupStrategy === 'IMO_THEN_NAME'
        ? { OR: [{ imoNumber: identity.imoNumber as string }, { vesselNameNormalized: identity.vesselNameNormalized }] }
        : { vesselNameNormalized: identity.vesselNameNormalized },
  });
  if (existing) {
    throw new AppError(409, `A vessel matching "${input.vesselName}" already exists (${existing.vesselName})`, {
      existingVesselId: existing.id,
    });
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const vessel = await tx.vessel.create({
      data: {
        vesselName: input.vesselName,
        vesselNameNormalized: identity.vesselNameNormalized,
        imoNumber: identity.imoNumber,
        imoNumberPlausible: identity.imoPlausible,
        flag: input.flag ?? null,
        vesselType: input.vesselType ?? null,
        summerDeadweightOrTeu: input.summerDeadweightOrTeu ?? null,
        registeredOwnerPerCor: input.registeredOwnerPerCor ?? null,
        registeredOwnerPerCsr: input.registeredOwnerPerCsr ?? null,
        operatorNameInCofr: input.operatorNameInCofr ?? null,
        bridgeLetter: input.bridgeLetter ?? null,
        builtLocation: input.builtLocation ?? null,
        serviceFeesApplicable: input.serviceFeesApplicable ?? 'UNKNOWN',
        status: 'ACTIVE',
      },
    });

    if (identity.imoNumber && !identity.imoPlausible) {
      await checkImoPlausibility(tx, { imoNumber: identity.imoNumber, vesselId: vessel.id });
    }

    let dataQualityIssuesRaised = 0;

    if (input.arrivalPort || input.etaRaw || input.etdRaw || input.voyageType || input.transactionType || input.sendTo) {
      const callingRecord = await tx.vesselCallingRecord.create({
        data: {
          vesselId: vessel.id,
          isCurrent: true,
          arrivalPort: input.arrivalPort ?? null,
          etaRaw: input.etaRaw ?? null,
          etdRaw: input.etdRaw ?? null,
          voyageType: input.voyageType ?? null,
          transactionType: input.transactionType ?? null,
          sendTo: input.sendTo ?? null,
          source: 'MANUAL_EDIT',
        },
      });

      const { parsed: etaParsed } = await checkAndRecordDate(tx, {
        raw: input.etaRaw ?? null,
        fieldName: 'eta',
        callingRecordId: callingRecord.id,
        vesselId: vessel.id,
      });
      const { parsed: etdParsed } = await checkAndRecordDate(tx, {
        raw: input.etdRaw ?? null,
        fieldName: 'etd',
        callingRecordId: callingRecord.id,
        vesselId: vessel.id,
      });
      if (!etaParsed && input.etaRaw) dataQualityIssuesRaised += 1;
      if (!etdParsed && input.etdRaw) dataQualityIssuesRaised += 1;

      await checkEtdBeforeEta(tx, { etaParsed, etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });
      const isPast = await checkPastEtd(tx, { etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });
      if (isPast) dataQualityIssuesRaised += 1;

      if (etaParsed || etdParsed) {
        await tx.vesselCallingRecord.update({
          where: { id: callingRecord.id },
          data: { ...(etaParsed ? { etaParsed } : {}), ...(etdParsed ? { etdParsed } : {}) },
        });
      }
    }

    return { vessel, dataQualityIssuesRaised };
  });

  await logAudit({
    eventType: 'VESSEL_ADDED',
    vesselId: result.vessel.id,
    actorUserId: req.userId,
    summary: `${result.vessel.vesselName} manually added to the vessel database`,
  });

  res.status(201).json({ vessel: result.vessel, dataQualityIssuesRaised: result.dataQualityIssuesRaised });
}));
