/**
 * Firestore Catalog & Collection Audit service for UniMatch PH.
 *
 * All writes enforce blueprint bounds and use serverTimestamp() so they match
 * firestore.rules verbatim. Public reads use where("isPublished", "==", true).
 */
import type { Auth, User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import {
  searchCatalogPrograms,
  searchCatalogUniversities,
} from "../src/algorithms/catalogQuery.js";
import {
  parseWeights,
  recommend,
  type CandidateInput,
  type RecommendationResponse,
} from "../src/algorithms/matching.js";
import {
  parseMatchSentence,
  type ParsedMatchQuery,
} from "../src/algorithms/nlpQueryParser.js";
export { mergeLiveAndBaselineCatalog } from "../src/algorithms/catalogMerge.js";

export enum CatalogOpType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface CatalogProgram {
  id: string;
  name: string;
  topic: string;
  strandAlignment: string;
  sourceUrl: string;
}

export interface CatalogRequirement {
  text: string;
  category: string;
  academicYear: string;
  sourceUrl: string;
}

export interface CatalogDeadline {
  label: string;
  dateIso: string;
  rawText: string;
  academicYear: string;
  sourceUrl: string;
}

export interface CatalogExam {
  examName: string;
  coverage: string;
  academicYear: string;
  sourceUrl: string;
}

export interface CatalogFee {
  amountMin: number | null;
  amountMax: number | null;
  currency: string;
  basis: string;
  rawText: string;
  academicYear: string;
  sourceUrl: string;
}

export interface CatalogLink {
  label: string;
  url: string;
  sourceUrl: string;
}

export interface CatalogConflict {
  field: string;
  keptValue: string;
  discardedValue: string;
  reason: string;
}

export interface CatalogUniversityRecord {
  id: string;
  name: string;
  shortName: string;
  city: string;
  campusLocation: string;
  sector: "Public" | "Private";
  color: "green" | "maroon" | "gold" | "rust" | "lilac";
  officialUrl: string;
  collectionStatus: "pending" | "partial" | "verified";
  academicYear: string;
  academicYears: string[];
  isPublished: boolean;
  programs: CatalogProgram[];
  admissionRequirements: CatalogRequirement[];
  applicationDeadlines: CatalogDeadline[];
  entranceExaminations: CatalogExam[];
  tuitionFees: CatalogFee[];
  applicationLinks: CatalogLink[];
  declaredConflicts: CatalogConflict[];
  sourceUrls: string[];
  sourceNotes: string[];
  collectedAt: string;
  lastVerifiedAt: string;
  updatedByUid?: string;
}

export interface CollectionRunRecord {
  id: string;
  universityId: string;
  universityName: string;
  mode: "polite-web" | "json-import" | "baseline-seed" | "manual-edit";
  status: "completed" | "partial" | "blocked_by_robots" | "failed";
  fetchedUrlCount: number;
  programCount: number;
  conflictCount: number;
  robotsSummary: string;
  notes: string;
  createdByUid?: string;
  createdAtMs?: number;
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_COLORS = new Set(["green", "maroon", "gold", "rust", "lilac"]);
const VALID_STATUSES = new Set(["pending", "partial", "verified"]);
const BOOTSTRAPPED_ADMIN_EMAILS = new Set(["enricomigsduran@gmail.com"]);

export function isBootstrappedAdminUser(user: User | null): boolean {
  if (!user || !user.emailVerified || !user.email) return false;
  return BOOTSTRAPPED_ADMIN_EMAILS.has(user.email.trim().toLowerCase());
}

export function slugifyCatalogId(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function cleanStr(val: unknown, maxLen: number): string {
  return String(val ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function cleanHttpsUrl(val: unknown, maxLen = 500): string {
  const s = cleanStr(val, maxLen);
  if (!s) return "";
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return "";
    }
    return parsed.href.slice(0, maxLen);
  } catch {
    return "";
  }
}

export function sanitizeCatalogUniversity(
  raw: Partial<CatalogUniversityRecord>,
  adminUid: string,
): CatalogUniversityRecord & { updatedByUid: string } {
  const id = slugifyCatalogId(raw.id || raw.name || "");
  if (!VALID_ID_RE.test(id)) {
    throw new Error("University slug ID must contain letters, numbers, hyphens, or underscores.");
  }
  const name = cleanStr(raw.name, 200);
  if (!name) throw new Error("University name is required.");
  const shortName = cleanStr(raw.shortName || name, 60) || name.slice(0, 60);
  const city = cleanStr(raw.city || "Manila", 100) || "Manila";
  const campusLocation = cleanStr(raw.campusLocation || city, 300) || city;
  const sector: "Public" | "Private" = raw.sector === "Public" ? "Public" : "Private";
  const colorRaw = cleanStr(raw.color || "green", 20);
  const color = (VALID_COLORS.has(colorRaw) ? colorRaw : "green") as CatalogUniversityRecord["color"];
  const statusRaw = cleanStr(raw.collectionStatus || "partial", 20);
  const collectionStatus = (
    VALID_STATUSES.has(statusRaw) ? statusRaw : "partial"
  ) as CatalogUniversityRecord["collectionStatus"];

  const programs: CatalogProgram[] = (Array.isArray(raw.programs) ? raw.programs : [])
    .slice(0, 400)
    .map((p, idx) => ({
      id: slugifyCatalogId(p?.id || `${id}-prog-${idx + 1}`) || `${id}-prog-${idx + 1}`,
      name: cleanStr(p?.name, 200),
      topic: cleanStr(p?.topic || "Arts, humanities & social sciences", 80),
      strandAlignment: cleanStr(p?.strandAlignment, 200),
      sourceUrl: cleanHttpsUrl(p?.sourceUrl),
    }))
    .filter((p) => p.name.length > 0);

  const admissionRequirements: CatalogRequirement[] = (
    Array.isArray(raw.admissionRequirements) ? raw.admissionRequirements : []
  )
    .slice(0, 100)
    .map((r) => ({
      text: cleanStr(r?.text, 500),
      category: cleanStr(r?.category || "general", 40) || "general",
      academicYear: cleanStr(r?.academicYear, 40),
      sourceUrl: cleanHttpsUrl(r?.sourceUrl),
    }))
    .filter((r) => r.text.length > 0);

  const applicationDeadlines: CatalogDeadline[] = (
    Array.isArray(raw.applicationDeadlines) ? raw.applicationDeadlines : []
  )
    .slice(0, 50)
    .map((d) => ({
      label: cleanStr(d?.label || "Application date", 120) || "Application date",
      dateIso: cleanStr(d?.dateIso, 20),
      rawText: cleanStr(d?.rawText, 400),
      academicYear: cleanStr(d?.academicYear, 40),
      sourceUrl: cleanHttpsUrl(d?.sourceUrl),
    }))
    .filter((d) => d.label.length > 0 || d.rawText.length > 0);

  const entranceExaminations: CatalogExam[] = (
    Array.isArray(raw.entranceExaminations) ? raw.entranceExaminations : []
  )
    .slice(0, 30)
    .map((e) => ({
      examName: cleanStr(e?.examName || "Entrance examination", 120),
      coverage: cleanStr(e?.coverage, 500),
      academicYear: cleanStr(e?.academicYear, 40),
      sourceUrl: cleanHttpsUrl(e?.sourceUrl),
    }))
    .filter((e) => e.examName.length > 0 || e.coverage.length > 0);

  const tuitionFees: CatalogFee[] = (Array.isArray(raw.tuitionFees) ? raw.tuitionFees : [])
    .slice(0, 50)
    .map((f) => {
      const min =
        f?.amountMin !== null && f?.amountMin !== undefined && String(f.amountMin) !== ""
          ? Number(f.amountMin)
          : null;
      const max =
        f?.amountMax !== null && f?.amountMax !== undefined && String(f.amountMax) !== ""
          ? Number(f.amountMax)
          : null;
      const safeMin = min !== null && Number.isFinite(min) && min >= 0 ? Math.round(min) : null;
      const safeMax =
        max !== null && Number.isFinite(max) && max >= 0
          ? Math.round(max)
          : safeMin;
      return {
        amountMin: safeMin,
        amountMax: safeMax,
        currency: cleanStr(f?.currency || "PHP", 12) || "PHP",
        basis: cleanStr(f?.basis || "unspecified", 30) || "unspecified",
        rawText: cleanStr(f?.rawText, 400),
        academicYear: cleanStr(f?.academicYear, 40),
        sourceUrl: cleanHttpsUrl(f?.sourceUrl),
      };
    })
    .filter((f) => f.amountMin !== null || f.rawText.length > 0);

  const applicationLinks: CatalogLink[] = (
    Array.isArray(raw.applicationLinks) ? raw.applicationLinks : []
  )
    .slice(0, 50)
    .map((l) => ({
      label: cleanStr(l?.label || "Application page", 120) || "Application page",
      url: cleanHttpsUrl(l?.url),
      sourceUrl: cleanHttpsUrl(l?.sourceUrl),
    }))
    .filter((l) => l.url.length > 0);

  const declaredConflicts: CatalogConflict[] = (
    Array.isArray(raw.declaredConflicts) ? raw.declaredConflicts : []
  )
    .slice(0, 50)
    .map((c) => ({
      field: cleanStr(c?.field, 60),
      keptValue: cleanStr(c?.keptValue, 300),
      discardedValue: cleanStr(c?.discardedValue, 300),
      reason: cleanStr(c?.reason, 300),
    }))
    .filter((c) => c.field.length > 0);

  const sourceUrls = Array.from(
    new Set(
      (Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [])
        .map((u) => cleanHttpsUrl(u))
        .filter(Boolean),
    ),
  ).slice(0, 50);

  const sourceNotes = (Array.isArray(raw.sourceNotes) ? raw.sourceNotes : [])
    .map((n) => cleanStr(n, 600))
    .filter(Boolean)
    .slice(0, 30);

  const academicYears = Array.from(
    new Set(
      (Array.isArray(raw.academicYears) ? raw.academicYears : [])
        .map((y) => cleanStr(y, 40))
        .filter(Boolean),
    ),
  ).slice(0, 10);

  return {
    id,
    name,
    shortName,
    city,
    campusLocation,
    sector,
    color,
    officialUrl: cleanHttpsUrl(raw.officialUrl),
    collectionStatus,
    academicYear: cleanStr(raw.academicYear, 40),
    academicYears,
    isPublished: raw.isPublished !== false,
    programs,
    admissionRequirements,
    applicationDeadlines,
    entranceExaminations,
    tuitionFees,
    applicationLinks,
    declaredConflicts,
    sourceUrls,
    sourceNotes,
    collectedAt: cleanStr(raw.collectedAt, 64),
    lastVerifiedAt: cleanStr(raw.lastVerifiedAt, 64),
    updatedByUid: adminUid,
  };
}

export type FirestoreErrorReporter = (
  error: unknown,
  operationType: CatalogOpType,
  path: string | null,
) => never;

export async function verifyAdminAccess(
  db: Firestore,
  user: User | null,
): Promise<boolean> {
  if (!user || !user.emailVerified) return false;
  if (isBootstrappedAdminUser(user)) return true;
  try {
    const snap = await getDoc(doc(db, "admins", user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

export async function loadPublishedCatalogUniversities(
  db: Firestore,
  reportError: FirestoreErrorReporter,
): Promise<CatalogUniversityRecord[]> {
  const path = "catalogUniversities";
  try {
    const q = query(
      collection(db, path),
      where("isPublished", "==", true),
    );
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => d.data() as CatalogUniversityRecord)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    reportError(error, CatalogOpType.LIST, path);
  }
}

export async function loadAllCatalogUniversitiesForAdmin(
  db: Firestore,
  reportError: FirestoreErrorReporter,
): Promise<CatalogUniversityRecord[]> {
  const path = "catalogUniversities";
  try {
    const snap = await getDocs(collection(db, path));
    return snap.docs
      .map((d) => d.data() as CatalogUniversityRecord)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    reportError(error, CatalogOpType.LIST, path);
  }
}

export async function saveCatalogUniversity(
  db: Firestore,
  user: User,
  draft: Partial<CatalogUniversityRecord>,
  reportError: FirestoreErrorReporter,
): Promise<CatalogUniversityRecord> {
  const clean = sanitizeCatalogUniversity(draft, user.uid);
  const path = `catalogUniversities/${clean.id}`;
  const ref = doc(db, "catalogUniversities", clean.id);
  try {
    await runTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (!existing.exists()) {
        tx.set(ref, {
          ...clean,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        const existingData = existing.data();
        tx.set(ref, {
          ...clean,
          createdAt: existingData.createdAt,
          updatedAt: serverTimestamp(),
        });
      }
    });
    return clean;
  } catch (error) {
    reportError(error, CatalogOpType.WRITE, path);
  }
}

export async function deleteCatalogUniversity(
  db: Firestore,
  universityId: string,
  reportError: FirestoreErrorReporter,
): Promise<void> {
  if (!VALID_ID_RE.test(universityId)) {
    throw new Error("Invalid university ID.");
  }
  const path = `catalogUniversities/${universityId}`;
  try {
    await deleteDoc(doc(db, "catalogUniversities", universityId));
  } catch (error) {
    reportError(error, CatalogOpType.DELETE, path);
  }
}

export async function recordCollectionRun(
  db: Firestore,
  user: User,
  run: Omit<CollectionRunRecord, "id" | "createdByUid" | "createdAtMs">,
  reportError: FirestoreErrorReporter,
): Promise<string> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = `collectionRuns/${runId}`;
  const universityId = slugifyCatalogId(run.universityId) || "all-baseline";
  try {
    await setDoc(doc(db, "collectionRuns", runId), {
      id: runId,
      universityId,
      universityName: cleanStr(run.universityName, 200) || universityId,
      mode: run.mode,
      status: run.status,
      fetchedUrlCount: Math.max(0, Math.min(200, Math.floor(run.fetchedUrlCount || 0))),
      programCount: Math.max(0, Math.min(5000, Math.floor(run.programCount || 0))),
      conflictCount: Math.max(0, Math.min(500, Math.floor(run.conflictCount || 0))),
      robotsSummary: cleanStr(run.robotsSummary, 500),
      notes: cleanStr(run.notes, 1000),
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
    });
    return runId;
  } catch (error) {
    reportError(error, CatalogOpType.CREATE, path);
  }
}

export async function loadCollectionRunsForAdmin(
  db: Firestore,
  user: User,
  reportError: FirestoreErrorReporter,
): Promise<CollectionRunRecord[]> {
  const path = "collectionRuns";
  try {
    const q = query(
      collection(db, path),
      where("createdByUid", "==", user.uid),
      limit(30),
    );
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        const ts = data.createdAt as { toMillis?: () => number } | undefined;
        return {
          id: String(data.id || d.id),
          universityId: String(data.universityId || ""),
          universityName: String(data.universityName || ""),
          mode: String(data.mode || "manual-edit") as CollectionRunRecord["mode"],
          status: String(data.status || "completed") as CollectionRunRecord["status"],
          fetchedUrlCount: Number(data.fetchedUrlCount || 0),
          programCount: Number(data.programCount || 0),
          conflictCount: Number(data.conflictCount || 0),
          robotsSummary: String(data.robotsSummary || ""),
          notes: String(data.notes || ""),
          createdByUid: String(data.createdByUid || ""),
          createdAtMs: typeof ts?.toMillis === "function" ? ts.toMillis() : 0,
        };
      })
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  } catch (error) {
    reportError(error, CatalogOpType.LIST, path);
  }
}

export async function getFreshIdToken(auth: Auth): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Please sign in with Google first.");
  }
  return user.getIdToken();
}

// --- Converters for seamless integration with public Explorer UI (app.js) ---
export function catalogRecordToExplorerDetail(docItem: CatalogUniversityRecord) {
  const tuitionAmountCount = docItem.tuitionFees.filter(
    (f) => typeof f.amountMin === "number" || typeof f.amountMax === "number",
  ).length;
  const freeTuition = docItem.tuitionFees.some(
    (f) => f.amountMin === 0 && f.amountMax === 0,
  );
  const firstExam = docItem.entranceExaminations[0];
  let examSummary: string | null = null;
  if (firstExam) {
    const cov = String(firstExam.coverage || "");
    if (/waived/i.test(cov) && !/except/i.test(cov)) {
      examSummary = "Exam waived";
    } else if (/waived/i.test(cov) && /except/i.test(cov)) {
      examSummary = firstExam.examName ? `${firstExam.examName} (mostly waived)` : "Mostly waived";
    } else {
      examSummary = firstExam.examName || "Required";
    }
  }

  const structured = {
    algorithm: "keyword-extraction-v1",
    university_name: docItem.name,
    campus_location: docItem.campusLocation,
    detected_name: docItem.name,
    academic_year: docItem.academicYear || null,
    academic_years: docItem.academicYears || [],
    programs: docItem.programs.map((p) => ({
      name: p.name,
      strand_alignment: p.strandAlignment || null,
      source_url: p.sourceUrl || null,
    })),
    admission_requirements: docItem.admissionRequirements.map((r) => ({
      text: r.text,
      category: r.category,
      academic_year: r.academicYear || null,
      source_url: r.sourceUrl || null,
    })),
    application_deadlines: docItem.applicationDeadlines.map((d) => ({
      label: d.label,
      date_iso: d.dateIso || null,
      raw_text: d.rawText,
      academic_year: d.academicYear || null,
      source_url: d.sourceUrl || null,
    })),
    entrance_examinations: docItem.entranceExaminations.map((e) => ({
      exam_name: e.examName,
      coverage: e.coverage,
      academic_year: e.academicYear || null,
      source_url: e.sourceUrl || null,
    })),
    tuition_fees: docItem.tuitionFees.map((f) => ({
      amount_min: f.amountMin,
      amount_max: f.amountMax,
      currency: f.currency,
      basis: f.basis,
      raw_text: f.rawText,
      academic_year: f.academicYear || null,
      source_url: f.sourceUrl || null,
    })),
    application_links: docItem.applicationLinks.map((l) => ({
      label: l.label,
      url: l.url,
      source_url: l.sourceUrl || null,
    })),
    source_urls: docItem.sourceUrls || [],
    last_verified_at: docItem.lastVerifiedAt || null,
    conflicts: docItem.declaredConflicts.map((c) => ({
      field: c.field,
      kept_value: c.keptValue,
      discarded_value: c.discardedValue,
      reason: c.reason,
    })),
  };

  return {
    id: docItem.id,
    name: docItem.name,
    short_name: docItem.shortName,
    city: docItem.city,
    campus_location: docItem.campusLocation,
    sector: docItem.sector,
    color: docItem.color,
    official_url: docItem.officialUrl || null,
    collection_status: docItem.collectionStatus,
    collected_at: docItem.collectedAt || null,
    academic_year: docItem.academicYear || null,
    academic_years: docItem.academicYears || [],
    last_verified_at: docItem.lastVerifiedAt || null,
    program_count: docItem.programs.length,
    tuition_amount_count: tuitionAmountCount,
    free_tuition: freeTuition,
    exam_summary: examSummary,
    programs: docItem.programs.map((p) => ({
      id: p.id,
      university_id: docItem.id,
      university_name: docItem.name,
      short_name: docItem.shortName,
      city: docItem.city,
      campus_location: docItem.campusLocation,
      sector: docItem.sector,
      color: docItem.color,
      name: p.name,
      topic: p.topic,
      strand_alignment: p.strandAlignment || null,
      source_url: p.sourceUrl || null,
      academic_year: docItem.academicYear || null,
      last_verified_at: docItem.lastVerifiedAt || null,
    })),
    structured,
    declared_conflicts: structured.conflicts,
    sources: (docItem.sourceUrls || []).map((url) => ({
      requested_url: url,
      final_url: url,
    })),
    evidence: {
      source_notes: docItem.sourceNotes || [],
      tuition_estimates: docItem.tuitionFees.map((f) => ({
        text: f.rawText,
        source_url: f.sourceUrl || null,
      })),
      admission_requirements: docItem.admissionRequirements.map((r) => ({
        text: r.text,
        source_url: r.sourceUrl || null,
      })),
      entrance_exam_coverage: docItem.entranceExaminations.map((e) => ({
        text: e.coverage || e.examName,
        source_url: e.sourceUrl || null,
      })),
      application_deadlines: docItem.applicationDeadlines.map((d) => ({
        text: d.rawText || `${d.label} ${d.dateIso}`,
        source_url: d.sourceUrl || null,
      })),
      application_status: [],
    },
  };
}

export function scoreLiveCatalogRecommendations(
  records: CatalogUniversityRecord[],
  preferences: {
    program?: string;
    city?: string;
    sector?: string;
    budget?: number | null;
    budget_basis?: string;
  },
  rawWeights: string | Record<string, number> | null | undefined,
  maxItems = 20,
): RecommendationResponse {
  const candidates: CandidateInput[] = [];
  const sorted = [...records].sort((a, b) => a.name.localeCompare(b.name));

  for (const u of sorted) {
    const fees = u.tuitionFees.map((f) => ({
      amount_min: f.amountMin,
      amount_max: f.amountMax,
      basis: f.basis,
      raw_text: f.rawText,
    }));
    if (!preferences.program || u.programs.length === 0) {
      candidates.push({
        university_id: u.id,
        university_name: u.name,
        short_name: u.shortName,
        city: u.city,
        campus_location: u.campusLocation,
        sector: u.sector,
        program_count: u.programs.length,
        program_id: null,
        program_name: null,
        topic: null,
        fees,
      });
    } else {
      for (const p of u.programs) {
        candidates.push({
          university_id: u.id,
          university_name: u.name,
          short_name: u.shortName,
          city: u.city,
          campus_location: u.campusLocation,
          sector: u.sector,
          program_count: u.programs.length,
          program_id: p.id,
          program_name: p.name,
          topic: p.topic,
          fees,
        });
      }
    }
  }

  const weights =
    typeof rawWeights === "string"
      ? parseWeights(rawWeights)
      : rawWeights ?? null;
  return recommend(candidates, preferences, weights, maxItems);
}

export function queryLiveCatalogUniversities(
  details: Array<ReturnType<typeof catalogRecordToExplorerDetail>>,
  options: {
    search?: string;
    city?: string;
    sector?: string;
    sort?: string;
  },
) {
  const byId = new Map(details.map((u) => [u.id, u]));
  return searchCatalogUniversities(
    details,
    (schoolId) => byId.get(schoolId)?.programs || [],
    options,
  );
}

export function queryLiveCatalogPrograms(
  details: Array<ReturnType<typeof catalogRecordToExplorerDetail>>,
  options: {
    search?: string;
    university_id?: string;
    topic?: string;
    sector?: string;
    city?: string;
    page?: number;
    limit?: number;
  },
) {
  const allPrograms = details.flatMap((u) => u.programs || []);
  return searchCatalogPrograms(allPrograms, options);
}

export function parseLiveCatalogMatchQuery(
  records: CatalogUniversityRecord[],
  sentence: string,
): ParsedMatchQuery {
  const programNames: string[] = [];
  const campusAreas = new Set<string>();
  for (const r of records) {
    for (const p of r.programs || []) {
      if (p.name) programNames.push(p.name);
    }
    const parts = String(r.campusLocation || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^metro manila$/i.test(s));
    if (parts.length >= 2) {
      campusAreas.add(parts[parts.length - 2]);
    }
  }
  return parseMatchSentence(sentence, {
    programNames,
    campusAreas: [...campusAreas],
  });
}
