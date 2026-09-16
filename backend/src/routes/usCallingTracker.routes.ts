import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { broadcast } from '../services/realtime/eventBus';
import {
  listTrackerEntries,
  createTrackerEntry,
  updateTrackerEntryField,
  deleteTrackerEntry,
  importTrackerEntriesFromFile,
  exportTrackerEntriesToXlsx,
  markTrackerEntryDeparted,
  undoTrackerEntryDeparted,
} from '../services/uscalling/usCallingTrackerService';

export const usCallingTrackerRouter = Router();
usCallingTrackerRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okType =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    if (!okType) {
      cb(new AppError(400, 'Only .xlsx files are accepted'));
      return;
    }
    cb(null, true);
  },
});

usCallingTrackerRouter.get('/distinct-values', asyncHandler(async (req, res) => {
  const field = typeof req.query.field === 'string' ? req.query.field : '';
  const allowedFields = new Set(['arrivalPort', 'flag']);
  if (!allowedFields.has(field)) {
    res.status(400).json({ error: `Unsupported field "${field}"` });
    return;
  }
  const rows = await prisma.usCallingTrackerEntry.findMany({
    where: { [field]: { not: null } },
    select: { [field]: true },
    distinct: [field as 'arrivalPort'],
  });
  const values = rows
    .map((r: Record<string, unknown>) => r[field] as string)
    .filter((v: string) => v && v.trim() !== '')
    .sort((a: string, b: string) => a.localeCompare(b));
  res.json({ values });
}));

usCallingTrackerRouter.get('/', asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const entries = await listTrackerEntries(search);
  res.json({ entries, count: entries.length });
}));

const entrySchema = z.object({
  vesselName: z.string().trim().min(1),
  tech: z.string().trim().optional(),
  etaRaw: z.string().trim().optional(),
  etdRaw: z.string().trim().optional(),
  arrivalPort: z.string().trim().optional(),
  flag: z.string().trim().optional(),
  certificateStatus: z.string().trim().optional(),
  enoaSentForReview: z.string().trim().optional(),
  qualship21ExpiryRaw: z.string().trim().optional(),
  usCallingMessageSentRaw: z.string().trim().optional(),
  receivedFromVesselRaw: z.string().trim().optional(),
  reviewedRaw: z.string().trim().optional(),
  ballastWaterNbicRaw: z.string().trim().optional(),
  ballastWaterCaWaOrRaw: z.string().trim().optional(),
  biofoulingPlanRaw: z.string().trim().optional(),
  marineInvasiveSpeciesRaw: z.string().trim().optional(),
  checklistSentRaw: z.string().trim().optional(),
  pscChecklistRaw: z.string().trim().optional(),
  remark: z.string().trim().optional(),
});

usCallingTrackerRouter.post('/', asyncHandler(async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const entry = await createTrackerEntry(parsed.data);
  res.status(201).json({ entry });
  broadcast('us-calling-tracker-changed');
}));

const fieldEditSchema = z.object({ field: z.string(), value: z.string() });

usCallingTrackerRouter.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = fieldEditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const entry = await updateTrackerEntryField(req.params.id, parsed.data.field, parsed.data.value.trim() === '' ? null : parsed.data.value);
    res.json({ entry });
    broadcast('us-calling-tracker-changed');
  } catch (err) {
    throw new AppError(400, err instanceof Error ? err.message : 'Could not update entry');
  }
}));

usCallingTrackerRouter.delete('/:id', asyncHandler(async (req, res) => {
  await deleteTrackerEntry(req.params.id);
  res.json({ ok: true });
  broadcast('us-calling-tracker-changed');
}));

/**
 * "Departed" action — the primary way rows leave this list per explicit
 * design ("no delete, only Departed"). Mirrors ENOA/D List's exact
 * pattern: deletes the entry and records the shared cross-list Departed
 * marker.
 */
usCallingTrackerRouter.post('/:id/departed', asyncHandler(async (req, res) => {
  try {
    const result = await markTrackerEntryDeparted(req.params.id);
    res.json(result);
    broadcast('us-calling-tracker-changed');
    broadcast('vessels-changed');
    broadcast('us-calling-changed');
  } catch (err) {
    throw new AppError(404, err instanceof Error ? err.message : 'Entry not found');
  }
}));

const undoDepartedSchema = z.object({
  vesselName: z.string(),
  tech: z.string().nullable().optional(),
  etaRaw: z.string().nullable().optional(),
  etdRaw: z.string().nullable().optional(),
  arrivalPort: z.string().nullable().optional(),
  flag: z.string().nullable().optional(),
  certificateStatus: z.string().nullable().optional(),
  enoaSentForReview: z.string().nullable().optional(),
  qualship21ExpiryRaw: z.string().nullable().optional(),
  usCallingMessageSentRaw: z.string().nullable().optional(),
  receivedFromVesselRaw: z.string().nullable().optional(),
  reviewedRaw: z.string().nullable().optional(),
  ballastWaterNbicRaw: z.string().nullable().optional(),
  ballastWaterCaWaOrRaw: z.string().nullable().optional(),
  biofoulingPlanRaw: z.string().nullable().optional(),
  marineInvasiveSpeciesRaw: z.string().nullable().optional(),
  checklistSentRaw: z.string().nullable().optional(),
  pscChecklistRaw: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),
});

usCallingTrackerRouter.post('/undo-departed', asyncHandler(async (req, res) => {
  const parsed = undoDepartedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const entry = await undoTrackerEntryDeparted(parsed.data);
  res.json({ ok: true, entry });
  broadcast('us-calling-tracker-changed');
  broadcast('vessels-changed');
  broadcast('us-calling-changed');
}));

usCallingTrackerRouter.post('/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded (expected multipart field "file")');
  const summary = await importTrackerEntriesFromFile(req.file.buffer);
  res.json({ summary });
  broadcast('us-calling-tracker-changed');
}));

usCallingTrackerRouter.get('/export', asyncHandler(async (req, res) => {
  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : undefined;
  const ids = idsParam ? idsParam.split(',').filter(Boolean) : undefined;
  const { buffer, filename } = await exportTrackerEntriesToXlsx(ids);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));
