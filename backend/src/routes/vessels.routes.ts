import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { resolveVesselIdentity } from '../services/import/vesselIdentity';
import { checkAndRecordDate, checkEtdBeforeEta, checkPastEtd, checkImoPlausibility } from '../services/dataQuality/dataQualityService';
import { computeServiceFeesExemption } from '../services/vessel/serviceFeesExemption';
import { logAudit } from '../services/audit/auditService';
import { broadcast } from '../services/realtime/eventBus';

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
  ballastOrLoaded: z.string().trim().optional(),
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
/**
 * Returns a SUGGESTED Service Fees Applicable value from Annex II
 * exemption criteria (see serviceFeesExemption.ts for the full rule and
 * its one genuine limitation — voyage distance can't be computed here).
 * Never writes anything; the Add Vessel form uses this to pre-fill its
 * dropdown while keeping it fully editable.
 */
const suggestServiceFeesSchema = z.object({
  vesselType: z.string().optional(),
  summerDeadweightOrTeu: z.string().optional(),
  ballastOrLoaded: z.string().optional(),
});

vesselsRouter.post('/suggest-service-fees', asyncHandler(async (req, res) => {
  const parsed = suggestServiceFeesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const result = computeServiceFeesExemption({
    vesselType: parsed.data.vesselType ?? null,
    capacityRaw: parsed.data.summerDeadweightOrTeu ?? null,
    ballastOrLoaded: parsed.data.ballastOrLoaded ?? null,
  });
  res.json(result);
}));

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

    if (input.arrivalPort || input.etaRaw || input.etdRaw || input.voyageType || input.transactionType || input.sendTo || input.ballastOrLoaded) {
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
          ballastOrLoaded: input.ballastOrLoaded ?? null,
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
  broadcast('vessels-changed');
}));

const bulkVesselIdsSchema = z.object({ vesselIds: z.array(z.string().uuid()).min(1) });

/**
 * Removes selected vessels from the Active Master. This is NEVER a delete
 * — it flips status to ARCHIVED, retaining the full permanent profile,
 * all evidence, and all calling-record history, exactly as the spec's
 * core distinction requires ("Remove from Active Master" ≠ "Delete").
 * A separate, explicitly-confirmed permanent-delete action does not exist
 * yet and is intentionally out of scope until there's a real need for it.
 */
vesselsRouter.post('/archive', asyncHandler(async (req, res) => {
  const parsed = bulkVesselIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let archived = 0;
    let skipped = 0;
    for (const vesselId of parsed.data.vesselIds) {
      const vessel = await tx.vessel.findUnique({ where: { id: vesselId } });
      if (!vessel || vessel.status !== 'ACTIVE') {
        skipped += 1;
        continue;
      }
      await tx.vessel.update({ where: { id: vesselId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await logAudit({
        eventType: 'VESSEL_REMOVED',
        vesselId,
        actorUserId: req.userId,
        summary: `${vessel.vesselName} removed from Active Master (archived, not deleted)`,
      });
      archived += 1;
    }
    return { archived, skipped };
  });

  res.json(result);
  broadcast('vessels-changed');
}));

/**
 * Restores selected vessels from the archive back to the Active Master.
 * Current ETA/ETD are left as whatever they were when archived — the
 * expectation (per spec) is that the next US Calling List upload supplies
 * fresh operational data, not this endpoint.
 */
vesselsRouter.post('/restore', asyncHandler(async (req, res) => {
  const parsed = bulkVesselIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let restored = 0;
    let skipped = 0;
    for (const vesselId of parsed.data.vesselIds) {
      const vessel = await tx.vessel.findUnique({ where: { id: vesselId } });
      if (!vessel || vessel.status !== 'ARCHIVED') {
        skipped += 1;
        continue;
      }
      await tx.vessel.update({ where: { id: vesselId }, data: { status: 'ACTIVE', restoredAt: new Date() } });
      await logAudit({
        eventType: 'VESSEL_RESTORED',
        vesselId,
        actorUserId: req.userId,
        summary: `${vessel.vesselName} restored to Active Master`,
      });
      restored += 1;
    }
    return { restored, skipped };
  });

  res.json(result);
  broadcast('vessels-changed');
}));

const restoreAndUpdateSchema = z.object({
  arrivalPort: z.string().trim().optional(),
  etaRaw: z.string().trim().optional(),
  etdRaw: z.string().trim().optional(),
  voyageType: z.string().trim().optional(),
  transactionType: z.string().trim().optional(),
  sendTo: z.string().trim().optional(),
});

/**
 * Restores a single archived vessel AND, if operational data is supplied,
 * gives it a fresh current calling record in the same step — the
 * "Archived Vessel Found → Restore & Update" convenience feature from the
 * spec, reachable here from a manual search (see add-vessel.html) rather
 * than only from a US Calling List upload. The prior current record (if
 * any) is marked non-current, never deleted, consistent with every other
 * operational update path in the app.
 */
