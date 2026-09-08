import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { broadcast } from '../services/realtime/eventBus';
import {
  listEntries,
  createEntry,
  updateEntryField,
  deleteEntry,
  importEntriesFromFile,
  applyEntriesToVecs,
  previewApplyToVecs,
  exportEntriesToXlsx,
} from '../services/uscalling/usCallingListEntryService';

export const usCallingEntriesRouter = Router();
usCallingEntriesRouter.use(requireAuth);

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

usCallingEntriesRouter.get('/', asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const entries = await listEntries(search);
  res.json({ entries, count: entries.length });
}));

const entrySchema = z.object({
  vesselName: z.string().trim().min(1),
  voyageType: z.string().trim().optional(),
  transactionType: z.string().trim().optional(),
  sendTo: z.string().trim().optional(),
  arrivalPort: z.string().trim().optional(),
  etaRaw: z.string().trim().optional(),
  etdRaw: z.string().trim().optional(),
});

usCallingEntriesRouter.post('/', asyncHandler(async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const entry = await createEntry(parsed.data);
  res.status(201).json({ entry });
  broadcast('us-calling-changed');
}));

const fieldEditSchema = z.object({ field: z.string(), value: z.string() });

usCallingEntriesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = fieldEditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const entry = await updateEntryField(req.params.id, parsed.data.field, parsed.data.value.trim() === '' ? null : parsed.data.value);
    res.json({ entry });
    broadcast('us-calling-changed');
  } catch (err) {
    throw new AppError(400, err instanceof Error ? err.message : 'Could not update entry');
  }
}));

usCallingEntriesRouter.delete('/:id', asyncHandler(async (req, res) => {
  await deleteEntry(req.params.id);
  res.json({ ok: true });
  broadcast('us-calling-changed');
}));

usCallingEntriesRouter.post('/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded (expected multipart field "file")');
  const summary = await importEntriesFromFile(req.file.buffer);
  res.json({ summary });
  broadcast('us-calling-changed');
}));

const applySchema = z.object({ restoreArchivedVessels: z.boolean().default(false) });

/**
 * Preview endpoint — the confirmation-popup data the user explicitly asked
 * for before Apply runs, since it can both update AND remove vessels.
 * Computes and returns counts (and the actual list of removal candidates
 * by name) without changing anything.
 */
usCallingEntriesRouter.get('/apply-preview', asyncHandler(async (_req, res) => {
  const preview = await previewApplyToVecs();
  res.json({ preview });
}));

usCallingEntriesRouter.post('/apply-to-vecs', asyncHandler(async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const { batchId, summary } = await applyEntriesToVecs(parsed.data.restoreArchivedVessels);
  res.status(201).json({ batchId, summary });
  broadcast('us-calling-changed');
  broadcast('vessels-changed');
}));

usCallingEntriesRouter.get('/export', asyncHandler(async (_req, res) => {
  const { buffer, filename } = await exportEntriesToXlsx();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));
