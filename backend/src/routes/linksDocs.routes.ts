import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { storage } from '../services/storage';
import { env } from '../config/env';
import { broadcast } from '../services/realtime/eventBus';

export const linksDocsRouter = Router();
linksDocsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

// --- Quick Links ---

linksDocsRouter.get('/links', asyncHandler(async (_req, res) => {
  const links = await prisma.quickLink.findMany({ orderBy: { label: 'asc' } });
  res.json({ links });
}));

const linkSchema = z.object({
  label: z.string().trim().min(1),
  url: z.string().trim().url('Must be a valid URL, including https://'),
});

linksDocsRouter.post('/links', asyncHandler(async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const link = await prisma.quickLink.create({ data: parsed.data });
  res.status(201).json({ link });
  broadcast('links-docs-changed');
}));

linksDocsRouter.patch('/links/:id', asyncHandler(async (req, res) => {
  const parsed = linkSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const link = await prisma.quickLink.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ link });
  broadcast('links-docs-changed');
}));

linksDocsRouter.delete('/links/:id', asyncHandler(async (req, res) => {
  await prisma.quickLink.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
  broadcast('links-docs-changed');
}));

// --- Shared Documents ---

linksDocsRouter.get('/documents', asyncHandler(async (_req, res) => {
  const documents = await prisma.sharedDocument.findMany({ orderBy: { name: 'asc' } });
  res.json({ documents });
}));

linksDocsRouter.post('/documents', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded (expected multipart field "file")');

  const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : req.file.originalname;
  const extension = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop() : 'bin';
  const storageKey = storage.buildKey('documents', `document.${extension}`);
  await storage.put(storageKey, req.file.buffer, req.file.mimetype);

  const document = await prisma.sharedDocument.create({
    data: {
      name,
      originalFilename: req.file.originalname,
      storageKey,
      mimeType: req.file.mimetype,
      fileSizeBytes: req.file.size,
    },
  });

  res.status(201).json({ document });
  broadcast('links-docs-changed');
}));

linksDocsRouter.get('/documents/:id/file', asyncHandler(async (req, res) => {
  const document = await prisma.sharedDocument.findUnique({ where: { id: req.params.id } });
  if (!document) throw new AppError(404, 'Document not found');

  const buffer = await storage.get(document.storageKey);
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${document.originalFilename}"`);
  res.send(buffer);
}));

linksDocsRouter.delete('/documents/:id', asyncHandler(async (req, res) => {
  const document = await prisma.sharedDocument.findUnique({ where: { id: req.params.id } });
  if (!document) throw new AppError(404, 'Document not found');

  await storage.delete(document.storageKey).catch(() => undefined);
  await prisma.sharedDocument.delete({ where: { id: document.id } });

  res.json({ ok: true });
  broadcast('links-docs-changed');
}));
