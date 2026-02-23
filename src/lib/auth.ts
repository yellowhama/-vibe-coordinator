/**
 * Auth utilities — password hashing, session management, middleware
 */

import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Context, Next } from "hono";
import {
  createSessionRecord,
  findSessionById,
  findUserById,
} from "./db.js";

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(): string {
  return uuidv4();
}

export function createSession(
  userId: string,
  deviceCode?: string | null,
  deviceName?: string | null,
  ttlDays: number = SESSION_TTL_DAYS
): { token: string; expiresAt: string } {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  createSessionRecord(token, userId, deviceCode ?? null, deviceName ?? null, expiresAt);
  return { token, expiresAt };
}

export function validateSession(token: string): Record<string, unknown> | null {
  const session = findSessionById(token);
  if (!session) return null;
  const user = findUserById(session.user_id as string);
  if (!user) return null;
  return user;
}

/**
 * Format a user record for API responses (strip sensitive fields).
 */
export function formatUser(user: Record<string, unknown>) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || null,
    avatar_url: user.avatar_url || null,
    auth_provider: user.auth_provider,
    is_admin: user.is_admin === 1,
  };
}

/**
 * Hono middleware — requires valid Bearer token.
 * Sets c.set("user", userRecord) on success.
 */
export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "UNAUTHORIZED", message: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const user = validateSession(token);
  if (!user) {
    return c.json({ error: "UNAUTHORIZED", message: "Invalid or expired session" }, 401);
  }

  c.set("user", user);
  c.set("sessionToken", token);
  await next();
}
