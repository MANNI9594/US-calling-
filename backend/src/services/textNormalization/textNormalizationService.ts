import { prisma } from '../../db/prisma';
import { toTitleCase } from '../../utils/toTitleCase';

export interface NormalizeTextCasingSummary {
  rowsChecked: number;
  rowsUpdated: number;
  fieldsNormalized: number;
}

export async function normalizeExistingTextCasing(): Promise<NormalizeTextCasingSummary> {
  let rowsChecked = 0;
  let rowsUpdated = 0;
  let fieldsNormalized = 0;

  const vessels = await prisma.vessel.findMany({
    include: { callingRecords: { where: { isCurrent: true }, take: 1 } },
  });
  for (const v of vessels) {
    rowsChecked += 1;
    const vesselFieldUpdates: Record<string, string> = {};
    const textFields: Array<[string, string | null]> = [
      ['vesselName', v.vesselName],
      ['flag', v.flag],
      ['vesselType', v.vesselType],
      ['registeredOwnerPerCor', v.registeredOwnerPerCor],
      ['registeredOwnerPerCsr', v.registeredOwnerPerCsr],
      ['operatorNameInCofr', v.operatorNameInCofr],
      ['bridgeLetter', v.bridgeLetter],
      ['builtLocation', v.builtLocation],
    ];
    for (const [field, current] of textFields) {
      const normalized = toTitleCase(current);
      if (normalized !== null && normalized !== undefined && normalized !== current) {
        vesselFieldUpdates[field] = normalized;
      }
    }
    if (Object.keys(vesselFieldUpdates).length > 0) {
      await prisma.vessel.update({ where: { id: v.id }, data: vesselFieldUpdates });
      fieldsNormalized += Object.keys(vesselFieldUpdates).length;
      rowsUpdated += 1;
    }

    const cr = v.callingRecords[0];
    if (cr) {
      const normalizedPort = toTitleCase(cr.arrivalPort);
      if (normalizedPort !== null && normalizedPort !== undefined && normalizedPort !== cr.arrivalPort) {
        await prisma.vesselCallingRecord.update({ where: { id: cr.id }, data: { arrivalPort: normalizedPort } });
        fieldsNormalized += 1;
      }
    }
  }

  const enoadEntries = await prisma.usCallingListEntry.findMany();
  for (const e of enoadEntries) {
    rowsChecked += 1;
    const updates: Record<string, string> = {};
    const textFields: Array<[string, string | null]> = [
      ['vesselName', e.vesselName],
      ['arrivalPort', e.arrivalPort],
    ];
    for (const [field, current] of textFields) {
      const normalized = toTitleCase(current);
      if (normalized !== null && normalized !== undefined && normalized !== current) {
        updates[field] = normalized;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.usCallingListEntry.update({ where: { id: e.id }, data: updates });
      fieldsNormalized += Object.keys(updates).length;
      rowsUpdated += 1;
    }
  }

  const trackerEntries = await prisma.usCallingTrackerEntry.findMany();
  for (const e of trackerEntries) {
    rowsChecked += 1;
    const updates: Record<string, string> = {};
    const textFields: Array<[string, string | null]> = [
      ['vesselName', e.vesselName],
      ['tech', e.tech],
      ['flag', e.flag],
      ['arrivalPort', e.arrivalPort],
      ['certificateStatus', e.certificateStatus],
    ];
    for (const [field, current] of textFields) {
      const normalized = toTitleCase(current);
      if (normalized !== null && normalized !== undefined && normalized !== current) {
        updates[field] = normalized;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.usCallingTrackerEntry.update({ where: { id: e.id }, data: updates });
      fieldsNormalized += Object.keys(updates).length;
      rowsUpdated += 1;
    }
  }

  return { rowsChecked, rowsUpdated, fieldsNormalized };
}
