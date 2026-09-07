import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { storage } from '../storage';
import { readUsCallingList, type UsCallingListRow } from './usCallingListReader';
import { matchCallingListRow, type CallingListVesselCandidate } from './callingListMatching';
import { parseOperationalDate } from '../../utils/parseOperationalDate';
import { checkAndRecordDate, checkEtdBeforeEta, checkPastEtd } from '../dataQuality/dataQualityService';
import { logAudit } from '../audit/auditService';

export interface CallingListPreviewRow {
  rowNumber: number;
  vesselNameRaw: string;
  matchStatus: 'ACTIVE_MATCH' | 'ARCHIVED_MATCH' | 'NEW_UNKNOWN' | 'AMBIGUOUS';
  matchedVesselId: string | null;
  matchedVesselName: string | null;
  previousEta: string | null;
  newEta: string | null;
  previousEtd: string | null;
  newEtd: string | null;
  previousPort: string | null;
  newPort: string | null;
  changeStatus: 'UPDATED' | 'UNCHANGED' | 'NEW' | 'ARCHIVED_FOUND' | 'AMBIGUOUS' | 'INVALID';
  dateWarnings: string[];
}

export interface CallingListPreviewResult {
  sheetName: string;
  rowCount: number;
  storageKey: string;
  originalFilename: string;
  rows: CallingListPreviewRow[];
  counts: {
    updated: number;
    unchanged: number;
    newUnknown: number;
    archivedFound: number;
    ambiguous: number;
    pastEtd: number;
  };
  readerWarnings: string[];
}

function parseDateOrWarn(raw: string | null, warnings: string[], label: string): Date | null {
  if (!raw) return null;
  const result = parseOperationalDate(raw);
  if (!result.parsed) warnings.push(`${label}: ${result.reason}`);
  return result.parsed;
}

