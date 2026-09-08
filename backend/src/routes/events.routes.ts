import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { subscribe, unsubscribe, clientCount } from '../services/realtime/eventBus';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

/**
 * Opens a long-lived Server-Sent Events connection. The browser's built-in
 * EventSource handles reconnection automatically if this drops — the
 * frontend doesn't need any special retry logic.
 *
 * A keepalive comment is sent periodically so intermediate proxies
 * (Railway's, browsers' own idle timeouts) don't silently close the
 * connection thinking it's gone quiet.
 */
eventsRouter.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: {"clients":${clientCount() + 1}}\n\n`);
  subscribe(res);

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe(res);
  });
});
