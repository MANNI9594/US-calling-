import ExcelJS from 'exceljs';
import { imageSize } from 'image-size';
import { prisma } from '../../db/prisma';
import { storage } from '../storage';
import { computeImagePlacement } from './imagePlacement';
import { logAudit } from '../audit/auditService';
import type { Prisma } from '@prisma/client';

/**
 * The 17 Master column headers, in order — see docs/EXCEL_STRUCTURE_FINDINGS.md.
 * Exported here so the writer and the post-export validator share one
 * source of truth for "what a correct export looks like."
 */
export const MASTER_HEADERS = [
  'Sr. No.',
  'Vessel Name',
  'IMO No',
  'Flag',
  'Vessel Type Bulk / Container / Tanker / LNG / Car Carrier',
  'Summer Deadweight / TEU (for container ships)',
  'Ballast/Loaded',
  'Registered Owners Name / Country as per Certificate of Registry',
  'Registered Owners Name / Country as per CSR',
  "Operator's Name in COFR",
  'Bridge Letter',
  'Data extracted from IMO WEBSITE',
  'Built Location',
  'Service fees applicable Yes/No/NA',
  'Arrival Port',
  'ETA',
  'ETD',
] as const;

interface StyleTemplate {
  sheetName: string;
  columnWidths: (number | undefined)[];
  headerStyles: Partial<ExcelJS.Style>[];
  dataRowStyle: Partial<ExcelJS.Style>;
  dataRowHeight: number | undefined;
}

/**
 * Loads the most recently completed Master Import's original file and
 * captures its formatting as a reusable template — column widths, header
 * cell styles, and a representative data-row style/height. This is what
 * lets the export "closely resemble the original workbook" (per spec)
 * without needing to mutate the original file in place, which earlier
 * testing showed is unreliable (ExcelJS's `rowCount` does not reliably
 * shrink after removing rows — see docs/ROADMAP.md Phase 9 notes).
 */
async function loadStyleTemplate(): Promise<StyleTemplate> {
  const lastImport = await prisma.importBatch.findFirst({
    where: { type: 'MASTER_IMPORT', status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
  });

  if (!lastImport || !lastImport.storageKey) {
    throw new Error('No completed Master import found. Import a Master workbook before exporting.');
  }

  const buffer = await storage.get(lastImport.storageKey);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];

  const columnWidths: (number | undefined)[] = [];
  const headerStyles: Partial<ExcelJS.Style>[] = [];
  for (let c = 1; c <= MASTER_HEADERS.length; c++) {
    columnWidths.push(sheet.getColumn(c).width);
    headerStyles.push(JSON.parse(JSON.stringify(sheet.getRow(1).getCell(c).style)));
  }

  // Row 2 is a real data row in every known-good Master workbook. If the
  // template file somehow has no second row (an edge case, e.g. an empty
  // Master), fall back to the header style rather than throwing — a
  // slightly-off data row style is a cosmetic issue, not a correctness one.
  const templateDataRow = sheet.rowCount >= 2 ? sheet.getRow(2) : sheet.getRow(1);
  const dataRowStyle: Partial<ExcelJS.Style> = JSON.parse(JSON.stringify(templateDataRow.getCell(2).style));
  const dataRowHeight = templateDataRow.height;

  return { sheetName: sheet.name, columnWidths, headerStyles, dataRowStyle, dataRowHeight };
}

interface ExportVesselRow {
  vessel: {
    id: string;
    vesselName: string;
    imoNumber: string | null;
    flag: string | null;
    vesselType: string | null;
    summerDeadweightOrTeu: string | null;
    registeredOwnerPerCor: string | null;
    registeredOwnerPerCsr: string | null;
    operatorNameInCofr: string | null;
    bridgeLetter: string | null;
    builtLocation: string | null;
    serviceFeesApplicable: string;
  };
  ballastOrLoaded: string | null;
  arrivalPort: string | null;
  etaRaw: string | null;
  etdRaw: string | null;
  evidenceStorageKey: string | null;
}

