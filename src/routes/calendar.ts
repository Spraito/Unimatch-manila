/**
 * Student & public University Application Calendar, Saved Universities Admission
 * Dashboard, Application Status Tracking, and Reminder Notification API routes.
 *
 * Design guarantees:
 * - Integrates directly with the existing saved/bookmarked universities list
 *   (clients pass saved `university_ids` dynamically; unsaving a university
 *   immediately excludes its events without modifying central DB records).
 * - Centralized admission schedule reads are public; student status tracking
 *   and reminder mutations require an authenticated session (+ CSRF) or a
 *   verified Firebase Bearer ID token.
 * - Never exposes admin mutation capabilities from these routes.
 */
import express, { type Request, type Response } from "express";
import { getUser } from "../accounts.js";
import {
  ADMISSION_EVENT_TYPES,
  ADMISSION_EVENT_TYPE_LABELS,
  APPLICATION_STATUSES,
  AdmissionScheduleValidationError,
  REMINDER_CHANNELS,
  REMINDER_INTERVALS_DAYS,
  VERIFICATION_STATUSES,
  buildSavedUniversitiesDashboard,
  computeInAppNotifications,
  dismissUserNotification,
  getAdmissionEventById,
  getUserApplicationStatuses,
  getUserEventReminders,
  listAdmissionEvents,
  setUserApplicationStatus,
  setUserEventReminder,
  todayManilaIso,
} from "../admissionScheduleStore.js";
import { adminAuth } from "../lib/firebaseAdmin.js";
import { isCsrfValid } from "../security.js";
import {
  SlidingFixedWindowLimiter,
  createRateLimitMiddleware,
} from "../securityHardening.js";

export const calendarRouter = express.Router();

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const trackingWriteLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyPrefix: "student-tracking-write",
});

interface AuthenticatedTrackingActor {
  userId: string;
  source: "session" | "firebase";
}

async function resolveOptionalActor(
  req: Request,
): Promise<AuthenticatedTrackingActor | null> {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (!token || token.length > 8192) return null;
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      if (decoded.uid) {
        return { userId: `firebase:${decoded.uid}`, source: "firebase" };
      }
    } catch {
      return null;
    }
  }

  const sessionUserId = req.session?.userId;
  if (!sessionUserId) return null;
  const liveUser = getUser(sessionUserId);
  if (
    !liveUser ||
    !liveUser.is_active ||
    Number(req.session.sessionVersion ?? 0) !== liveUser.session_version
  ) {
    delete req.session.userId;
    delete req.session.sessionVersion;
    return null;
  }
  return { userId: liveUser.id, source: "session" };
}

