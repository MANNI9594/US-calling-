import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { readMasterWorkbook } from '../src/services/excel/masterWorkbookReader';
import { groupImageAnchorsByRow } from '../src/services/excel/imageAssociationGrouping';

const REAL_WORKBOOK_PATH = process.env.REAL_MASTER_WORKBOOK_PATH;
const maybeDescribe = REAL_WORKBOOK_PATH ? describe : describe.skip;

maybeDescribe('groupImageAnchorsByRow (against the real reference workbook)', () => {
  it('produces 33 clean single-image rows and 17 pileup images on Excel row 2, matching Phase 1 findings', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const { images } = await readMasterWorkbook(buffer);

    const { clean, pileup } = groupImageAnchorsByRow(images);

    expect(clean).toHaveLength(33);
    expect(pileup).toHaveLength(17);
    expect(pileup.every((img) => img.excelRow === 2)).toBe(true);
    expect(pileup.every((img) => img.pileupSize === 17)).toBe(true);
  });

  it('clean associations point at Excel rows 3 and up (never row 2, which is the pileup)', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const { images } = await readMasterWorkbook(buffer);
    const { clean } = groupImageAnchorsByRow(images);

    expect(clean.every((img) => img.excelRow >= 3)).toBe(true);
    // 33 distinct rows -> no row appears twice among the clean set
    expect(new Set(clean.map((img) => img.excelRow)).size).toBe(33);
  });

  it('total clean + pileup accounts for all 50 image anchors', async () => {
    const buffer = readFileSync(path.resolve(REAL_WORKBOOK_PATH as string));
    const { images } = await readMasterWorkbook(buffer);
    const { clean, pileup } = groupImageAnchorsByRow(images);

    expect(clean.length + pileup.length).toBe(images.length);
    expect(images.length).toBe(50);
  });

  it('handles a trivial synthetic case: two vessels, each with exactly one clean image', () => {
    const { clean, pileup } = groupImageAnchorsByRow([
      { imageId: 1, anchorRow: 1, anchorCol: 11 },
      { imageId: 2, anchorRow: 2, anchorCol: 11 },
    ]);
    expect(clean).toHaveLength(2);
    expect(pileup).toHaveLength(0);
    expect(clean.map((c) => c.excelRow).sort()).toEqual([2, 3]);
  });

  it('handles a trivial synthetic pileup: three images on one row, zero clean', () => {
    const { clean, pileup } = groupImageAnchorsByRow([
      { imageId: 1, anchorRow: 5, anchorCol: 11 },
      { imageId: 2, anchorRow: 5, anchorCol: 11 },
      { imageId: 3, anchorRow: 5, anchorCol: 11 },
    ]);
    expect(clean).toHaveLength(0);
    expect(pileup).toHaveLength(3);
    expect(pileup.every((p) => p.pileupSize === 3)).toBe(true);
  });
});