vesselsRouter.post('/:id/restore-and-update', asyncHandler(async (req, res) => {
  const parsed = restoreAndUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const vessel = await prisma.vessel.findUnique({ where: { id: req.params.id } });
  if (!vessel) throw new AppError(404, 'Vessel not found');
  if (vessel.status !== 'ARCHIVED') {
    throw new AppError(400, `${vessel.vesselName} is not archived — nothing to restore`);
  }

  const hasOperationalData = Boolean(
    input.arrivalPort || input.etaRaw || input.etdRaw || input.voyageType || input.transactionType || input.sendTo,
  );

  const dataQualityIssuesRaised = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.vessel.update({ where: { id: vessel.id }, data: { status: 'ACTIVE', restoredAt: new Date() } });

    let issuesRaised = 0;

    if (hasOperationalData) {
      const previousCurrent = await tx.vesselCallingRecord.findFirst({ where: { vesselId: vessel.id, isCurrent: true } });
      if (previousCurrent) {
        await tx.vesselCallingRecord.update({ where: { id: previousCurrent.id }, data: { isCurrent: false } });
      }

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
          source: 'RESTORE',
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
      if (!etaParsed && input.etaRaw) issuesRaised += 1;
      if (!etdParsed && input.etdRaw) issuesRaised += 1;

      await checkEtdBeforeEta(tx, { etaParsed, etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });
      const isPast = await checkPastEtd(tx, { etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });
      if (isPast) issuesRaised += 1;

      if (etaParsed || etdParsed) {
        await tx.vesselCallingRecord.update({
          where: { id: callingRecord.id },
          data: { ...(etaParsed ? { etaParsed } : {}), ...(etdParsed ? { etdParsed } : {}) },
        });
      }
    }

    return issuesRaised;
  });

  await logAudit({
    eventType: 'VESSEL_RESTORED',
    vesselId: vessel.id,
    actorUserId: req.userId,
    summary: `${vessel.vesselName} restored to Active Master${hasOperationalData ? ' with fresh operational data' : ''}`,
  });

  res.json({ vessel: { ...vessel, status: 'ACTIVE' }, dataQualityIssuesRaised });
  broadcast('vessels-changed');
}));

/**
 * Edits a vessel's PERMANENT profile fields (name, IMO, flag, type, etc.).
 * Used by Active Master's inline "double-click to edit" cells. Deliberately
 * separate from the operational-fields endpoint below — permanent fields
 * live on Vessel, operational fields live on VesselCallingRecord, and
 * mixing them into one endpoint would blur that distinction everywhere
 * else in the app already depends on.
 *
 * Renaming a vessel or changing its IMO re-checks for a collision with a
 * DIFFERENT existing vessel, using the same identity resolution as Master
 * Import/Add Vessel — an edit must never silently create a duplicate
 * identity clash.
 */
const editVesselSchema = z.object({
  vesselName: z.string().trim().min(1).optional(),
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
});

vesselsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = editVesselSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const vessel = await prisma.vessel.findUnique({ where: { id: req.params.id } });
  if (!vessel) throw new AppError(404, 'Vessel not found');

  const data: Record<string, unknown> = {};
  const changedFields: string[] = [];

  if (input.vesselName !== undefined && input.vesselName !== vessel.vesselName) {
    const identity = resolveVesselIdentity(input.vesselName, input.imoNumber ?? vessel.imoNumber);
    const collision = await prisma.vessel.findFirst({
      where: { vesselNameNormalized: identity.vesselNameNormalized, id: { not: vessel.id } },
    });
    if (collision) {
      throw new AppError(409, `Another vessel already uses the name "${collision.vesselName}"`);
    }
    data.vesselName = input.vesselName;
    data.vesselNameNormalized = identity.vesselNameNormalized;
    changedFields.push('vesselName');
  }

  if (input.imoNumber !== undefined && input.imoNumber !== vessel.imoNumber) {
    const identity = resolveVesselIdentity(input.vesselName ?? vessel.vesselName, input.imoNumber);
    if (identity.imoNumber) {
      const collision = await prisma.vessel.findFirst({
        where: { imoNumber: identity.imoNumber, id: { not: vessel.id } },
      });
      if (collision) {
        throw new AppError(409, `IMO ${identity.imoNumber} is already used by ${collision.vesselName}`);
      }
    }
    data.imoNumber = identity.imoNumber;
    data.imoNumberPlausible = identity.imoPlausible;
    changedFields.push('imoNumber');
  }

  (['flag', 'vesselType', 'summerDeadweightOrTeu', 'registeredOwnerPerCor', 'registeredOwnerPerCsr', 'operatorNameInCofr', 'bridgeLetter', 'builtLocation', 'serviceFeesApplicable'] as const).forEach((field) => {
    if (input[field] !== undefined && input[field] !== (vessel as unknown as Record<string, unknown>)[field]) {
      data[field] = input[field];
      changedFields.push(field);
    }
  });

  if (changedFields.length === 0) {
    res.json({ vessel });
    return;
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const result = await tx.vessel.update({ where: { id: vessel.id }, data });

    // If the IMO was just corrected to a plausible value, resolve any
    // open "implausible IMO" flag rather than leaving a stale warning
    // around after the user has already fixed it.
    if (data.imoNumberPlausible === true) {
      await tx.dataQualityIssue.updateMany({
        where: { vesselId: vessel.id, issueType: 'IMPLAUSIBLE_IMO', status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    }

    return result;
  });

  await logAudit({
    eventType: 'MANUAL_EDIT',
    vesselId: vessel.id,
    actorUserId: req.userId,
    summary: `${vessel.vesselName}: edited ${changedFields.join(', ')}`,
    detail: { changedFields, newValues: data as Prisma.InputJsonValue },
  });

  res.json({ vessel: updated });
  broadcast('vessels-changed');
}));

