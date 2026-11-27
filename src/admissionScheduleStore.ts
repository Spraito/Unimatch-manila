/**
 * Centralized University Admission Schedule, Application Status Tracking,
 * and Reminder Notification store for UniMatch PH.
 *
 * Architectural guarantees:
 * - Single source of truth for centralized admission events linked to existing
 *   university IDs from `src/store.ts` (`universities` map).
 * - Student application statuses and event reminders are stored independently
 *   per student and NEVER mutate central university schedule records.
 * - Unsaving a university only removes it from the student's shortlist; central
 *   admission events are never deleted when a student unsaves a school.
 * - Strict data accuracy:
 *     * Only `verified` events with valid ISO dates are flagged `is_confirmed: true`.
 *     * Unannounced exam dates are stored with `verification_status: "tba"` and
 *       `start_date: null`, displayed as "To Be Announced" (never guessed/invented).
 *     * Expired schedules (`(end_date || start_date) < todayManilaIso`) are never
 *       returned as upcoming events or active reminder alerts.
 * - Write-through persistence to Neon PostgreSQL when configured, plus atomic
 *   local JSON fallback files for offline/local operation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  dbDeleteAdmissionEvent,
  dbLoadAdmissionEvents,
  dbLoadAllUserApplicationTracking,
  dbLoadAllUserEventReminders,
  dbUpsertAdmissionEvent,
  dbUpsertUserApplicationStatus,
  dbUpsertUserEventReminder,
  isPostgresSchemaReady,
  type PgAdmissionEventRow,
} from "./db/postgres.js";
import {
  ROOT,
  deadlinesByUniversity,
  examsByUniversity,
  linksByUniversity,
  safeUrl,
  universities,
  type UniversityRecord,
} from "./store.js";

export const ADMISSION_EVENT_TYPES = [
  "entrance_exam",
  "application_open",
  "application_deadline",
  "results_release",
  "enrollment",
  "other",
] as const;

export type AdmissionEventType = (typeof ADMISSION_EVENT_TYPES)[number];

export const ADMISSION_EVENT_TYPE_LABELS: Record<AdmissionEventType, string> = {
  entrance_exam: "Entrance Examination",
  application_open: "Application Opening",
  application_deadline: "Application Deadline",
  results_release: "Results Release",
  enrollment: "Enrollment & Confirmation",
  other: "Admission Event",
};

export const VERIFICATION_STATUSES = ["verified", "unverified", "tba"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  verified: "Verified",
  unverified: "Unverified",
  tba: "To Be Announced",
};

export const APPLICATION_STATUSES = [
  "Interested",
  "Application Ongoing",
  "Application Submitted",
  "Examination Scheduled",
  "Examination Completed",
  "Application Completed",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const REMINDER_INTERVALS_DAYS = [7, 3, 1] as const;
export type ReminderIntervalDays = (typeof REMINDER_INTERVALS_DAYS)[number];

export const REMINDER_CHANNELS = ["in_app", "email", "browser"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export interface AdmissionEvent {
  event_id: string;
  university_id: string;
  event_name: string;
  event_type: AdmissionEventType;
  start_date: string | null;
  end_date: string | null;
  exam_time: string | null;
  venue: string | null;
  official_source_url: string | null;
  description: string;
  verification_status: VerificationStatus;
  updated_by: string;
  created_at: string;
  last_updated_at: string;
}

export interface EnrichedAdmissionEvent extends AdmissionEvent {
  university_name: string;
  university_short_name: string;
  university_color: string;
  university_city: string;
  university_sector: string;
  official_admissions_url: string | null;
  event_type_label: string;
  verification_label: string;
  is_confirmed: boolean;
  is_expired: boolean;
  is_upcoming: boolean;
  days_until: number | null;
  display_date: string;
  application_period: {
    open_date: string | null;
    deadline_date: string | null;
    label: string | null;
  } | null;
}

export interface UserApplicationStatusRecord {
  user_id: string;
  university_id: string;
  status: ApplicationStatus;
  updated_at: string;
}

export interface UserEventReminderRecord {
  user_id: string;
  event_id: string;
  enabled: boolean;
  intervals_days: ReminderIntervalDays[];
  channels: ReminderChannel[];
  dismissed_keys: string[];
  updated_at: string;
}

export interface InAppNotification {
  notification_key: string;
  channel: ReminderChannel;
  event_id: string;
  university_id: string;
  university_name: string;
  university_short_name: string;
  event_name: string;
  event_type: AdmissionEventType;
  event_type_label: string;
  start_date: string;
  exam_time: string | null;
  venue: string | null;
  official_source_url: string | null;
  days_until: number;
  threshold_days: ReminderIntervalDays;
  title: string;
  message: string;
}

/**
 * Extensible notification channel adapter contract.
 * In-app delivery is implemented and evaluated today; future email or
 * browser-push adapters can register here without changing reminder storage.
 */
export interface NotificationDispatcher {
  channel: ReminderChannel;
  isAvailable(): boolean;
  prepare(notification: InAppNotification): InAppNotification;
}

export const notificationDispatchers: Record<
  ReminderChannel,
  NotificationDispatcher
