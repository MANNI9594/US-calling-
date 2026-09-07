import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { storage } from '../services/storage';
import { previewMasterImport, commitMasterImport, backfillMissingPermanentFields } from '../services/import/masterImportService';
import { asyncHandler } from '../middleware/asyncHandler';

export const importRouter = Router();
importRouter.use(requireAuth);

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

/**
 * Step 1 of 2: parse the uploaded Master workbook and show what WOULD
 * happen, without creating any Vessel/Evidence/CallingRecord rows. The
 * original file is written to storage here so the same bytes can be
 * committed afterward without asking the user to upload twice — see
 * masterImportService.ts for why that's safe (an unfinished preview just
 * leaves an unreferenced file, never an inconsistent DB row).
 */
importRouter.post('/master-workbook/preview', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded (expected multipart field "file")');

  const preview = await previewMasterImport(req.file.buffer, req.file.originalname);
  res.json({ preview });
}));

const commitSchema = z.object({
  storageKey: z.string().min(1),
  originalFilename: z.string().min(1),
});

/**
 * Step 2 of 2: actually commits the previously-previewed file (referenced
 * by storageKey, not re-uploaded) inside one atomic transaction.
 */
importRouter.post('/master-workbook/commit', asyncHandler(async (req, res) => {
  const parsed = commitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const exists = await storage.exists(parsed.data.storageKey);
  if (!exists) {
    throw new AppError(400, 'The previewed file could not be found in storage. Please upload and preview again.');
  }

  const { batchId, summary } = await commitMasterImport(parsed.data.storageKey, parsed.data.originalFilename);
  res.status(201).json({ batchId, summary });
}));

const historyQuerySchema = z.object({
  type: z.enum(['MASTER_IMPORT', 'US_CALLING_LIST_UPLOAD', 'MASTER_EXPORT', 'BACKUP_EXPORT', 'BACKUP_RESTORE']).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/** Import history: filename, date/time, status, and summary counts. */
importRouter.get('/batches', asyncHandler(async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    return;
  }

  const batches = await prisma.importBatch.findMany({
    where: { type: parsed.data.type },
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit,
  });

  res.json({ batches });
}));

importRouter.get('/batches/:id', asyncHandler(async (req, res) => {
  const batch = await prisma.importBatch.findUnique({ where: { id: req.params.id } });
  if (!batch) throw new AppError(404, 'Import batch not found');
  res.json({ batch });
}));

/**
 * One-time remediation: re-reads the last Master import and fills in any
 * permanent field that's currently blank on an existing vessel — see
 * masterImportService.ts for exactly why this exists and its safety
 * guarantees (never overwrites a populated field, never creates vessels).
 */
importRouter.post('/backfill-missing-fields', asyncHandler(async (_req, res) => {
  const summary = await backfillMissingPermanentFields();
  res.json({ summary });
}));