export async function previewUsCallingListUpdate(fileBuffer: Buffer, originalFilename: string): Promise<CallingListPreviewResult> {
  const parsed = await readUsCallingList(fileBuffer);

  const allVessels = await prisma.vessel.findMany({
    select: { id: true, vesselName: true, vesselNameNormalized: true, status: true },
  });
  const candidates: CallingListVesselCandidate[] = allVessels.map(
    (v: { id: string; vesselName: string; vesselNameNormalized: string; status: 'ACTIVE' | 'ARCHIVED' }) => ({
      id: v.id,
      vesselName: v.vesselName,
      vesselNameNormalized: v.vesselNameNormalized,
      status: v.status,
    }),
  );

  const currentRecords = await prisma.vesselCallingRecord.findMany({
    where: { vesselId: { in: candidates.map((c) => c.id) }, isCurrent: true },
  });
  interface CurrentRecordSnapshot {
    vesselId: string;
    etaRaw: string | null;
    etdRaw: string | null;
    arrivalPort: string | null;
  }
  const currentRecordsByVesselId = new Map<string, CurrentRecordSnapshot>();
  for (const r of currentRecords as CurrentRecordSnapshot[]) {
    currentRecordsByVesselId.set(r.vesselId, r);
  }

  const previewRows: CallingListPreviewRow[] = [];
  const counts = { updated: 0, unchanged: 0, newUnknown: 0, archivedFound: 0, ambiguous: 0, pastEtd: 0 };
  const now = new Date();

  for (const row of parsed.rows) {
    if (!row.vesselName) continue;

    const match = matchCallingListRow(row.vesselName, candidates);
    const dateWarnings: string[] = [];

    const newEtaParsed = parseDateOrWarn(row.etaRaw, dateWarnings, 'ETA');
    const newEtdParsed = parseDateOrWarn(row.etdRaw, dateWarnings, 'ETD');
    if (newEtaParsed && newEtdParsed && newEtdParsed.getTime() < newEtaParsed.getTime()) {
      dateWarnings.push('ETD is before ETA');
    }
    const isPastEtd = newEtdParsed ? newEtdParsed.getTime() < now.getTime() : false;
    if (isPastEtd) {
      dateWarnings.push('ETD has already passed');
      counts.pastEtd += 1;
    }

    const previousRecord = match.matchedVesselId ? currentRecordsByVesselId.get(match.matchedVesselId) : undefined;

    let changeStatus: CallingListPreviewRow['changeStatus'];
    if (match.status === 'NEW_UNKNOWN') {
      changeStatus = 'NEW';
      counts.newUnknown += 1;
    } else if (match.status === 'AMBIGUOUS') {
      changeStatus = 'AMBIGUOUS';
      counts.ambiguous += 1;
    } else if (match.status === 'ARCHIVED_MATCH') {
      changeStatus = 'ARCHIVED_FOUND';
      counts.archivedFound += 1;
    } else {
      const unchanged =
        previousRecord?.etaRaw === row.etaRaw && previousRecord?.etdRaw === row.etdRaw && previousRecord?.arrivalPort === row.arrivalPort;
      changeStatus = unchanged ? 'UNCHANGED' : 'UPDATED';
      if (unchanged) counts.unchanged += 1;
      else counts.updated += 1;
    }

    previewRows.push({
      rowNumber: row.rowNumber,
      vesselNameRaw: row.vesselName,
      matchStatus: match.status,
      matchedVesselId: match.matchedVesselId,
      matchedVesselName: match.matchedVesselName,
      previousEta: previousRecord?.etaRaw ?? null,
      newEta: row.etaRaw,
      previousEtd: previousRecord?.etdRaw ?? null,
      newEtd: row.etdRaw,
      previousPort: previousRecord?.arrivalPort ?? null,
      newPort: row.arrivalPort,
      changeStatus,
      dateWarnings,
    });
  }

  const storageKey = storage.buildKey('us-calling-uploads', originalFilename);
  await storage.put(storageKey, fileBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  return {
    sheetName: parsed.sheetName,
    rowCount: parsed.rows.length,
    storageKey,
    originalFilename,
    rows: previewRows,
    counts,
    readerWarnings: parsed.warnings,
  };
}

export interface CommitOptions {
  storageKey: string;
  originalFilename: string;
  restoreArchivedVessels: boolean;
}

export interface CallingListCommitSummary {
  rowsProcessed: number;
  vesselsUpdated: number;
  vesselsUnchanged: number;
  vesselsRestored: number;
  archivedSkipped: number;
  newUnknownSkipped: number;
  ambiguousSkipped: number;
  dataQualityIssuesRaised: number;
}

/**
 * Applies a previewed US Calling List: creates a new "current"
 * VesselCallingRecord for every confidently-matched row (marking the prior
 * current record non-current, never deleting it — that's the history).
 * Runs inside one transaction, same atomicity guarantee as Master Import.
 *
 * NEW_UNKNOWN and AMBIGUOUS rows are never applied automatically — they're
 * informational only in this phase. Creating a new vessel from an unknown
 * row, and resolving an ambiguous match, are both deliberately left as a
 * manual, reviewed action rather than an automatic one here.
 */
export async function commitUsCallingListUpdate(options: CommitOptions): Promise<{ batchId: string; summary: CallingListCommitSummary }> {
  const fileBuffer = await storage.get(options.storageKey);
  const parsed = await readUsCallingList(fileBuffer);

  const batch = await prisma.importBatch.create({
    data: {
      type: 'US_CALLING_LIST_UPLOAD',
      originalFilename: options.originalFilename,
      storageKey: options.storageKey,
      status: 'PROCESSING',
    },
  });

  try {
    const summary = await runCommitTransaction(parsed.rows, batch.id, options.restoreArchivedVessels);

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'COMPLETED', completedAt: new Date(), summaryJson: summary as unknown as Prisma.InputJsonValue },
    });

    await logAudit({
      eventType: 'US_CALLING_LIST_UPLOADED',
      importBatchId: batch.id,
      summary: `US Calling List "${options.originalFilename}" applied: ${summary.vesselsUpdated} updated, ${summary.vesselsRestored} restored`,
      detail: summary as unknown as Prisma.InputJsonValue,
    });

    return { batchId: batch.id, summary };
  } catch (err) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

