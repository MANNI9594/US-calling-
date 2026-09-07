import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does NOT automatically catch a rejected promise (or a thrown
 * error inside an async function) from a route handler — it needs to be
 * passed to `next(err)` explicitly, or the request hangs / the process
 * gets an unhandled rejection instead of the client getting a response.
 *
 * Every async route handler in this app must be wrapped in this. It's
 * cheap insurance for something that's easy to silently get wrong once
 * and then have it apply to every single route.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
