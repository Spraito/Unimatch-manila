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
  ADMISSION_EVENT_TYPES,
  ADMISSION_EVENT_TYPE_LABELS,
  AdmissionScheduleValidationError,
  VERIFICATION_STATUSES,
  createAdmissionEvent,
  deleteAdmissionEvent,
  listAdmissionEvents,
  todayManilaIso,
  updateAdmissionEvent,
} from "../admissionScheduleStore.js";
import {
  AdminAccountError,
  createAdminAccount,
  isActiveAdminUser,
  listAdminAccounts,
  removeAdminAccount,
  type AdminActor,
} from "../adminAccounts.js";
import { universities } from "../store.js";
import {
  CatalogValidationError,
  buildAdminDashboardSummary,
  deleteAdminCatalogUniversity,
  listAdminCatalogRuns,
  listAdminCatalogUniversities,
  saveAdminCatalogUniversity,
  seedBaselineCatalogUniversities,
  type SaveCatalogAuditOptions,
} from "../catalogStore.js";
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

const catalogWriteLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  keyPrefix: "admin-catalog-write",
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

adminRouter.get("/admin/dashboard", (req, res) => {
  const sessionUser = res.locals.currentUser;
  if (sessionUser && !isActiveAdminUser(sessionUser)) {
    return res.status(403).render("admin_dashboard", {
      title: "Access restricted",
      error: null,
      flashes: consumeFlashes(req),
      sessionAccessDenied: true,
      isSessionAdmin: false,
      sessionAdmin: null,
    });
  }
  const sessionAdmin = resolveSessionAdminActor(req);
  return res.render("admin_dashboard", {
    title: "Admin dashboard",
    error: null,
    flashes: consumeFlashes(req),
    sessionAccessDenied: false,
    isSessionAdmin: Boolean(sessionAdmin),
    sessionAdmin,
  });
});

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

// --- Admin Dashboard & Unified Catalog Management APIs ---

adminRouter.get(
  "/api/admin/dashboard",
  requireAdmin,
  (req: AdminRequest, res: Response) => {
    try {
      return res.json(buildAdminDashboardSummary(req.adminActor!));
    } catch (err) {
      console.error("[admin] Failed to build admin dashboard summary:", err);
      return res
        .status(500)
        .json({ error: "Could not load administrator dashboard summary." });
    }
  },
);

adminRouter.get(
  "/api/admin/catalog",
  requireAdmin,
  (req: AdminRequest, res: Response) => {
    try {
      return res.json({
        universities: listAdminCatalogUniversities(),
        runs: listAdminCatalogRuns(30),
        collector: getCollectorConfig(),
        actor: {
          email: req.adminActor!.email,
          displayName: req.adminActor!.displayName,
          source: req.adminActor!.source,
        },
      });
    } catch (err) {
      console.error("[admin] Failed to load admin catalog:", err);
      return res
        .status(500)
        .json({ error: "Could not load the university catalog." });
    }
  },
);

adminRouter.put(
  "/api/admin/catalog/:universityId",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const paramId = String(req.params.universityId || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(paramId)) {
        return res.status(400).json({
          error:
            "University slug ID must be 2–128 lowercase letters, numbers, hyphens, or underscores.",
        });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const rawUniversity =
        body.university && typeof body.university === "object"
          ? (body.university as Record<string, unknown>)
          : body;
      const auditInput =
        body.audit && typeof body.audit === "object"
          ? (body.audit as SaveCatalogAuditOptions)
          : undefined;

      const result = await saveAdminCatalogUniversity(
        { ...rawUniversity, id: paramId },
        req.adminActor!,
        auditInput,
      );
      return res.json(result);
    } catch (err) {
      if (err instanceof CatalogValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error("[admin] Failed to save catalog university:", err);
      return res
        .status(500)
        .json({ error: "Could not save university catalog changes." });
    }
  },
);

adminRouter.delete(
  "/api/admin/catalog/:universityId",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const paramId = String(req.params.universityId || "").trim().toLowerCase();
      const result = await deleteAdminCatalogUniversity(paramId, req.adminActor!);
      return res.json(result);
    } catch (err) {
      if (err instanceof CatalogValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error("[admin] Failed to delete catalog university:", err);
      return res
        .status(500)
        .json({ error: "Could not delete university from catalog." });
    }
  },
);

adminRouter.post(
  "/api/admin/catalog/seed",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const overwrite = Boolean(body.overwrite);
      const result = await seedBaselineCatalogUniversities(
        overwrite,
        req.adminActor!,
      );
      return res.json(result);
    } catch (err) {
      console.error("[admin] Failed to seed baseline catalog:", err);
      return res
        .status(500)
        .json({ error: "Could not seed baseline universities." });
    }
  },
);

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

