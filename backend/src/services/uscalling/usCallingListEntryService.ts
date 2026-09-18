import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { normalizeVesselName } from '../../utils/normalizeVesselName';
import { parseOperationalDate } from '../../utils/parseOperationalDate';
import { readUsCallingList, type UsCallingListRow } from './usCallingListReader';
import { runCommitTransaction, type CallingListCommitSummary } from './usCallingImportService';
import { matchCallingListRow, type CallingListVesselCandidate } from './callingListMatching';
import { logAudit } from '../audit/auditService';
import { markVesselDeparted, clearVesselDeparted, getDepartedNormalizedNames } from '../departed/departedVesselService';

export interface EntryInput {
  vesselName: string;
  voyageType?: string | null;
  transactionType?: string | null;
  sendTo?: string | null;
  arrivalPort?: string | null;
  etaRaw?: string | null;
  etdRaw?: string | null;
}

function parsedDatesFor(etaRaw: string | null | undefined, etdRaw: string | null | undefined) {
  return {
    etaParsed: etaRaw ? parseOperationalDate(etaRaw).parsed : null,
    etdParsed: etdRaw ? parseOperationalDate(etdRaw).parsed : null,
  };
}

export async function listEntries(search?: string) {
  const entries = await prisma.usCallingListEntry.findMany({
    where: search
      ? { vesselName: { contains: search, mode: 'insensitive' } }
      : undefined,
    orderBy: { vesselName: 'asc' },
  });
  const departedNames = await getDepartedNormalizedNames();
  return entries.map((e: { vesselNameNormalized: string }) => ({ ...e, isDeparted: departedNames.has(e.vesselNameNormalized) }));
}

export async function createEntry(input: EntryInput) {
  const { etaParsed, etdParsed } = parsedDatesFor(input.etaRaw, input.etdRaw);
  const entry = await prisma.usCallingListEntry.create({
    data: {
      vesselName: input.vesselName,
      vesselNameNormalized: normalizeVesselName(input.vesselName),
      voyageType: input.voyageType ?? null,
      transactionType: input.transactionType ?? null,
      sendTo: input.sendTo ?? null,
      arrivalPort: input.arrivalPort ?? null,
      etaRaw: input.etaRaw ?? null,
      etdRaw: input.etdRaw ?? null,
      etaParsed,
      etdParsed,
    },
  });
  // A vessel actively present on ENOA/D List is, by definition, not
  // departed — even if it carries a stale Departed marker from earlier
  // (e.g. its ENOA was sent by mistake, removed via "Departed", then
  // re-added once the mistake was caught). Being back on this list is
  // unambiguous evidence it's active again, so clear the marker here too,
  // not just on the apply/import path — a plain "Add Vessel" create was a
  // real gap this didn't cover before.
  await clearVesselDeparted(input.vesselName);
  return entry;
}

const EDITABLE_ENTRY_FIELDS = new Set([
  'vesselName', 'voyageType', 'transactionType', 'sendTo', 'arrivalPort', 'etaRaw', 'etdRaw',
]);

export async function updateEntryField(id: string, field: string, value: string | null) {
  if (!EDITABLE_ENTRY_FIELDS.has(field)) {
    throw new Error(`Field "${field}" is not editable`);
  }

  const updateData: Record<string, unknown> = { [field]: value };

  if (field === 'vesselName') {
    updateData.vesselNameNormalized = normalizeVesselName(value ?? '');
  }
  if (field === 'etaRaw') {
    updateData.etaParsed = value ? parseOperationalDate(value).parsed : null;
  }
  if (field === 'etdRaw') {
    updateData.etdParsed = value ? parseOperationalDate(value).parsed : null;
  }

  return prisma.usCallingListEntry.update({ where: { id }, data: updateData });
}

export async function deleteEntry(id: string) {
  return prisma.usCallingListEntry.delete({ where: { id } });
}

export interface ImportEntriesSummary {
  created: number;
  updated: number;
  totalRows: number;
}

/**
 * Bulk-imports a US Calling List Excel file into the persistent entry
 * table — upserts by normalized vessel name (never duplicates), never
 * deletes an existing entry just because it's absent from this particular
 * file. This is what lets "re-upload the file" and "just edit the rows
 * that are already here" coexist as equally valid ways to keep the list
 * current.
 */
