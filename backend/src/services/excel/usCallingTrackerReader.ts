import ExcelJS from 'exceljs';
import { normalizeHeaderText } from './normalizeHeaderText';
import { extractCellText } from './extractCellText';

export interface UsCallingTrackerRow {
  rowNumber: number;
  vesselName: string;
  tech: string | null;
  etaRaw: string | null;
  etdRaw: string | null;
  arrivalPort: string | null;
  certificateStatus: string | null;
  qualship21ExpiryRaw: string | null;
  enoaSentForReview: string | null;
  usCallingMessageSentRaw: string | null;
  receivedFromVesselRaw: string | null;
  reviewedRaw: string | null;
  ballastWaterNbicRaw: string | null;
  ballastWaterCaWaOrRaw: string | null;
  biofoulingPlanRaw: string | null;
  marineInvasiveSpeciesRaw: string | null;
  flag: string | null;
  checklistSentRaw: string | null;
  pscChecklistRaw: string | null;
  remark: string | null;
}

export interface UsCallingTrackerReadResult {
  sheetName: string;
  rows: UsCallingTrackerRow[];
  warnings: string[];
}

const HEADER_MAP: Record<string, keyof UsCallingTrackerRow | 'vesselName'> = {
  [normalizeHeaderText('Name Of Vessels')]: 'vesselName',
  [normalizeHeaderText('Tech')]: 'tech',
  [normalizeHeaderText('ETA')]: 'etaRaw',
  [normalizeHeaderText('ETD')]: 'etdRaw',
  [normalizeHeaderText('Port ')]: 'arrivalPort',
  [normalizeHeaderText('Certificate Status')]: 'certificateStatus',
  [normalizeHeaderText('Qualship 21 Expiry Date')]: 'qualship21ExpiryRaw',
  [normalizeHeaderText('E-NOA sent for review ')]: 'enoaSentForReview',
  [normalizeHeaderText('US Calling Message Sent')]: 'usCallingMessageSentRaw',
  [normalizeHeaderText('Received from vessel')]: 'receivedFromVesselRaw',
  [normalizeHeaderText('Reviewed or not')]: 'reviewedRaw',
  [normalizeHeaderText('Ballast Water Report submitted to NBIC')]: 'ballastWaterNbicRaw',
  [normalizeHeaderText('Ballast Water Report submitted to California / Washington / Oregon?')]: 'ballastWaterCaWaOrRaw',
  [normalizeHeaderText('Bio-fouling Management Plan received from Master for review (California calls only)?')]: 'biofoulingPlanRaw',
  [normalizeHeaderText('Marine Invasive Species Program Annual Vessel Reporting Form submitted to California State Lands Commission ')]: 'marineInvasiveSpeciesRaw',
  [normalizeHeaderText('Flag')]: 'flag',
  [normalizeHeaderText('Hong Kong/ Marshall / Panama/ Liberia/ Singapore Checklist sent\u00a0to vessel')]: 'checklistSentRaw',
  [normalizeHeaderText('PSC Checklist sent or not sent to Flag State')]: 'pscChecklistRaw',
  [normalizeHeaderText('Remark')]: 'remark',
};

function cellToText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    const dd = String(raw.getUTCDate()).padStart(2, '0');
    const mm = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = raw.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  const text = extractCellText(raw).trim();
  return text === '' ? null : text;
}

export async function readUsCallingTracker(fileBuffer: Buffer): Promise<UsCallingTrackerReadResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

  const warnings: string[] = [];

  if (workbook.worksheets.length === 0) {
    throw new Error('Workbook contains no worksheets');
  }
  if (workbook.worksheets.length > 1) {
    warnings.push(
      `Workbook contains ${workbook.worksheets.length} worksheets; using the first (${workbook.worksheets[0].name}). Additional sheets are ignored.`,
    );
  }

  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1);
  const headerByColumn: Record<number, keyof UsCallingTrackerRow | 'vesselName' | undefined> = {};
  const unrecognizedHeaders: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const normalized = normalizeHeaderText(extractCellText(cell.value));
    const field = HEADER_MAP[normalized];
    if (field) {
      headerByColumn[colNumber] = field;
    } else if (normalized) {
      unrecognizedHeaders.push(normalized);
    }
  });

  if (Object.keys(headerByColumn).length === 0) {
    throw new Error('No recognized header row found (row 1 did not match any expected US Calling column)');
  }
  if (unrecognizedHeaders.length > 0) {
    warnings.push(`Unrecognized column header(s), ignored: ${unrecognizedHeaders.join('; ')}`);
  }
  if (!Object.values(headerByColumn).includes('vesselName')) {
    throw new Error('No "Name Of Vessels" column found — cannot import without a vessel name for each row');
  }

  const rows: UsCallingTrackerRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const partial: Partial<UsCallingTrackerRow> = {};
    let hasAnyValue = false;

    for (const [colStr, field] of Object.entries(headerByColumn)) {
      if (!field) continue;
      const colNumber = Number(colStr);
      const value = cellToText(row.getCell(colNumber).value);
      if (value !== null) hasAnyValue = true;
      (partial as Record<string, string | null>)[field] = value;
    }

    if (!hasAnyValue) return;
    if (!partial.vesselName) return;

    rows.push({
      rowNumber,
      vesselName: partial.vesselName,
      tech: partial.tech ?? null,
      etaRaw: partial.etaRaw ?? null,
      etdRaw: partial.etdRaw ?? null,
      arrivalPort: partial.arrivalPort ?? null,
      certificateStatus: partial.certificateStatus ?? null,
      qualship21ExpiryRaw: partial.qualship21ExpiryRaw ?? null,
      enoaSentForReview: partial.enoaSentForReview ?? null,
      usCallingMessageSentRaw: partial.usCallingMessageSentRaw ?? null,
      receivedFromVesselRaw: partial.receivedFromVesselRaw ?? null,
      reviewedRaw: partial.reviewedRaw ?? null,
      ballastWaterNbicRaw: partial.ballastWaterNbicRaw ?? null,
      ballastWaterCaWaOrRaw: partial.ballastWaterCaWaOrRaw ?? null,
      biofoulingPlanRaw: partial.biofoulingPlanRaw ?? null,
      marineInvasiveSpeciesRaw: partial.marineInvasiveSpeciesRaw ?? null,
      flag: partial.flag ?? null,
      checklistSentRaw: partial.checklistSentRaw ?? null,
      pscChecklistRaw: partial.pscChecklistRaw ?? null,
      remark: partial.remark ?? null,
    });
  });

  return { sheetName: sheet.name, rows, warnings };
}
