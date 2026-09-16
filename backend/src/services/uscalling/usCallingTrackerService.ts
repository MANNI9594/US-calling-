import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { normalizeVesselName } from '../../utils/normalizeVesselName';
import { parseOperationalDate } from '../../utils/parseOperationalDate';
import { readUsCallingTracker } from '../excel/usCallingTrackerReader';
import { markVesselDeparted, clearVesselDeparted, getDepartedNormalizedNames } from '../departed/departedVesselService';

export interface TrackerEntryInput {
  vesselName: string;
  tech?: string | null;
  etaRaw?: string | null;
  etdRaw?: string | null;
  arrivalPort?: string | null;
  flag?: string | null;
  certificateStatus?: string | null;
  enoaSentForReview?: string | null;
  qualship21ExpiryRaw?: string | null;
  usCallingMessageSentRaw?: string | null;
  receivedFromVesselRaw?: string | null;
  reviewedRaw?: string | null;
  ballastWaterNbicRaw?: string | null;
  ballastWaterCaWaOrRaw?: string | null;
  biofoulingPlanRaw?: string | null;
  marineInvasiveSpeciesRaw?: string | null;
  checklistSentRaw?: string | null;
  pscChecklistRaw?: string | null;
  remark?: string | null;
}

const DATE_ONLY_FIELDS = new Set(['etaRaw', 'etdRaw']);
const EDITABLE_FIELDS = new Set([
  'vesselName', 'tech', 'etaRaw', 'etdRaw', 'arrivalPort', 'flag', 'certificateStatus', 'enoaSentForReview',
  'qualship21ExpiryRaw', 'usCallingMessageSentRaw', 'receivedFromVesselRaw', 'reviewedRaw',
  'ballastWaterNbicRaw', 'ballastWaterCaWaOrRaw', 'biofoulingPlanRaw', 'marineInvasiveSpeciesRaw',
  'checklistSentRaw', 'pscChecklistRaw', 'remark',
]);

function parsedDateFor(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  return parseOperationalDate(raw).parsed;
}

async function annotateWithVecsPresence<T extends { vesselNameNormalized: string }>(
  entries: T[],
): Promise<Array<T & { inVecs: boolean; isDeparted: boolean }>> {
  if (entries.length === 0) return [];
  const vecsNames = new Set(
    (await prisma.vessel.findMany({ select: { vesselNameNormalized: true } })).map(
      (v: { vesselNameNormalized: string }) => v.vesselNameNormalized,
    ),
  );
  const departedNames = await getDepartedNormalizedNames();
  return entries.map((e) => ({
    ...e,
    inVecs: vecsNames.has(e.vesselNameNormalized),
    isDeparted: departedNames.has(e.vesselNameNormalized),
  }));
}

export async function listTrackerEntries(search?: string) {
  const entries = await prisma.usCallingTrackerEntry.findMany({
    where: search ? { vesselName: { contains: search, mode: 'insensitive' } } : undefined,
    orderBy: { vesselName: 'asc' },
  });
  return annotateWithVecsPresence(entries);
}

export async function createTrackerEntry(input: TrackerEntryInput) {
  const entry = await prisma.usCallingTrackerEntry.create({
    data: {
      vesselName: input.vesselName,
      vesselNameNormalized: normalizeVesselName(input.vesselName),
      tech: input.tech ?? null,
      etaRaw: input.etaRaw ?? null,
      etaParsed: parsedDateFor(input.etaRaw),
      etdRaw: input.etdRaw ?? null,
      etdParsed: parsedDateFor(input.etdRaw),
      arrivalPort: input.arrivalPort ?? null,
      flag: input.flag ?? null,
      certificateStatus: input.certificateStatus ?? null,
      enoaSentForReview: input.enoaSentForReview ?? null,
      qualship21ExpiryRaw: input.qualship21ExpiryRaw ?? null,
      usCallingMessageSentRaw: input.usCallingMessageSentRaw ?? null,
      receivedFromVesselRaw: input.receivedFromVesselRaw ?? null,
      reviewedRaw: input.reviewedRaw ?? null,
      ballastWaterNbicRaw: input.ballastWaterNbicRaw ?? null,
      ballastWaterCaWaOrRaw: input.ballastWaterCaWaOrRaw ?? null,
      biofoulingPlanRaw: input.biofoulingPlanRaw ?? null,
      marineInvasiveSpeciesRaw: input.marineInvasiveSpeciesRaw ?? null,
      checklistSentRaw: input.checklistSentRaw ?? null,
      pscChecklistRaw: input.pscChecklistRaw ?? null,
      remark: input.remark ?? null,
    },
  });
  return entry;
}

