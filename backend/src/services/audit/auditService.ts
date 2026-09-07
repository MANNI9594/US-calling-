import type { AuditEventType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

export interface LogAuditInput {
  eventType: AuditEventType;
  summary: string;
  vesselId?: string;
  importBatchId?: string;
  actorUserId?: string; // omit for system-initiated events (e.g. automatic rollback)
  detail?: Prisma.InputJsonValue;
}

/**
 * Single entry point for writing to the audit log. Keeping this as one
 * function (rather than scattering `prisma.auditLog.create` calls) means
 * every audit event has a consistent shape and makes it easy to see, in one
 * place, every event type the app actually emits.
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: input.eventType,
      summary: input.summary,
      vesselId: input.vesselId,
      importBatchId: input.importBatchId,
      actorUserId: input.actorUserId,
      detailJson: input.detail,
    },
  });
}