function parseUniversityIdsParam(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return [];
  const parts = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const id of parts) {
    if (!VALID_ID_RE.test(id)) {
      throw new AdmissionScheduleValidationError(
        "Invalid university identifier in filter.",
        400,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
    if (clean.length >= 50) break;
  }
  return clean;
}

/**
 * Dedicated `/calendar` entry point — renders the main UniMatch PH explorer
 * shell with initial view pre-selected to `calendar` so the existing sidebar,
 * saved universities state, theme toggle, and auth header stay unified.
 */
calendarRouter.get("/calendar", (_req, res) => {
  res.render("index", { initialView: "calendar" });
});

/**
 * GET /api/admission-events
 * Dynamically retrieves centralized admission schedules from the database.
 * Supports filtering by:
 * - `university_ids` (comma-separated saved university IDs)
 * - `university_id` (single university ID)
 * - `event_type`
 * - `verification_status`
 * - `include_unverified` ("true" | "false", default "true")
 * - `include_expired` ("true" | "false", default "true")
 */
calendarRouter.get("/api/admission-events", (req: Request, res: Response) => {
  try {
    const today = todayManilaIso();
    const universityIds = parseUniversityIdsParam(req.query.university_ids);
    const universityId =
      typeof req.query.university_id === "string"
        ? req.query.university_id.trim()
        : "";
    if (universityId && !VALID_ID_RE.test(universityId)) {
      return res.status(400).json({ error: "Invalid university identifier." });
    }
    const eventType =
      typeof req.query.event_type === "string" ? req.query.event_type.trim() : "";
    const verificationStatus =
      typeof req.query.verification_status === "string"
        ? req.query.verification_status.trim()
        : "";
    const includeUnverified =
      String(req.query.include_unverified ?? "true").toLowerCase() !== "false";
    const includeExpired =
      String(req.query.include_expired ?? "true").toLowerCase() !== "false";

    const items = listAdmissionEvents({
      universityIds,
      universityId: universityId || undefined,
      eventType: eventType || undefined,
      verificationStatus: verificationStatus || undefined,
      includeUnverified,
      includeExpired,
      todayIso: today,
    });

    return res.json({
      today,
      items,
      total: items.length,
      confirmed_upcoming_count: items.filter((e) => e.is_upcoming).length,
      unverified_or_tba_count: items.filter(
        (e) => !e.is_confirmed && !e.is_expired,
      ).length,
      expired_count: items.filter((e) => e.is_expired).length,
      meta: {
        event_types: ADMISSION_EVENT_TYPES,
        event_type_labels: ADMISSION_EVENT_TYPE_LABELS,
        verification_statuses: VERIFICATION_STATUSES,
        application_statuses: APPLICATION_STATUSES,
        reminder_intervals_days: REMINDER_INTERVALS_DAYS,
        reminder_channels: REMINDER_CHANNELS,
      },
    });
  } catch (err) {
    if (err instanceof AdmissionScheduleValidationError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res
      .status(500)
      .json({ error: "Could not load university admission schedules." });
  }
});

/**
 * GET /api/admission-events/:eventId
 * Returns complete details for a single admission event plus its university's
 * official admissions URL and application period summary.
 */
calendarRouter.get(
  "/api/admission-events/:eventId",
  (req: Request, res: Response) => {
    const eventId = String(req.params.eventId || "").trim();
    if (!VALID_ID_RE.test(eventId)) {
      return res.status(400).json({ error: "Invalid event identifier." });
    }
    const event = getAdmissionEventById(eventId);
    if (!event) {
      return res.status(404).json({ error: "Admission event not found." });
    }
    return res.json({ event });
  },
);

/**
 * GET /api/saved-dashboard?university_ids=up-manila,dlsu-manila
 * Builds the enhanced Saved Universities Dashboard summaries and combined
 * calendar schedule for the student's currently saved universities.
 * Automatically enriches with persisted application statuses and active
 * in-app notifications when the student is signed in.
 */
calendarRouter.get(
  "/api/saved-dashboard",
  async (req: Request, res: Response) => {
    try {
      const today = todayManilaIso();
      const universityIds = parseUniversityIdsParam(req.query.university_ids) ?? [];
      const actor = await resolveOptionalActor(req);

      const userStatuses = actor
        ? getUserApplicationStatuses(actor.userId)
        : {};
      const reminders = actor ? getUserEventReminders(actor.userId) : {};
      const notifications = actor
        ? computeInAppNotifications(actor.userId, universityIds, today)
        : [];

      const universitiesSummary = buildSavedUniversitiesDashboard(
        universityIds,
        userStatuses,
        today,
      );
      const events = listAdmissionEvents({
        universityIds,
        includeUnverified: true,
        includeExpired: true,
        todayIso: today,
      });

      return res.json({
        today,
        authenticated: Boolean(actor),
        items: universitiesSummary,
        events,
        statuses: userStatuses,
        reminders,
        notifications,
        application_statuses: APPLICATION_STATUSES,
        reminder_intervals_days: REMINDER_INTERVALS_DAYS,
      });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not load saved universities admission data." });
    }
  },
);

/**
 * GET /api/tracking?saved_ids=up-manila,ust-manila
 * Returns the authenticated student's application statuses, event reminders,
 * and active in-app reminder notifications.
 */
calendarRouter.get("/api/tracking", async (req: Request, res: Response) => {
  try {
    const actor = await resolveOptionalActor(req);
    if (!actor) {
      return res.status(401).json({
        authenticated: false,
        error: "Sign in to sync application statuses and reminders across devices.",
      });
    }
    const savedIds = parseUniversityIdsParam(req.query.saved_ids) ?? [];
    const today = todayManilaIso();
    return res.json({
      authenticated: true,
      today,
      statuses: getUserApplicationStatuses(actor.userId),
      reminders: getUserEventReminders(actor.userId),
      notifications: computeInAppNotifications(actor.userId, savedIds, today),
      application_statuses: APPLICATION_STATUSES,
      reminder_intervals_days: REMINDER_INTERVALS_DAYS,
    });
  } catch (err) {
    if (err instanceof AdmissionScheduleValidationError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(500).json({ error: "Could not load tracking state." });
  }
});

/**
 * PUT /api/tracking/status/:universityId
 * Updates an authenticated student's application progress status for a saved
 * university without modifying central admission schedule data.
 */
calendarRouter.put(
  "/api/tracking/status/:universityId",
  createRateLimitMiddleware(trackingWriteLimiter),
  async (req: Request, res: Response) => {
    try {
      const actor = await resolveOptionalActor(req);
      if (!actor) {
        return res
          .status(401)
          .json({ error: "Sign in to save your application status." });
      }
      if (actor.source === "session" && !isCsrfValid(req)) {
        return res.status(403).json({
          error: "Security verification failed. Refresh the page and try again.",
        });
      }
      const universityId = String(req.params.universityId || "").trim();
      if (!VALID_ID_RE.test(universityId)) {
        return res.status(400).json({ error: "Invalid university identifier." });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const saved = await setUserApplicationStatus(
        actor.userId,
        universityId,
        body.status,
      );
      return res.json({
        status: saved.status,
        university_id: saved.university_id,
        updated_at: saved.updated_at,
      });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not update application status." });
    }
  },
);

/**
 * PUT /api/tracking/reminders/:eventId
 * Enables or disables reminders (7, 3, 1 days before event) for an individual
 * admission event and recomputes active in-app notifications.
 */
calendarRouter.put(
  "/api/tracking/reminders/:eventId",
  createRateLimitMiddleware(trackingWriteLimiter),
  async (req: Request, res: Response) => {
    try {
      const actor = await resolveOptionalActor(req);
      if (!actor) {
        return res
          .status(401)
          .json({ error: "Sign in to save event reminders." });
      }
      if (actor.source === "session" && !isCsrfValid(req)) {
        return res.status(403).json({
          error: "Security verification failed. Refresh the page and try again.",
        });
      }
      const eventId = String(req.params.eventId || "").trim();
      if (!VALID_ID_RE.test(eventId)) {
        return res.status(400).json({ error: "Invalid event identifier." });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const reminder = await setUserEventReminder(actor.userId, eventId, {
        enabled: body.enabled,
        intervals_days: body.intervals_days,
        channels: body.channels,
      });
      const savedIds = Array.isArray(body.saved_ids)
        ? body.saved_ids.map(String).filter((id) => VALID_ID_RE.test(id))
        : [];
      const notifications = savedIds.length
        ? computeInAppNotifications(actor.userId, savedIds)
        : [];
      return res.json({ reminder, notifications });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res.status(500).json({ error: "Could not save event reminder." });
    }
  },
);

/**
 * POST /api/tracking/notifications/dismiss
 * Dismisses a specific active in-app reminder notification key.
 */
calendarRouter.post(
  "/api/tracking/notifications/dismiss",
  createRateLimitMiddleware(trackingWriteLimiter),
  async (req: Request, res: Response) => {
    try {
      const actor = await resolveOptionalActor(req);
      if (!actor) {
        return res
          .status(401)
          .json({ error: "Sign in to manage reminder notifications." });
      }
      if (actor.source === "session" && !isCsrfValid(req)) {
        return res.status(403).json({
          error: "Security verification failed. Refresh the page and try again.",
        });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const eventId = String(body.event_id || "").trim();
      const notificationKey = String(body.notification_key || "").trim();
      if (!VALID_ID_RE.test(eventId) || !notificationKey) {
        return res
          .status(400)
          .json({ error: "Provide a valid event_id and notification_key." });
      }
      const updated = await dismissUserNotification(
        actor.userId,
        eventId,
        notificationKey,
      );
      const savedIds = Array.isArray(body.saved_ids)
        ? body.saved_ids.map(String).filter((id) => VALID_ID_RE.test(id))
        : [];
      const notifications = savedIds.length
        ? computeInAppNotifications(actor.userId, savedIds)
        : [];
      return res.json({ reminder: updated, notifications });
    } catch (err) {
      if (err instanceof AdmissionScheduleValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Could not dismiss reminder notification." });
    }
  },
);