export async function updateTrackerEntryField(id: string, field: string, value: string | null) {
  if (!EDITABLE_FIELDS.has(field)) {
    throw new Error(`Field "${field}" is not editable`);
  }

  const updateData: Record<string, unknown> = { [field]: value };
  if (field === 'vesselName') {
    updateData.vesselNameNormalized = normalizeVesselName(value ?? '');
  }
  if (DATE_ONLY_FIELDS.has(field)) {
    updateData[field.replace('Raw', 'Parsed')] = parsedDateFor(value);
  }

  return prisma.usCallingTrackerEntry.update({ where: { id }, data: updateData });
}

export async function deleteTrackerEntry(id: string) {
  return prisma.usCallingTrackerEntry.delete({ where: { id } });
}

export interface ImportTrackerSummary {
  created: number;
  updated: number;
  totalRows: number;
  warnings: string[];
}

export async function importTrackerEntriesFromFile(fileBuffer: Buffer): Promise<ImportTrackerSummary> {
  const parsed = await readUsCallingTracker(fileBuffer);
  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const row of parsed.rows) {
      const normalized = normalizeVesselName(row.vesselName);
      const data = {
        vesselName: row.vesselName,
        tech: row.tech,
        etaRaw: row.etaRaw,
        etaParsed: parsedDateFor(row.etaRaw),
        etdRaw: row.etdRaw,
        etdParsed: parsedDateFor(row.etdRaw),
        arrivalPort: row.arrivalPort,
        flag: row.flag,
        certificateStatus: row.certificateStatus,
        enoaSentForReview: row.enoaSentForReview,
        qualship21ExpiryRaw: row.qualship21ExpiryRaw,
        usCallingMessageSentRaw: row.usCallingMessageSentRaw,
        receivedFromVesselRaw: row.receivedFromVesselRaw,
        reviewedRaw: row.reviewedRaw,
        ballastWaterNbicRaw: row.ballastWaterNbicRaw,
        ballastWaterCaWaOrRaw: row.ballastWaterCaWaOrRaw,
        biofoulingPlanRaw: row.biofoulingPlanRaw,
        marineInvasiveSpeciesRaw: row.marineInvasiveSpeciesRaw,
        checklistSentRaw: row.checklistSentRaw,
        pscChecklistRaw: row.pscChecklistRaw,
        remark: row.remark,
      };

      const existing = await tx.usCallingTrackerEntry.findFirst({ where: { vesselNameNormalized: normalized } });
      if (existing) {
        await tx.usCallingTrackerEntry.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await tx.usCallingTrackerEntry.create({ data: { ...data, vesselNameNormalized: normalized } });
        created += 1;
      }
    }
  });

  return { created, updated, totalRows: parsed.rows.length, warnings: parsed.warnings };
}

export interface TrackerExportResult {
  buffer: Buffer;
  filename: string;
}

