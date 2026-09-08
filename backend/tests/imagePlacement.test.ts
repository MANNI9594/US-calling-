import { describe, it, expect } from 'vitest';
import { computeImagePlacement, columnWidthToPixels, rowHeightToPixels } from '../src/services/export/imagePlacement';

describe('columnWidthToPixels', () => {
  it('converts the real reference workbook column L width (52.42578125) to a realistic pixel value', () => {
    // BUG REGRESSION: a hardcoded guess of 460px was used previously and
    // confirmed wrong in real use (Excel showed images overflowing into
    // the next column). The correct Excel column-width formula produces
    // ~360px for this real width, which is what actually fits.
    const px = columnWidthToPixels(52.42578125);
    expect(px).toBeGreaterThan(340);
    expect(px).toBeLessThan(380);
  });

  it('never returns a value below the minimum floor for a tiny column width', () => {
    const px = columnWidthToPixels(1);
    expect(px).toBeGreaterThanOrEqual(20);
  });
});

describe('rowHeightToPixels', () => {
  it('converts the real reference workbook data row height (~76-81pt) to a realistic pixel value', () => {
    const px = rowHeightToPixels(78);
    expect(px).toBeGreaterThan(80);
    expect(px).toBeLessThan(100);
  });
});

describe('computeImagePlacement', () => {
  it('preserves aspect ratio for a real evidence image (404x122, captured from the reference workbook)', () => {
    const result = computeImagePlacement(404, 122, 360, 90);
    const originalRatio = 404 / 122;
    const resultRatio = result.width / result.height;
    expect(resultRatio).toBeCloseTo(originalRatio, 1);
  });

  it('fits within explicitly-passed max bounds for a real wide/short evidence image', () => {
    const result = computeImagePlacement(510, 83, 360, 90); // real dimensions from image13.png
    expect(result.width).toBeLessThanOrEqual(360);
    expect(result.height).toBeLessThanOrEqual(90);
  });

  it('does not upscale a small image beyond its natural size', () => {
    const result = computeImagePlacement(100, 50, 360, 90);
    expect(result.width).toBeLessThanOrEqual(100);
    expect(result.height).toBeLessThanOrEqual(50);
  });

  it('scales down a very large image to fit within the real column-derived bounds', () => {
    const result = computeImagePlacement(2000, 1000, 360, 90);
    expect(result.width).toBeLessThanOrEqual(360);
    expect(result.height).toBeLessThanOrEqual(90);
  });

  it('falls back to a fixed box for degenerate (zero/negative) input rather than NaN or divide-by-zero', () => {
    const result = computeImagePlacement(0, 0);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('uses sensible fallback bounds when no explicit max is passed', () => {
    const result = computeImagePlacement(2000, 1000);
    // Fallback bounds are deliberately conservative (narrower than the old
    // wrong 460px guess) so an uncomputed fallback never repeats the
    // overflow bug.
    expect(result.width).toBeLessThanOrEqual(300);
  });
});
