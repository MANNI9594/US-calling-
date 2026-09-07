import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { healthRouter } from './routes/health.routes';
import { authRouter } from './routes/auth.routes';
import { vesselsRouter } from './routes/vessels.routes';
import { evidenceRouter } from './routes/evidence.routes';
import { importRouter } from './routes/import.routes';
import { usCallingRouter } from './routes/uscalling.routes';
import { exportRouter } from './routes/export.routes';
import { errorHandler } from './middleware/errorHandler';

export const logger = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });

export function createApp() {
  const app = express();

  // Trust the reverse proxy on Railway/Render/etc. so `secure` cookies and
  // rate limiting see the real client IP/protocol.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON + evidence images, not HTML pages, so a
      // restrictive default CSP is unnecessary friction here.
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true, // required for the session cookie to be sent cross-origin (frontend on a different domain)
    }),
  );
  app.use(express.json({ limit: '2mb' })); // vessel/evidence records are small JSON; file uploads use multer separately
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/vessels', vesselsRouter);
  app.use('/api/evidence', evidenceRouter);
  app.use('/api/import', importRouter);
  app.use('/api/us-calling-list', usCallingRouter);
  app.use('/api/export', exportRouter);

  // Serves setup.html — a browser-only one-time account creation page, so
  // no curl/CLI is needed even for that step. See docs/DEPLOYMENT.md.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  app.use(errorHandler(logger));

  return app;
}