/**
 * Edits a vessel's CURRENT operational fields (Port/ETA/ETD) IN PLACE —
 * a deliberate departure from the "always version, mark old non-current"
 * pattern used by Master Import and US Calling List processing. Those
 * flows represent a new data FEED arriving; this endpoint represents a
 * human correcting a value that's already there. Versioning every small
 * inline edit would explode calling-record history for no real benefit —
 * the audit log already records what changed and when.
 *
 * Re-runs the same date-quality checks used everywhere else (malformed
 * date, ETD-before-ETA, past-ETD) against the corrected values, and
 * resolves any open flag that the edit fixes — an edit that corrects a
 * malformed date shouldn't leave a stale "invalid date" warning behind.
 */
const editOperationalSchema = z.object({
  arrivalPort: z.string().trim().optional(),
  etaRaw: z.string().trim().optional(),
  etdRaw: z.string().trim().optional(),
  ballastOrLoaded: z.string().trim().optional(),
});

vesselsRouter.patch('/:id/operational', asyncHandler(async (req, res) => {
  const parsed = editOperationalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const vessel = await prisma.vessel.findUnique({ where: { id: req.params.id } });
  if (!vessel) throw new AppError(404, 'Vessel not found');

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let record = await tx.vesselCallingRecord.findFirst({ where: { vesselId: vessel.id, isCurrent: true } });

    const mergedEta = input.etaRaw !== undefined ? input.etaRaw : record?.etaRaw ?? null;
    const mergedEtd = input.etdRaw !== undefined ? input.etdRaw : record?.etdRaw ?? null;
    const mergedPort = input.arrivalPort !== undefined ? input.arrivalPort : record?.arrivalPort ?? null;
    const mergedBallast = input.ballastOrLoaded !== undefined ? input.ballastOrLoaded : record?.ballastOrLoaded ?? null;

    const eventType = input.etaRaw !== undefined ? 'ETA_CHANGED' : input.etdRaw !== undefined ? 'ETD_CHANGED' : input.arrivalPort !== undefined ? 'PORT_CHANGED' : 'MANUAL_EDIT';

    if (!record) {
      record = await tx.vesselCallingRecord.create({
        data: { vesselId: vessel.id, isCurrent: true, arrivalPort: mergedPort, etaRaw: mergedEta, etdRaw: mergedEtd, ballastOrLoaded: mergedBallast, source: 'MANUAL_EDIT' },
      });
    } else {
      record = await tx.vesselCallingRecord.update({
        where: { id: record.id },
        data: { arrivalPort: mergedPort, etaRaw: mergedEta, etdRaw: mergedEtd, ballastOrLoaded: mergedBallast },
      });
    }

    // Clear stale flags for fields being re-evaluated, then re-run the
    // same checks fresh — simplest way to guarantee no orphaned issue
    // survives a correction.
    await tx.dataQualityIssue.updateMany({
      where: { callingRecordId: record.id, status: 'OPEN', issueType: { in: ['INVALID_DATE_FORMAT', 'ETD_BEFORE_ETA', 'PAST_ETD'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    const { parsed: etaParsed } = await checkAndRecordDate(tx, { raw: mergedEta, fieldName: 'eta', callingRecordId: record.id, vesselId: vessel.id });
    const { parsed: etdParsed } = await checkAndRecordDate(tx, { raw: mergedEtd, fieldName: 'etd', callingRecordId: record.id, vesselId: vessel.id });
    await checkEtdBeforeEta(tx, { etaParsed, etdParsed, callingRecordId: record.id, vesselId: vessel.id });
    await checkPastEtd(tx, { etdParsed, callingRecordId: record.id, vesselId: vessel.id });

    if (etaParsed || etdParsed) {
      record = await tx.vesselCallingRecord.update({
        where: { id: record.id },
        data: { ...(etaParsed ? { etaParsed } : { etaParsed: null }), ...(etdParsed ? { etdParsed } : { etdParsed: null }) },
      });
    }

    return { record, eventType };
  });

  await logAudit({
    eventType: result.eventType as 'ETA_CHANGED' | 'ETD_CHANGED' | 'PORT_CHANGED' | 'MANUAL_EDIT',
    vesselId: vessel.id,
    actorUserId: req.userId,
    summary: `${vessel.vesselName}: manually edited operational data`,
  });

  res.json({ callingRecord: result.record });
  broadcast('vessels-changed');
}));
