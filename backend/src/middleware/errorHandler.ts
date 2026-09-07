import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';
import multer from 'multer';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(logger: Logger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, details: err.details });
      return;
    }

    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : `Upload error: ${err.message}`;
      res.status(400).json({ error: message });
      return;
    }

    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

    // Never leak internal error details/stack traces to the client — this
    // handles operational data (owner names, vessel data), so keep the
    // response generic.
    res.status(500).json({ error: 'Internal server error' });
  };
}