> = {
  in_app: {
    channel: "in_app",
    isAvailable: () => true,
    prepare: (n) => ({ ...n, channel: "in_app" }),
  },
  email: {
    channel: "email",
    isAvailable: () => false,
    prepare: (n) => ({ ...n, channel: "email" }),
  },
  browser: {
    channel: "browser",
    isAvailable: () => false,
    prepare: (n) => ({ ...n, channel: "browser" }),
  },
};

export interface SavedUniversityDashboardItem {
  university_id: string;
  name: string;
  short_name: string;
  city: string;
  sector: string;
  color: string;
  official_admissions_url: string | null;
  application_status: ApplicationStatus;
  application_status_updated_at: string | null;
  next_upcoming_event: EnrichedAdmissionEvent | null;
  entrance_exam: {
    status: VerificationStatus;
    event_id: string | null;
    event_name: string | null;
    start_date: string | null;
    end_date: string | null;
    exam_time: string | null;
    venue: string | null;
    display_date: string;
    official_source_url: string | null;
  };
  application_deadline: {
    status: VerificationStatus;
    event_id: string | null;
    event_name: string | null;
    start_date: string | null;
    end_date: string | null;
    display_date: string;
    official_source_url: string | null;
  } | null;
  verified_upcoming_count: number;
  unverified_or_tba_count: number;
  total_events_count: number;
  events: EnrichedAdmissionEvent[];
}

export class AdmissionScheduleValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AdmissionScheduleValidationError";
    this.statusCode = statusCode;
  }
}

export interface UpsertAdmissionEventInput {
  university_id: unknown;
  event_name: unknown;
  event_type: unknown;
  start_date?: unknown;
  end_date?: unknown;
  exam_time?: unknown;
  venue?: unknown;
  official_source_url?: unknown;
  description?: unknown;
  verification_status?: unknown;
}

const DEFAULT_SCHEDULES_FILE = path.join(
  ROOT,
  "data",
  "admission_schedules.json",
);
const DEFAULT_TRACKING_FILE = path.join(ROOT, "data", "student_tracking.json");

let schedulesFilePath = DEFAULT_SCHEDULES_FILE;
let trackingFilePath = DEFAULT_TRACKING_FILE;
let persistenceDisabledForTests = false;

// Central admission events keyed by event_id
const admissionEvents = new Map<string, AdmissionEvent>();
// Student statuses keyed by `${userId}::${universityId}`
const applicationStatuses = new Map<string, UserApplicationStatusRecord>();
// Student event reminders keyed by `${userId}::${eventId}`
const eventReminders = new Map<string, UserEventReminderRecord>();

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function setAdmissionPersistenceForTests(options: {
  disabled?: boolean;
  schedulesFile?: string;
  trackingFile?: string;
}): void {
  if (typeof options.disabled === "boolean") {
    persistenceDisabledForTests = options.disabled;
  }
  if (options.schedulesFile) {
    schedulesFilePath = options.schedulesFile;
  }
  if (options.trackingFile) {
    trackingFilePath = options.trackingFile;
  }
}

export function resetAdmissionStoresForTests(): void {
  admissionEvents.clear();
  applicationStatuses.clear();
  eventReminders.clear();
}

/**
 * Returns today's calendar date (YYYY-MM-DD) in Asia/Manila (UTC+8).
 */
