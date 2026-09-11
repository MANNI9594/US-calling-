import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { computeImagePlacement, columnWidthToPixels, rowHeightToPixels } from '../src/services/export/imagePlacement';

describe('evidence image sizing and centering in the Master export', () => {
  it('a placed image is smaller than the full column/row and centered within it (not edge-to-edge, not top-left anchored)', async () => {
    const fullColumnWidthPx = columnWidthToPixels(52.42578125, 0);
    const fullRowHeightPx = rowHeightToPixels(78, 0);

    const SHRINK_FACTOR = 0.75;
    const maxImageWidthPx = fullColumnWidthPx * SHRINK_FACTOR;
    const maxImageHeightPx = fullRowHeightPx * SHRINK_FACTOR;

    const placement = computeImagePlacement(510, 83, maxImageWidthPx, maxImageHeightPx);

    expect(placement.width).toBeLessThan(fullColumnWidthPx);
    expect(placement.height).toBeLessThan(fullRowHeightPx);

    const colOffsetFraction = Math.max(0, (fullColumnWidthPx - placement.width) / 2 / fullColumnWidthPx);
    const rowOffsetFraction = Math.max(0, (fullRowHeightPx - placement.height) / 2 / fullRowHeightPx);

    expect(colOffsetFraction).toBeGreaterThan(0);
    expect(rowOffsetFraction).toBeGreaterThan(0);
    expect(colOffsetFraction).toBeLessThan(0.5);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Test');
    sheet.getColumn(12).width = 52.42578125;

    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const imageId = wb.addImage({ buffer: tinyPng, extension: 'png' });
    sheet.addImage(imageId, {
      tl: { col: 11 + colOffsetFraction, row: 1 + rowOffsetFraction },
      ext: { width: placement.width, height: placement.height },
    } as unknown as ExcelJS.ImageRange);

    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as unknown as Buffer);
    const images = wb2.getWorksheet('Test')!.getImages();

    expect(images.length).toBe(1);
    expect(images[0].range.tl.nativeColOff).toBeGreaterThan(0);
    expect(images[0].range.tl.nativeRowOff).toBeGreaterThan(0);
    expect(images[0].range.ext.width).toBe(placement.width);
    expect(images[0].range.ext.height).toBe(placement.height);
  });
});