export async function importEntriesFromFile(fileBuffer: Buffer): Promise<ImportEntriesSummary> {
  const parsed = await readUsCallingList(fileBuffer);
  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const row of parsed.rows) {
      if (!row.vesselName) continue;
      const normalized = normalizeVesselName(row.vesselName);
      const { etaParsed, etdParsed } = parsedDatesFor(row.etaRaw, row.etdRaw);

      const existing = await tx.usCallingListEntry.findFirst({ where: { vesselNameNormalized: normalized } });
      if (existing) {
        await tx.usCallingListEntry.update({
          where: { id: existing.id },
          data: {
            voyageType: row.voyageType,
            transactionType: row.transactionType,
            sendTo: row.sendTo,
            arrivalPort: row.arrivalPort,
            etaRaw: row.etaRaw,
            etdRaw: row.etdRaw,
            etaParsed,
            etdParsed,
          },
        });
        updated += 1;
      } else {
        await tx.usCallingListEntry.create({
          data: {
            vesselName: row.vesselName,
            vesselNameNormalized: normalized,
            voyageType: row.voyageType,
            transactionType: row.transactionType,
            sendTo: row.sendTo,
            arrivalPort: row.arrivalPort,
            etaRaw: row.etaRaw,
            etdRaw: row.etdRaw,
            etaParsed,
            etdParsed,
          },
        });
        created += 1;
      }
    }
  });

  return { created, updated, totalRows: parsed.rows.length };
}

/**
 * Applies every currently-persisted entry to the VECS List (Vessel /
 * VesselCallingRecord records) — the one-click replacement for "upload
 * the file again." Reuses the EXACT SAME matching + data-quality +
 * atomicity logic as a file upload always has (`runCommitTransaction`,
 * shared with usCallingImportService.ts) — this is a different source of
 * rows, not different business logic.
 */