export function todayManilaIso(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

/**
 * Validates a strict YYYY-MM-DD date string against the actual Gregorian calendar.
 */
export function parseIsoDateStrict(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const match = ISO_DATE_RE.exec(trimmed);
  if (!match) {
    throw new AdmissionScheduleValidationError(
      `Invalid date "${trimmed}". Dates must use YYYY-MM-DD format.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AdmissionScheduleValidationError(
      `Date "${trimmed}" is outside the valid calendar range.`,
    );
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    throw new AdmissionScheduleValidationError(
      `Date "${trimmed}" is not a real calendar date.`,
    );
  }
  return trimmed;
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export function formatDisplayDate(
  startDate: string | null,
  endDate: string | null,
  verificationStatus: VerificationStatus,
): string {
  if (verificationStatus === "tba" || !startDate) {
    return "To Be Announced";
  }
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-PH", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  if (endDate && endDate !== startDate) {
    return `${fmt(startDate)} – ${fmt(endDate)}`;
  }
  return fmt(startDate);
}

function cleanOptionalText(
  value: unknown,
  maxLength: number,
  fieldLabel: string,
): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length > maxLength) {
    throw new AdmissionScheduleValidationError(
      `${fieldLabel} must be at most ${maxLength} characters.`,
    );
  }
  return cleaned;
}

function validateOfficialUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.length > 500) {
    throw new AdmissionScheduleValidationError(
      "Official source URL must be at most 500 characters.",
    );
  }
  const checked = safeUrl(raw);
  if (!checked) {
    throw new AdmissionScheduleValidationError(
      "Official source URL must be a valid https:// link.",
    );
  }
  return checked;
}

export function validateEventInput(
  input: UpsertAdmissionEventInput,
): Omit<
  AdmissionEvent,
  "event_id" | "updated_by" | "created_at" | "last_updated_at"
> {
  const universityId = String(input.university_id ?? "").trim();
  if (!universityId || !universities.has(universityId)) {
    throw new AdmissionScheduleValidationError(
      "Please select an existing university from the UniMatch PH catalog.",
    );
  }

  const eventName = String(input.event_name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (eventName.length < 3 || eventName.length > 160) {
    throw new AdmissionScheduleValidationError(
      "Event name must be between 3 and 160 characters.",
    );
  }

  const rawType = String(input.event_type ?? "").trim() as AdmissionEventType;
  if (!ADMISSION_EVENT_TYPES.includes(rawType)) {
    throw new AdmissionScheduleValidationError(
      `Event type must be one of: ${ADMISSION_EVENT_TYPES.join(", ")}.`,
    );
  }

  const rawVerification = String(
    input.verification_status ?? "unverified",
  ).trim() as VerificationStatus;
  if (!VERIFICATION_STATUSES.includes(rawVerification)) {
    throw new AdmissionScheduleValidationError(
      `Verification status must be one of: ${VERIFICATION_STATUSES.join(", ")}.`,
    );
  }

  let startDate = parseIsoDateStrict(input.start_date);
  let endDate = parseIsoDateStrict(input.end_date);

  if (rawVerification === "tba") {
    // Never carry speculative dates on TBA records
    startDate = null;
    endDate = null;
  } else if (rawVerification === "verified" && !startDate) {
    throw new AdmissionScheduleValidationError(
      "Verified events must include a valid start date (YYYY-MM-DD). Use 'To Be Announced' if no official date has been released.",
    );
  }

  if (endDate && !startDate) {
    throw new AdmissionScheduleValidationError(
      "An end date requires a start date.",
    );
  }
  if (startDate && endDate && endDate < startDate) {
    throw new AdmissionScheduleValidationError(
      "End date cannot be earlier than start date.",
    );
  }

  const examTime = cleanOptionalText(input.exam_time, 100, "Examination time");
  const venue = cleanOptionalText(input.venue, 240, "Venue");
  const officialSourceUrl = validateOfficialUrl(input.official_source_url);
  const description =
    cleanOptionalText(input.description, 1500, "Description / notes") || "";

  return {
    university_id: universityId,
    event_name: eventName,
    event_type: rawType,
    start_date: startDate,
    end_date: endDate,
    exam_time: examTime,
    venue,
    official_source_url: officialSourceUrl,
    description,
    verification_status: rawVerification,
  };
}

function officialAdmissionsUrlFor(school: UniversityRecord): string | null {
  const links = linksByUniversity.get(school.id) ?? [];
  for (const link of links) {
    const u = safeUrl(link.url);
    if (u) return u;
  }
  return safeUrl(school.official_url);
}

// --- Local JSON atomic persistence fallback ---

function writeAtomicJson(targetPath: string, payload: unknown): void {
  if (persistenceDisabledForTests) return;
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, targetPath);
}

function persistSchedulesLocal(): void {
  writeAtomicJson(schedulesFilePath, {
    version: 1,
    updated_at: new Date().toISOString(),
    events: Array.from(admissionEvents.values()),
  });
}

function persistTrackingLocal(): void {
  writeAtomicJson(trackingFilePath, {
    version: 1,
    updated_at: new Date().toISOString(),
    statuses: Array.from(applicationStatuses.values()),
    reminders: Array.from(eventReminders.values()),
  });
}

export function loadPersistedAdmissionDataLocal(): void {
  if (fs.existsSync(schedulesFilePath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(schedulesFilePath, "utf8"),
      ) as { events?: AdmissionEvent[] };
      if (Array.isArray(parsed.events)) {
        for (const ev of parsed.events) {
          if (ev && typeof ev.event_id === "string" && ev.university_id) {
            admissionEvents.set(ev.event_id, ev);
          }
        }
      }
    } catch (err) {
      console.error(
        "[admission-schedules] Could not parse local schedules JSON:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (fs.existsSync(trackingFilePath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(trackingFilePath, "utf8"),
      ) as {
        statuses?: UserApplicationStatusRecord[];
        reminders?: UserEventReminderRecord[];
      };
      if (Array.isArray(parsed.statuses)) {
        for (const s of parsed.statuses) {
          if (s && s.user_id && s.university_id && isValidApplicationStatus(s.status)) {
            applicationStatuses.set(`${s.user_id}::${s.university_id}`, s);
          }
        }
      }
      if (Array.isArray(parsed.reminders)) {
        for (const r of parsed.reminders) {
          if (r && r.user_id && r.event_id) {
            eventReminders.set(`${r.user_id}::${r.event_id}`, {
              user_id: r.user_id,
              event_id: r.event_id,
              enabled: Boolean(r.enabled),
              intervals_days: sanitizeIntervals(r.intervals_days),
              channels: sanitizeChannels(r.channels),
              dismissed_keys: Array.isArray(r.dismissed_keys)
                ? r.dismissed_keys.map(String).slice(0, 50)
                : [],
              updated_at: r.updated_at || new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.error(
        "[admission-schedules] Could not parse local tracking JSON:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function loadAdmissionDataFromPostgres(): Promise<void> {
  if (!isPostgresSchemaReady()) return;
  try {
    const pgEvents = await dbLoadAdmissionEvents();
    if (pgEvents.length > 0) {
      admissionEvents.clear();
      for (const row of pgEvents) {
        const type = ADMISSION_EVENT_TYPES.includes(
          row.event_type as AdmissionEventType,
        )
          ? (row.event_type as AdmissionEventType)
          : "other";
        admissionEvents.set(row.event_id, {
          ...row,
          event_type: type,
        });
      }
    } else if (admissionEvents.size > 0) {
      // Push truthful baseline TBA records to newly initialized DB
      for (const ev of admissionEvents.values()) {
        await dbUpsertAdmissionEvent(ev as PgAdmissionEventRow);
      }
    }

    const pgStatuses = await dbLoadAllUserApplicationTracking();
    for (const s of pgStatuses) {
      if (isValidApplicationStatus(s.status)) {
        applicationStatuses.set(`${s.user_id}::${s.university_id}`, {
          user_id: s.user_id,
          university_id: s.university_id,
          status: s.status,
          updated_at: s.updated_at,
        });
      }
    }

    const pgReminders = await dbLoadAllUserEventReminders();
    for (const r of pgReminders) {
      eventReminders.set(`${r.user_id}::${r.event_id}`, {
        user_id: r.user_id,
        event_id: r.event_id,
        enabled: Boolean(r.enabled),
        intervals_days: sanitizeIntervals(r.intervals_days),
        channels: sanitizeChannels(r.channels),
        dismissed_keys: Array.isArray(r.dismissed_keys)
          ? r.dismissed_keys.map(String).slice(0, 50)
          : [],
        updated_at: r.updated_at,
      });
    }
  } catch (err) {
    console.error(
      "[admission-schedules] PostgreSQL hydration error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Seeds truthful baseline admission entries from existing university catalog
 * records ONLY for universities that currently have zero events in the central
 * schedule store. NEVER invents or estimates exam dates — unannounced dates
 * are explicitly recorded with `verification_status: "tba"` and `start_date: null`.
 */
export function seedBaselineAdmissionEvents(): number {
  let added = 0;
  const nowIso = new Date().toISOString();
  const universitiesWithEvents = new Set(
    Array.from(admissionEvents.values()).map((e) => e.university_id),
  );

  for (const school of universities.values()) {
    if (universitiesWithEvents.has(school.id)) continue;

    const officialUrl = officialAdmissionsUrlFor(school);
    const exams = examsByUniversity.get(school.id) ?? [];
    const deadlines = deadlinesByUniversity.get(school.id) ?? [];
    const lastUpdated = school.last_verified_at || nowIso;

    // 1. Seed any real dated deadlines already present in the catalog
    for (const dl of deadlines) {
      let validIso: string | null = null;
      if (dl.date_iso) {
        try {
          validIso = parseIsoDateStrict(dl.date_iso);
        } catch {
          validIso = null;
        }
      }
      const eventId = `seed-${school.id}-dl-${crypto
        .createHash("sha256")
        .update(`${school.id}:${dl.label}:${dl.date_iso || ""}`)
        .digest("hex")
        .slice(0, 10)}`;
      if (admissionEvents.has(eventId)) continue;
      admissionEvents.set(eventId, {
        event_id: eventId,
        university_id: school.id,
        event_name: dl.label || `${school.short_name} Application Deadline`,
        event_type: "application_deadline",
        start_date: validIso,
        end_date: null,
        exam_time: null,
        venue: null,
        official_source_url: safeUrl(dl.source_url) || officialUrl,
        description: dl.raw_text || "",
        verification_status: validIso ? "unverified" : "tba",
        updated_by: "system-baseline",
        created_at: nowIso,
        last_updated_at: dl.last_verified_at || lastUpdated,
      });
      added += 1;
    }

    // 2. Seed entrance examination entry with "To Be Announced" (never guessed!)
    if (exams.length > 0) {
      const primaryExam = exams[0];
      const examLabel = primaryExam.exam_name
        ? `${primaryExam.exam_name} — Entrance Examination`
        : `${school.short_name} Entrance Examination`;
      const eventId = `seed-${school.id}-exam`;
      if (!admissionEvents.has(eventId)) {
        admissionEvents.set(eventId, {
          event_id: eventId,
          university_id: school.id,
          event_name: examLabel,
          event_type: "entrance_exam",
          start_date: null,
          end_date: null,
          exam_time: null,
          venue: school.campus_location || null,
          official_source_url: safeUrl(primaryExam.source_url) || officialUrl,
          description: primaryExam.coverage
            ? `${primaryExam.coverage} Official examination dates have not yet been published in UniMatch PH — verify updates directly on the university admissions portal.`
            : `Official examination dates for ${school.name} are To Be Announced. Verify directly on the university's official admissions portal.`,
          verification_status: "tba",
          updated_by: "system-baseline",
          created_at: nowIso,
          last_updated_at: primaryExam.last_verified_at || lastUpdated,
        });
        added += 1;
      }
    } else {
      const eventId = `seed-${school.id}-admissions`;
      if (!admissionEvents.has(eventId)) {
        admissionEvents.set(eventId, {
          event_id: eventId,
          university_id: school.id,
          event_name: `${school.short_name} Freshman Admissions & Screening`,
          event_type: "application_open",
          start_date: null,
          end_date: null,
          exam_time: null,
          venue: school.campus_location || null,
          official_source_url: officialUrl,
          description: `Official application and examination schedule dates for ${school.name} are To Be Announced. Check the official admissions page for the latest intake advisory.`,
          verification_status: "tba",
          updated_by: "system-baseline",
          created_at: nowIso,
          last_updated_at: lastUpdated,
        });
        added += 1;
      }
    }
  }

  if (added > 0) {
    persistSchedulesLocal();
  }
  return added;
}

