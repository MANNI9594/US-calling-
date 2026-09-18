import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { computeImagePlacement, columnWidthToPixels, rowHeightToPixels } from '../src/services/export/imagePlacement';

describe('evidence image sizing, centering, and anchor type in the Master export', () => {
  it('a placed image is smaller than the full column/row, centered within it, and anchored as twoCellAnchor/editAs=twoCell (so it travels with a normal copy-paste of the cell range, unlike the oneCellAnchor this export used before)', async () => {
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

    const tlCol = 11 + colOffsetFraction;
    const tlRow = 1 + rowOffsetFraction;
    const brCol = tlCol + placement.width / fullColumnWidthPx;
    const brRow = tlRow + placement.height / fullRowHeightPx;

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Test');
    sheet.getColumn(12).width = 52.42578125;

    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const imageId = wb.addImage({ buffer: tinyPng, extension: 'png' });
    sheet.addImage(imageId, {
      tl: { col: tlCol, row: tlRow },
      br: { col: brCol, row: brRow },
      editAs: 'twoCell',
    } as unknown as ExcelJS.ImageRange);

    const buf = await wb.xlsx.writeBuffer();

    // Verify the actual XML, not just the in-memory model — this is what
    // determines real Excel's behavior, and is the exact check that caught
    // this export using the wrong anchor type in the first place.
    const zipContents = await wb.xlsx.writeBuffer();
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipContents as unknown as Buffer);
    const drawingFile = Object.keys(zip.files).find((name) => /drawing\d*\.xml$/.test(name));
    expect(drawingFile).toBeDefined();
    const drawingXml = await zip.files[drawingFile!].async('string');
    expect(drawingXml).toContain('<xdr:twoCellAnchor');
    expect(drawingXml).toContain('editAs="twoCell"');
    expect(drawingXml).not.toContain('oneCellAnchor');

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as unknown as Buffer);
    const images = wb2.getWorksheet('Test')!.getImages();

    expect(images.length).toBe(1);
    expect(images[0].range.tl.nativeColOff).toBeGreaterThan(0);
    expect(images[0].range.tl.nativeRowOff).toBeGreaterThan(0);
    expect(images[0].range.br).toBeDefined();
  });
});
