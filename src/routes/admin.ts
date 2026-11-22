/**
 * Admin catalog routes, polite collection endpoints, and Admin Account Management API.
 *
 * Security model:
 * - Every /api/admin/* endpoint enforces server-side admin authorization via `requireAdmin`.
 * - Accepts EITHER:
 *     1. A verified Firebase ID token (`Authorization: Bearer <token>`) belonging to
 *        the bootstrapped Google Admin or an active admin email, OR
 *     2. An active Express session whose live user record in the store has
 *        `role === "admin"`, `is_active === true`, and a matching `session_version`.
 * - Every state-changing request authenticated by session cookie also verifies the
 *   CSRF token (`X-CSRF-Token` or `csrf_token`) alongside same-origin checks.
 * - Regular users (`role === "student"` or non-admin Google accounts) always receive
 *   HTTP 403 Forbidden from both protected pages and backend API endpoints.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import { getProfile, getUser } from "../accounts.js";
import {
  AdminAccountError,
  createAdminAccount,
  isActiveAdminUser,
  listAdminAccounts,
  removeAdminAccount,
  type AdminActor,
} from "../adminAccounts.js";
import {
  collectUniversityPolite,
  exportBaselineCatalog,
  getCollectorConfig,
  parseCollectorJsonImport,
} from "../collector.js";
import { adminAuth, isVerifiedAdminToken } from "../lib/firebaseAdmin.js";
import { isCsrfValid } from "../security.js";
import {
  SlidingFixedWindowLimiter,
  createRateLimitMiddleware,
} from "../securityHardening.js";
import { consumeFlashes } from "./auth.js";

export const adminRouter = express.Router();

export interface AdminRequest extends Request {
  adminUser?: DecodedIdToken;
  adminActor?: AdminActor;
}

const collectLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 8,
  keyPrefix: "admin-collect",
});

const importLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 25,
  keyPrefix: "admin-import",
});

const adminAccountWriteLimiter = new SlidingFixedWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyPrefix: "admin-accounts-write",
});

function resolveSessionAdminActor(req: Request): AdminActor | null {
  const userId = req.session?.userId;
  if (!userId) return null;
  const liveUser = getUser(userId);
  if (
    !liveUser ||
    !liveUser.is_active ||
    Number(req.session.sessionVersion ?? 0) !== liveUser.session_version
  ) {
    // Immediately clear stale or revoked session credentials
    delete req.session.userId;
    delete req.session.sessionVersion;
    return null;
  }
  if (!isActiveAdminUser(liveUser)) {
    return null;
  }
  try {
    const profile = getProfile(liveUser.id);
    return {
      id: liveUser.id,
      email: profile.email,
      username: profile.username,
      displayName: profile.display_name,
      source: "session",
    };
  } catch {
    return null;
  }
}

export async function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization || "";

  // 1. Check Bearer Firebase ID token when supplied
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (!token || token.length > 8192) {
      return res.status(401).json({ error: "Invalid authorization token." });
    }
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      if (!isVerifiedAdminToken(decoded)) {
        return res
          .status(403)
          .json({ error: "Admin access is required for this action." });
      }
      const email = String(decoded.email || "").trim().toLowerCase();
      req.adminUser = decoded;
      req.adminActor = {
        id: `firebase:${decoded.uid}`,
        email,
        username: email.split("@")[0] || "admin",
        displayName: String(decoded.name || email || "Administrator"),
        source: "firebase",
      };
      return next();
    } catch {
      return res.status(401).json({
        error: "Your sign-in session could not be verified. Sign in again.",
      });
    }
  }

  // 2. Check live Express session against server-side account store
  if (req.session?.userId) {
    const liveUser = getUser(req.session.userId);
    if (
      !liveUser ||
      !liveUser.is_active ||
      Number(req.session.sessionVersion ?? 0) !== liveUser.session_version
    ) {
      delete req.session.userId;
      delete req.session.sessionVersion;
      return res.status(401).json({
        error: "Your administrator session is no longer active. Please sign in again.",
      });
    }
    if (!isActiveAdminUser(liveUser)) {
      return res.status(403).json({
        error: "Administrator permissions are required to perform this action.",
      });
    }
    const actor = resolveSessionAdminActor(req);
    if (!actor) {
      return res.status(401).json({ error: "Admin sign-in is required." });
    }
    req.adminActor = actor;
    return next();
  }

  return res.status(401).json({ error: "Admin sign-in is required." });
}

function requireCsrfForSessionAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.adminActor?.source === "session" && !isCsrfValid(req)) {
    return res.status(400).json({
      error: "Your security token expired. Reload the page and try again.",
    });
  }
  return next();
}

// --- Protected Admin Pages ---

adminRouter.get("/admin", (req, res) => {
  const sessionUser = res.locals.currentUser;
  if (sessionUser && !isActiveAdminUser(sessionUser)) {
    return res.status(403).render("admin", {
      title: "Access restricted",
      error: null,
      flashes: consumeFlashes(req),
      sessionAccessDenied: true,
      isSessionAdmin: false,
      sessionAdmin: null,
    });
  }
  const sessionAdmin = resolveSessionAdminActor(req);
  return res.render("admin", {
    title: "Catalog manager",
    error: null,
    flashes: consumeFlashes(req),
    sessionAccessDenied: false,
    isSessionAdmin: Boolean(sessionAdmin),
    sessionAdmin,
  });
});

adminRouter.get("/admin/accounts", (req, res) => {
  const sessionUser = res.locals.currentUser;
  // Regular logged-in student accounts are blocked server-side with HTTP 403
  if (sessionUser && !isActiveAdminUser(sessionUser)) {
    return res.status(403).render("admin_accounts", {
      title: "Access restricted",
      error: null,
      flashes: consumeFlashes(req),
      sessionAccessDenied: true,
      isSessionAdmin: false,
      sessionAdmin: null,
    });
  }
  const sessionAdmin = resolveSessionAdminActor(req);
  return res.render("admin_accounts", {
    title: "Admin accounts",
    error: null,
    flashes: consumeFlashes(req),
    sessionAccessDenied: false,
    isSessionAdmin: Boolean(sessionAdmin),
    sessionAdmin,
  });
});

// --- Admin Account Management API ---

adminRouter.get(
  "/api/admin/accounts",
  requireAdmin,
  (req: AdminRequest, res: Response) => {
    const actor = req.adminActor!;
    return res.json(listAdminAccounts(actor));
  },
);

adminRouter.post(
  "/api/admin/accounts",
  createRateLimitMiddleware(adminAccountWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  (req: AdminRequest, res: Response) => {
    const actor = req.adminActor!;
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const result = createAdminAccount(
        {
          username: String(body.username ?? ""),
          email: String(body.email ?? ""),
          displayName:
            typeof body.displayName === "string" ? body.displayName : undefined,
          password: String(body.password ?? ""),
          passwordConfirm:
            body.passwordConfirm !== undefined
              ? String(body.passwordConfirm)
              : undefined,
        },
        actor,
      );
      return res.status(201).json(result);
    } catch (err) {
      if (err instanceof AdminAccountError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(400)
        .json({ error: "Could not create administrator account." });
    }
  },
);

adminRouter.delete(
  "/api/admin/accounts/:accountId",
  createRateLimitMiddleware(adminAccountWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  (req: AdminRequest, res: Response) => {
    const actor = req.adminActor!;
    const accountId = String(req.params.accountId || "").trim();
    try {
      const result = removeAdminAccount(accountId, actor);
      return res.json(result);
    } catch (err) {
      if (err instanceof AdminAccountError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(400)
        .json({ error: "Could not remove administrator account." });
    }
  },
);

// --- Existing Admin Catalog & Collector APIs (unified admin guard) ---

adminRouter.get("/api/admin/baseline", requireAdmin, (_req, res) => {
  try {
    return res.json({
      universities: exportBaselineCatalog(),
      collector: getCollectorConfig(),
    });
  } catch (err) {
    console.error("Failed to build baseline catalog export:", err);
    return res
      .status(500)
      .json({ error: "Could not prepare the baseline university catalog." });
  }
});

adminRouter.post(
  "/api/admin/collect",
  createRateLimitMiddleware(collectLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const universityId = String(body.universityId || "").trim();
      const customUrl =
        typeof body.customUrl === "string" ? body.customUrl.trim() : "";
      const discoverSubpages =
        typeof body.discoverSubpages === "boolean" ? body.discoverSubpages : true;
      const rawUrls = Array.isArray(body.urls) ? body.urls : null;

      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(universityId)) {
        return res
          .status(400)
          .json({ error: "Select a valid configured university to collect." });
      }
      if (customUrl.length > 500) {
        return res
          .status(400)
          .json({ error: "Custom URL must be at most 500 characters." });
      }

      let urls: string[] | undefined;
      if (rawUrls !== null) {
        if (rawUrls.length > 12) {
          return res
            .status(400)
            .json({ error: "You can collect at most 12 official URLs per run." });
        }
        urls = [];
        for (const item of rawUrls) {
          if (typeof item !== "string") {
            return res
              .status(400)
              .json({ error: "Each URL must be a valid HTTPS string." });
          }
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (trimmed.length > 500) {
            return res
              .status(400)
              .json({ error: "Each URL must be at most 500 characters." });
          }
          urls.push(trimmed);
        }
        if (urls.length === 0 && !customUrl) {
          return res.status(400).json({
            error:
              "Select at least one configured page or paste an official HTTPS URL.",
          });
        }
      }

      const result = await collectUniversityPolite({
        universityId,
        urls,
        customUrl: customUrl || undefined,
        discoverSubpages,
      });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : "Could not complete polite collection.",
      });
    }
  },
);

adminRouter.post(
  "/api/admin/parse-import",
  createRateLimitMiddleware(importLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const rawSnapshot = body.snapshot ?? body;
      const result = parseCollectorJsonImport(rawSnapshot);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : "Could not parse the uploaded collector JSON snapshot.",
      });
    }
  },
);