// --- Enrichment & Query Helpers ---

function computeApplicationPeriodForUniversity(
  universityId: string,
  todayIso: string,
): { open_date: string | null; deadline_date: string | null; label: string | null } | null {
  const uniEvents = Array.from(admissionEvents.values()).filter(
    (e) =>
      e.university_id === universityId &&
      e.verification_status === "verified" &&
      e.start_date !== null,
  );

  const openEv = uniEvents
    .filter((e) => e.event_type === "application_open")
    .sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""))[0];

  const deadlineEv = uniEvents
    .filter(
      (e) =>
        e.event_type === "application_deadline" &&
        (e.end_date || e.start_date || "") >= todayIso,
    )
    .sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""))[0] ||
    uniEvents
      .filter((e) => e.event_type === "application_deadline")
      .sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""))[0];

  if (!openEv && !deadlineEv) return null;

  const openDate = openEv?.start_date || null;
  const deadlineDate = deadlineEv?.end_date || deadlineEv?.start_date || null;
  let label: string | null = null;
  if (openDate && deadlineDate) {
    label = `${formatDisplayDate(openDate, null, "verified")} – ${formatDisplayDate(deadlineDate, null, "verified")}`;
  } else if (openDate) {
    label = `Opens ${formatDisplayDate(openDate, null, "verified")}`;
  } else if (deadlineDate) {
    label = `Closes ${formatDisplayDate(deadlineDate, null, "verified")}`;
  }
  return { open_date: openDate, deadline_date: deadlineDate, label };
}