// --- Administrator Admission Schedule Management ---

adminRouter.get("/admin/schedules", (req: Request, res: Response) => {
  const sessionUser = res.locals.currentUser;
  if (sessionUser && !isActiveAdminUser(sessionUser)) {
    return res.status(403).render("admin_schedules", {
      title: "Access restricted",
      error: null,
      flashes: consumeFlashes(req),
      sessionAccessDenied: true,
      isSessionAdmin: false,
      sessionAdmin: null,
    });
  }
  const sessionAdmin = resolveSessionAdminActor(req);
  return res.render("admin_schedules", {
    title: "Admission schedules",
    error: null,
    flashes: consumeFlashes(req),
    sessionAccessDenied: false,
    isSessionAdmin: Boolean(sessionAdmin),
    sessionAdmin,
  });
});

adminRouter.get(
  "/api/admin/admission-events",
  requireAdmin,
  (req: AdminRequest, res: Response) => {
    const today = todayManilaIso();
    const universityId =
      typeof req.query.university_id === "string"
        ? req.query.university_id.trim()
        : "";
    const eventType =
      typeof req.query.event_type === "string" ? req.query.event_type.trim() : "";
    const verificationStatus =
      typeof req.query.verification_status === "string"
        ? req.query.verification_status.trim()
        : "";

    const items = listAdmissionEvents({
      universityId: universityId || undefined,
      eventType: eventType || undefined,
      verificationStatus: verificationStatus || undefined,
      includeUnverified: true,
      includeExpired: true,
      todayIso: today,
    });

    const allEvents = listAdmissionEvents({
      includeUnverified: true,
      includeExpired: true,
      todayIso: today,
    });

    const universityOptions = Array.from(universities.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({
        id: u.id,
        name: u.name,
        short_name: u.short_name,
        official_url: u.official_url,
      }));

    return res.json({
      actor: req.adminActor
        ? {
            email: req.adminActor.email,
            displayName: req.adminActor.displayName,
            source: req.adminActor.source,
          }
        : null,
      today,
      items,
      total: items.length,
      summary: {
        total: allEvents.length,
        verified_upcoming: allEvents.filter((e) => e.is_upcoming).length,
        unverified_or_tba: allEvents.filter(
          (e) => !e.is_confirmed && !e.is_expired,
        ).length,
        expired: allEvents.filter((e) => e.is_expired).length,
      },
      universities: universityOptions,
      event_types: ADMISSION_EVENT_TYPES,
      event_type_labels: ADMISSION_EVENT_TYPE_LABELS,
      verification_statuses: VERIFICATION_STATUSES,
    });
  },
);

adminRouter.post(
  "/api/admin/admission-events",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const actorEmail = req.adminActor?.email || "admin";
      const created = await createAdmissionEvent(
        {
          university_id: body.university_id,
          event_name: body.event_name,
          event_type: body.event_type,
          academic_year: body.academic_year,
          start_date: body.start_date,
          end_date: body.end_date,
          exam_time: body.exam_time,
          venue: body.venue,
          official_source_url: body.official_source_url,
          description: body.description,
          verification_status: body.verification_status,
        },
        actorEmail,
      );
      return res.status(201).json({ event: created });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not create admission event." });
    }
  },
);

adminRouter.put(
  "/api/admin/admission-events/:eventId",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const eventId = String(req.params.eventId || "").trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(eventId)) {
        return res.status(400).json({ error: "Invalid event identifier." });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const actorEmail = req.adminActor?.email || "admin";
      const updated = await updateAdmissionEvent(
        eventId,
        {
          university_id: body.university_id,
          event_name: body.event_name,
          event_type: body.event_type,
          academic_year: body.academic_year,
          start_date: body.start_date,
          end_date: body.end_date,
          exam_time: body.exam_time,
          venue: body.venue,
          official_source_url: body.official_source_url,
          description: body.description,
          verification_status: body.verification_status,
        },
        actorEmail,
      );
      return res.json({ event: updated });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not update admission event." });
    }
  },
);

adminRouter.delete(
  "/api/admin/admission-events/:eventId",
  createRateLimitMiddleware(catalogWriteLimiter),
  requireAdmin,
  requireCsrfForSessionAdmin,
  async (req: AdminRequest, res: Response) => {
    try {
      const eventId = String(req.params.eventId || "").trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(eventId)) {
        return res.status(400).json({ error: "Invalid event identifier." });
      }
      const removed = await deleteAdmissionEvent(eventId);
      if (!removed) {
        return res.status(404).json({ error: "Admission event not found." });
      }
      return res.json({ deleted: true, event_id: eventId });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not delete admission event." });
    }
  },
);

