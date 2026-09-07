import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { hashPassword, verifyPassword, createSession, destroySession, destroyAllSessionsForUser } from '../services/auth/authService';
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
 * One-time bootstrap endpoint: creates the FIRST user account. Only works
 * when no user exists yet — after that it always refuses, so it can never
 * be used to create additional accounts (that's POST /users below, which
 * requires an existing login). This is what makes it safe to leave this
 * endpoint unauthenticated: it's a one-shot door that locks itself.
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

/**
 * Adds another team member's account. Deliberately requires an existing
 * login (unlike /setup) — this is how a small team (e.g. 3 people sharing
 * one Master database) each get their own login without ever exposing an
 * open self-registration endpoint to the internet. Every vessel/evidence
 * action already records `actorUserId`, so once a team has multiple real
 * accounts, the audit log naturally shows who did what.
 */
const addTeamMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});

authRouter.post('/users', requireAuth, asyncHandler(async (req, res) => {
  const parsed = addTeamMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'A user with that email already exists' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  await logAudit({
    eventType: 'TEAM_MEMBER_ADDED',
    actorUserId: req.userId,
    summary: `${req.userEmail} added a new team member account (${user.email})`,
  });

  res.status(201).json({ email: user.email, createdAt: user.createdAt });
}));

/** Lists team member accounts (email + timestamps only — never password hashes). */
authRouter.get('/users', requireAuth, asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { email: true, createdAt: true, lastLoginAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ users });
}));

/**
 * Self-service password change — requires knowing the CURRENT password,
 * so this alone doesn't help if someone is actually locked out (see the
 * teammate-reset and emergency-recovery endpoints below for that case).
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'New password must be at least 10 characters'),
});

authRouter.post('/me/change-password', requireAuth, asyncHandler(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const currentOk = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!currentOk) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

  res.json({ ok: true });
}));

/**
 * Lets any logged-in team member reset ANOTHER team member's password —
 * no email verification step, by design: this is a small trusted team
 * sharing one dataset, not a multi-tenant product with untrusted users.
 * The target's email is used rather than an ID since that's what the Team
 * page already displays and it's what a person would naturally type.
 */
const resetTeamMemberPasswordSchema = z.object({
  email: z.string().email(),
  newPassword: z.string().min(10, 'New password must be at least 10 characters'),
});

authRouter.post('/users/reset-password', requireAuth, asyncHandler(async (req, res) => {
  const parsed = resetTeamMemberPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const target = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!target) {
    res.status(404).json({ error: 'No user with that email' });
    return;
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash: newHash } });
  await destroyAllSessionsForUser(target.id); // force re-login everywhere with the new password

  await logAudit({
    eventType: 'MANUAL_EDIT',
    actorUserId: req.userId,
    summary: `${req.userEmail} reset the password for ${target.email}`,
  });

  res.json({ ok: true, email: target.email });
}));

/**
 * Emergency account recovery — for when NOBODY can log in at all (the
 * true lockout case). Deliberately unauthenticated (there's no session to
 * require), so it's gated instead by a long random secret set as a
 * deployment-time environment variable (ADMIN_RECOVERY_SECRET), known only
 * to whoever deployed the app — never a user password, never stored in
 * the database. If that variable isn't set, this endpoint always refuses;
 * recovery is opt-in, not a default open door. Rate-limited hard since
 * it's unauthenticated.
 */
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many recovery attempts. Please wait and try again.' },
});

const recoverySchema = z.object({
  secret: z.string().min(1),
  email: z.string().email(),
  newPassword: z.string().min(10, 'New password must be at least 10 characters'),
});

authRouter.post('/recovery-reset', recoveryLimiter, asyncHandler(async (req, res) => {
  if (!env.ADMIN_RECOVERY_SECRET) {
    res.status(503).json({ error: 'Account recovery is not configured for this deployment. Set ADMIN_RECOVERY_SECRET to enable it.' });
    return;
  }

  const parsed = recoverySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const providedSecret = Buffer.from(parsed.data.secret);
  const realSecret = Buffer.from(env.ADMIN_RECOVERY_SECRET);
  const secretMatches =
    providedSecret.length === realSecret.length && timingSafeEqual(providedSecret, realSecret);

  if (!secretMatches) {
    res.status(401).json({ error: 'Invalid recovery secret' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!target) {
    res.status(404).json({ error: 'No user with that email' });
    return;
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash: newHash } });
  await destroyAllSessionsForUser(target.id);

  await logAudit({
    eventType: 'MANUAL_EDIT',
    summary: `${target.email}'s password was reset via emergency recovery`,
  });

  res.json({ ok: true, email: target.email });
}));