export function enrichAdmissionEvent(
  event: AdmissionEvent,
  todayIso: string = todayManilaIso(),
): EnrichedAdmissionEvent {
  const school = universities.get(event.university_id);
  const officialAdmissionsUrl = school ? officialAdmissionsUrlFor(school) : null;
  const effectiveEnd = event.end_date || event.start_date;
  const isConfirmed =
    event.verification_status === "verified" && Boolean(event.start_date);
  const isExpired = Boolean(effectiveEnd && effectiveEnd < todayIso);
  const isUpcoming = isConfirmed && !isExpired;
  const daysUntil = event.start_date
    ? daysBetweenIso(todayIso, event.start_date)
    : null;

  return {
    ...event,
    university_name: school?.name || event.university_id,
    university_short_name: school?.short_name || event.university_id,
    university_color: school?.color || "green",
    university_city: school?.city || "Manila",
    university_sector: school?.sector || "Not specified",
    official_admissions_url: officialAdmissionsUrl,
    event_type_label:
      ADMISSION_EVENT_TYPE_LABELS[event.event_type] || "Admission Event",
    verification_label:
      VERIFICATION_STATUS_LABELS[event.verification_status] || "Unverified",
    is_confirmed: isConfirmed,
    is_expired: isExpired,
    is_upcoming: isUpcoming,
    days_until: daysUntil,
    display_date: formatDisplayDate(
      event.start_date,
      event.end_date,
      event.verification_status,
    ),
    application_period: computeApplicationPeriodForUniversity(
      event.university_id,
      todayIso,
    ),
  };
}

export interface ListAdmissionEventsFilter {
  universityIds?: string[];
  universityId?: string;
  eventType?: string;
  verificationStatus?: string;
  includeUnverified?: boolean;
  includeExpired?: boolean;
  todayIso?: string;
}

export function listAdmissionEvents(
  filter: ListAdmissionEventsFilter = {},
): EnrichedAdmissionEvent[] {
  const todayIso = filter.todayIso || todayManilaIso();
  const idSet =
    filter.universityIds !== undefined
      ? new Set(filter.universityIds.map((s) => s.trim()).filter(Boolean))
      : null;

  const includeUnverified = filter.includeUnverified !== false;
  const includeExpired = filter.includeExpired !== false;

  const enriched: EnrichedAdmissionEvent[] = [];
  for (const ev of admissionEvents.values()) {
    if (filter.universityId && ev.university_id !== filter.universityId) {
      continue;
    }
    if (idSet !== null && !idSet.has(ev.university_id)) {
      continue;
    }
    if (filter.eventType && ev.event_type !== filter.eventType) {
      continue;
    }
    if (
      filter.verificationStatus &&
      ev.verification_status !== filter.verificationStatus
    ) {
      continue;
    }
    const item = enrichAdmissionEvent(ev, todayIso);
    if (!includeUnverified && !item.is_confirmed) {
      continue;
    }
    if (!includeExpired && item.is_expired) {
      continue;
    }
    enriched.push(item);
  }

  enriched.sort((a, b) => {
    // Verified upcoming first, then dated events, then TBA, then expired
    if (a.is_upcoming !== b.is_upcoming) return a.is_upcoming ? -1 : 1;
    if (a.is_expired !== b.is_expired) return a.is_expired ? 1 : -1;
    if (a.start_date && b.start_date && a.start_date !== b.start_date) {
      return a.start_date.localeCompare(b.start_date);
    }
    if (a.start_date && !b.start_date) return -1;
    if (!a.start_date && b.start_date) return 1;
    return (
      a.university_name.localeCompare(b.university_name) ||
      a.event_name.localeCompare(b.event_name)
    );
  });

  return enriched;
}

