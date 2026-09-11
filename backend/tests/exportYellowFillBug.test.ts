import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';

describe('BUG REGRESSION: highlighting a single cell must never bleed into every other cell', () => {
  it('setting .fill directly on a cell that shares a style object reference with other cells corrupts ALL of them (documents the bug found in real use)', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Buggy');
    const sharedStyle = { font: { name: 'Calibri', size: 11 } };

    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 3; c++) {
        const cell = sheet.getRow(r).getCell(c);
        cell.value = `R${r}C${c}`;
        cell.style = sharedStyle;
      }
    }

    sheet.getRow(2).getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF200' } };

    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as unknown as Buffer);
    const sheet2 = wb2.getWorksheet('Buggy')!;

    let yellowCount = 0;
    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 3; c++) {
        const fill = sheet2.getRow(r).getCell(c).fill as { fgColor?: { argb?: string } } | undefined;
        if (fill?.fgColor?.argb === 'FFFFF200') yellowCount++;
      }
    }

    expect(yellowCount).toBe(9);
  });

  it('the FIX — spreading the shared style into a new object per highlighted cell — only colors the intended cell', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Fixed');
    const sharedStyle = { font: { name: 'Calibri', size: 11 } };

    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 3; c++) {
        const cell = sheet.getRow(r).getCell(c);
        cell.value = `R${r}C${c}`;
        cell.style = sharedStyle;
      }
    }

    const yellowFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF200' } };
    sheet.getRow(2).getCell(2).style = { ...sharedStyle, fill: yellowFill };

    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as unknown as Buffer);
    const sheet2 = wb2.getWorksheet('Fixed')!;

    const yellowCells: string[] = [];
    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 3; c++) {
        const fill = sheet2.getRow(r).getCell(c).fill as { fgColor?: { argb?: string } } | undefined;
        if (fill?.fgColor?.argb === 'FFFFF200') yellowCells.push(`R${r}C${c}`);
      }
    }

    expect(yellowCells).toEqual(['R2C2']);

    const highlightedCell = sheet2.getRow(2).getCell(2);
    expect(highlightedCell.font?.name).toBe('Calibri');
  });
});
