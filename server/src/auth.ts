import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

export const SESSION_COOKIE = "rr_session";
const SESSION_TTL_S = 7 * 86_400;
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export type AuthOptions = { password: string; secret: string; secure: boolean };

export function passwordMatches(input: string, expected: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  retryAfter(ip: string, now = Date.now()): number {
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    this.failures.set(ip, recent);
    return recent.length >= MAX_FAILURES ? Math.ceil((recent[0]! + WINDOW_MS - now) / 1000) : 0;
  }

  fail(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}

export async function startSession(c: Context, opts: AuthOptions): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_S * 1000).toISOString();
  await setSignedCookie(c, SESSION_COOKIE, expiresAt, opts.secret, {
    httpOnly: true,
    sameSite: "Strict",
    secure: opts.secure,
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return expiresAt;
}

export function endSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function sessionExpiry(c: Context, opts: AuthOptions): Promise<string | null> {
  const value = await getSignedCookie(c, opts.secret, SESSION_COOKIE);
  if (!value || Number.isNaN(Date.parse(value)) || Date.parse(value) < Date.now()) return null;
  return value;
}

export function requireSession(opts: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!(await sessionExpiry(c, opts))) return c.json({ error: "unauthorized", message: "Login required" }, 401);
    await next();
  };
}
