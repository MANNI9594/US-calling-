import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { storage } from '../storage';
import { readMasterWorkbook, type MasterWorkbookReadResult } from '../excel/masterWorkbookReader';
import { groupImageAnchorsByRow } from '../excel/imageAssociationGrouping';
import { resolveVesselIdentity } from './vesselIdentity';
import { checkAndRecordDate, checkEtdBeforeEta, checkPastEtd, checkImoPlausibility } from '../dataQuality/dataQualityService';
import { logAudit } from '../audit/auditService';

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
};

export interface MasterImportPreview {
  sheetName: string;
  headers: string[];
  rowCount: number;
  imageCount: number;
  cleanImageAssociationCount: number;
  pileupImageCount: number;
  vesselsNew: string[];
  vesselsAlreadyInDatabase: string[];
  readerWarnings: string[];
  storageKey: string;
  originalFilename: string;
}

/**
 * READ-ONLY preview: parses the workbook and checks proposed vessel
 * identities against the database, but writes nothing except the original
 * file to storage (so the same bytes can be committed later without asking
 * the user to re-upload). No Vessel/Evidence/CallingRecord rows are created
 * here — see docs/EVIDENCE_MAPPING.md and the "import preview before
 * committing" requirement.
 */
export async function previewMasterImport(fileBuffer: Buffer, originalFilename: string): Promise<MasterImportPreview> {
  const parsed = await readMasterWorkbook(fileBuffer);
  const { clean, pileup } = groupImageAnchorsByRow(
    parsed.images.map((img) => ({ imageId: img.imageId, anchorRow: img.anchorRow, anchorCol: img.anchorCol })),
  );

  const vesselsNew: string[] = [];
  const vesselsAlreadyInDatabase: string[] = [];

  for (const row of parsed.rows) {
    const vesselName = String(row.values['Vessel Name'] ?? '').trim();
    if (!vesselName) continue;
    const identity = resolveVesselIdentity(vesselName, row.values['IMO No'] as string | number | null);

    const existing = await prisma.vessel.findFirst({
      where:
        identity.lookupStrategy === 'IMO_THEN_NAME'
          ? { OR: [{ imoNumber: identity.imoNumber as string }, { vesselNameNormalized: identity.vesselNameNormalized }] }
          : { vesselNameNormalized: identity.vesselNameNormalized },
    });

    if (existing) {
      vesselsAlreadyInDatabase.push(vesselName);
    } else {
      vesselsNew.push(vesselName);
    }
  }

  const storageKey = storage.buildKey('master-imports', originalFilename);
  await storage.put(
    storageKey,
    fileBuffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  return {
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    imageCount: parsed.images.length,
    cleanImageAssociationCount: clean.length,
    pileupImageCount: pileup.length,
    vesselsNew,
    vesselsAlreadyInDatabase,
    readerWarnings: parsed.warnings,
    storageKey,
    originalFilename,
  };
}

export interface MasterImportSummary {
  vesselsCreated: number;
  vesselsSkippedAlreadyExists: number;
  evidenceCleanlyAssociated: number;
  evidenceUnassigned: number;
  evidenceSkippedDuplicate: number;
  dataQualityIssuesRaised: number;
  pastEtdCount: number;
  readerWarnings: string[];
}

/**
 * Commits a previously-previewed Master workbook: creates Vessel,
 * VesselCallingRecord, and VesselEvidence rows inside a single transaction.
 * If anything throws, Postgres rolls back everything — no partial import
 * is ever left behind (see docs/ARCHITECTURE.md "Atomicity").
 *
 * Image bytes are written to storage BEFORE the transaction starts (storage
 * writes aren't transactional with Postgres) but the transaction is what
 * decides whether any VesselEvidence row ends up pointing at them — an
 * uncommitted import leaves orphaned files in storage, never orphaned or
 * inconsistent database rows. This tradeoff is documented in ROADMAP.md.
 */
export async function commitMasterImport(storageKey: string, originalFilename: string): Promise<{ batchId: string; summary: MasterImportSummary }> {
  const fileBuffer = await storage.get(storageKey);
  const parsed = await readMasterWorkbook(fileBuffer);

  const batch = await prisma.importBatch.create({
    data: { type: 'MASTER_IMPORT', originalFilename, storageKey, status: 'PROCESSING' },
  });

  try {
    const summary = await runImportTransaction(parsed, batch.id, storageKey);

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'COMPLETED', completedAt: new Date(), summaryJson: summary as unknown as Prisma.InputJsonValue },
    });

    await logAudit({
      eventType: 'MASTER_IMPORTED',
      importBatchId: batch.id,
      summary: `Master workbook "${originalFilename}" imported: ${summary.vesselsCreated} new vessels, ${summary.vesselsSkippedAlreadyExists} already existed`,
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

async function runImportTransaction(
  parsed: MasterWorkbookReadResult,
  batchId: string,
  batchStorageKey: string,
): Promise<MasterImportSummary> {
  // Step 1 (outside the DB transaction): persist every image asset to
  // storage and compute its content hash, up front. Cheap and idempotent —
  // safe to do before we know whether the DB transaction will succeed.
  const imageAssets = await Promise.all(
    parsed.images.map(async (img) => {
      const contentHash = createHash('sha256').update(img.buffer).digest('hex');
      const mimeType = EXTENSION_TO_MIME[img.extension.toLowerCase()] ?? 'application/octet-stream';
      const storageKey = storage.buildKey('evidence', `evidence.${img.extension}`);
      await storage.put(storageKey, img.buffer, mimeType);
      return {
        imageId: img.imageId,
        anchorRow: img.anchorRow,
        anchorCol: img.anchorCol,
        storageKey,
        contentHash,
        mimeType,
        sizeBytes: img.buffer.length,
      };
    }),
  );

  const { clean, pileup } = groupImageAnchorsByRow(
    parsed.images.map((img) => ({ imageId: img.imageId, anchorRow: img.anchorRow, anchorCol: img.anchorCol })),
  );

  const summary: MasterImportSummary = {
    vesselsCreated: 0,
    vesselsSkippedAlreadyExists: 0,
    evidenceCleanlyAssociated: 0,
    evidenceUnassigned: 0,
    evidenceSkippedDuplicate: 0,
    dataQualityIssuesRaised: 0,
    pastEtdCount: 0,
    readerWarnings: parsed.warnings,
  };

  await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const rowNumberToVesselId = new Map<number, string>();

      for (const row of parsed.rows) {
        const vesselName = String(row.values['Vessel Name'] ?? '').trim();
        if (!vesselName) continue;

        const rawImo = row.values['IMO No'] as string | number | null;
        const identity = resolveVesselIdentity(vesselName, rawImo);

        const existing = await tx.vessel.findFirst({
          where:
            identity.lookupStrategy === 'IMO_THEN_NAME'
              ? { OR: [{ imoNumber: identity.imoNumber as string }, { vesselNameNormalized: identity.vesselNameNormalized }] }
              : { vesselNameNormalized: identity.vesselNameNormalized },
        });

        if (existing) {
          // Per user decision: repeated Master imports never overwrite an
          // existing vessel's permanent fields. The row is skipped entirely
          // (including its evidence and calling record) — the Master
          // workbook is a one-time seed, not a recurring overwrite source.
          summary.vesselsSkippedAlreadyExists += 1;
          rowNumberToVesselId.set(row.rowNumber, existing.id);
          continue;
        }

        const vessel = await tx.vessel.create({
          data: {
            vesselName,
            vesselNameNormalized: identity.vesselNameNormalized,
            imoNumber: identity.imoNumber,
            imoNumberPlausible: identity.imoPlausible,
            flag: asString(row.values['Flag']),
            vesselType: asString(row.values['Vessel Type Bulk / Container / Tanker / LNG / Car Carrier']),
            summerDeadweightOrTeu: asString(row.values['Summer Deadweight / TEU (for container ships)']),
            registeredOwnerPerCor: asString(row.values['Registered Owners Name / Country as per Certificate of Registry']),
            registeredOwnerPerCsr: asString(row.values['Registered Owners Name / Country as per CSR']),
            operatorNameInCofr: asString(row.values["Operator's Name in COFR"]),
            bridgeLetter: asString(row.values['Bridge Letter']),
            builtLocation: asString(row.values['Built Location']),
            serviceFeesApplicable: mapServiceFees(row.values['Service fees applicable Yes/No/NA']),
            sourceImportBatchId: batchId,
            status: 'ACTIVE',
          },
        });

        rowNumberToVesselId.set(row.rowNumber, vessel.id);
        summary.vesselsCreated += 1;

        if (!identity.imoPlausible && identity.imoNumber) {
          await checkImoPlausibility(tx, { imoNumber: identity.imoNumber, vesselId: vessel.id });
          summary.dataQualityIssuesRaised += 1;
        }

        const callingRecord = await tx.vesselCallingRecord.create({
          data: {
            vesselId: vessel.id,
            isCurrent: true,
            arrivalPort: asString(row.values['Arrival Port']),
            etaRaw: asString(row.values['ETA']),
            etdRaw: asString(row.values['ETD']),
            ballastOrLoaded: asString(row.values['Ballast/Loaded']),
            source: 'MASTER_IMPORT',
            sourceImportBatchId: batchId,
          },
        });

        const { parsed: etaParsed } = await checkAndRecordDate(tx, {
          raw: asString(row.values['ETA']),
          fieldName: 'eta',
          callingRecordId: callingRecord.id,
          vesselId: vessel.id,
        });
        const { parsed: etdParsed } = await checkAndRecordDate(tx, {
          raw: asString(row.values['ETD']),
          fieldName: 'etd',
          callingRecordId: callingRecord.id,
          vesselId: vessel.id,
        });
        if (!etaParsed) summary.dataQualityIssuesRaised += 1;
        if (!etdParsed) summary.dataQualityIssuesRaised += 1;

        await checkEtdBeforeEta(tx, { etaParsed, etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });

        if (etaParsed && etdParsed && etdParsed.getTime() < etaParsed.getTime()) {
          summary.dataQualityIssuesRaised += 1;
        }

        const isPast = await checkPastEtd(tx, { etdParsed, callingRecordId: callingRecord.id, vesselId: vessel.id });
        if (isPast) {
          summary.pastEtdCount += 1;
          summary.dataQualityIssuesRaised += 1;
        }

        if (etaParsed && etdParsed) {
          await tx.vesselCallingRecord.update({
            where: { id: callingRecord.id },
            data: { etaParsed, etdParsed },
          });
        } else if (etaParsed) {
          await tx.vesselCallingRecord.update({ where: { id: callingRecord.id }, data: { etaParsed } });
        } else if (etdParsed) {
          await tx.vesselCallingRecord.update({ where: { id: callingRecord.id }, data: { etdParsed } });
        }
      }

      // Step 2: evidence, keyed strictly by vesselId — never by re-deriving
      // position after this point. Clean single-anchor rows get a
      // provisional (NEEDS_REVIEW, never CONFIRMED) association if — and
      // only if — that Excel row actually maps to a vessel we just
      // processed. Pileup images always go to the Unassigned pool.
      const assetsByImageId = new Map(imageAssets.map((a) => [a.imageId, a]));

      for (const cleanAssoc of clean) {
        const asset = assetsByImageId.get(cleanAssoc.imageId);
        if (!asset) continue;
        const vesselId = rowNumberToVesselId.get(cleanAssoc.excelRow) ?? null;

        // Dedup guard: if this exact image (by content, not filename or
        // position) already exists as an active evidence record anywhere,
        // don't create a second copy. This matters specifically for
        // re-uploading the Master workbook — without this check, every
        // re-import would silently pile up duplicate evidence rows for
        // vessels whose screenshot hasn't changed, exactly the kind of
        // uncontrolled growth the evidence review workflow exists to avoid.
        const existingByHash = await tx.vesselEvidence.findFirst({
          where: { contentHash: asset.contentHash, isActive: true },
        });
        if (existingByHash) {
          summary.evidenceSkippedDuplicate += 1;
          continue;
        }

        await tx.vesselEvidence.create({
          data: {
            vesselId,
            storageKey: asset.storageKey,
            originalFilename: `image${asset.imageId}.${parsed.images.find((i) => i.imageId === asset.imageId)?.extension ?? 'png'}`,
            contentHash: asset.contentHash,
            mimeType: asset.mimeType,
            fileSizeBytes: asset.sizeBytes,
            sourceAnchorRow: cleanAssoc.anchorRow,
            sourceAnchorCol: cleanAssoc.anchorCol,
            associationMethod: vesselId ? 'ORIGINAL_ANCHOR' : 'UNASSIGNED',
            reviewStatus: vesselId ? 'NEEDS_REVIEW' : 'UNASSIGNED',
            sourceImportBatchId: batchId,
          },
        });

        if (vesselId) summary.evidenceCleanlyAssociated += 1;
        else summary.evidenceUnassigned += 1;
      }

      for (const pileupImg of pileup) {
        const asset = assetsByImageId.get(pileupImg.imageId);
        if (!asset) continue;

        const existingByHash = await tx.vesselEvidence.findFirst({
          where: { contentHash: asset.contentHash, isActive: true },
        });
        if (existingByHash) {
          summary.evidenceSkippedDuplicate += 1;
          continue;
        }

        await tx.vesselEvidence.create({
          data: {
            vesselId: null,
            storageKey: asset.storageKey,
            originalFilename: `image${asset.imageId}.${parsed.images.find((i) => i.imageId === asset.imageId)?.extension ?? 'png'}`,
            contentHash: asset.contentHash,
            mimeType: asset.mimeType,
            fileSizeBytes: asset.sizeBytes,
            sourceAnchorRow: pileupImg.anchorRow,
            sourceAnchorCol: pileupImg.anchorCol,
            associationMethod: 'UNASSIGNED',
            reviewStatus: 'UNASSIGNED',
            sourceImportBatchId: batchId,
          },
        });

        summary.evidenceUnassigned += 1;
      }
    },
    { timeout: 60_000 },
  );

  void batchStorageKey; // kept as a parameter for symmetry/future use (e.g. re-reading on retry)
  return summary;
}

function asString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function mapServiceFees(value: string | number | null | undefined): 'YES' | 'NO' | 'NA' | 'UNKNOWN' {
  const str = asString(value)?.toUpperCase();
  if (str === 'YES' || str === 'Y') return 'YES';
  if (str === 'NO' || str === 'N') return 'NO';
  if (str === 'NA' || str === 'N/A') return 'NA';
  return 'UNKNOWN';
}
