import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../services/auth/authService';

export const SESSION_COOKIE_NAME = 'ucmm_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token || typeof token !== 'string') {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = await verifySession(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  req.userId = session.userId;
  req.userEmail = session.user.email;
  next();
}