export function getAdmissionEventById(
  eventId: string,
  todayIso: string = todayManilaIso(),
): EnrichedAdmissionEvent | null {
  const ev = admissionEvents.get(eventId);
  if (!ev) return null;
  return enrichAdmissionEvent(ev, todayIso);
}

// --- Admin CRUD for Centralized Admission Schedules ---

export async function createAdmissionEvent(
  input: UpsertAdmissionEventInput,
  actorEmail: string,
): Promise<EnrichedAdmissionEvent> {
  const validated = validateEventInput(input);
  const nowIso = new Date().toISOString();
  const eventId = `evt_${crypto.randomBytes(6).toString("hex")}`;

  const record: AdmissionEvent = {
    event_id: eventId,
    ...validated,
    updated_by: actorEmail || "admin",
    created_at: nowIso,
    last_updated_at: nowIso,
  };

  admissionEvents.set(eventId, record);
  persistSchedulesLocal();
  await dbUpsertAdmissionEvent(record as PgAdmissionEventRow);
  return enrichAdmissionEvent(record);
}

export async function updateAdmissionEvent(
  eventId: string,
  input: UpsertAdmissionEventInput,
  actorEmail: string,
): Promise<EnrichedAdmissionEvent> {
  const existing = admissionEvents.get(eventId);
  if (!existing) {
    throw new AdmissionScheduleValidationError(
      "Admission event not found.",
      404,
    );
  }
  const validated = validateEventInput(input);
  const nowIso = new Date().toISOString();

  const updated: AdmissionEvent = {
    event_id: existing.event_id,
    ...validated,
    updated_by: actorEmail || "admin",
    created_at: existing.created_at,
    last_updated_at: nowIso,
  };

  admissionEvents.set(eventId, updated);
  persistSchedulesLocal();
  await dbUpsertAdmissionEvent(updated as PgAdmissionEventRow);
  return enrichAdmissionEvent(updated);
}

export async function deleteAdmissionEvent(eventId: string): Promise<boolean> {
  if (!admissionEvents.has(eventId)) return false;
  admissionEvents.delete(eventId);

  // Clean up orphaned student reminders for this deleted central event
  let remindersChanged = false;
  for (const [key, rem] of eventReminders.entries()) {
    if (rem.event_id === eventId) {
      eventReminders.delete(key);
      remindersChanged = true;
    }
  }

  persistSchedulesLocal();
  if (remindersChanged) {
    persistTrackingLocal();
  }
  await dbDeleteAdmissionEvent(eventId);
  return true;
}

// --- Student Application Status Tracking (separate from central schedule) ---

export function isValidApplicationStatus(
  value: unknown,
): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

export function getUserApplicationStatuses(
  userId: string,
): Record<string, { status: ApplicationStatus; updated_at: string }> {
  const result: Record<string, { status: ApplicationStatus; updated_at: string }> =
    {};
  const prefix = `${userId}::`;
  for (const [key, rec] of applicationStatuses.entries()) {
    if (!key.startsWith(prefix)) continue;
    result[rec.university_id] = {
      status: rec.status,
      updated_at: rec.updated_at,
    };
  }
  return result;
}

export async function setUserApplicationStatus(
  userId: string,
  universityId: string,
  status: unknown,
): Promise<UserApplicationStatusRecord> {
  if (!universities.has(universityId)) {
    throw new AdmissionScheduleValidationError(
      "University not found in UniMatch PH catalog.",
      404,
    );
  }
  if (!isValidApplicationStatus(status)) {
    throw new AdmissionScheduleValidationError(
      `Application status must be one of: ${APPLICATION_STATUSES.join(", ")}.`,
    );
  }
  const nowIso = new Date().toISOString();
  const rec: UserApplicationStatusRecord = {
    user_id: userId,
    university_id: universityId,
    status,
    updated_at: nowIso,
  };
  applicationStatuses.set(`${userId}::${universityId}`, rec);
  persistTrackingLocal();
  await dbUpsertUserApplicationStatus(userId, universityId, status, nowIso);
  return rec;
}

// --- Student Event Reminders & In-App Notification Engine ---

export function sanitizeIntervals(value: unknown): ReminderIntervalDays[] {
  if (!Array.isArray(value)) return [7, 3, 1];
  const valid = new Set<ReminderIntervalDays>();
  for (const item of value) {
    const n = Number(item);
    if (n === 7 || n === 3 || n === 1) {
      valid.add(n);
    }
  }
  const sorted = Array.from(valid).sort((a, b) => b - a);
  return sorted.length > 0 ? sorted : [7, 3, 1];
}

export function sanitizeChannels(value: unknown): ReminderChannel[] {
  if (!Array.isArray(value)) return ["in_app"];
  const out = new Set<ReminderChannel>(["in_app"]);
  for (const item of value) {
    if (item === "in_app" || item === "email" || item === "browser") {
      out.add(item);
    }
  }
  return Array.from(out);
}

export function getUserEventReminders(
  userId: string,
): Record<string, UserEventReminderRecord> {
  const result: Record<string, UserEventReminderRecord> = {};
  const prefix = `${userId}::`;
  for (const [key, rec] of eventReminders.entries()) {
    if (!key.startsWith(prefix)) continue;
    // Only expose reminders for events that still exist centrally
    if (!admissionEvents.has(rec.event_id)) continue;
    result[rec.event_id] = rec;
  }
  return result;
}

