/**
 * Bearer-token sessions, kept in memory. Tokens are opaque random strings;
 * the client keeps them in memory too (never in localStorage).
 */
import { randomBytes } from "node:crypto";

interface Session {
  userId: string;
  expiresAt: number;
}

const ONE_TIME_CODE_TTL_MS = 60_000;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly codes = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly timeoutMinutes: number) {}

  create(userId: string): { token: string; expiresAt: string } {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.timeoutMinutes * 60_000;
    this.sessions.set(token, { userId, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Resolve a token to a user id; sliding expiration. */
  resolve(token: string): string | null {
    return this.resolveSession(token)?.userId ?? null;
  }

  /** Like `resolve`, with the (extended) expiry time in ms since the epoch. */
  resolveSession(token: string): { userId: string; expiresAt: number } | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + this.timeoutMinutes * 60_000;
    return { userId: session.userId, expiresAt: session.expiresAt };
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * One-time code handed to the browser after an SSO redirect, exchanged for
   * a token by the client so the token never appears in a URL.
   */
  issueCode(token: string): string {
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { token, expiresAt: Date.now() + ONE_TIME_CODE_TTL_MS });
    return code;
  }

  redeemCode(code: string): string | null {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.token;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(token);
    for (const [code, c] of this.codes) if (c.expiresAt < now) this.codes.delete(code);
  }
}
