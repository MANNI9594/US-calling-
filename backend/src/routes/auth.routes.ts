import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { hashPassword, verifyPassword, createSession, destroySession } from '../services/auth/authService';
import { requireAuth, SESSION_COOKIE_NAME } from '../middleware/auth';
import { logAudit } from '../services/audit/auditService';
import { asyncHandler } from '../middleware/asyncHandler';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10, // this is a single-user tool; 10 attempts / 15 min is plenty of headroom, tight enough to blunt brute force
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait and try again.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function setSessionCookie(res: import('express').Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

authRouter.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  // Deliberately identical response whether the email doesn't exist or the
  // password is wrong — don't leak which one failed.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const session = await createSession(user.id);
  setSessionCookie(res, session.token, session.expiresAt);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await logAudit({ eventType: 'LOGIN', actorUserId: user.id, summary: `${user.email} logged in` });

  res.json({ email: user.email });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (token) await destroySession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.userEmail });
});

/**
 * One-time setup endpoint: creates the single user account. Only works when
 * no user exists yet, so it can't be used to create additional accounts
 * later or by anyone else after initial setup — this is a personal
 * single-user tool, not a multi-tenant registration system.
 */
const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});

authRouter.post('/setup', asyncHandler(async (req, res) => {
  const existingCount = await prisma.user.count();
  if (existingCount > 0) {
    res.status(403).json({ error: 'Setup already completed. Use /login instead.' });
    return;
  }

  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const session = await createSession(user.id);
  setSessionCookie(res, session.token, session.expiresAt);

  res.status(201).json({ email: user.email });
}));
