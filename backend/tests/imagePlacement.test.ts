import { describe, it, expect } from 'vitest';
import { computeImagePlacement } from '../src/services/export/imagePlacement';

describe('computeImagePlacement', () => {
  it('preserves aspect ratio for a real evidence image (404x122, captured from the reference workbook)', () => {
    const result = computeImagePlacement(404, 122);
    const originalRatio = 404 / 122;
    const resultRatio = result.width / result.height;
    expect(resultRatio).toBeCloseTo(originalRatio, 1);
  });

  it('fits within the max bounds for a real wide/short evidence image', () => {
    const result = computeImagePlacement(510, 83); // real dimensions from image13.png
    expect(result.width).toBeLessThanOrEqual(460);
    expect(result.height).toBeLessThanOrEqual(95);
  });

  it('does not upscale a small image beyond its natural size', () => {
    const result = computeImagePlacement(100, 50);
    expect(result.width).toBeLessThanOrEqual(100);
    expect(result.height).toBeLessThanOrEqual(50);
  });

  it('scales down a very large image to fit', () => {
    const result = computeImagePlacement(2000, 1000);
    expect(result.width).toBeLessThanOrEqual(460);
    expect(result.height).toBeLessThanOrEqual(95);
  });

  it('falls back to a fixed box for degenerate (zero/negative) input rather than NaN or divide-by-zero', () => {
    const result = computeImagePlacement(0, 0);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });
});