export async function setUserEventReminder(
  userId: string,
  eventId: string,
  input: {
    enabled: unknown;
    intervals_days?: unknown;
    channels?: unknown;
  },
): Promise<UserEventReminderRecord> {
  if (!admissionEvents.has(eventId)) {
    throw new AdmissionScheduleValidationError(
      "Admission event not found.",
      404,
    );
  }
  const enabled = Boolean(input.enabled);
  const intervals: ReminderIntervalDays[] =
    input.intervals_days !== undefined
      ? sanitizeIntervals(input.intervals_days)
      : [7, 3, 1];
  const channels: ReminderChannel[] =
    input.channels !== undefined ? sanitizeChannels(input.channels) : ["in_app"];

  const existing = eventReminders.get(`${userId}::${eventId}`);
  const nowIso = new Date().toISOString();
  const record: UserEventReminderRecord = {
    user_id: userId,
    event_id: eventId,
    enabled,
    intervals_days: intervals,
    channels,
    dismissed_keys: existing?.dismissed_keys ?? [],
    updated_at: nowIso,
  };

  eventReminders.set(`${userId}::${eventId}`, record);
  persistTrackingLocal();
  await dbUpsertUserEventReminder(record);
  return record;
}

export async function dismissUserNotification(
  userId: string,
  eventId: string,
  notificationKey: string,
): Promise<UserEventReminderRecord | null> {
  const key = `${userId}::${eventId}`;
  const existing = eventReminders.get(key);
  if (!existing) return null;
  const cleanNotifKey = String(notificationKey || "").trim().slice(0, 120);
  if (!cleanNotifKey) return existing;

  const set = new Set(existing.dismissed_keys);
  set.add(cleanNotifKey);
  const updated: UserEventReminderRecord = {
    ...existing,
    dismissed_keys: Array.from(set).slice(-50),
    updated_at: new Date().toISOString(),
  };
  eventReminders.set(key, updated);
  persistTrackingLocal();
  await dbUpsertUserEventReminder(updated);
  return updated;
}

/**
 * Evaluates active due in-app reminder notifications for a student's saved
 * universities.
 *
 * Rules:
 * - Only evaluates events for universities currently in `savedUniversityIds`.
 * - Only fires for `verified` events with a valid `start_date` where
 *   `0 <= daysUntil <= max(enabled intervals)` (never expired, never unverified/TBA).
 * - Notification key includes `start_date` so if an admin updates an exam date,
 *   the student receives an updated alert automatically.
 */
export function computeInAppNotifications(
  userId: string,
  savedUniversityIds: string[],
  todayIso: string = todayManilaIso(),
): InAppNotification[] {
  const savedSet = new Set(savedUniversityIds.map((s) => s.trim()).filter(Boolean));
  if (savedSet.size === 0) return [];

  const reminders = getUserEventReminders(userId);
  return evaluateRemindersAgainstEvents(reminders, savedSet, todayIso);
}

export function evaluateRemindersAgainstEvents(
  remindersByEventId: Record<
    string,
    Pick<
      UserEventReminderRecord,
      "event_id" | "enabled" | "intervals_days" | "dismissed_keys"
    >
  >,
  savedUniversityIdSet: Set<string>,
  todayIso: string = todayManilaIso(),
): InAppNotification[] {
  const notifications: InAppNotification[] = [];

  for (const rem of Object.values(remindersByEventId)) {
    if (!rem.enabled) continue;
    const rawEvent = admissionEvents.get(rem.event_id);
    if (!rawEvent) continue;
    if (!savedUniversityIdSet.has(rawEvent.university_id)) continue;

    const event = enrichAdmissionEvent(rawEvent, todayIso);
    // Strict accuracy: never trigger reminders for unverified, TBA, or expired events
    if (!event.is_confirmed || !event.start_date || event.days_until === null) {
      continue;
    }
    if (event.days_until < 0) {
      continue;
    }

    const intervals = sanitizeIntervals(rem.intervals_days);
    // Find the tightest matching threshold >= days_until
    const sortedAsc = [...intervals].sort((a, b) => a - b);
    const matchedThreshold = sortedAsc.find(
      (threshold) => event.days_until! <= threshold,
    );
    if (!matchedThreshold) continue;

    const notifKey = `${event.event_id}:${matchedThreshold}d:${event.start_date}`;
    if (rem.dismissed_keys.includes(notifKey)) continue;

    const timingPhrase =
      event.days_until === 0
        ? "is today"
        : event.days_until === 1
          ? "is tomorrow (1 day away)"
          : `is in ${event.days_until} days`;

    const baseNotification: InAppNotification = {
      notification_key: notifKey,
      channel: "in_app",
      event_id: event.event_id,
      university_id: event.university_id,
      university_name: event.university_name,
      university_short_name: event.university_short_name,
      event_name: event.event_name,
      event_type: event.event_type,
      event_type_label: event.event_type_label,
      start_date: event.start_date,
      exam_time: event.exam_time,
      venue: event.venue,
      official_source_url:
        event.official_source_url || event.official_admissions_url,
      days_until: event.days_until,
      threshold_days: matchedThreshold,
      title: `${event.university_short_name}: ${event.event_name}`,
      message: `${event.event_name} at ${event.university_name} ${timingPhrase} (${event.display_date}).`,
    };

    notifications.push(notificationDispatchers.in_app.prepare(baseNotification));
  }

  notifications.sort(
    (a, b) =>
      a.days_until - b.days_until ||
      a.start_date.localeCompare(b.start_date) ||
      a.university_name.localeCompare(b.university_name),
  );
  return notifications;
}

