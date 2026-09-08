import type { Response } from 'express';

/**
 * A tiny in-memory pub/sub for Server-Sent Events. Every connected browser
 * tab holds one open HTTP response; broadcasting writes an SSE-formatted
 * message to all of them at once.
 *
 * DELIBERATELY in-memory, not backed by Redis/a message queue: this app
 * runs as a single Node process (one Railway/Render service instance),
 * which is the right scale for a personal/small-team tool. If this ever
 * needed to run as multiple horizontally-scaled instances, an in-memory
 * broadcast would only reach clients connected to the SAME instance —
 * that's the one real limitation of this approach, noted here rather than
 * discovered silently later.
 */

const clients = new Set<Response>();

export function subscribe(res: Response): void {
  clients.add(res);
}

export function unsubscribe(res: Response): void {
  clients.delete(res);
}

export function broadcast(event: string, data: unknown = {}): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // A write failing means that client's connection is already dead —
      // it'll be cleaned up by its own 'close' handler; nothing to do here.
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