async function loadActiveVesselsForExport(): Promise<ExportVesselRow[]> {
  const vessels = await prisma.vessel.findMany({
    where: { status: 'ACTIVE' },
    include: {
      callingRecords: { where: { isCurrent: true }, take: 1 },
      evidence: {
        where: { isActive: true, reviewStatus: 'CONFIRMED' },
        orderBy: { reviewedAt: 'desc' },
        take: 1,
      },
    },
  });

  interface VesselWithRelations {
    id: string;
    vesselName: string;
    imoNumber: string | null;
    flag: string | null;
    vesselType: string | null;
    summerDeadweightOrTeu: string | null;
    registeredOwnerPerCor: string | null;
    registeredOwnerPerCsr: string | null;
    operatorNameInCofr: string | null;
    bridgeLetter: string | null;
    builtLocation: string | null;
    serviceFeesApplicable: string;
    callingRecords: Array<{
      etaRaw: string | null;
      etdRaw: string | null;
      arrivalPort: string | null;
      ballastOrLoaded: string | null;
      etaParsed: Date | null;
    }>;
    evidence: Array<{ storageKey: string }>;
  }

  const rows: ExportVesselRow[] = (vessels as VesselWithRelations[]).map((v) => {
    const cr = v.callingRecords[0];
    return {
      vessel: {
        id: v.id,
        vesselName: v.vesselName,
        imoNumber: v.imoNumber,
        flag: v.flag,
        vesselType: v.vesselType,
        summerDeadweightOrTeu: v.summerDeadweightOrTeu,
        registeredOwnerPerCor: v.registeredOwnerPerCor,
        registeredOwnerPerCsr: v.registeredOwnerPerCsr,
        operatorNameInCofr: v.operatorNameInCofr,
        bridgeLetter: v.bridgeLetter,
        builtLocation: v.builtLocation,
        serviceFeesApplicable: v.serviceFeesApplicable,
      },
      ballastOrLoaded: cr?.ballastOrLoaded ?? null,
      arrivalPort: cr?.arrivalPort ?? null,
      etaRaw: cr?.etaRaw ?? null,
      etdRaw: cr?.etdRaw ?? null,
      evidenceStorageKey: v.evidence[0]?.storageKey ?? null,
    };
  });

  // Sort by parsed ETA ascending, vessels with no parseable ETA sort last —
  // same rule as the Active Master table (vessels.routes.ts), so what the
  // user sees on screen matches what they download.
  const etaByVesselId = new Map(
    (vessels as VesselWithRelations[]).map((v) => [v.id, v.callingRecords[0]?.etaParsed ?? null]),
  );
  rows.sort((a, b) => {
    const aEta = etaByVesselId.get(a.vessel.id)?.getTime() ?? Number.POSITIVE_INFINITY;
    const bEta = etaByVesselId.get(b.vessel.id)?.getTime() ?? Number.POSITIVE_INFINITY;
    return aEta - bEta;
  });

  return rows;
}

function asImoCellValue(imoNumber: string | null): string | number | null {
  if (!imoNumber) return null;
  return /^\d+$/.test(imoNumber) ? Number(imoNumber) : imoNumber;
}

export interface MasterExportResult {
  buffer: Buffer;
  filename: string;
  batchId: string;
  vesselCount: number;
  imagesPlaced: number;
}

