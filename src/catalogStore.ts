/**
 * Server-side Catalog Store, Sanitizer, Audit Trail & Dashboard Aggregator.
 *
 * Enables BOTH local password-authenticated administrators (Express session + CSRF)
 * and Firebase Google administrators (verified Bearer ID token) to manage the
 * university catalog securely, while persisting changes to Neon PostgreSQL
 * (with atomic local JSON fallback) and updating the live public explorer store
 * immediately.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdminActor } from "./adminAccounts.js";
import { listAdminAccounts } from "./adminAccounts.js";
import { exportBaselineCatalog, type CatalogUniversityDraft } from "./collector.js";
import {
  dbInsertCatalogRun,
  dbLoadCatalogRuns,
  dbLoadCatalogUniversities,
  dbMarkCatalogUniversityDeleted,
  dbUpsertCatalogUniversity,
  isPostgresConfigured,
  isPostgresSchemaReady,
  type PgCatalogRunRow,
} from "./db/postgres.js";
import {
  ROOT,
  removeRuntimeUniversity,
  upsertRuntimeUniversityFromCatalog,
  usersById,
} from "./store.js";

export type ServerCatalogUniversity = CatalogUniversityDraft & {
  updatedBy?: string;
  updatedAt?: string;
};

export interface ServerCatalogRun {
  id: string;
  universityId: string;
  universityName: string;
  mode: "baseline-seed" | "polite-web" | "json-import" | "manual-edit" | "delete";
  status: "completed" | "partial" | "blocked_by_robots" | "failed";
  fetchedUrlCount: number;
  programCount: number;
  conflictCount: number;
  robotsSummary: string;
  notes: string;
  actorEmail: string;
  createdAtMs: number;
  createdAt: string;
}

export class CatalogValidationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "CatalogValidationError";
    this.statusCode = statusCode;
  }
}

const VALID_SECTORS = new Set(["Public", "Private"]);
const VALID_COLORS = new Set(["green", "maroon", "gold", "rust", "lilac"]);
const VALID_STATUSES = new Set(["pending", "partial", "verified"]);
const VALID_MODES = new Set([
  "baseline-seed",
  "polite-web",
  "json-import",
  "manual-edit",
  "delete",
]);
const VALID_RUN_STATUSES = new Set([
  "completed",
  "partial",
  "blocked_by_robots",
  "failed",
]);

const CATALOG_FALLBACK_FILE = path.join(ROOT, "data", "catalog_store.json");

const catalogById = new Map<string, ServerCatalogUniversity>();
const deletedCatalogIds = new Set<string>();
const catalogRuns: ServerCatalogRun[] = [];
let baselineInitialized = false;

function cleanStr(value: unknown, maxLen: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function safeHttpsUrl(value: unknown): string {
  const s = cleanStr(value, 500);
  if (!s) return "";
  try {
    const parsed = new URL(s);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
    ) {
      return s;
    }
    return "";
  } catch {
    return "";
  }
}

export function slugifyCatalogId(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

export function sanitizeServerCatalogUniversity(
  input: unknown,
  actorEmail?: string,
): ServerCatalogUniversity {
  if (!input || typeof input !== "object") {
    throw new CatalogValidationError("University payload must be a JSON object.");
  }
  const src = input as Record<string, unknown>;
  const name = cleanStr(src.name, 200);
  if (!name) {
    throw new CatalogValidationError("University full name is required.");
  }

  const rawId = cleanStr(src.id, 128);
  const id = slugifyCatalogId(rawId || name);
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,127}$/.test(id)) {
    throw new CatalogValidationError(
      "University slug ID must be 2–128 lowercase letters, numbers, hyphens, or underscores.",
    );
  }

  const shortName = cleanStr(src.shortName, 60) || name.slice(0, 30);
  const city = cleanStr(src.city, 100) || "Manila";
  const campusLocation = cleanStr(src.campusLocation, 300) || city;
  const sector = VALID_SECTORS.has(String(src.sector))
    ? (String(src.sector) as "Public" | "Private")
    : "Private";
  const color = VALID_COLORS.has(String(src.color))
    ? (String(src.color) as ServerCatalogUniversity["color"])
    : "green";
  const collectionStatus = VALID_STATUSES.has(String(src.collectionStatus))
    ? (String(src.collectionStatus) as ServerCatalogUniversity["collectionStatus"])
    : "partial";

  const rawOfficialUrl = cleanStr(src.officialUrl, 500);
  if (rawOfficialUrl && !safeHttpsUrl(rawOfficialUrl)) {
    throw new CatalogValidationError("Official URL must be a valid https:// address.");
  }
  const officialUrl = safeHttpsUrl(rawOfficialUrl);

  const rawPrograms = Array.isArray(src.programs) ? src.programs : [];
  const programs = rawPrograms
    .slice(0, 400)
    .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
    .map((p, idx) => ({
      id: cleanStr(p.id, 80) || `${id}-prog-${idx + 1}`,
      name: cleanStr(p.name, 200),
      topic: cleanStr(p.topic, 80) || "Arts & society",
      strandAlignment: cleanStr(p.strandAlignment, 120),
      sourceUrl: safeHttpsUrl(p.sourceUrl),
    }))
    .filter((p) => Boolean(p.name));

  const rawReqs = Array.isArray(src.admissionRequirements)
    ? src.admissionRequirements
    : [];
  const admissionRequirements = rawReqs
    .slice(0, 100)
    .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === "object"))
    .map((r) => ({
      text: cleanStr(r.text, 500),
      category: cleanStr(r.category, 60) || "general",
      academicYear: cleanStr(r.academicYear, 40),
      sourceUrl: safeHttpsUrl(r.sourceUrl),
    }))
    .filter((r) => Boolean(r.text));

  const rawDeadlines = Array.isArray(src.applicationDeadlines)
    ? src.applicationDeadlines
    : [];
  const applicationDeadlines = rawDeadlines
    .slice(0, 50)
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
    .map((d) => ({
      label: cleanStr(d.label, 120) || "Application deadline",
      dateIso: cleanStr(d.dateIso, 20),
      rawText: cleanStr(d.rawText, 400),
      academicYear: cleanStr(d.academicYear, 40),
      sourceUrl: safeHttpsUrl(d.sourceUrl),
    }))
    .filter((d) => Boolean(d.label || d.rawText));

  const rawExams = Array.isArray(src.entranceExaminations)
    ? src.entranceExaminations
    : [];
  const entranceExaminations = rawExams
    .slice(0, 30)
    .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
    .map((e) => ({
      examName: cleanStr(e.examName, 120) || "Entrance examination",
      coverage: cleanStr(e.coverage, 500),
      academicYear: cleanStr(e.academicYear, 40),
      sourceUrl: safeHttpsUrl(e.sourceUrl),
    }))
    .filter((e) => Boolean(e.examName || e.coverage));

  const rawFees = Array.isArray(src.tuitionFees) ? src.tuitionFees : [];
  const tuitionFees = rawFees
    .slice(0, 50)
    .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === "object"))
    .map((f) => {
      const minVal =
        typeof f.amountMin === "number" &&
        Number.isFinite(f.amountMin) &&
        f.amountMin >= 0 &&
        f.amountMin <= 10_000_000
          ? f.amountMin
          : null;
      const maxVal =
        typeof f.amountMax === "number" &&
        Number.isFinite(f.amountMax) &&
        f.amountMax >= 0 &&
        f.amountMax <= 10_000_000
          ? f.amountMax
          : minVal;
      return {
        amountMin: minVal,
        amountMax: maxVal !== null && minVal !== null && maxVal < minVal ? minVal : maxVal,
        currency: cleanStr(f.currency, 10) || "PHP",
        basis: cleanStr(f.basis, 30) || "unspecified",
        rawText: cleanStr(f.rawText, 400),
        academicYear: cleanStr(f.academicYear, 40),
        sourceUrl: safeHttpsUrl(f.sourceUrl),
      };
    })
    .filter((f) => f.amountMin !== null || Boolean(f.rawText));

  const rawLinks = Array.isArray(src.applicationLinks) ? src.applicationLinks : [];
  const applicationLinks = rawLinks
    .slice(0, 50)
    .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === "object"))
    .map((l) => ({
      label: cleanStr(l.label, 120) || "Application portal",
      url: safeHttpsUrl(l.url),
      sourceUrl: safeHttpsUrl(l.sourceUrl),
    }))
    .filter((l) => Boolean(l.url));

  const rawConflicts = Array.isArray(src.declaredConflicts)
    ? src.declaredConflicts
    : [];
  const declaredConflicts = rawConflicts
    .slice(0, 50)
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"))
    .map((c) => ({
      field: cleanStr(c.field, 80),
      keptValue: cleanStr(c.keptValue, 400),
      discardedValue: cleanStr(c.discardedValue, 400),
      keptSourceUrl: safeHttpsUrl(c.keptSourceUrl),
      discardedSourceUrl: safeHttpsUrl(c.discardedSourceUrl),
      reason: cleanStr(c.reason, 400),
    }))
    .filter((c) => Boolean(c.field));

  const sourceUrls = Array.from(
    new Set(
      (Array.isArray(src.sourceUrls) ? src.sourceUrls : [])
        .map((u) => safeHttpsUrl(u))
        .filter(Boolean),
    ),
  ).slice(0, 40);

  const sourceNotes = Array.from(
    new Set(
      (Array.isArray(src.sourceNotes) ? src.sourceNotes : [])
        .map((n) => cleanStr(n, 400))
        .filter(Boolean),
    ),
  ).slice(0, 30);

  const academicYears = Array.from(
    new Set(
      (Array.isArray(src.academicYears) ? src.academicYears : [])
        .map((y) => cleanStr(y, 40))
        .filter(Boolean),
    ),
  ).slice(0, 10);

  const nowIso = new Date().toISOString();

  return {
    id,
    name,
    shortName,
    city,
    campusLocation,
    sector,
    color,
    officialUrl,
    collectionStatus,
    academicYear: cleanStr(src.academicYear, 40),
    academicYears,
    isPublished: src.isPublished !== false,
    programs,
    admissionRequirements,
    applicationDeadlines,
    entranceExaminations,
    tuitionFees,
    applicationLinks,
    declaredConflicts,
    sourceUrls,
    sourceNotes,
    collectedAt: cleanStr(src.collectedAt, 50) || nowIso,
    lastVerifiedAt: cleanStr(src.lastVerifiedAt, 50) || nowIso,
    updatedBy: actorEmail ? cleanStr(actorEmail, 254) : cleanStr(src.updatedBy, 254) || undefined,
    updatedAt: nowIso,
  };
}

interface PersistedCatalogFile {
  version: number;
  overrides: Record<string, ServerCatalogUniversity>;
  deletedIds: string[];
  runs: ServerCatalogRun[];
}

let catalogOverridesLocal = new Map<string, ServerCatalogUniversity>();

function persistLocalCatalogSnapshot(): void {
  try {
    const dir = path.dirname(CATALOG_FALLBACK_FILE);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedCatalogFile = {
      version: 1,
      overrides: Object.fromEntries(catalogOverridesLocal.entries()),
      deletedIds: Array.from(deletedCatalogIds.values()),
      runs: catalogRuns.slice(0, 100),
    };
    const tmpPath = `${CATALOG_FALLBACK_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, CATALOG_FALLBACK_FILE);
  } catch (err) {
    console.warn(
      "[catalog] Could not write local catalog fallback snapshot:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function initCatalogStoreFromBaseline(force = false): void {
  if (baselineInitialized && !force) return;
  const baseline = exportBaselineCatalog();
  for (const item of baseline) {
    if (!deletedCatalogIds.has(item.id) && !catalogById.has(item.id)) {
      catalogById.set(item.id, { ...item });
    }
  }
  baselineInitialized = true;
}

export function loadPersistedCatalogLocal(): {
  overridesLoaded: number;
  runsLoaded: number;
} {
  initCatalogStoreFromBaseline();
  if (!fs.existsSync(CATALOG_FALLBACK_FILE)) {
    return { overridesLoaded: 0, runsLoaded: 0 };
  }
  try {
    const raw = fs.readFileSync(CATALOG_FALLBACK_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedCatalogFile>;
    let overridesLoaded = 0;

    if (Array.isArray(parsed.deletedIds)) {
      for (const id of parsed.deletedIds) {
        const cleanId = slugifyCatalogId(String(id));
        if (!cleanId) continue;
        deletedCatalogIds.add(cleanId);
        catalogById.delete(cleanId);
        removeRuntimeUniversity(cleanId);
      }
    }

    if (parsed.overrides && typeof parsed.overrides === "object") {
      for (const [key, value] of Object.entries(parsed.overrides)) {
        try {
          const clean = sanitizeServerCatalogUniversity({ ...value, id: key });
          deletedCatalogIds.delete(clean.id);
          catalogOverridesLocal.set(clean.id, clean);
          catalogById.set(clean.id, clean);
          upsertRuntimeUniversityFromCatalog(clean);
          overridesLoaded += 1;
        } catch {
          // Skip malformed local entry
        }
      }
    }

    let runsLoaded = 0;
    if (Array.isArray(parsed.runs)) {
      catalogRuns.length = 0;
      for (const r of parsed.runs.slice(0, 100)) {
        if (!r || typeof r !== "object") continue;
        catalogRuns.push(r as ServerCatalogRun);
        runsLoaded += 1;
      }
    }
    return { overridesLoaded, runsLoaded };
  } catch (err) {
    console.warn(
      "[catalog] Could not load local catalog fallback file:",
      err instanceof Error ? err.message : err,
    );
    return { overridesLoaded: 0, runsLoaded: 0 };
  }
}

export async function loadCatalogFromPostgres(): Promise<{
  universitiesLoaded: number;
  runsLoaded: number;
}> {
  initCatalogStoreFromBaseline();
  if (!isPostgresSchemaReady()) {
    return { universitiesLoaded: 0, runsLoaded: 0 };
  }

  const [rows, pgRuns] = await Promise.all([
    dbLoadCatalogUniversities(),
    dbLoadCatalogRuns(60),
  ]);

  let universitiesLoaded = 0;
  for (const row of rows) {
    if (row.is_deleted) {
      deletedCatalogIds.add(row.id);
      catalogById.delete(row.id);
      catalogOverridesLocal.delete(row.id);
      removeRuntimeUniversity(row.id);
      continue;
    }
    try {
      const clean = sanitizeServerCatalogUniversity(
        {
          ...row.payload,
          id: row.id,
          isPublished: row.is_published,
          collectionStatus: row.collection_status,
          updatedBy: row.updated_by ?? undefined,
        },
        row.updated_by ?? undefined,
      );
      clean.updatedAt = row.updated_at;
      deletedCatalogIds.delete(clean.id);
      catalogById.set(clean.id, clean);
      catalogOverridesLocal.set(clean.id, clean);
      upsertRuntimeUniversityFromCatalog(clean);
      universitiesLoaded += 1;
    } catch {
      // Skip malformed row
    }
  }

  catalogRuns.length = 0;
  for (const r of pgRuns) {
    const mode = VALID_MODES.has(r.mode)
      ? (r.mode as ServerCatalogRun["mode"])
      : "manual-edit";
    const status = VALID_RUN_STATUSES.has(r.status)
      ? (r.status as ServerCatalogRun["status"])
      : "completed";
    const ts = Date.parse(r.created_at) || Date.now();
    catalogRuns.push({
      id: r.id,
      universityId: r.university_id,
      universityName: r.university_name,
      mode,
      status,
      fetchedUrlCount: r.fetched_url_count,
      programCount: r.program_count,
      conflictCount: r.conflict_count,
      robotsSummary: r.robots_summary,
      notes: r.notes,
      actorEmail: r.actor_email,
      createdAtMs: ts,
      createdAt: r.created_at,
    });
  }

  return { universitiesLoaded, runsLoaded: catalogRuns.length };
}

export function listAdminCatalogUniversities(): ServerCatalogUniversity[] {
  initCatalogStoreFromBaseline();
  return Array.from(catalogById.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function listPublishedCatalogUniversities(): ServerCatalogUniversity[] {
  return listAdminCatalogUniversities().filter((u) => u.isPublished !== false);
}

export function listAdminCatalogRuns(limit = 30): ServerCatalogRun[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return [...catalogRuns]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, safeLimit);
}

async function appendCatalogAuditRun(
  runInput: Omit<ServerCatalogRun, "id" | "createdAtMs" | "createdAt">,
): Promise<ServerCatalogRun> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const run: ServerCatalogRun = {
    id: crypto.randomUUID(),
    ...runInput,
    createdAtMs: nowMs,
    createdAt: nowIso,
  };
  catalogRuns.unshift(run);
  if (catalogRuns.length > 100) {
    catalogRuns.length = 100;
  }

  const pgRow: PgCatalogRunRow = {
    id: run.id,
    university_id: run.universityId,
    university_name: run.universityName,
    mode: run.mode,
    status: run.status,
    fetched_url_count: run.fetchedUrlCount,
    program_count: run.programCount,
    conflict_count: run.conflictCount,
    robots_summary: run.robotsSummary,
    notes: run.notes,
    actor_email: run.actorEmail,
    created_at: run.createdAt,
  };
  if (isPostgresSchemaReady()) {
    await dbInsertCatalogRun(pgRow);
  }
  persistLocalCatalogSnapshot();
  return run;
}

export interface SaveCatalogAuditOptions {
  mode?: ServerCatalogRun["mode"];
  status?: ServerCatalogRun["status"];
  fetchedUrlCount?: number;
  robotsSummary?: string;
  notes?: string;
}

export async function saveAdminCatalogUniversity(
  rawInput: unknown,
  actor: AdminActor,
  audit?: SaveCatalogAuditOptions,
): Promise<{ university: ServerCatalogUniversity; run: ServerCatalogRun }> {
  initCatalogStoreFromBaseline();
  const clean = sanitizeServerCatalogUniversity(rawInput, actor.email);

  deletedCatalogIds.delete(clean.id);
  catalogById.set(clean.id, clean);
  catalogOverridesLocal.set(clean.id, clean);
  upsertRuntimeUniversityFromCatalog(clean);

  if (isPostgresSchemaReady()) {
    await dbUpsertCatalogUniversity(
      clean.id,
      clean as unknown as Record<string, unknown>,
      clean.isPublished,
      clean.collectionStatus,
      actor.email,
    );
  }

  const mode: ServerCatalogRun["mode"] =
    audit?.mode && VALID_MODES.has(audit.mode) ? audit.mode : "manual-edit";
  const status: ServerCatalogRun["status"] =
    audit?.status && VALID_RUN_STATUSES.has(audit.status)
      ? audit.status
      : "completed";

  const run = await appendCatalogAuditRun({
    universityId: clean.id,
    universityName: clean.name,
    mode,
    status,
    fetchedUrlCount:
      typeof audit?.fetchedUrlCount === "number"
        ? Math.max(0, Math.min(500, Math.floor(audit.fetchedUrlCount)))
        : clean.sourceUrls.length,
    programCount: clean.programs.length,
    conflictCount: clean.declaredConflicts.length,
    robotsSummary: cleanStr(
      audit?.robotsSummary || "Direct verified admin catalog update.",
      400,
    ),
    notes: cleanStr(
      audit?.notes ||
        `Saved ${clean.name} (${clean.programs.length} programs, ${clean.tuitionFees.length} tuition records).`,
      600,
    ),
    actorEmail: actor.email,
  });

  return { university: clean, run };
}

export async function deleteAdminCatalogUniversity(
  universityId: string,
  actor: AdminActor,
): Promise<{ removedId: string; run: ServerCatalogRun }> {
  initCatalogStoreFromBaseline();
  const cleanId = slugifyCatalogId(universityId);
  if (!cleanId || !/^[a-z0-9][a-z0-9_-]{1,127}$/.test(cleanId)) {
    throw new CatalogValidationError("Invalid university slug identifier.");
  }
  const existing = catalogById.get(cleanId);
  if (!existing) {
    throw new CatalogValidationError("University was not found in the catalog.", 404);
  }

  catalogById.delete(cleanId);
  catalogOverridesLocal.delete(cleanId);
  deletedCatalogIds.add(cleanId);
  removeRuntimeUniversity(cleanId);

  if (isPostgresSchemaReady()) {
    await dbMarkCatalogUniversityDeleted(cleanId, actor.email);
  }

  const run = await appendCatalogAuditRun({
    universityId: cleanId,
    universityName: existing.name,
    mode: "delete",
    status: "completed",
    fetchedUrlCount: 0,
    programCount: 0,
    conflictCount: 0,
    robotsSummary: "Removed by administrator.",
    notes: `Removed ${existing.name} (${cleanId}) from the live catalog.`,
    actorEmail: actor.email,
  });

  return { removedId: cleanId, run };
}

export async function seedBaselineCatalogUniversities(
  overwrite: boolean,
  actor: AdminActor,
): Promise<{
  written: number;
  skipped: number;
  totalPrograms: number;
  run: ServerCatalogRun;
}> {
  initCatalogStoreFromBaseline();
  const baseline = exportBaselineCatalog();
  let written = 0;
  let skipped = 0;
  let totalPrograms = 0;

  for (const item of baseline) {
    const existing = catalogById.get(item.id);
    const isEmptyPlaceholder =
      existing &&
      existing.programs.length === 0 &&
      existing.admissionRequirements.length === 0 &&
      existing.entranceExaminations.length === 0;

    if (!overwrite && existing && !isEmptyPlaceholder) {
      skipped += 1;
      continue;
    }

    const clean = sanitizeServerCatalogUniversity(item, actor.email);
    deletedCatalogIds.delete(clean.id);
    catalogById.set(clean.id, clean);
    catalogOverridesLocal.set(clean.id, clean);
    upsertRuntimeUniversityFromCatalog(clean);

    if (isPostgresSchemaReady()) {
      await dbUpsertCatalogUniversity(
        clean.id,
        clean as unknown as Record<string, unknown>,
        clean.isPublished,
        clean.collectionStatus,
        actor.email,
      );
    }

    written += 1;
    totalPrograms += clean.programs.length;
  }

  const run = await appendCatalogAuditRun({
    universityId: "all-baseline",
    universityName: `Manila Baseline (${baseline.length} schools)`,
    mode: "baseline-seed",
    status: "completed",
    fetchedUrlCount: written,
    programCount: totalPrograms,
    conflictCount: 0,
    robotsSummary: "Seeded from verified baseline JSON dataset.",
    notes: `Saved ${written} universit${written === 1 ? "y" : "ies"} (${skipped} existing kept untouched).`,
    actorEmail: actor.email,
  });

  return { written, skipped, totalPrograms, run };
}

export function buildAdminDashboardSummary(actor: AdminActor) {
  const allUniversities = listAdminCatalogUniversities();
  const adminList = listAdminAccounts(actor);

  let publishedCount = 0;
  let draftCount = 0;
  let verifiedCount = 0;
  let partialCount = 0;
  let pendingCount = 0;
  let totalPrograms = 0;
  let totalFees = 0;
  let totalDeadlines = 0;
  let totalExams = 0;
  let totalConflicts = 0;
  let withTuitionCount = 0;
  let withDeadlinesCount = 0;
  let withExamsCount = 0;

  for (const u of allUniversities) {
    if (u.isPublished !== false) publishedCount += 1;
    else draftCount += 1;

    if (u.collectionStatus === "verified") verifiedCount += 1;
    else if (u.collectionStatus === "partial") partialCount += 1;
    else pendingCount += 1;

    totalPrograms += u.programs.length;
    totalFees += u.tuitionFees.length;
    totalDeadlines += u.applicationDeadlines.length;
    totalExams += u.entranceExaminations.length;
    totalConflicts += u.declaredConflicts.length;

    if (u.tuitionFees.length > 0) withTuitionCount += 1;
    if (u.applicationDeadlines.length > 0) withDeadlinesCount += 1;
    if (u.entranceExaminations.length > 0) withExamsCount += 1;
  }

  // Strictly aggregate user counts (no student PII exposed)
  let studentTotal = 0;
  let studentLocal = 0;
  let studentGoogle = 0;
  let totpEnabledTotal = 0;
  let activeUsersTotal = 0;
  for (const user of usersById.values()) {
    if (!user.is_active) continue;
    activeUsersTotal += 1;
    if (user.totp_enabled) totpEnabledTotal += 1;
    if (user.role === "student") {
      studentTotal += 1;
      if (user.auth_provider === "google") studentGoogle += 1;
      else studentLocal += 1;
    }
  }

  const catalogRows = allUniversities.map((u) => ({
    id: u.id,
    name: u.name,
    shortName: u.shortName,
    city: u.city,
    sector: u.sector,
    collectionStatus: u.collectionStatus,
    isPublished: u.isPublished !== false,
    programCount: u.programs.length,
    feeCount: u.tuitionFees.length,
    deadlineCount: u.applicationDeadlines.length,
    examCount: u.entranceExaminations.length,
    conflictCount: u.declaredConflicts.length,
    academicYear: u.academicYear || "",
    lastVerifiedAt: u.lastVerifiedAt || u.collectedAt || "",
  }));

  return {
    actor: {
      email: actor.email,
      displayName: actor.displayName,
      source: actor.source,
    },
    storage: {
      postgresPersistent: isPostgresConfigured() && isPostgresSchemaReady(),
    },
    metrics: {
      universitiesTotal: allUniversities.length,
      universitiesPublished: publishedCount,
      universitiesDraft: draftCount,
      verifiedCount,
      partialCount,
      pendingCount,
      programsTotal: totalPrograms,
      feesTotal: totalFees,
      deadlinesTotal: totalDeadlines,
      examsTotal: totalExams,
      conflictsTotal: totalConflicts,
      withTuitionCount,
      withDeadlinesCount,
      withExamsCount,
      adminsTotal: adminList.summary.totalActiveAdmins,
      adminsLocal: adminList.summary.localAdminCount,
      adminsGoogle: adminList.summary.hasBootstrappedAdmin ? 1 : 0,
      studentsTotal: studentTotal,
      studentsLocal: studentLocal,
      studentsGoogle: studentGoogle,
      totpEnabledTotal,
      activeUsersTotal,
    },
    universities: catalogRows,
    recentRuns: listAdminCatalogRuns(15),
  };
}

/** Test-only reset helper so unit tests start from a clean catalog state. */
export function resetCatalogStoreForTests(): void {
  catalogById.clear();
  catalogOverridesLocal.clear();
  deletedCatalogIds.clear();
  catalogRuns.length = 0;
  baselineInitialized = false;
}
