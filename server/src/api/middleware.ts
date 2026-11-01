import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { ApiErrorBody } from "@planning/shared";
import { AppError, UnauthorizedError } from "../domain/errors.js";
import type { SessionStore } from "../auth/sessions.js";
import type { Services } from "../services/Services.js";
import type { ServiceContext } from "../services/support.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: ServiceContext;
      token?: string;
    }
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

/** Resolve the bearer token to a user. Used by REST and MCP alike. */
export function authenticate(services: Services, sessions: SessionStore) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = bearerToken(req);
    const userId = token ? sessions.resolve(token) : null;
    const user = userId ? await services.users.get(userId) : null;
    if (!token || !user) throw new UnauthorizedError();
    req.token = token;
    req.ctx = { user, origin: "UI" };
    next();
  };
}

/** After the SDK's bearer check (MCP with OAuth): the token's user becomes the request context. */
export function userFromOAuth(services: Services) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const userId = req.auth?.extra?.userId;
    const user = typeof userId === "string" ? await services.users.get(userId) : null;
    if (!user) throw new UnauthorizedError();
    req.token = req.auth!.token;
    req.ctx = { user, origin: "UI" };
    next();
  };
}

export function ctxOf(req: Request): ServiceContext {
  if (!req.ctx) throw new UnauthorizedError();
  return req.ctx;
}

/**
 * CORS: same-origin requests have no Origin header; hosted clients must be
 * in `allowedOrigins`; `file://` clients send `Origin: null` and are only
 * allowed with `allowFileClient` (they always use bearer tokens, never cookies).
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: string[],
  allowFileClient: boolean,
): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return allowFileClient;
  return allowed.includes(origin);
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  let status = 500;
  let body: ApiErrorBody = { error: { code: "INTERNAL", message: "Internal server error" } };
  if (err instanceof AppError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err instanceof z.ZodError) {
    status = 400;
    body = { error: { code: "VALIDATION", message: z.prettifyError(err), details: err.issues } };
  } else if (err instanceof SyntaxError && "body" in err) {
    status = 400;
    body = { error: { code: "VALIDATION", message: "Malformed JSON body" } };
  } else {
    console.error(err);
  }
  res.status(status).json(body);
}
