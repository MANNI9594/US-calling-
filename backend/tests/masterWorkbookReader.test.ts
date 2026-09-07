import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { readMasterWorkbook } from '../src/services/excel/masterWorkbookReader';

// This uses the ACTUAL reference workbook supplied by the user, per the
// spec's "CRITICAL ACCEPTANCE TEST" requirement — not a dummy fixture.
const REAL_WORKBOOK_PATH = process.env.REAL_MASTER_WORKBOOK_PATH;

const maybeDescribe = REAL_WORKBOOK_PATH ? describe : describe.skip;

maybeDescribe('readMasterWorkbook (against the real reference workbook)', () => {
  it('extracts 43 vessel rows and 17 headers, matching the Phase 1 openpyxl inspection', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);

    expect(result.sheetName).toBe('Sheet2');
    expect(result.headers).toHaveLength(17);
    expect(result.headers[1]).toBe('Vessel Name');
    expect(result.rows).toHaveLength(43);
  });

  it('extracts 50 image anchors, referencing 43 unique underlying image assets (a few images are anchored twice)', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);
    expect(result.images).toHaveLength(50);
    expect(new Set(result.images.map((img) => img.imageId)).size).toBe(43);
  });

  it('confirms the known row-2 image pileup: 17 image anchors stacked at row index 1', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);
    const atRowOne = result.images.filter((img) => img.anchorRow === 1);
    expect(atRowOne.length).toBe(17);
  });

  it('confirms 33 images are cleanly anchored to their own distinct row', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);
    const distinctRows = new Set(result.images.filter((img) => img.anchorRow !== 1).map((img) => img.anchorRow));
    expect(distinctRows.size).toBe(33);
  });

  it('reads Ocean Harvest (row 2) with correct IMO and ETA/ETD raw strings', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);
    const row = result.rows.find((r) => r.values['Vessel Name'] === 'Ocean Harvest');
    expect(row).toBeDefined();
    expect(row?.values['IMO No']).toBe(9747467);
    expect(row?.values['ETA']).toBe('20.08.2026');
    expect(row?.values['ETD']).toBe('09.09.2026');
  });

  it('reads the known malformed ETD value for Athens C verbatim (no silent fix)', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const result = await readMasterWorkbook(buffer);
    const row = result.rows.find((r) => r.values['Vessel Name'] === 'Athens C');
    expect(row?.values['ETD']).toBe('06.09.026');
  });
});