export async function generateMasterExport(): Promise<MasterExportResult> {
  const template = await loadStyleTemplate();
  const rows = await loadActiveVesselsForExport();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(template.sheetName);

  MASTER_HEADERS.forEach((_, i) => {
    sheet.getColumn(i + 1).width = template.columnWidths[i];
  });

  const headerRow = sheet.getRow(1);
  MASTER_HEADERS.forEach((header, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = header;
    cell.style = template.headerStyles[i];
  });

  let imagesPlaced = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const excelRowNumber = i + 2;
    const row = sheet.getRow(excelRowNumber);

    const values: Array<string | number | null> = [
      i + 1, // Sr. No. — renumbered to match this export's ETA order, per user decision
      r.vessel.vesselName,
      asImoCellValue(r.vessel.imoNumber),
      r.vessel.flag,
      r.vessel.vesselType,
      r.vessel.summerDeadweightOrTeu,
      r.ballastOrLoaded,
      r.vessel.registeredOwnerPerCor,
      r.vessel.registeredOwnerPerCsr,
      r.vessel.operatorNameInCofr,
      r.vessel.bridgeLetter,
      null, // evidence image column — populated visually below, not as a cell value
      r.vessel.builtLocation,
      r.vessel.serviceFeesApplicable === 'UNKNOWN' ? null : r.vessel.serviceFeesApplicable,
      r.arrivalPort,
      r.etaRaw,
      r.etdRaw,
    ];

    values.forEach((value, colIdx) => {
      const cell = row.getCell(colIdx + 1);
      cell.value = value;
      cell.style = template.dataRowStyle;
    });
    if (template.dataRowHeight !== undefined) {
      row.height = template.dataRowHeight;
    }

    if (r.evidenceStorageKey) {
      try {
        const imgBuffer = await storage.get(r.evidenceStorageKey);
        const dims = imageSize(imgBuffer);
        const placement = computeImagePlacement(dims.width, dims.height);
        const extension = (dims.type === 'jpg' ? 'jpeg' : dims.type) as 'png' | 'jpeg' | 'gif';
        const imageId = workbook.addImage({ buffer: imgBuffer as unknown as ExcelJS.Buffer, extension });
        sheet.addImage(imageId, {
          tl: { col: 11, row: excelRowNumber - 1 },
          ext: { width: placement.width, height: placement.height },
        } as unknown as ExcelJS.ImageRange);
        imagesPlaced += 1;
      } catch {
        // A single unreadable evidence image must not fail the whole
        // export — the row's data is still correct and complete without
        // its picture; this is a cosmetic gap, not a data-integrity one.
      }
    }
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  await validateExportBuffer(buffer, rows.length, imagesPlaced);

  const today = new Date().toISOString().slice(0, 10);
  const filename = `US_Calling_Master_${today}.xlsx`;

  const storageKey = storage.buildKey('exports', filename);
  await storage.put(storageKey, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const batch = await prisma.importBatch.create({
    data: {
      type: 'MASTER_EXPORT',
      originalFilename: filename,
      storageKey,
      status: 'COMPLETED',
      completedAt: new Date(),
      summaryJson: { vesselCount: rows.length, imagesPlaced } as unknown as Prisma.InputJsonValue,
    },
  });

  await logAudit({
    eventType: 'MASTER_EXPORTED',
    importBatchId: batch.id,
    summary: `Master workbook exported: ${rows.length} vessels, ${imagesPlaced} evidence images placed`,
  });

  return { buffer, filename, batchId: batch.id, vesselCount: rows.length, imagesPlaced };
}

/**
 * Re-reads the just-generated buffer and checks it against what was
 * intended, per the spec's explicit export-validation requirement: if this
 * fails, the caller must not offer the file for download. This is a
 * structural sanity check (sheet exists, headers match, row/image counts
 * match), not a guarantee of perfect visual fidelity — Excel itself is the
 * only true authority on whether a file "opens successfully."
 */
async function validateExportBuffer(buffer: Buffer, expectedVesselCount: number, expectedImageCount: number): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  if (workbook.worksheets.length === 0) {
    throw new Error('Export validation failed: generated workbook has no worksheets');
  }
  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1);
  for (let i = 0; i < MASTER_HEADERS.length; i++) {
    const actual = String(headerRow.getCell(i + 1).value ?? '').trim();
    if (actual !== MASTER_HEADERS[i]) {
      throw new Error(`Export validation failed: header column ${i + 1} is "${actual}", expected "${MASTER_HEADERS[i]}"`);
    }
  }

  let actualDataRows = 0;
  sheet.eachRow((_row, rowNumber) => {
    if (rowNumber > 1) actualDataRows += 1;
  });
  if (actualDataRows !== expectedVesselCount) {
    throw new Error(`Export validation failed: expected ${expectedVesselCount} vessel rows, found ${actualDataRows}`);
  }

  const actualImages = sheet.getImages().length;
  if (actualImages !== expectedImageCount) {
    throw new Error(`Export validation failed: expected ${expectedImageCount} embedded images, found ${actualImages}`);
  }
}