export async function applyEntriesToVecs(restoreArchivedVessels: boolean): Promise<{ batchId: string; summary: CallingListCommitSummary }> {
  const entries = await prisma.usCallingListEntry.findMany();

  const rows: UsCallingListRow[] = entries.map((e: {
    vesselName: string;
    voyageType: string | null;
    transactionType: string | null;
    sendTo: string | null;
    arrivalPort: string | null;
    etaRaw: string | null;
    etdRaw: string | null;
  }, idx: number) => ({
    rowNumber: idx + 2,
    vesselName: e.vesselName,
    voyageType: e.voyageType,
    transactionType: e.transactionType,
    sendTo: e.sendTo,
    arrivalPort: e.arrivalPort,
    etaRaw: e.etaRaw,
    etdRaw: e.etdRaw,
  }));

  const batch = await prisma.importBatch.create({
    data: {
      type: 'US_CALLING_LIST_UPLOAD',
      originalFilename: 'US Calling List (live, in-app)',
      storageKey: null,
      status: 'PROCESSING',
    },
  });

  try {
    // Update-only, by explicit design: this NEVER removes/archives a
    // vessel on its own. Removal is a fully manual, human decision —
    // mark a vessel "Departed" on ENOA/D List (see markVesselDeparted
    // below), which flags it on VECS List; the person then decides
    // whether and when to actually remove it themselves.
    const summary = await runCommitTransaction(rows, batch.id, restoreArchivedVessels);

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'COMPLETED', completedAt: new Date(), summaryJson: summary as unknown as Prisma.InputJsonValue },
    });

    await logAudit({
      eventType: 'US_CALLING_LIST_UPLOADED',
      importBatchId: batch.id,
      summary: `US Calling List applied from the live in-app list: ${summary.vesselsUpdated} updated, ${summary.vesselsRestored} restored`,
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

export interface UsCallingListExportResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Exports the current persisted entries as a plain .xlsx matching the
 * original 7-column US Calling List format — a simple flat sheet, no
 * embedded images/styling template needed (unlike the VECS Master export).
 */
export async function exportEntriesToXlsx(ids?: string[]): Promise<UsCallingListExportResult> {
  const ExcelJS = (await import('exceljs')).default;
  const entries = await prisma.usCallingListEntry.findMany({
    where: ids ? { id: { in: ids } } : undefined,
    orderBy: { vesselName: 'asc' },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('US Calling List');
  sheet.addRow(['Vessel Name', 'Voyage Type', 'Transection type', 'Send To', 'Port', 'ETA', 'ETD']);
  for (const e of entries) {
    sheet.addRow([e.vesselName, e.voyageType, e.transactionType, e.sendTo, e.arrivalPort, e.etaRaw, e.etdRaw]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((col) => { col.width = 20; });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const today = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `US_Calling_List_${today}.xlsx` };
}

/**
 * Computes what "Apply to VECS List" WOULD do, without changing anything —
 * update-only, per explicit design (see applyEntriesToVecs above). No
 * removal/archiving is computed or previewed here anymore.
 */
export interface ApplyToVecsPreview {
  counts: {
    totalEntries: number;
    updated: number;
    unchanged: number;
    newUnknown: number;
    archivedFound: number;
    ambiguous: number;
  };
}

interface VesselWithCurrentRecord {
  id: string;
  vesselName: string;
  vesselNameNormalized: string;
  status: 'ACTIVE' | 'ARCHIVED';
  callingRecords: Array<{ etaRaw: string | null; etdRaw: string | null; arrivalPort?: string | null }>;
}

export async function previewApplyToVecs(): Promise<ApplyToVecsPreview> {
  const entries = await prisma.usCallingListEntry.findMany();

  const allVessels = (await prisma.vessel.findMany({
    select: {
      id: true,
      vesselName: true,
      vesselNameNormalized: true,
      status: true,
      callingRecords: { where: { isCurrent: true }, take: 1, select: { etaRaw: true, etdRaw: true, arrivalPort: true } },
    },
  })) as unknown as VesselWithCurrentRecord[];

  const candidates: CallingListVesselCandidate[] = allVessels.map((v) => ({
    id: v.id,
    vesselName: v.vesselName,
    vesselNameNormalized: v.vesselNameNormalized,
    status: v.status,
  }));

  const counts = { totalEntries: entries.length, updated: 0, unchanged: 0, newUnknown: 0, archivedFound: 0, ambiguous: 0 };

  for (const entry of entries) {
    const match = matchCallingListRow(entry.vesselName, candidates);

    if (match.status === 'NEW_UNKNOWN') {
      counts.newUnknown += 1;
    } else if (match.status === 'AMBIGUOUS') {
      counts.ambiguous += 1;
    } else if (match.status === 'ARCHIVED_MATCH') {
      counts.archivedFound += 1;
    } else {
      const vessel = allVessels.find((v) => v.id === match.matchedVesselId);
      const cr = vessel?.callingRecords[0];
      const unchanged = cr?.etaRaw === entry.etaRaw && cr?.etdRaw === entry.etdRaw && cr?.arrivalPort === entry.arrivalPort;
      if (unchanged) counts.unchanged += 1;
      else counts.updated += 1;
    }
  }

  return { counts };
}

export interface MarkDepartedResult {
  entryDeleted: boolean;
  snapshot: {
    vesselName: string;
    voyageType: string | null;
    transactionType: string | null;
    sendTo: string | null;
    arrivalPort: string | null;
    etaRaw: string | null;
    etdRaw: string | null;
  };
}

/**
 * Marks a vessel Departed from ENOA/D List: deletes the entry AND records
 * the shared cross-list Departed marker (see departedVesselService.ts) so
 * the badge shows on US Calling and VECS List too, wherever else this
 * vessel currently appears — independent of whether a matching VECS
 * vessel exists yet.
 *
 * Returns a full snapshot of the deleted entry's data, not just its id —
 * Undo needs to recreate an equivalent entry (a delete can't be undone by
 * replaying a field-value diff the way a normal edit can), and the
 * original id is gone the moment this transaction commits.
 */
export async function markEntryDeparted(entryId: string): Promise<MarkDepartedResult> {
  const entry = await prisma.usCallingListEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error('Entry not found');

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.usCallingListEntry.delete({ where: { id: entryId } });
  });
  await markVesselDeparted(entry.vesselName);

  return {
    entryDeleted: true,
    snapshot: {
      vesselName: entry.vesselName,
      voyageType: entry.voyageType,
      transactionType: entry.transactionType,
      sendTo: entry.sendTo,
      arrivalPort: entry.arrivalPort,
      etaRaw: entry.etaRaw,
      etdRaw: entry.etdRaw,
    },
  };
}

/**
 * Undoes a "Departed" action from ENOA/D List: recreates the entry from
 * its snapshot (a new id — the original is gone, but the data is
 * identical) and clears the shared Departed marker, since undoing a
 * departure should undo the cross-list badge too.
 */
export async function undoEntryDeparted(snapshot: MarkDepartedResult['snapshot']) {
  // createEntry already clears the Departed marker as of its own fix
  // above — kept as a single call here rather than a redundant second one,
  // since re-creating the row IS what un-departs it.
  return createEntry(snapshot);
}
