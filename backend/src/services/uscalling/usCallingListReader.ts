import ExcelJS from 'exceljs';

/**
 * Reads a US Calling List upload — the recurring, day-to-day file, distinct
 * from the one-time Master workbook. Known columns (per the user's spec):
 *   Vessel Name | Voyage Type | Transection type | Send To | Port | ETA | ETD
 *
 * Header matching is intentionally tolerant: real-world column headers vary
 * in case, whitespace, and minor spelling (the spec's own example spells it
 * "Transection type", not "Transaction type" — this is not a typo to
 * silently correct, it's the actual header text to be tolerant of).
 *
 * Only "Vessel Name", "ETA", and "ETD" are strictly required — a missing
 * Port/Voyage Type/Send To is a data-quality gap on that row, not a reason
 * to reject the whole file.
 */

export interface UsCallingListRow {
  rowNumber: number;
  vesselName: string;
  voyageType: string | null;
  transactionType: string | null;
  sendTo: string | null;
  arrivalPort: string | null;
  etaRaw: string | null;
  etdRaw: string | null;
}

export interface UsCallingListReadResult {
  sheetName: string;
  rows: UsCallingListRow[];
  warnings: string[];
}

const HEADER_ALIASES: Record<string, keyof Omit<UsCallingListRow, 'rowNumber'>> = {
  'vessel name': 'vesselName',
  vessel: 'vesselName',
  'voyage type': 'voyageType',
  'transection type': 'transactionType', // the spec's actual (misspelled) header — tolerated, not "corrected"
  'transaction type': 'transactionType',
  'send to': 'sendTo',
  sendto: 'sendTo',
  port: 'arrivalPort',
  'arrival port': 'arrivalPort',
  eta: 'etaRaw',
  etd: 'etdRaw',
};

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function readUsCallingList(fileBuffer: Buffer): Promise<UsCallingListReadResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);

  const warnings: string[] = [];
  if (workbook.worksheets.length === 0) {
    throw new Error('Workbook contains no worksheets');
  }
  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1);
  const columnMap = new Map<number, keyof Omit<UsCallingListRow, 'rowNumber'>>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const normalized = normalizeHeader(String(cell.value ?? ''));
    const mapped = HEADER_ALIASES[normalized];
    if (mapped) columnMap.set(colNumber, mapped);
  });

  const required: Array<keyof Omit<UsCallingListRow, 'rowNumber'>> = ['vesselName', 'etaRaw', 'etdRaw'];
  const foundFields = new Set(columnMap.values());
  const missing = required.filter((f) => !foundFields.has(f));
  if (missing.length > 0) {
    throw new Error(
      `Missing required column(s): ${missing.join(', ')}. Found headers: ${Array.from(headerRow.values as unknown[])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .join(', ')}`,
    );
  }

  const rows: UsCallingListRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const partial: Partial<Record<keyof Omit<UsCallingListRow, 'rowNumber'>, string | null>> = {};
    let hasAnyValue = false;
    for (const [colNumber, field] of columnMap.entries()) {
      const raw = row.getCell(colNumber).value;
      let value: string | null;
      if (raw === null || raw === undefined) {
        value = null;
      } else if (typeof raw === 'object' && 'result' in (raw as object)) {
        value = String((raw as { result?: string | number }).result ?? '') || null;
      } else {
        value = String(raw).trim() || null;
      }
      if (value) hasAnyValue = true;
      partial[field] = value;
    }

    if (!hasAnyValue) return;

    rows.push({
      rowNumber,
      vesselName: (partial.vesselName ?? '').trim(),
      voyageType: partial.voyageType ?? null,
      transactionType: partial.transactionType ?? null,
      sendTo: partial.sendTo ?? null,
      arrivalPort: partial.arrivalPort ?? null,
      etaRaw: partial.etaRaw ?? null,
      etdRaw: partial.etdRaw ?? null,
    });
  });

  return { sheetName: sheet.name, rows, warnings };
}
