import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ─── Role constants — import these everywhere instead of magic strings ─────────
export const ROLES = {
  ADMIN: "ADMIN_SUB_AFFILIATE",
  BASIC: "BASIC_SUB_AFFILIATE",
  MANAGER: "AFFILIATE_MANAGER",
} as const;

export type AppRole = (typeof ROLES)[keyof typeof ROLES];

export interface AuthRequest extends Request {
  user?: { userId: string; role: AppRole };
}

// ── Verify JWT and attach user ─────────────────────────────────────────────────
export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      role: AppRole;
    };
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ── Role guard factory ─────────────────────────────────────────────────────────
export const requireRole =
  (...roles: AppRole[]) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };

// ── Convenience guards (single-import shortcuts used in route files) ───────────
export const requireAdmin = requireRole(ROLES.ADMIN);
export const requireBasic = requireRole(ROLES.BASIC);
export const requireManager = requireRole(ROLES.MANAGER);

// Admin OR Basic can both see the conversion feed
export const requireAdminOrBasic = requireRole(ROLES.ADMIN, ROLES.BASIC);
