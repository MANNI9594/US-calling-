import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { storage } from '../services/storage';
import { previewUsCallingListUpdate, commitUsCallingListUpdate } from '../services/uscalling/usCallingImportService';

export const usCallingRouter = Router();
usCallingRouter.use(requireAuth);

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

usCallingRouter.post('/preview', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded (expected multipart field "file")');

  const preview = await previewUsCallingListUpdate(req.file.buffer, req.file.originalname);
  res.json({ preview });
}));

const commitSchema = z.object({
  storageKey: z.string().min(1),
  originalFilename: z.string().min(1),
  restoreArchivedVessels: z.boolean().default(false),
});

usCallingRouter.post('/commit', asyncHandler(async (req, res) => {
  const parsed = commitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const exists = await storage.exists(parsed.data.storageKey);
  if (!exists) {
    throw new AppError(400, 'The previewed file could not be found in storage. Please upload and preview again.');
  }

  const { batchId, summary } = await commitUsCallingListUpdate(parsed.data);
  res.status(201).json({ batchId, summary });
}));
