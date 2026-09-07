import ExcelJS from 'exceljs';
import { formatAsMasterDate } from '../../utils/parseOperationalDate';

/**
 * Normalizes header text so a lookup key we write in code (using a plain
 * ASCII straight apostrophe, e.g. "Operator's Name in COFR") reliably
 * matches whatever the real Excel file actually contains — which may use a
 * typographic/curly apostrophe (') instead, as the real reference workbook
 * does. Confirmed as a real bug: this exact mismatch silently caused the
 * Operator field to import as blank for every single vessel, because the
 * lookup key never matched. Also collapses any run of whitespace, in case
 * a header has irregular spacing.
 */
function normalizeHeaderText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u0060]/g, "'") // curly single quotes + backtick -> straight apostrophe
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * READ-ONLY inspection of a Master workbook. This is deliberately scoped to
 * extraction only — no vessel/evidence records are created here. Phase 3
 * (Master Import) will take this output and decide how to turn it into
 * Vessel + VesselEvidence rows, running the OCR/association logic the user
 * asked for on the evidence images this returns.
 *
 * We do NOT trust image anchor position as vessel association (see
 * docs/EXCEL_STRUCTURE_FINDINGS.md — the reference workbook has 16 images
 * mis-anchored to one row). This reader still records the anchor faithfully
 * because it's useful forensic metadata, but callers must treat it as a
 * *hint*, not ground truth.
 */

export interface MasterWorkbookRow {
  rowNumber: number; // 1-indexed Excel row number
  values: Record<string, string | number | null>; // keyed by header text
}

export interface MasterWorkbookImage {
  imageId: number; // ExcelJS internal image id, unique within the workbook
  extension: string; // 'png' | 'jpeg' | ...
  buffer: Buffer;
  anchorRow: number; // 0-indexed row the image's top-left is anchored to (raw from xlsx)
  anchorCol: number; // 0-indexed column
}

export interface MasterWorkbookReadResult {
  sheetName: string;
  headers: string[];
  rows: MasterWorkbookRow[];
  images: MasterWorkbookImage[];
  warnings: string[];
}

export async function readMasterWorkbook(fileBuffer: Buffer): Promise<MasterWorkbookReadResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

  const warnings: string[] = [];

  if (workbook.worksheets.length === 0) {
    throw new Error('Workbook contains no worksheets');
  }
  if (workbook.worksheets.length > 1) {
    warnings.push(
      `Workbook contains ${workbook.worksheets.length} worksheets; using the first (` +
        `${workbook.worksheets[0].name}). Additional sheets are ignored.`,
    );
  }

  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = normalizeHeaderText(String(cell.value ?? '').trim());
  });

  if (headers.length === 0) {
    throw new Error('No header row found (row 1 is empty)');
  }

  const rows: MasterWorkbookRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const values: Record<string, string | number | null> = {};
    let hasAnyValue = false;
    headers.forEach((header, idx) => {
      if (!header) return;
      const cell = row.getCell(idx + 1);
      const raw = cell.value;
      let value: string | number | null;
      if (raw === null || raw === undefined) {
        value = null;
      } else if (raw instanceof Date) {
        // Same real-world issue as the US Calling List reader: a
        // date-typed cell (rather than the Master's usual plain-text
        // dates) must be formatted back to DD.MM.YYYY, not stringified
        // via JS's default Date#toString(). See usCallingListReader.ts for
        // the full explanation and the bug this fixes.
        value = formatAsMasterDate(raw);
      } else if (typeof raw === 'object' && 'result' in (raw as object)) {
        // formula cell — use cached result, never re-derive
        value = (raw as { result?: string | number }).result ?? null;
      } else if (typeof raw === 'number' || typeof raw === 'string') {
        value = raw;
      } else {
        value = String(raw);
      }
      if (value !== null && value !== '') hasAnyValue = true;
      values[header] = value;
    });
    if (hasAnyValue) {
      rows.push({ rowNumber, values });
    }
  });

  const images: MasterWorkbookImage[] = [];
  const sheetImages = sheet.getImages(); // [{ imageId, range: { tl: {col,row}, br } }]
  for (const img of sheetImages) {
    const media = workbook.getImage(Number(img.imageId));
    if (!media) {
      warnings.push(`Image id ${img.imageId} referenced by a drawing anchor but not found in workbook media`);
      continue;
    }
    images.push({
      imageId: Number(img.imageId),
      extension: media.extension,
      buffer: Buffer.isBuffer(media.buffer) ? media.buffer : Buffer.from(media.buffer as ArrayBuffer),
      anchorRow: Math.floor(img.range.tl.row),
      anchorCol: Math.floor(img.range.tl.col),
    });
  }

  return { sheetName: sheet.name, headers, rows, images, warnings };
}
