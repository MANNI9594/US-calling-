import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '../../db/prisma';
import { env } from '../../config/env';

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function hashToken(token: string): string {
  // Sessions are looked up by hash, never by the raw token — so a DB leak
  // alone doesn't hand out valid session tokens (same principle as
  // password hashing, applied to session tokens).
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  token: string; // raw value — goes in the cookie, never stored
  expiresAt: Date;
}

export async function createSession(userId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function verifySession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Expired — clean it up lazily and report as invalid.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  return session;
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.delete({ where: { tokenHash: hashToken(token) } }).catch(() => undefined);
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
