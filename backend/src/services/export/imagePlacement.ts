/**
 * Computes the width/height (in pixels) to place an evidence image at in
 * the exported workbook's Column L, preserving its aspect ratio and fitting
 * within the ACTUAL space available — the caller must pass the real
 * column-width/row-height bounds (see columnWidthToPixels/rowHeightToPixels
 * below), converted from whatever the template workbook's real column L
 * width and data row height are, rather than a hardcoded guess.
 *
 * A hardcoded guess was tried first (460×95px, estimated from the
 * reference workbook's ~52-character column width) and confirmed wrong in
 * real use — the real column is narrower than that estimate assumed,
 * causing images to visually overflow into the next column when opened in
 * Excel. Excel does not clip a positioned image to its anchor column; it
 * draws it at whatever pixel size it's told, so an overestimate is a real,
 * visible bug, not a cosmetic rounding difference.
 *
 * Pure function — no ExcelJS, no file I/O — so it's testable with plain
 * numbers.
 */

export interface ImagePlacement {
  width: number;
  height: number;
}

// Fallback bounds only used if the caller has no real column/row dimension
// to convert (e.g. the template row 2 was missing entirely — see
// masterExportService.ts). Deliberately conservative (narrower than the
// old 460×95 guess) so a fallback errs toward "too small" rather than
// repeating the overflow bug.
const FALLBACK_MAX_WIDTH_PX = 300;
const FALLBACK_MAX_HEIGHT_PX = 80;

/**
 * Converts an Excel column "width" (character units, as stored in the
 * xlsx and returned by ExcelJS's `column.width`) to an approximate pixel
 * width, using the same formula Excel/openpyxl use for the default
 * Calibri-11 font (Maximum Digit Width = 7px). A small margin is
 * subtracted so a placed image sits safely inside the column rather than
 * exactly at its edge.
 */
export function columnWidthToPixels(excelWidth: number, marginPx = 8): number {
  const mdw = 7;
  const pixels = Math.round(((256 * excelWidth + Math.trunc(128 / mdw)) / 256) * mdw);
  return Math.max(pixels - marginPx, 20); // never return something unusably tiny
}

/**
 * Converts an Excel row height (in points, as returned by ExcelJS's
 * `row.height`) to an approximate pixel height (96 DPI: 1pt = 4/3 px).
 */
export function rowHeightToPixels(points: number, marginPx = 6): number {
  const pixels = Math.round(points * (4 / 3));
  return Math.max(pixels - marginPx, 20);
}

export function computeImagePlacement(
  naturalWidth: number,
  naturalHeight: number,
  maxWidth: number = FALLBACK_MAX_WIDTH_PX,
  maxHeight: number = FALLBACK_MAX_HEIGHT_PX,
): ImagePlacement {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    // Degenerate input (corrupt/unreadable image metadata) — fall back to
    // a fixed reasonable box rather than dividing by zero or producing a
    // negative/NaN size.
    return { width: maxWidth, height: maxHeight };
  }

  const widthScale = maxWidth / naturalWidth;
  const heightScale = maxHeight / naturalHeight;
  const scale = Math.min(widthScale, heightScale, 1); // never upscale past 1:1

  return {
    width: Math.round(naturalWidth * scale),
    height: Math.round(naturalHeight * scale),
  };
}
