import { Router } from 'express';
import { prisma } from '../db/prisma';
import { asyncHandler } from '../middleware/asyncHandler';

export const healthRouter = Router();

healthRouter.get('/health', asyncHandler(async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
  }
}));
