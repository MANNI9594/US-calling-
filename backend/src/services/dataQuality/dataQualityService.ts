import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
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

export interface StaleFlagCleanupSummary {
  vesselsChecked: number;
  issuesResolved: number;
}

/**
 * One-time sweep: resolves any OPEN date-quality issue (INVALID_DATE_FORMAT,
 * ETD_BEFORE_ETA, PAST_ETD) that no longer applies to a vessel's CURRENT
 * calling record. Exists specifically to remediate a real bug found in
 * live use: the batch update path (US Calling List uploads/apply) didn't
 * clear stale flags before this fix landed, so a flag raised by an
 * earlier, wrong upload could sit open forever even after a later, correct
 * upload fixed the actual dates. New flags can no longer get stuck this
 * way (see usCallingImportService.ts), but this sweep is what cleans up
 * ones already stuck from before that fix, without requiring the user to
 * manually re-save every affected vessel one at a time.
 *
 * Re-derives the truth from the vessel's CURRENT record specifically —
 * an issue may be attached to an older, now-superseded calling record,
 * so this never trusts "which record is this issue attached to," only
 * "is this actually still true right now."
 */
export async function cleanupStaleDateQualityFlags(): Promise<StaleFlagCleanupSummary> {
  const vessels = await prisma.vessel.findMany({
    include: {
      callingRecords: { where: { isCurrent: true }, take: 1 },
      dataQualityIssues: {
        where: { status: 'OPEN', issueType: { in: ['INVALID_DATE_FORMAT', 'ETD_BEFORE_ETA', 'PAST_ETD'] } },
      },
    },
  });

  const summary: StaleFlagCleanupSummary = { vesselsChecked: 0, issuesResolved: 0 };
  const now = Date.now();

  for (const vessel of vessels) {
    if (vessel.dataQualityIssues.length === 0) continue;
    summary.vesselsChecked += 1;

    const current = vessel.callingRecords[0];
    const etaResult = parseOperationalDate(current?.etaRaw ?? null);
    const etdResult = parseOperationalDate(current?.etdRaw ?? null);
    const etdBeforeEta = Boolean(etaResult.parsed && etdResult.parsed && etdResult.parsed.getTime() < etaResult.parsed.getTime());
    const isPastEtd = Boolean(etdResult.parsed && etdResult.parsed.getTime() < now);

    for (const issue of vessel.dataQualityIssues) {
      let stillTrue = true;

      if (issue.issueType === 'INVALID_DATE_FORMAT' && issue.fieldName === 'eta') {
        stillTrue = !etaResult.parsed;
      } else if (issue.issueType === 'INVALID_DATE_FORMAT' && issue.fieldName === 'etd') {
        stillTrue = !etdResult.parsed;
      } else if (issue.issueType === 'ETD_BEFORE_ETA') {
        stillTrue = etdBeforeEta;
      } else if (issue.issueType === 'PAST_ETD') {
        stillTrue = isPastEtd;
      }

      if (!stillTrue) {
        await prisma.dataQualityIssue.update({
          where: { id: issue.id },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
        summary.issuesResolved += 1;
      }
    }
  }

  return summary;
}
