import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret } from "../config";
import { usersRepository, toAuthUser } from "../repositories/users.repository";
import { forbidden, unauthorized } from "../lib/errors";
import { hasPermission, type Role } from "@shared/roles";
import { asyncHandler } from "../lib/http";

const TOKEN_TTL = "7d";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: TOKEN_TTL, audience: "woomarket360" });
}

function bearerUserId(req: Request): string | null {
  const header = req.get("authorization") ?? req.get("x-auth-token");
  if (!header) return null;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  try {
    const payload = jwt.verify(token, jwtSecret(), { audience: "woomarket360" }) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the caller from the session cookie or a bearer token and loads the user
 * fresh from the database, so deactivation and permission changes apply immediately.
 */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  let userId = req.session?.userId ?? null;
  let method: "session" | "bearer" | undefined = userId ? "session" : undefined;
  if (!userId) {
    userId = bearerUserId(req);
    if (userId) method = "bearer";
  }
  if (userId) {
    const user = await usersRepository.findById(userId);
    if (user && user.status === "active") {
      req.user = toAuthUser(user);
      req.authMethod = method;
    } else if (req.session?.userId) {
      delete req.session.userId;
    }
  }
  next();
});

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Passes when the user holds any of the listed permissions. No implicit role bypass. */
export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user.permissions, ...permissions)) {
      return next(forbidden(`Missing permission: ${permissions.join(" or ")}`, "MISSING_PERMISSION"));
    }
    next();
  };
}