const EXPORT_HEADERS = [
  'Name Of Vessels', 'Tech', 'ETA', 'ETD', 'Port ', 'Certificate Status', 'Qualship 21 Expiry Date',
  'E-NOA sent for review ', 'US Calling Message Sent', 'Received from vessel', 'Reviewed or not',
  'Ballast Water Report submitted to NBIC', 'Ballast Water Report submitted to California / Washington / Oregon?',
  'Bio-fouling Management Plan received from Master for review (California calls only)?',
  'Marine Invasive Species Program Annual Vessel Reporting Form submitted to California State Lands Commission ',
  'Flag', 'Hong Kong/ Marshall / Panama/ Liberia/ Singapore Checklist sent to vessel',
  'PSC Checklist sent or not sent to Flag State', 'Remark',
];

export async function exportTrackerEntriesToXlsx(ids?: string[]): Promise<TrackerExportResult> {
  const ExcelJS = (await import('exceljs')).default;
  const entries = await prisma.usCallingTrackerEntry.findMany({
    where: ids ? { id: { in: ids } } : undefined,
    orderBy: { vesselName: 'asc' },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('US Calling');
  sheet.addRow(EXPORT_HEADERS);
  for (const e of entries) {
    sheet.addRow([
      e.vesselName, e.tech, e.etaRaw, e.etdRaw, e.arrivalPort, e.certificateStatus, e.qualship21ExpiryRaw,
      e.enoaSentForReview, e.usCallingMessageSentRaw, e.receivedFromVesselRaw, e.reviewedRaw,
      e.ballastWaterNbicRaw, e.ballastWaterCaWaOrRaw, e.biofoulingPlanRaw, e.marineInvasiveSpeciesRaw,
      e.flag, e.checklistSentRaw, e.pscChecklistRaw, e.remark,
    ]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((col) => { col.width = 22; });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const today = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `US_Calling_${today}.xlsx` };
}

export interface TrackerDepartedResult {
  entryDeleted: boolean;
  snapshot: TrackerEntryInput;
}

/**
 * "Departed" action for US Calling — mirrors ENOA/D List's exact pattern:
 * deletes the entry and records the shared cross-list Departed marker, so
 * the badge shows on VECS List and ENOA/D List too, wherever else this
 * vessel currently appears.
 */
export async function markTrackerEntryDeparted(id: string): Promise<TrackerDepartedResult> {
  const entry = await prisma.usCallingTrackerEntry.findUnique({ where: { id } });
  if (!entry) throw new Error('Entry not found');

  const snapshot: TrackerEntryInput = {
    vesselName: entry.vesselName,
    tech: entry.tech,
    etaRaw: entry.etaRaw,
    etdRaw: entry.etdRaw,
    arrivalPort: entry.arrivalPort,
    flag: entry.flag,
    certificateStatus: entry.certificateStatus,
    enoaSentForReview: entry.enoaSentForReview,
    qualship21ExpiryRaw: entry.qualship21ExpiryRaw,
    usCallingMessageSentRaw: entry.usCallingMessageSentRaw,
    receivedFromVesselRaw: entry.receivedFromVesselRaw,
    reviewedRaw: entry.reviewedRaw,
    ballastWaterNbicRaw: entry.ballastWaterNbicRaw,
    ballastWaterCaWaOrRaw: entry.ballastWaterCaWaOrRaw,
    biofoulingPlanRaw: entry.biofoulingPlanRaw,
    marineInvasiveSpeciesRaw: entry.marineInvasiveSpeciesRaw,
    checklistSentRaw: entry.checklistSentRaw,
    pscChecklistRaw: entry.pscChecklistRaw,
    remark: entry.remark,
  };

  await prisma.usCallingTrackerEntry.delete({ where: { id } });
  await markVesselDeparted(entry.vesselName);

  return { entryDeleted: true, snapshot };
}

/**
 * Undoes a "Departed" action from US Calling: recreates the entry from
 * its snapshot and clears the shared Departed marker.
 */
export async function undoTrackerEntryDeparted(snapshot: TrackerEntryInput) {
  const entry = await createTrackerEntry(snapshot);
  await clearVesselDeparted(snapshot.vesselName);
  return entry;
}
