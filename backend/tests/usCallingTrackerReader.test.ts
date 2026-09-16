import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { readUsCallingTracker } from '../src/services/excel/usCallingTrackerReader';

const REAL_FILE_PATH = '/mnt/user-data/uploads/Book1.xlsx';

describe.skipIf(!existsSync(REAL_FILE_PATH))("readUsCallingTracker (against the user's real uploaded file)", () => {
  it('extracts real vessel rows, including a known name from the real file', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    expect(result.rows.length).toBeGreaterThan(10); // the real file has 74 data rows
    const names = result.rows.map((r) => r.vesselName);
    expect(names).toContain('Ocean Harvest');
    expect(names).toContain('Celsius Greenland');
  });

  it('extracts Tech field correctly, including a value with a trailing space in the source ("Celsius ")', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const oceanHarvest = result.rows.find((r) => r.vesselName === 'Ocean Harvest');
    expect(oceanHarvest?.tech).toBe('HK Tech D11');

    const celsius = result.rows.find((r) => r.vesselName === 'Celsius Greenland');
    expect(celsius?.tech).toBe('Celsius');
  });

  it('reads the checklist column despite its real header containing a non-breaking space, not a regular one', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const oceanHarvest = result.rows.find((r) => r.vesselName === 'Ocean Harvest');
    expect(oceanHarvest?.checklistSentRaw).toBe('21.07.2026');
  });

  it('reads non-date status values ("NA", "-", "Not Eligible") verbatim, without coercing them into dates', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const oceanHarvest = result.rows.find((r) => r.vesselName === 'Ocean Harvest');
    expect(oceanHarvest?.certificateStatus).toBe('-');
    expect(oceanHarvest?.qualship21ExpiryRaw).toBe('Not Eligible');
    expect(oceanHarvest?.ballastWaterCaWaOrRaw).toBe('NA');

    const celsius = result.rows.find((r) => r.vesselName === 'Celsius Greenland');
    expect(celsius?.usCallingMessageSentRaw).toBe('NA');
  });

  it('reads a genuine Excel date-typed cell in Qualship 21 Expiry Date and formats it as DD-MM-YYYY', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const chemSelenium = result.rows.find((r) => r.vesselName === 'Chem Selenium');
    expect(chemSelenium?.qualship21ExpiryRaw).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  });

  it('reads real ETA/ETD values as plain DD.MM.YYYY-style text, unmodified', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const alfredN = result.rows.find((r) => r.vesselName === 'Alfred N');
    expect(alfredN?.etaRaw).toBe('08.09.2026');
    expect(alfredN?.etdRaw).toBe('11.09.2026');
  });

  it('produces no unrecognized-header warnings against the real file', async () => {
    const buffer = readFileSync(path.resolve(REAL_FILE_PATH));
    const result = await readUsCallingTracker(buffer);

    const unrecognizedWarnings = result.warnings.filter((w) => w.includes('Unrecognized'));
    expect(unrecognizedWarnings).toEqual([]);
  });
});