// --- Saved Universities Dashboard Builder ---

export function buildSavedUniversitiesDashboard(
  savedUniversityIds: string[],
  userStatuses: Record<
    string,
    { status: ApplicationStatus; updated_at?: string | null }
  > = {},
  todayIso: string = todayManilaIso(),
): SavedUniversityDashboardItem[] {
  const items: SavedUniversityDashboardItem[] = [];
  const seen = new Set<string>();

  for (const rawId of savedUniversityIds) {
    const uid = String(rawId || "").trim();
    if (!uid || seen.has(uid)) continue;
    const school = universities.get(uid);
    if (!school) continue;
    seen.add(uid);

    const events = listAdmissionEvents({
      universityId: uid,
      includeUnverified: true,
      includeExpired: true,
      todayIso,
    });

    const upcomingVerified = events.filter((e) => e.is_upcoming);
    const nextUpcoming = upcomingVerified[0] || null;

    // Entrance examination summary: prefer upcoming verified exam, otherwise TBA / unverified
    const verifiedUpcomingExam = upcomingVerified.find(
      (e) => e.event_type === "entrance_exam",
    );
    const anyExam =
      verifiedUpcomingExam ||
      events.find(
        (e) => e.event_type === "entrance_exam" && !e.is_expired,
      ) ||
      events.find((e) => e.event_type === "entrance_exam") ||
      null;

    const entranceExamSummary = verifiedUpcomingExam
      ? {
          status: "verified" as VerificationStatus,
          event_id: verifiedUpcomingExam.event_id,
          event_name: verifiedUpcomingExam.event_name,
          start_date: verifiedUpcomingExam.start_date,
          end_date: verifiedUpcomingExam.end_date,
          exam_time: verifiedUpcomingExam.exam_time,
          venue: verifiedUpcomingExam.venue,
          display_date: verifiedUpcomingExam.display_date,
          official_source_url:
            verifiedUpcomingExam.official_source_url ||
            officialAdmissionsUrlFor(school),
        }
      : {
          status: (anyExam?.verification_status === "unverified"
            ? "unverified"
            : "tba") as VerificationStatus,
          event_id: anyExam?.event_id || null,
          event_name: anyExam?.event_name || `${school.short_name} Entrance Examination`,
          start_date:
            anyExam && !anyExam.is_expired && anyExam.verification_status === "unverified"
              ? anyExam.start_date
              : null,
          end_date:
            anyExam && !anyExam.is_expired && anyExam.verification_status === "unverified"
              ? anyExam.end_date
              : null,
          exam_time: anyExam?.exam_time || null,
          venue: anyExam?.venue || null,
          display_date:
            anyExam &&
            !anyExam.is_expired &&
            anyExam.verification_status === "unverified" &&
            anyExam.start_date
              ? `${anyExam.display_date} (Unverified)`
              : "To Be Announced",
          official_source_url:
            anyExam?.official_source_url || officialAdmissionsUrlFor(school),
        };

    // Application deadline summary: strictly upcoming verified deadline (or unverified upcoming if clearly marked)
    const verifiedUpcomingDeadline = upcomingVerified.find(
      (e) => e.event_type === "application_deadline",
    );
    const unverifiedUpcomingDeadline = !verifiedUpcomingDeadline
      ? events.find(
          (e) =>
            e.event_type === "application_deadline" &&
            !e.is_expired &&
            e.verification_status === "unverified" &&
            Boolean(e.start_date),
        )
      : null;

    const deadlineTarget = verifiedUpcomingDeadline || unverifiedUpcomingDeadline;
    const deadlineSummary = deadlineTarget
      ? {
          status: deadlineTarget.verification_status,
          event_id: deadlineTarget.event_id,
          event_name: deadlineTarget.event_name,
          start_date: deadlineTarget.start_date,
          end_date: deadlineTarget.end_date,
          display_date:
            deadlineTarget.verification_status === "verified"
              ? deadlineTarget.display_date
              : `${deadlineTarget.display_date} (Unverified)`,
          official_source_url:
            deadlineTarget.official_source_url || officialAdmissionsUrlFor(school),
        }
      : null;

    const statusEntry = userStatuses[uid];
    const appStatus: ApplicationStatus =
      statusEntry && isValidApplicationStatus(statusEntry.status)
        ? statusEntry.status
        : "Interested";

    items.push({
      university_id: school.id,
      name: school.name,
      short_name: school.short_name,
      city: school.city,
      sector: school.sector,
      color: school.color,
      official_admissions_url: officialAdmissionsUrlFor(school),
      application_status: appStatus,
      application_status_updated_at: statusEntry?.updated_at ?? null,
      next_upcoming_event: nextUpcoming,
      entrance_exam: entranceExamSummary,
      application_deadline: deadlineSummary,
      verified_upcoming_count: upcomingVerified.length,
      unverified_or_tba_count: events.filter((e) => !e.is_confirmed && !e.is_expired)
        .length,
      total_events_count: events.length,
      events,
    });
  }

  return items;
}
