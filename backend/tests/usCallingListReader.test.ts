import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readUsCallingList } from '../src/services/uscalling/usCallingListReader';

/**
 * Builds a real .xlsx file in memory (via the same ExcelJS library the app
 * uses to read it) containing the exact example rows from the user's own
 * spec — including the actual "Transection type" header spelling — then
 * verifies the reader extracts it correctly. This is a genuine round-trip
 * test of real xlsx bytes, not a mocked/stubbed reader.
 */
async function buildSampleUsCallingListBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(['Vessel Name', 'Voyage Type', 'Transection type', 'Send To', 'Port', 'ETA', 'ETD']);
  sheet.addRow(['Alfred N', 'Foreign to US', 'Initial', 'NVMC', 'Lake Charles', '06-09-2026', '09-09-2026']);
  sheet.addRow(['Atlantic Sunshine', 'US to US', 'Update', 'NVMC', 'Arthur', '02-09-2026', '07-09-2026']);
  sheet.addRow(['Atlantic Sunflower', 'Foreign to US', 'Initial', 'NVMC', 'Houston', '05-09-2026', '10-09-2026']);
  sheet.addRow(['Athens C', 'Foreign to US', 'Initial', 'NVMC', 'Arthur', '03-09-2026', '06-09-2026']);
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe('readUsCallingList (real xlsx round-trip, spec example data)', () => {
  it('parses all 4 example rows correctly', async () => {
    const buffer = await buildSampleUsCallingListBuffer();
    const result = await readUsCallingList(buffer);
    expect(result.rows).toHaveLength(4);
  });

  it('tolerates the actual "Transection type" header spelling without correcting or rejecting it', async () => {
    const buffer = await buildSampleUsCallingListBuffer();
    const result = await readUsCallingList(buffer);
    expect(result.rows[0].transactionType).toBe('Initial');
  });

  it('extracts vessel name, port, and both dates correctly for each row', async () => {
    const buffer = await buildSampleUsCallingListBuffer();
    const result = await readUsCallingList(buffer);
    const alfred = result.rows.find((r) => r.vesselName === 'Alfred N');
    expect(alfred?.arrivalPort).toBe('Lake Charles');
    expect(alfred?.etaRaw).toBe('06-09-2026');
    expect(alfred?.etdRaw).toBe('09-09-2026');
  });

  it('extracts voyage type and send-to correctly', async () => {
    const buffer = await buildSampleUsCallingListBuffer();
    const result = await readUsCallingList(buffer);
    const sunshine = result.rows.find((r) => r.vesselName === 'Atlantic Sunshine');
    expect(sunshine?.voyageType).toBe('US to US');
    expect(sunshine?.sendTo).toBe('NVMC');
  });

  it('throws a clear error when required columns are missing', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Vessel Name', 'Port']); // missing ETA/ETD
    sheet.addRow(['Alfred N', 'Lake Charles']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(readUsCallingList(buffer)).rejects.toThrow(/Missing required column/);
  });

  it('is tolerant of header case and whitespace variation', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['  vessel NAME  ', 'eta', 'ETD', 'PORT']);
    sheet.addRow(['Test Vessel', '01-01-2027', '05-01-2027', 'Houston']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await readUsCallingList(buffer);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].vesselName).toBe('Test Vessel');
    expect(result.rows[0].arrivalPort).toBe('Houston');
  });

  it('BUG REGRESSION: formats a native Excel date-typed cell as DD-MM-YYYY, not JS Date#toString() garbage', async () => {
    // Reproduces a real bug found during live testing: typing "10-09-2026"
    // into Excel by hand causes Excel to auto-convert the cell to a real
    // date type rather than text (unlike the Master workbook, which stores
    // dates as plain text). Before the fix, this produced values like
    // "Wed Sep 09 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"
    // which then failed downstream date-format validation entirely.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Vessel Name', 'ETA', 'ETD']);
    const row = sheet.addRow(['Test Vessel', new Date(Date.UTC(2026, 8, 9)), new Date(Date.UTC(2026, 8, 13))]);
    row.getCell(2).numFmt = 'dd-mm-yyyy';
    row.getCell(3).numFmt = 'dd-mm-yyyy';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await readUsCallingList(buffer);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].etaRaw).toBe('09-09-2026');
    expect(result.rows[0].etdRaw).toBe('13-09-2026');
    // Explicitly assert the old buggy output never reappears
    expect(result.rows[0].etaRaw).not.toContain('GMT');
    expect(result.rows[0].etaRaw).not.toContain('Coordinated Universal Time');
  });
});
