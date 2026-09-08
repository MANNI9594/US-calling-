import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { normalizeVesselName } from '../../utils/normalizeVesselName';
import { parseOperationalDate } from '../../utils/parseOperationalDate';
import { readUsCallingList, type UsCallingListRow } from './usCallingListReader';
import { runCommitTransaction, type CallingListCommitSummary } from './usCallingImportService';
import { matchCallingListRow, type CallingListVesselCandidate } from './callingListMatching';
import { isRemovalCandidate } from './removalCandidate';
import { logAudit } from '../audit/auditService';

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
  return prisma.usCallingListEntry.findMany({
    where: search
      ? { vesselName: { contains: search, mode: 'insensitive' } }
      : undefined,
    orderBy: { vesselName: 'asc' },
  });
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
export interface ApplyToVecsSummary extends CallingListCommitSummary {
  vesselsRemoved: number;
}

export async function applyEntriesToVecs(restoreArchivedVessels: boolean): Promise<{ batchId: string; summary: ApplyToVecsSummary }> {
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

  // Computed BEFORE the update transaction — the set of "active vessels
  // matched by no entry at all" is unaffected by updating vessels that ARE
  // matched, so this ordering doesn't change the result, just keeps the
  // removal logic simple and separately auditable from the update logic.
  const { removalCandidates } = await computeRemovalCandidates(entries);

  const batch = await prisma.importBatch.create({
    data: {
      type: 'US_CALLING_LIST_UPLOAD',
      originalFilename: 'US Calling List (live, in-app)',
      storageKey: null,
      status: 'PROCESSING',
    },
  });

  try {
    const summary = await runCommitTransaction(rows, batch.id, restoreArchivedVessels);

    // Archive departed vessels — the SAME archive mechanism as the manual
    // "Remove Selected" button on VECS List: status flip only, vessel
    // profile/evidence/history untouched and fully restorable. Never a
    // delete, regardless of how a vessel came to be archived.
    for (const candidate of removalCandidates) {
      await prisma.vessel.update({
        where: { id: candidate.vesselId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await logAudit({
        eventType: 'VESSEL_REMOVED',
        vesselId: candidate.vesselId,
        importBatchId: batch.id,
        summary: `${candidate.vesselName} auto-removed from VECS List: not present in the current US Calling List and its ETA (${candidate.etaRaw ?? 'unknown'}) is not in the future`,
      });
    }

    const fullSummary: ApplyToVecsSummary = { ...summary, vesselsRemoved: removalCandidates.length };

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'COMPLETED', completedAt: new Date(), summaryJson: fullSummary as unknown as Prisma.InputJsonValue },
    });

    await logAudit({
      eventType: 'US_CALLING_LIST_UPLOADED',
      importBatchId: batch.id,
      summary: `US Calling List applied from the live in-app list: ${summary.vesselsUpdated} updated, ${summary.vesselsRestored} restored, ${removalCandidates.length} removed (departed)`,
      detail: fullSummary as unknown as Prisma.InputJsonValue,
    });

    return { batchId: batch.id, summary: fullSummary };
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
export async function exportEntriesToXlsx(): Promise<UsCallingListExportResult> {
  const ExcelJS = (await import('exceljs')).default;
  const entries = await prisma.usCallingListEntry.findMany({ orderBy: { vesselName: 'asc' } });

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
 * the confirmation-popup data the user explicitly asked for before this
 * action runs, since it can both update AND remove vessels.
 *
 * Removal rule (deliberately conservative): a VECS vessel is only a
 * removal candidate if it is BOTH (a) not matched by name to any current
 * US Calling List entry, AND (b) its current ETA is today or already in
 * the past (or entirely unparseable). A vessel with a genuinely FUTURE ETA
 * is never touched, regardless of whether it's on the US Calling List —
 * the US Calling List is a near-term/current view and legitimately won't
 * contain vessels VECS is tracking for 10-20 days out yet. Being missing
 * from a near-term list is only meaningful evidence of departure once the
 * vessel's own ETA says it should already be here.
 *
 * IMPORTANT: removal here means the same thing it always means in this
 * app — archived, never deleted. The vessel's permanent profile, its
 * evidence images, and its full history remain completely intact and
 * restorable via the VECS List "Archived" tab. This function (and
 * applyEntriesToVecs below) never touches the delete path.
 */
export interface ApplyToVecsPreview {
  counts: {
    totalEntries: number;
    updated: number;
    unchanged: number;
    newUnknown: number;
    archivedFound: number;
    ambiguous: number;
    toBeRemoved: number;
  };
  removalCandidates: Array<{ vesselId: string; vesselName: string; etaRaw: string | null }>;
}

interface VesselWithCurrentRecord {
  id: string;
  vesselName: string;
  vesselNameNormalized: string;
  status: 'ACTIVE' | 'ARCHIVED';
  callingRecords: Array<{ etaRaw: string | null; etdRaw: string | null; etaParsed: Date | null; arrivalPort?: string | null }>;
}

async function computeRemovalCandidates(
  entries: Array<{ vesselNameNormalized: string }>,
): Promise<{ candidates: CallingListVesselCandidate[]; allVessels: VesselWithCurrentRecord[]; removalCandidates: ApplyToVecsPreview['removalCandidates']; matchedNormalizedNames: Set<string> }> {
  const allVessels = (await prisma.vessel.findMany({
    select: {
      id: true,
      vesselName: true,
      vesselNameNormalized: true,
      status: true,
      callingRecords: { where: { isCurrent: true }, take: 1, select: { etaRaw: true, etdRaw: true, etaParsed: true, arrivalPort: true } },
    },
  })) as unknown as VesselWithCurrentRecord[];

  const candidates: CallingListVesselCandidate[] = allVessels.map((v) => ({
    id: v.id,
    vesselName: v.vesselName,
    vesselNameNormalized: v.vesselNameNormalized,
    status: v.status,
  }));

  const matchedNormalizedNames = new Set(entries.map((e) => e.vesselNameNormalized));

  const now = Date.now();
  const removalCandidates: ApplyToVecsPreview['removalCandidates'] = [];
  for (const v of allVessels) {
    const cr = v.callingRecords[0];
    const etaParsedMs = cr?.etaParsed ? new Date(cr.etaParsed).getTime() : null;

    if (!isRemovalCandidate({ status: v.status, vesselNameNormalized: v.vesselNameNormalized, etaParsedMs }, matchedNormalizedNames, now)) {
      continue;
    }

    removalCandidates.push({ vesselId: v.id, vesselName: v.vesselName, etaRaw: cr?.etaRaw ?? null });
  }

  return { candidates, allVessels, removalCandidates, matchedNormalizedNames };
}

export async function previewApplyToVecs(): Promise<ApplyToVecsPreview> {
  const entries = await prisma.usCallingListEntry.findMany();
  const { candidates, allVessels, removalCandidates } = await computeRemovalCandidates(entries);

  const counts = { totalEntries: entries.length, updated: 0, unchanged: 0, newUnknown: 0, archivedFound: 0, ambiguous: 0, toBeRemoved: removalCandidates.length };

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

  return { counts, removalCandidates };
}
