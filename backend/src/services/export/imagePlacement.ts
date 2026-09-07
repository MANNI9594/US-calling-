/**
 * Computes the width/height (in pixels) to place an evidence image at in
 * the exported workbook's Column L, preserving its aspect ratio and fitting
 * within the space the original Master workbook's column/row dimensions
 * imply (column L ≈ 460px wide at the reference file's 52-char width, row
 * height ≈ 76-81pt ≈ ~100-108px).
 *
 * Pure function — no ExcelJS, no file I/O — so it's testable with plain
 * numbers.
 */

export interface ImagePlacement {
  width: number;
  height: number;
}

const MAX_WIDTH_PX = 460;
const MAX_HEIGHT_PX = 95;

export function computeImagePlacement(naturalWidth: number, naturalHeight: number): ImagePlacement {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    // Degenerate input (corrupt/unreadable image metadata) — fall back to
    // a fixed reasonable box rather than dividing by zero or producing a
    // negative/NaN size.
    return { width: MAX_WIDTH_PX, height: MAX_HEIGHT_PX };
  }

  const widthScale = MAX_WIDTH_PX / naturalWidth;
  const heightScale = MAX_HEIGHT_PX / naturalHeight;
  const scale = Math.min(widthScale, heightScale, 1); // never upscale past 1:1

  return {
    width: Math.round(naturalWidth * scale),
    height: Math.round(naturalHeight * scale),
  };
}
