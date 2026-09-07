import type { Prisma } from '@prisma/client';
import { validateImoNumber } from '../../utils/imoChecksum';
import { parseOperationalDate } from '../../utils/parseOperationalDate';

/**
 * Central place that turns "a raw value came in" into either a clean parsed
 * value, or a parsed value PLUS an open DataQualityIssue, or a null parsed
 * value PLUS an open DataQualityIssue — but never a silently-guessed value.
 *
 * Phase 3/4 (Master import, US Calling List processing) call these
 * functions while building Vessel / VesselCallingRecord rows, inside the
 * same DB transaction, so a batch either produces its data + its flags
 * together or neither happens (see docs/ARCHITECTURE.md "Atomicity").
 */

export interface DateQualityCheckResult {
  parsed: Date | null;
  raw: string;
}

export async function checkAndRecordDate(
  tx: Prisma.TransactionClient,
  params: {
    raw: string | null | undefined;
    fieldName: 'eta' | 'etd';
    callingRecordId: string;
    vesselId: string;
  },
): Promise<DateQualityCheckResult> {
  const { raw, fieldName, callingRecordId, vesselId } = params;
  const rawStr = raw ?? '';
  const { parsed, reason } = parseOperationalDate(raw);

  if (!parsed) {
    await tx.dataQualityIssue.create({
      data: {
        entityType: 'CALLING_RECORD',
        callingRecordId,
        vesselId,
        fieldName,
        issueType: 'INVALID_DATE_FORMAT',
        rawValue: rawStr,
        message: reason ?? `Could not parse ${fieldName.toUpperCase()} value "${rawStr}"`,
        severity: 'ERROR',
      },
    });
  }

  return { parsed, raw: rawStr };
}

export async function checkEtdBeforeEta(
  tx: Prisma.TransactionClient,
  params: { etaParsed: Date | null; etdParsed: Date | null; callingRecordId: string; vesselId: string },
): Promise<void> {
  const { etaParsed, etdParsed, callingRecordId, vesselId } = params;
  if (etaParsed && etdParsed && etdParsed.getTime() < etaParsed.getTime()) {
    await tx.dataQualityIssue.create({
      data: {
        entityType: 'CALLING_RECORD',
        callingRecordId,
        vesselId,
        fieldName: 'etd',
        issueType: 'ETD_BEFORE_ETA',
        rawValue: etdParsed.toISOString(),
        message: 'ETD is before ETA for this calling record',
        severity: 'WARNING',
      },
    });
  }
}

export async function checkPastEtd(
  tx: Prisma.TransactionClient,
  params: { etdParsed: Date | null; callingRecordId: string; vesselId: string; now?: Date },
): Promise<boolean> {
  const { etdParsed, callingRecordId, vesselId, now = new Date() } = params;
  if (etdParsed && etdParsed.getTime() < now.getTime()) {
    await tx.dataQualityIssue.create({
      data: {
        entityType: 'CALLING_RECORD',
        callingRecordId,
        vesselId,
        fieldName: 'etd',
        issueType: 'PAST_ETD',
        rawValue: etdParsed.toISOString(),
        message: 'ETD has already passed — vessel may have departed. This does not remove it automatically.',
        severity: 'INFO',
      },
    });
    return true;
  }
  return false;
}

export async function checkImoPlausibility(
  tx: Prisma.TransactionClient,
  params: { imoNumber: string | null | undefined; vesselId: string },
): Promise<boolean> {
  const { imoNumber, vesselId } = params;
  const { isPlausible, reason } = validateImoNumber(imoNumber);

  if (!isPlausible) {
    await tx.dataQualityIssue.create({
      data: {
        entityType: 'VESSEL',
        vesselId,
        fieldName: 'imoNumber',
        issueType: 'IMPLAUSIBLE_IMO',
        rawValue: imoNumber ?? '',
        message: reason ?? 'IMO number failed checksum validation',
        severity: 'WARNING',
      },
    });
  }

  return isPlausible;
}
