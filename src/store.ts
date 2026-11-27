/**
 * In-memory datastore replacing SQLite for AI Studio Web runtime.
 *
 * Loads curated Manila universities from config/universities.json and
 * pre-collected PUP and DLSU evidence exports from data/{pup,dlsu}/unimatch_ph_raw_data.json,
 * running Algorithm 1 (structureRecord) on startup with zero external network calls.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_FIELDS,
  cleanText,
  structureRecord,
  type ApplicationLinkRow,
  type ConflictRow,
  type DeadlineRow,
  type ExamRow,
  type FeeRow,
  type RequirementRow,
} from "./algorithms/extraction.js";
import {
  recommend,
  type CandidateInput,
  type Criterion,
  type RecommendationResponse,
} from "./algorithms/matching.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");

type SchoolTuple = [string, string, string, string, string];

const SCHOOLS: Record<string, SchoolTuple> = {
  "University of the Philippines Manila": [
    "up-manila",
    "UP Manila",
    "Manila",
    "Public",
    "maroon",
  ],
  "University of Santo Tomas": [
    "ust-manila",
    "UST",
    "Manila",
    "Private",
    "gold",
  ],
  "De La Salle University": [
    "dlsu-manila",
    "DLSU",
    "Manila",
    "Private",
    "green",
  ],
  "Adamson University": [
    "adamson-manila",
    "Adamson",
    "Manila",
    "Private",
    "lilac",
  ],
  "Polytechnic University of the Philippines": [
    "pup-sta-mesa",
    "PUP",
    "Manila",
    "Public",
    "rust",
  ],
  "University of the East": ["ue-manila", "UE", "Manila", "Private", "rust"],
  "Far Eastern University": [
    "feu-manila",
    "FEU",
    "Manila",
    "Private",
    "gold",
  ],
  "San Beda University": [
    "sanbeda-manila",
    "San Beda",
    "Manila",
    "Private",
    "maroon",
  ],
  "Mapúa University": [
    "mapua-manila",
    "Mapúa",
    "Manila",
    "Private",
    "maroon",
  ],
  "Lyceum of the Philippines University": [
    "lpu-manila",
    "LPU Manila",
    "Manila",
    "Private",
    "maroon",
  ],
  "Centro Escolar University": [
    "ceu-manila",
    "CEU",
    "Manila",
    "Private",
    "gold",
  ],
  "Technological University of the Philippines": [
    "tup-manila",
    "TUP",
    "Manila",
    "Public",
    "lilac",
  ],
  "Philippine Normal University": [
    "pnu-manila",
    "PNU",
    "Manila",
    "Public",
    "green",
  ],
  "Pamantasan ng Lungsod ng Maynila": [
    "plm-manila",
    "PLM",
    "Manila",
    "Public",
    "green",
  ],
  "St. Paul University Manila": [
    "spumanila",
    "SPU Manila",
    "Manila",
    "Private",
    "lilac",
  ],
};

const CANONICAL_CAMPUSES: Record<string, string> = {
  "up-manila": "Padre Faura Street, Ermita, Manila, Metro Manila",
  "ust-manila": "España Boulevard, Sampaloc, Manila, Metro Manila",
  "dlsu-manila": "Taft Avenue, Malate, Manila, Metro Manila",
  "adamson-manila": "900 San Marcelino Street, Ermita, Manila, Metro Manila",
  "pup-sta-mesa": "Sta. Mesa, Manila, Metro Manila",
  "ue-manila": "2219 C.M. Recto Avenue, Sampaloc, Manila, Metro Manila",
  "feu-manila": "Nicanor Reyes Street, Sampaloc, Manila, Metro Manila",
  "sanbeda-manila": "638 Mendiola Street, San Miguel, Manila, Metro Manila",
  "mapua-manila": "658 Muralla Street, Intramuros, Manila, Metro Manila",
  "lpu-manila": "Muralla Street, Intramuros, Manila, Metro Manila",
  "ceu-manila": "9 Mendiola Street, San Miguel, Manila, Metro Manila",
  "tup-manila": "Ayala Boulevard, Ermita, Manila, Metro Manila",
  "pnu-manila": "Taft Avenue, Ermita, Manila, Metro Manila",
  "plm-manila": "General Luna Street, Intramuros, Manila, Metro Manila",
  spumanila: "680 Pedro Gil Street, Malate, Manila, Metro Manila",
};

const TOPICS: Record<string, string[]> = {
  Computing: [
    "computer",
    "information technology",
    "information systems",
    "data science",
    "multimedia computing",
    "esports",
  ],
  Engineering: [
    "engineering",
    "architecture",
    "environmental planning",
    "interior design",
    "industrial design",
    "geology",
    "chemical process technology",
  ],
  Education: ["education", "library", "for teachers"],
  Business: [
    "business",
    "accountancy",
    "accounting",
    "auditing",
    "entrepreneur",
    "office",
    "tourism",
    "hospitality",
    "transportation",
    "customs",
    "supply chain",
    "legal management",
    "government management",
    "economics",
  ],
  "Science & health": [
    "science",
    "mathematics",
    "statistics",
    "biology",
    "chemistry",
    "biochemistry",
    "microbiology",
    "physics",
    "nutrition",
    "psychology",
    "nursing",
    "pharmacy",
    "pharmaceutical",
    "medical",
    "dental",
    "optometry",
    "physical therapy",
    "occupational therapy",
    "speech-language",
    "radiologic",
    "public health",
    "cosmetic",
    "food technology",
    "laboratory technology",
    "sports science",
  ],
};

export interface UniversityRecord {
  id: string;
  name: string;
  short_name: string;
  city: string;
  campus_location: string;
  sector: string;
  color: string;
  official_url: string | null;
  sources: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
  collection_status: string;
  collected_at: string | null;
  academic_year: string | null;
  academic_years: string[];
  last_verified_at: string | null;
}

export interface ProgramRecord {
  id: string;
  university_id: string;
  name: string;
  topic: string;
  strand_alignment: string | null;
  source_url: string | null;
  academic_year: string | null;
  last_verified_at: string | null;
}

export interface CollectionSourceRecord {
  university_id: string;
  url: string;
  domain: string;
  status: string;
  http_status: number | null;
  fields: string[];
  retrieved_at: string | null;
  last_verified_at: string | null;
  error: string | null;
}

export interface CollectionRunRecord {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  universities_processed: number;
  sources_fetched: number;
  sources_failed: number;
  message: string | null;
}

export type UserRole = "student" | "admin";
export type AuthProvider = "local" | "google";

export const BOOTSTRAPPED_ADMIN_EMAILS = new Set(["enricomigsduran@gmail.com"]);

export function isBootstrappedAdminEmail(email: string): boolean {
  return BOOTSTRAPPED_ADMIN_EMAILS.has(String(email || "").trim().toLowerCase());
}

export interface UserRecord {
  id: string;
  username_hash: string | null;
  username_encrypted: string | null;
  email_hash: string;
  email_encrypted: string;
  display_name_encrypted: string;
  password_hash: string;
  auth_provider: AuthProvider;
  firebase_uid: string | null;
  role: UserRole;
  is_active: boolean;
  failed_logins: number;
  locked_until: string | null;
  totp_secret_encrypted: string | null;
  totp_enabled: boolean;
  totp_recovery_hashes: string[];
  session_version: number;
  password_changed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UserPreferencesRecord {
  user_id: string;
  program: string;
  city: string;
  sector: string;
  budget: number | null;
  budget_basis: string;
  weights: Record<Criterion, number>;
  updated_at: string;
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parts = new URL(value);
    if (
      parts.protocol === "https:" &&
      parts.hostname &&
      !parts.username &&
      !parts.password
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function topicFor(name: string): string {
  const lower = name.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPICS)) {
    if (keywords.some((kw) => lower.includes(kw))) return topic;
  }
  return "Arts & society";
}

export function tuitionAmountCount(entries: unknown): number {
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const amounts = (entry as Record<string, unknown>).amounts;
    if (!Array.isArray(amounts)) continue;
    for (const amt of amounts) {
      if (!amt || typeof amt !== "object") continue;
      const a = amt as Record<string, unknown>;
      const low = a.min_php;
      const high = a.max_php;
      if (
        typeof low === "number" &&
        typeof high === "number" &&
        Number.isFinite(low) &&
        Number.isFinite(high) &&
        0 <= low &&
        low <= high
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function identityFor(name: string, campus: string): SchoolTuple {
  const known = SCHOOLS[name];
  const normCampus = campus.toLowerCase().replace(/\s+/g, " ").trim();
  if (known && normCampus === CANONICAL_CAMPUSES[known[0]].toLowerCase()) {
    return known;
  }
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "university";
  const suffix = sha256Hex(`${name.toLowerCase()}:${normCampus}`).slice(0, 8);
  const words = name.match(/[A-Za-z]+/g) ?? [];
  const initials =
    words
      .filter((w) => !["the", "of", "and"].includes(w.toLowerCase()))
      .map((w) => w[0].toUpperCase())
      .join("")
      .slice(0, 5) || "UNI";
  return [
    `${slug}-${suffix}`,
    known ? known[1] : initials,
    "Not specified",
    known ? known[3] : "Not specified",
    known ? known[4] : "green",
  ];
}

function collectionNotes(record: Record<string, unknown>): string[] {
  const notes: string[] = Array.isArray(record.source_notes)
    ? record.source_notes.filter((n): n is string => typeof n === "string")
    : [];
  const rawPrograms = Array.isArray(record.programs) ? record.programs : [];
  const names = rawPrograms
    .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
    .map((p) => String(p.name ?? "").replace(/\s+/g, " ").trim());
  const uniqueNames = new Set(names.map((n) => n.toLowerCase()));
  const duplicateCount = names.length - uniqueNames.size;
  if (duplicateCount > 0) {
    notes.push(
      `The raw export contains ${duplicateCount} repeated program name(s) after whitespace/case normalization. The searchable index keeps one entry per normalized title; original files are unchanged.`,
    );
  }
  const legacyHosts = new Set<string>();
  const sources = Array.isArray(record.sources) ? record.sources : [];
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const src = s as Record<string, unknown>;
    const url = safeUrl(src.final_url || src.requested_url);
    if (url) {
      const host = new URL(url).hostname;
      if (host.startsWith("old.")) legacyHosts.add(host);
    }
  }
  if (legacyHosts.size > 0) {
    notes.push(
      `Recorded sources use a legacy hostname (${Array.from(legacyHosts).sort().join(", ")}). Current intake applicability has not been verified; check academic-year references against the university's current admissions pages.`,
    );
  }
  const fees = Array.isArray(record.tuition_estimates)
    ? record.tuition_estimates
    : [];
  if (fees.length > 0 && tuitionAmountCount(fees) === 0) {
    notes.push(
      "Tuition evidence contains references or headings but no numeric PHP amounts. A fee reference is not a tuition estimate; no cost per semester is available from this export.",
    );
  }
  const campusLower = String(record.campus_location ?? "").toLowerCase();
  const otherCampuses = ["Laguna", "Rufino"].filter(
    (place) =>
      names.some((n) => new RegExp(`\\b${place}\\b`, "i").test(n)) &&
      !campusLower.includes(place.toLowerCase()),
  );
  if (otherCampuses.length > 0) {
    notes.push(
      `Some program titles refer to ${otherCampuses.join(", ")} or multi-campus pathways. The configured university address does not establish that every entry is offered entirely at that campus.`,
    );
  }
  if (
    names.some(
      (n) =>
        /\bMaster\b/i.test(n) || (n.match(/\bBachelor\b/gi) ?? []).length > 1,
    )
  ) {
    notes.push(
      "The catalog includes combined degrees and bachelor/master pathways. Counts describe collected title entries, not a verified number of standalone undergraduate degrees.",
    );
  }
  if (
    names.some((n) => n.includes(">") || /Science\s+Bachelor\b/i.test(n))
  ) {
    notes.push(
      "Some titles retain extraction artifacts or possibly concatenated degree names. Names are preserved as source text; review the original catalog before using them as verified program names.",
    );
  }
  return Array.from(new Set(notes));
}

// --- In-memory tables ---
export const universities = new Map<string, UniversityRecord>();
export const programsByUniversity = new Map<string, ProgramRecord[]>();
export const requirementsByUniversity = new Map<string, RequirementRow[]>();
export const deadlinesByUniversity = new Map<string, DeadlineRow[]>();
export const examsByUniversity = new Map<string, ExamRow[]>();
export const feesByUniversity = new Map<string, FeeRow[]>();
export const linksByUniversity = new Map<string, ApplicationLinkRow[]>();
export const conflictsByUniversity = new Map<string, ConflictRow[]>();
export const collectionSources = new Map<string, CollectionSourceRecord>();
export const collectionRuns: CollectionRunRecord[] = [];

export const usersById = new Map<string, UserRecord>();
export const userIdByEmailHash = new Map<string, string>();
export const userIdByUsernameHash = new Map<string, string>();
export const userPreferencesById = new Map<string, UserPreferencesRecord>();

function upsertSources(
  schoolId: string,
  sources: Array<Record<string, unknown>>,
  fallbackTime: string | null,
): void {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const url = safeUrl(source.final_url || source.requested_url);
    if (!url) continue;
    const status = cleanText(source.status ?? "unknown") || "unknown";
    const retrieved =
      typeof source.retrieved_at_utc === "string"
        ? source.retrieved_at_utc
        : fallbackTime;
    const verified = status === "fetched" ? retrieved : null;
    const httpStatus =
      typeof source.http_status === "number" ? source.http_status : null;
    const fields = Array.isArray(source.fields)
      ? source.fields.filter((f): f is string => typeof f === "string")
      : [];
    const error = typeof source.error === "string" ? source.error : null;
    const key = `${schoolId}::${url}`;
    const prev = collectionSources.get(key);
    collectionSources.set(key, {
      university_id: schoolId,
      url,
      domain: new URL(url).hostname.toLowerCase(),
      status,
      http_status: httpStatus,
      fields,
      retrieved_at: retrieved,
      last_verified_at: verified ?? prev?.last_verified_at ?? null,
      error,
    });
  }
}

export function importRecords(records: Array<Record<string, unknown>>): number {
  for (const record of records) {
    const name = String(record.university_name ?? "").trim();
    const campus = String(record.campus_location ?? "").trim();
    const [schoolId, shortName, city, sector, color] = identityFor(
      name,
      campus,
    );
    const existing = universities.get(schoolId);
    const evidence: Record<string, unknown> = {};
    for (const key of [
      ...EVIDENCE_FIELDS,
      "source_notes",
      "errors",
      "missing_fields",
    ]) {
      evidence[key] = Array.isArray(record[key]) ? record[key] : [];
    }
    evidence.source_notes = collectionNotes({ ...record, ...evidence });
    const sources = Array.isArray(record.sources)
      ? (record.sources as Array<Record<string, unknown>>)
      : [];

    const structuredInput: Record<string, unknown> = { ...record, ...evidence };
    delete structuredInput.structured;
    const structured = structureRecord(structuredInput);

    const retrievedAt =
      typeof record.retrieved_at_utc === "string"
        ? record.retrieved_at_utc
        : null;
    const verifiedAt =
      record.collection_status !== "failed" ? retrievedAt : null;

    let official: string | null = null;
    for (const s of sources) {
      const candidate = safeUrl(s.final_url || s.requested_url);
      if (candidate) {
        official = candidate;
        break;
      }
    }
    official = official ?? existing?.official_url ?? null;

    const fetched = sources.some((s) => s.status === "fetched");
    const hasCurrentData =
      fetched ||
      [...EVIDENCE_FIELDS, "programs"].some(
        (k) => Array.isArray(record[k]) && (record[k] as unknown[]).length > 0,
      );
    const previouslyCollected =
      Boolean(existing) && existing!.collection_status !== "pending";
    const status = hasCurrentData
      ? "partial"
      : previouslyCollected
        ? existing!.collection_status
        : "pending";
    const collectedAt = hasCurrentData
      ? retrievedAt
      : existing?.collected_at ?? null;

    universities.set(schoolId, {
      id: schoolId,
      name,
      short_name: shortName,
      city,
      campus_location: campus,
      sector,
      color,
      official_url: official,
      sources,
      evidence,
      collection_status: status,
      collected_at: collectedAt,
      academic_year: structured.academic_year ?? existing?.academic_year ?? null,
      academic_years: structured.academic_years,
      last_verified_at: verifiedAt ?? existing?.last_verified_at ?? null,
    });

    const seenProgramIds = new Set<string>();
    const progs: ProgramRecord[] = [];
    for (const prog of structured.programs) {
      const programName = prog.name.replace(/\s+/g, " ").trim();
      const programId = sha256Hex(
        `${schoolId}:${programName.toLowerCase()}`,
      ).slice(0, 20);
      if (seenProgramIds.has(programId)) continue;
      seenProgramIds.add(programId);
      progs.push({
        id: programId,
        university_id: schoolId,
        name: programName,
        topic: topicFor(programName),
        strand_alignment: prog.strand_alignment,
        source_url: safeUrl(prog.source_url),
        academic_year: structured.academic_year,
        last_verified_at: verifiedAt,
      });
    }
    programsByUniversity.set(schoolId, progs);

    requirementsByUniversity.set(
      schoolId,
      structured.admission_requirements.map((r) => ({
        ...r,
        last_verified_at: verifiedAt,
      })),
    );
    deadlinesByUniversity.set(
      schoolId,
      structured.application_deadlines.map((d) => ({
        ...d,
        last_verified_at: verifiedAt,
      })),
    );
    examsByUniversity.set(
      schoolId,
      structured.entrance_examinations.map((e) => ({
        ...e,
        last_verified_at: verifiedAt,
      })),
    );
    feesByUniversity.set(
      schoolId,
      structured.tuition_fees.map((f) => ({
        ...f,
        last_verified_at: verifiedAt,
      })),
    );
    linksByUniversity.set(
      schoolId,
      structured.application_links
        .filter((l) => safeUrl(l.url) !== null)
        .map((l) => ({
          label: cleanText(l.label) || "Application page",
          url: safeUrl(l.url)!,
          source_url: safeUrl(l.source_url),
          last_verified_at: verifiedAt,
        })),
    );
    conflictsByUniversity.set(schoolId, structured.conflicts);
    upsertSources(schoolId, sources, retrievedAt);
  }
  return records.length;
}

export function initStore(): void {
  if (universities.size > 0) return;

  const configPath = path.join(ROOT, "config", "universities.json");
  if (fs.existsSync(configPath)) {
    const configured = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as Array<{
      name: string;
      campus_location: string;
      source_notes?: string[];
      pages: Array<{ url: string }>;
    }>;
    for (const source of configured) {
      const [schoolId, shortName, city, sector, color] = identityFor(
        source.name,
        source.campus_location,
      );
      const sourcesList = source.pages.map((p) => ({
        requested_url: p.url,
        status: "configured",
      }));
      universities.set(schoolId, {
        id: schoolId,
        name: source.name,
        short_name: shortName,
        city,
        campus_location: source.campus_location,
        sector,
        color,
        official_url: safeUrl(source.pages[0]?.url),
        sources: sourcesList,
        evidence: {
          source_notes: source.source_notes ?? [],
        },
        collection_status: "pending",
        collected_at: null,
        academic_year: null,
        academic_years: [],
        last_verified_at: null,
      });
      programsByUniversity.set(schoolId, []);
      requirementsByUniversity.set(schoolId, []);
      deadlinesByUniversity.set(schoolId, []);
      examsByUniversity.set(schoolId, []);
      feesByUniversity.set(schoolId, []);
      linksByUniversity.set(schoolId, []);
      conflictsByUniversity.set(schoolId, []);
      upsertSources(schoolId, sourcesList, null);
    }
  }

  const baselinePath = path.join(ROOT, "data", "baseline_universities.json");
  let baselineSupplements: Record<string, Record<string, unknown>> = {};
  if (fs.existsSync(baselinePath)) {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
      records?: Array<Record<string, unknown>>;
      supplements?: Record<string, Record<string, unknown>>;
    };
    if (Array.isArray(parsed.records) && parsed.records.length > 0) {
      importRecords(parsed.records);
    }
    if (parsed.supplements && typeof parsed.supplements === "object") {
      baselineSupplements = parsed.supplements;
    }
  }

  for (const folder of ["pup", "dlsu"]) {
    const samplePath = path.join(
      ROOT,
      "data",
      folder,
      "unimatch_ph_raw_data.json",
    );
    if (fs.existsSync(samplePath)) {
      const records = JSON.parse(
        fs.readFileSync(samplePath, "utf8"),
      ) as Array<Record<string, unknown>>;
      importRecords(records);
    }
  }

  // Merge verified supplements (e.g., DCAT/PUPCET, official links, RA 10931 for PUP)
  // without altering pre-collected raw JSON files or discarding existing programs/fees.
  for (const [schoolId, supplement] of Object.entries(baselineSupplements)) {
    const school = universities.get(schoolId);
    if (!school) continue;
    const structured = structureRecord({
      university_name: school.name,
      campus_location: school.campus_location,
      retrieved_at_utc: school.collected_at ?? "2026-11-21T00:00:00Z",
      ...supplement,
    });
    const verifiedAt = school.last_verified_at ?? "2026-11-21T00:00:00Z";

    if ((requirementsByUniversity.get(schoolId)?.length ?? 0) === 0 && structured.admission_requirements.length > 0) {
      requirementsByUniversity.set(
        schoolId,
        structured.admission_requirements.map((r) => ({ ...r, last_verified_at: verifiedAt })),
      );
      if (!Array.isArray(school.evidence.admission_requirements) || school.evidence.admission_requirements.length === 0) {
        school.evidence.admission_requirements = Array.isArray(supplement.admission_requirements)
          ? supplement.admission_requirements
          : [];
      }
    }
    if ((examsByUniversity.get(schoolId)?.length ?? 0) === 0 && structured.entrance_examinations.length > 0) {
      examsByUniversity.set(
        schoolId,
        structured.entrance_examinations.map((e) => ({ ...e, last_verified_at: verifiedAt })),
      );
      if (!Array.isArray(school.evidence.entrance_exam_coverage) || school.evidence.entrance_exam_coverage.length === 0) {
        school.evidence.entrance_exam_coverage = Array.isArray(supplement.entrance_exam_coverage)
          ? supplement.entrance_exam_coverage
          : [];
      }
    }
    if ((feesByUniversity.get(schoolId)?.length ?? 0) === 0 && structured.tuition_fees.length > 0) {
      feesByUniversity.set(
        schoolId,
        structured.tuition_fees.map((f) => ({ ...f, last_verified_at: verifiedAt })),
      );
      if (!Array.isArray(school.evidence.tuition_estimates) || school.evidence.tuition_estimates.length === 0) {
        school.evidence.tuition_estimates = Array.isArray(supplement.tuition_estimates)
          ? supplement.tuition_estimates
          : [];
      }
    }
    if ((linksByUniversity.get(schoolId)?.length ?? 0) === 0 && structured.application_links.length > 0) {
      linksByUniversity.set(
        schoolId,
        structured.application_links
          .filter((l) => safeUrl(l.url) !== null)
          .map((l) => ({
            label: cleanText(l.label) || "Application page",
            url: safeUrl(l.url)!,
            source_url: safeUrl(l.source_url),
            last_verified_at: verifiedAt,
          })),
      );
    }
    if (Array.isArray(supplement.source_notes)) {
      const existingNotes = Array.isArray(school.evidence.source_notes)
        ? (school.evidence.source_notes as string[])
        : [];
      const extraNotes = supplement.source_notes.filter((n): n is string => typeof n === "string");
      school.evidence.source_notes = Array.from(new Set([...existingNotes, ...extraNotes]));
    }
  }
}

export function loadStructured(schoolId: string) {
  const school = universities.get(schoolId);
  if (!school) return null;

  const sourceUrls: string[] = [];
  for (const s of school.sources) {
    for (const key of ["final_url", "requested_url"]) {
      const url = safeUrl(s[key]);
      if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
    }
  }

  const deadlines = [...(deadlinesByUniversity.get(schoolId) ?? [])].sort(
    (a, b) => {
      if ((a.date_iso === null) !== (b.date_iso === null)) {
        return a.date_iso === null ? 1 : -1;
      }
      if (a.date_iso && b.date_iso && a.date_iso !== b.date_iso) {
        return a.date_iso.localeCompare(b.date_iso);
      }
      return a.label.localeCompare(b.label);
    },
  );

  return {
    academic_year: school.academic_year,
    academic_years: school.academic_years,
    last_verified_at: school.last_verified_at,
    source_urls: sourceUrls,
    admission_requirements: requirementsByUniversity.get(schoolId) ?? [],
    application_deadlines: deadlines,
    entrance_examinations: examsByUniversity.get(schoolId) ?? [],
    tuition_fees: feesByUniversity.get(schoolId) ?? [],
    application_links: linksByUniversity.get(schoolId) ?? [],
  };
}

export function serializeSchool(school: UniversityRecord, detail = false) {
  const programCount = (programsByUniversity.get(school.id) ?? []).length;
  const structuredFees = feesByUniversity.get(school.id) ?? [];
  const structuredExams = examsByUniversity.get(school.id) ?? [];
  const structuredFeeAmountCount = structuredFees.filter(
    (f) => typeof f.amount_min === "number" || typeof f.amount_max === "number",
  ).length;
  const freeTuition = structuredFees.some(
    (f) => f.amount_min === 0 && f.amount_max === 0,
  );
  const firstExam = structuredExams[0];
  let examSummary: string | null = null;
  if (firstExam) {
    const cov = String(firstExam.coverage || "");
    if (/waived/i.test(cov) && !/except/i.test(cov)) {
      examSummary = "Exam waived";
    } else if (/waived/i.test(cov) && /except/i.test(cov)) {
      examSummary = firstExam.exam_name ? `${firstExam.exam_name} (mostly waived)` : "Mostly waived";
    } else {
      examSummary = firstExam.exam_name || "Required";
    }
  }
  const base: Record<string, unknown> = {
    id: school.id,
    name: school.name,
    short_name: school.short_name,
    city: school.city,
    campus_location: school.campus_location,
    sector: school.sector,
    color: school.color,
    official_url: safeUrl(school.official_url),
    collection_status: school.collection_status,
    collected_at: school.collected_at,
    academic_year: school.academic_year,
    academic_years_json: JSON.stringify(school.academic_years),
    last_verified_at: school.last_verified_at,
    program_count: programCount,
    review_required: true,
    tuition_evidence_count: Math.max(
      Array.isArray(school.evidence.tuition_estimates)
        ? school.evidence.tuition_estimates.length
        : 0,
      structuredFees.length,
    ),
    tuition_amount_count: Math.max(
      tuitionAmountCount(school.evidence.tuition_estimates),
      structuredFeeAmountCount,
    ),
    free_tuition: freeTuition,
    exam_summary: examSummary,
  };

  if (detail) {
    base.sources = school.sources;
    base.evidence = school.evidence;
  } else {
    base.source_notes = Array.isArray(school.evidence.source_notes)
      ? school.evidence.source_notes
      : [];
  }
  return base;
}

export function datasetStats() {
  const allSchools = Array.from(universities.values());
  let programCount = 0;
  const topicSet = new Set<string>();
  const citySet = new Set<string>();
  let latestCollection: string | null = null;
  let requirementsCount = 0;
  let deadlinesCount = 0;
  let examsCount = 0;
  let feesCount = 0;

  for (const s of allSchools) {
    citySet.add(s.city);
    if (s.collected_at && (!latestCollection || s.collected_at > latestCollection)) {
      latestCollection = s.collected_at;
    }
    const progs = programsByUniversity.get(s.id) ?? [];
    programCount += progs.length;
    for (const p of progs) topicSet.add(p.topic);
    requirementsCount += (requirementsByUniversity.get(s.id) ?? []).length;
    deadlinesCount += (deadlinesByUniversity.get(s.id) ?? []).length;
    examsCount += (examsByUniversity.get(s.id) ?? []).length;
    feesCount += (feesByUniversity.get(s.id) ?? []).length;
  }

  return {
    universities: allSchools.length,
    programs: programCount,
    collected_universities: allSchools.filter(
      (s) => s.collection_status !== "pending",
    ).length,
    cities: Array.from(citySet).sort(),
    topics: Array.from(topicSet).sort(),
    latest_collection: latestCollection,
    requirements: requirementsCount,
    deadlines: deadlinesCount,
    examinations: examsCount,
    tuition_records: feesCount,
    tracked_sources: collectionSources.size,
  };
}

export function queryUniversities(
  search = "",
  city = "",
  sector = "",
  sort = "featured",
) {
  if (!["name", "programs", "featured"].includes(sort)) {
    throw new Error("Unknown sort order");
  }
  const q = search.toLowerCase();
  const matched = Array.from(universities.values()).filter((u) => {
    if (city && u.city !== city) return false;
    if (sector && u.sector !== sector) return false;
    if (q) {
      const hay = `${u.name} ${u.short_name} ${u.campus_location}`.toLowerCase();
      const progs = programsByUniversity.get(u.id) ?? [];
      if (
        !hay.includes(q) &&
        !progs.some((p) => p.name.toLowerCase().includes(q))
      ) {
        return false;
      }
    }
    return true;
  });

  matched.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    const countA = (programsByUniversity.get(a.id) ?? []).length;
    const countB = (programsByUniversity.get(b.id) ?? []).length;
    if (countB !== countA) return countB - countA;
    return a.name.localeCompare(b.name);
  });

  return matched.map((u) => serializeSchool(u, false));
}

export function getUniversityDetail(schoolId: string) {
  const school = universities.get(schoolId);
  if (!school) return null;
  const item = serializeSchool(school, true);
  const progs = [...(programsByUniversity.get(schoolId) ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const structured = loadStructured(schoolId);
  const conflicts = [...(conflictsByUniversity.get(schoolId) ?? [])].sort(
    (a, b) =>
      a.field.localeCompare(b.field) ||
      a.kept_value.localeCompare(b.kept_value),
  );

  item.programs = progs;
  item.structured = structured;
  item.declared_conflicts = conflicts;
  item.profile = {
    university_name: school.name,
    campus_location: school.campus_location,
    academic_year: structured ? structured.academic_year : null,
    academic_years: structured ? structured.academic_years : [],
    source_urls: structured ? structured.source_urls : [],
    application_urls: (structured ? structured.application_links : [])
      .map((l) => l.url)
      .filter(Boolean),
    last_verified_at:
      (structured && structured.last_verified_at) || school.last_verified_at,
    availability: {
      admission_requirements: Boolean(
        structured && structured.admission_requirements.length > 0,
      ),
      application_deadlines: Boolean(
        structured && structured.application_deadlines.length > 0,
      ),
      entrance_examinations: Boolean(
        structured && structured.entrance_examinations.length > 0,
      ),
      tuition_fees: Boolean(structured && structured.tuition_fees.length > 0),
      application_links: Boolean(
        structured && structured.application_links.length > 0,
      ),
    },
  };
  return item;
}

export function queryPrograms(
  search = "",
  schoolId = "",
  topic = "",
  page = 1,
  limit = 12,
) {
  const q = search.toLowerCase();
  const joined: Array<
    ProgramRecord & {
      university_name: string;
      short_name: string;
      city: string;
      color: string;
    }
  > = [];

  for (const [uid, progs] of programsByUniversity.entries()) {
    if (schoolId && uid !== schoolId) continue;
    const u = universities.get(uid);
    if (!u) continue;
    for (const p of progs) {
      if (topic && p.topic !== topic) continue;
      if (q) {
        const hay = `${p.name} ${u.name} ${u.short_name}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      joined.push({
        ...p,
        university_name: u.name,
        short_name: u.short_name,
        city: u.city,
        color: u.color,
      });
    }
  }

  joined.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const start = (page - 1) * limit;
  return {
    items: joined.slice(start, start + limit),
    total: joined.length,
    page,
    limit,
  };
}

export function recommendationCandidates(): CandidateInput[] {
  const sortedSchools = Array.from(universities.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const candidates: CandidateInput[] = [];

  for (const u of sortedSchools) {
    const fees = [...(feesByUniversity.get(u.id) ?? [])]
      .sort((a, b) => {
        if ((a.amount_min === null) !== (b.amount_min === null)) {
          return a.amount_min === null ? 1 : -1;
        }
        return (a.amount_min ?? 0) - (b.amount_min ?? 0);
      })
      .map((f) => ({
        amount_min: f.amount_min,
        amount_max: f.amount_max,
        basis: f.basis,
        raw_text: f.raw_text,
      }));
    const progs = [...(programsByUniversity.get(u.id) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (progs.length === 0) {
      candidates.push({
        university_id: u.id,
        university_name: u.name,
        short_name: u.short_name,
        city: u.city,
        campus_location: u.campus_location,
        sector: u.sector,
        program_count: 0,
        program_id: null,
        program_name: null,
        topic: null,
        fees,
      });
    } else {
      for (const p of progs) {
        candidates.push({
          university_id: u.id,
          university_name: u.name,
          short_name: u.short_name,
          city: u.city,
          campus_location: u.campus_location,
          sector: u.sector,
          program_count: progs.length,
          program_id: p.id,
          program_name: p.name,
          topic: p.topic,
          fees,
        });
      }
    }
  }
  return candidates;
}

export function rankedRecommendations(
  preferences: Record<string, unknown>,
  weights?: Record<string, unknown> | null,
  limit = 20,
): RecommendationResponse {
  let candidates = recommendationCandidates();
  if (!preferences.program) {
    const seen = new Set<string>();
    const perUniversity: CandidateInput[] = [];
    for (const c of candidates) {
      if (seen.has(c.university_id)) continue;
      seen.add(c.university_id);
      perUniversity.push({
        ...c,
        program_id: null,
        program_name: null,
        topic: null,
      });
    }
    candidates = perUniversity;
  }
  return recommend(candidates, preferences, weights, limit);
}

export function collectionHistory(limit = 10) {
  const runs = [...collectionRuns]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit);
  const sources = Array.from(collectionSources.values())
    .sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) || a.url.localeCompare(b.url),
    )
    .map((s) => ({
      university_id: s.university_id,
      url: s.url,
      domain: s.domain,
      status: s.status,
      http_status: s.http_status,
      retrieved_at: s.retrieved_at,
      last_verified_at: s.last_verified_at,
      error: s.error,
    }));
  return { runs, sources };
}

export interface RuntimeCatalogSyncInput {
  id: string;
  name: string;
  shortName: string;
  city: string;
  campusLocation: string;
  sector: string;
  color: string;
  officialUrl: string;
  collectionStatus: string;
  academicYear: string;
  academicYears: string[];
  isPublished: boolean;
  programs: Array<{
    id: string;
    name: string;
    topic: string;
    strandAlignment: string;
    sourceUrl: string;
  }>;
  admissionRequirements: Array<{
    text: string;
    category: string;
    academicYear: string;
    sourceUrl: string;
  }>;
  applicationDeadlines: Array<{
    label: string;
    dateIso: string;
    rawText: string;
    academicYear: string;
    sourceUrl: string;
  }>;
  entranceExaminations: Array<{
    examName: string;
    coverage: string;
    academicYear: string;
    sourceUrl: string;
  }>;
  tuitionFees: Array<{
    amountMin: number | null;
    amountMax: number | null;
    currency: string;
    basis: string;
    rawText: string;
    academicYear: string;
    sourceUrl: string;
  }>;
  applicationLinks: Array<{
    label: string;
    url: string;
    sourceUrl: string;
  }>;
  declaredConflicts: Array<{
    field: string;
    keptValue: string;
    discardedValue: string;
    keptSourceUrl?: string;
    discardedSourceUrl?: string;
    reason: string;
  }>;
  sourceUrls: string[];
  sourceNotes: string[];
  collectedAt: string;
  lastVerifiedAt: string;
}

export function removeRuntimeUniversity(schoolId: string): void {
  universities.delete(schoolId);
  programsByUniversity.delete(schoolId);
  requirementsByUniversity.delete(schoolId);
  deadlinesByUniversity.delete(schoolId);
  examsByUniversity.delete(schoolId);
  feesByUniversity.delete(schoolId);
  linksByUniversity.delete(schoolId);
  conflictsByUniversity.delete(schoolId);
  for (const key of Array.from(collectionSources.keys())) {
    if (key.startsWith(`${schoolId}::`)) {
      collectionSources.delete(key);
    }
  }
}

export function upsertRuntimeUniversityFromCatalog(
  record: RuntimeCatalogSyncInput,
): void {
  const schoolId = record.id;
  if (!record.isPublished) {
    removeRuntimeUniversity(schoolId);
    return;
  }

  const existing = universities.get(schoolId);
  const official = safeUrl(record.officialUrl) ?? null;
  const collectedAt = record.collectedAt || existing?.collected_at || new Date().toISOString();
  const verifiedAt = record.lastVerifiedAt || collectedAt;

  const sourcesList: Array<Record<string, unknown>> = record.sourceUrls
    .map((u) => safeUrl(u))
    .filter((u): u is string => Boolean(u))
    .map((url) => ({
      requested_url: url,
      final_url: url,
      status: "fetched",
      retrieved_at_utc: verifiedAt,
    }));

  if (official && !sourcesList.some((s) => s.final_url === official)) {
    sourcesList.unshift({
      requested_url: official,
      final_url: official,
      status: "fetched",
      retrieved_at_utc: verifiedAt,
    });
  }

  const existingEvidence = existing?.evidence ?? {};
  const evidence: Record<string, unknown> = {
    ...existingEvidence,
    source_notes: record.sourceNotes,
  };

  universities.set(schoolId, {
    id: schoolId,
    name: record.name,
    short_name: record.shortName,
    city: record.city,
    campus_location: record.campusLocation,
    sector: record.sector,
    color: record.color,
    official_url: official,
    sources: sourcesList.length > 0 ? sourcesList : (existing?.sources ?? []),
    evidence,
    collection_status: record.collectionStatus,
    collected_at: collectedAt,
    academic_year: record.academicYear || null,
    academic_years: record.academicYears,
    last_verified_at: verifiedAt,
  });

  const progs: ProgramRecord[] = [];
  const seenIds = new Set<string>();
  for (const p of record.programs) {
    const cleanName = p.name.replace(/\s+/g, " ").trim();
    if (!cleanName) continue;
    const pid =
      p.id ||
      sha256Hex(`${schoolId}:${cleanName.toLowerCase()}`).slice(0, 20);
    if (seenIds.has(pid)) continue;
    seenIds.add(pid);
    progs.push({
      id: pid,
      university_id: schoolId,
      name: cleanName,
      topic: p.topic || topicFor(cleanName),
      strand_alignment: p.strandAlignment || null,
      source_url: safeUrl(p.sourceUrl),
      academic_year: record.academicYear || null,
      last_verified_at: verifiedAt,
    });
  }
  programsByUniversity.set(schoolId, progs);

  requirementsByUniversity.set(
    schoolId,
    record.admissionRequirements.map((r) => ({
      text: r.text,
      category: r.category || "general",
      academic_year: r.academicYear || null,
      source_url: safeUrl(r.sourceUrl),
      last_verified_at: verifiedAt,
    })),
  );

  deadlinesByUniversity.set(
    schoolId,
    record.applicationDeadlines.map((d) => ({
      label: d.label,
      date_iso: d.dateIso || null,
      raw_text: d.rawText,
      academic_year: d.academicYear || null,
      source_url: safeUrl(d.sourceUrl),
      last_verified_at: verifiedAt,
    })),
  );

  examsByUniversity.set(
    schoolId,
    record.entranceExaminations.map((e) => ({
      exam_name: e.examName || null,
      coverage: e.coverage,
      academic_year: e.academicYear || null,
      source_url: safeUrl(e.sourceUrl),
      last_verified_at: verifiedAt,
    })),
  );

  feesByUniversity.set(
    schoolId,
    record.tuitionFees.map((f) => ({
      amount_min: f.amountMin,
      amount_max: f.amountMax,
      currency: f.currency || "PHP",
      basis: f.basis || "unspecified",
      raw_text: f.rawText,
      academic_year: f.academicYear || null,
      source_url: safeUrl(f.sourceUrl),
      last_verified_at: verifiedAt,
    })),
  );

  linksByUniversity.set(
    schoolId,
    record.applicationLinks
      .filter((l) => safeUrl(l.url) !== null)
      .map((l) => ({
        label: cleanText(l.label) || "Application page",
        url: safeUrl(l.url)!,
        source_url: safeUrl(l.sourceUrl),
        last_verified_at: verifiedAt,
      })),
  );

  conflictsByUniversity.set(
    schoolId,
    record.declaredConflicts.map((c) => ({
      field: c.field,
      kept_value: c.keptValue,
      discarded_value: c.discardedValue,
      kept_source_url: safeUrl(c.keptSourceUrl),
      discarded_source_url: safeUrl(c.discardedSourceUrl),
      reason: c.reason,
    })),
  );

  upsertSources(schoolId, sourcesList, verifiedAt);
}