async function runCommitTransaction(
  rows: UsCallingListRow[],
  batchId: string,
  restoreArchivedVessels: boolean,
): Promise<CallingListCommitSummary> {
  const summary: CallingListCommitSummary = {
    rowsProcessed: 0,
    vesselsUpdated: 0,
    vesselsUnchanged: 0,
    vesselsRestored: 0,
    archivedSkipped: 0,
    newUnknownSkipped: 0,
    ambiguousSkipped: 0,
    dataQualityIssuesRaised: 0,
  };

  await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const allVessels = await tx.vessel.findMany({
        select: { id: true, vesselName: true, vesselNameNormalized: true, status: true },
      });
      const candidates: CallingListVesselCandidate[] = allVessels.map(
        (v: { id: string; vesselName: string; vesselNameNormalized: string; status: 'ACTIVE' | 'ARCHIVED' }) => ({
          id: v.id,
          vesselName: v.vesselName,
          vesselNameNormalized: v.vesselNameNormalized,
          status: v.status,
        }),
      );

      for (const row of rows) {
        if (!row.vesselName) continue;
        summary.rowsProcessed += 1;

        const match = matchCallingListRow(row.vesselName, candidates);

        if (match.status === 'NEW_UNKNOWN') {
          summary.newUnknownSkipped += 1;
          continue;
        }
        if (match.status === 'AMBIGUOUS') {
          summary.ambiguousSkipped += 1;
          continue;
        }
        if (match.status === 'ARCHIVED_MATCH' && !restoreArchivedVessels) {
          summary.archivedSkipped += 1;
          continue;
        }

        const vesselId = match.matchedVesselId as string;

        if (match.status === 'ARCHIVED_MATCH' && restoreArchivedVessels) {
          await tx.vessel.update({
            where: { id: vesselId },
            data: { status: 'ACTIVE', restoredAt: new Date() },
          });
          await logAudit({
            eventType: 'VESSEL_RESTORED',
            vesselId,
            summary: `${match.matchedVesselName} restored to Active Master via US Calling List match`,
            importBatchId: batchId,
          });
          summary.vesselsRestored += 1;
        }

        const previousCurrent = await tx.vesselCallingRecord.findFirst({ where: { vesselId, isCurrent: true } });
        const unchanged =
          previousCurrent?.etaRaw === row.etaRaw &&
          previousCurrent?.etdRaw === row.etdRaw &&
          previousCurrent?.arrivalPort === row.arrivalPort;

        if (unchanged) {
          summary.vesselsUnchanged += 1;
          continue;
        }

        if (previousCurrent) {
          await tx.vesselCallingRecord.update({ where: { id: previousCurrent.id }, data: { isCurrent: false } });
        }

        const newRecord = await tx.vesselCallingRecord.create({
          data: {
            vesselId,
            isCurrent: true,
            arrivalPort: row.arrivalPort,
            etaRaw: row.etaRaw,
            etdRaw: row.etdRaw,
            voyageType: row.voyageType,
            transactionType: row.transactionType,
            sendTo: row.sendTo,
            ballastOrLoaded: previousCurrent?.ballastOrLoaded ?? null, // not present in this source — carried forward
            source: 'US_CALLING_LIST_UPLOAD',
            sourceImportBatchId: batchId,
          },
        });

        const { parsed: etaParsed } = await checkAndRecordDate(tx, {
          raw: row.etaRaw,
          fieldName: 'eta',
          callingRecordId: newRecord.id,
          vesselId,
        });
        const { parsed: etdParsed } = await checkAndRecordDate(tx, {
          raw: row.etdRaw,
          fieldName: 'etd',
          callingRecordId: newRecord.id,
          vesselId,
        });
        if (!etaParsed) summary.dataQualityIssuesRaised += 1;
        if (!etdParsed) summary.dataQualityIssuesRaised += 1;

        await checkEtdBeforeEta(tx, { etaParsed, etdParsed, callingRecordId: newRecord.id, vesselId });
        if (etaParsed && etdParsed && etdParsed.getTime() < etaParsed.getTime()) {
          summary.dataQualityIssuesRaised += 1;
        }

        const isPast = await checkPastEtd(tx, { etdParsed, callingRecordId: newRecord.id, vesselId });
        if (isPast) summary.dataQualityIssuesRaised += 1;

        if (etaParsed || etdParsed) {
          await tx.vesselCallingRecord.update({
            where: { id: newRecord.id },
            data: { ...(etaParsed ? { etaParsed } : {}), ...(etdParsed ? { etdParsed } : {}) },
          });
        }

        summary.vesselsUpdated += 1;
      }
    },
    { timeout: 60_000 },
  );

  return summary;
}
