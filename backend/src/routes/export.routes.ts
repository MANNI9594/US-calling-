import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { generateMasterExport } from '../services/export/masterExportService';

export const exportRouter = Router();
exportRouter.use(requireAuth);

/**
 * Generates the current Active Master as a downloadable .xlsx, using the
 * last completed Master Import as a formatting template (see
 * masterExportService.ts). Runs synchronously and streams the result —
 * appropriate at this personal-tool scale (tens of vessels, tens of
 * images); would need to become a background job if that scale changed
 * substantially.
 */
exportRouter.get('/master-xlsx', asyncHandler(async (_req, res) => {
  const result = await generateMasterExport();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(result.buffer);
}));
