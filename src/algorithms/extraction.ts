/**
 * Algorithm 1 — keyword-based NLP extraction and categorisation.
 *
 * Turns collector text blocks into structured admissions records with
 * normalised academic years, dates, fees, requirements, exams, links and conflicts.
 */

export const ALGORITHM_VERSION = "keyword-extraction-v1";

export const EVIDENCE_FIELDS = [
  "tuition_estimates",
  "admission_requirements",
  "entrance_exam_coverage",
  "application_deadlines",
  "application_status",
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS);

const MONTH_TOKEN_LIST = Array.from(
  new Set([
    ...MONTH_NAMES,
    ...MONTH_NAMES.map((m) => m.slice(0, 3)),
    "sept",
  ]),
).sort((a, b) => b.length - a.length);

const MONTH_TOKEN = `(?:${MONTH_TOKEN_LIST.join("|")})\\.?`;

const ACADEMIC_YEAR_RE =
  /\b(?:A\.?\s?Y\.?|S\.?\s?Y\.?|Academic\s+Year)\s*[:.]?\s*(20\d{2})\s*[-–—/]\s*(20\d{2}|\d{2})\b/gi;

const DOCUMENT_WORDS =
  /\b(?:form|document|card|transcript|diploma|certificate|photo|essay|recommendation|record|clearance|id)\b/i;

const ELIGIBILITY_WORDS =
  /\beligib(?:le|ility)\b|\bgrade\b|\bgpa\b|\bstrand\b|\brequired\s+subjects?\b|\bresidency\b|\bcitizen/i;

const EXAM_WORDS = /\bexam(?:ination)?\b|\btest\b|\bupcat\b|\bpupcet\b/i;

const KNOWN_EXAMS = [
  "UPCAT",
  "PUPCET",
  "DCAT",
  "USTET",
  "DLSUCET",
  "ACET",
  "BUCET",
  "SSCAT",
  "TUPCET",
  "PLMEE",
  "UST Entrance Test",
  "DLSU College Admission Test",
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXAM_ACRONYM = new RegExp(
  `\\b(${KNOWN_EXAMS.map(escapeRegExp).join("|")})\\b`,
  "i",
);
const GENERIC_EXAM =
  /\b([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,4}\s+(?:Entrance|Admission|College)\s+(?:Test|Examination))\b/;
const SHORT_EXAM = /\b([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]+)?\s+Test)\b/;

const BOILERPLATE =
  /cookie|privacy\s+policy|skip\s+to\s+(?:main\s+)?content|all\s+rights\s+reserved|enable\s+javascript|javascript:|back\s+to\s+top|©|terms\s+of\s+use/i;

const REQUIREMENT_PREFIX =
  /^\s*(?:[-•●▪*–—]|\d{1,2}[.)]|\((?:[a-z]|\d{1,2})\))\s*/i;
const NUMBERED_REQUIREMENT_GLOBAL = /(?:^|\s)\d{1,2}[.)]\s+/g;
const NUMBERED_REQUIREMENT_SPLIT = /(?:^|\s)\d{1,2}[.)]\s+/;

const FEE_BASIS_PATTERNS: Array<[string, RegExp]> = [
  ["semester", /per\s+semester|\/\s*semester|each\s+semester/i],
  ["trimester", /per\s+trimester|\/\s*trimester/i],
  ["unit", /per\s+unit|\/\s*unit/i],
  ["year", /per\s+(?:academic\s+)?year|annual|\/\s*year/i],
];

const SECTION_LABELS: Record<string, string[]> = {
  tuition_estimates: ["tuition fees", "school fees"],
  application_deadlines: ["application deadlines", "important dates"],
  entrance_exam_coverage: [
    "entrance examination coverage",
    "exam coverage",
    "test coverage",
    "test components",
    "subtests",
  ],
  admission_requirements: ["admission requirements", "application requirements"],
};

export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function stripHeadingLabel(text: string, labels: string[]): string {
  const cleaned = cleanText(text);
  for (const label of labels) {
    const re = new RegExp(`^${escapeRegExp(label)}\\s*[:.\\-–—]?\\s*`, "i");
    const match = re.exec(cleaned);
    if (match) {
      const trimmed = cleaned.slice(match[0].length).trim();
      if (trimmed) return trimmed;
    }
  }
  return cleaned;
}

export function normalizeKey(value: unknown): string {
  const text = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

export function stripBoilerplate(text: unknown): string {
  if (typeof text !== "string") return "";
  const lines = text.split(/[\r\n]+/).filter((line) => line.trim());
  const kept = lines.filter((line) => !BOILERPLATE.test(line));
  return cleanText(kept.join(" "));
}

function makeIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function monthFromToken(token: string): number | null {
  const lower = token.toLowerCase().replace(/\.$/, "");
  for (const [key, val] of Object.entries(MONTHS)) {
    if (key.startsWith(lower)) return val;
  }
  return null;
}

export function normalizedDates(text: string): string[] {
  const dates = new Set<string>();

  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const iso = makeIsoDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
    if (iso) dates.add(iso);
  }

  const mdyRe = new RegExp(
    `\\b(${MONTH_TOKEN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(20\\d{2})\\b`,
    "gi",
  );
  for (const match of text.matchAll(mdyRe)) {
    const month = monthFromToken(match[1]);
    if (month) {
      const iso = makeIsoDate(Number(match[3]), month, Number(match[2]));
      if (iso) dates.add(iso);
    }
  }

  const dmyRe = new RegExp(
    `\\b(\\d{1,2})\\s+(${MONTH_TOKEN})\\s+(20\\d{2})\\b`,
    "gi",
  );
  for (const match of text.matchAll(dmyRe)) {
    const month = monthFromToken(match[2]);
    if (month) {
      const iso = makeIsoDate(Number(match[3]), month, Number(match[1]));
      if (iso) dates.add(iso);
    }
  }

  return Array.from(dates).sort();
}

export function academicYearsFromText(text: string): string[] {
  const years: string[] = [];
  if (!text) return years;
  ACADEMIC_YEAR_RE.lastIndex = 0;
  for (const match of text.matchAll(ACADEMIC_YEAR_RE)) {
    const start = match[1];
    const end = match[2];
    const finish = end.length === 4 ? end : `${start.slice(0, 2)}${end}`;
    const value = `${start}-${finish}`;
    if (!years.includes(value)) years.push(value);
  }
  return years;
}

export function collectAcademicYears(texts: string[]): string[] {
  const years: string[] = [];
  for (const text of texts) {
    for (const year of academicYearsFromText(text)) {
      if (!years.includes(year)) years.push(year);
    }
  }
  return years;
}

export function resolveAcademicYear(
  texts: string[],
): [string | null, string[]] {
  const years = collectAcademicYears(texts);
  return [years.length === 1 ? years[0] : null, years];
}

function firstYear(text: string): string | null {
  const years = academicYearsFromText(text);
  return years.length === 1 ? years[0] : null;
}

function classifyRequirement(text: string): string {
  if (EXAM_WORDS.test(text)) return "entrance_exam";
  if (DOCUMENT_WORDS.test(text)) return "document";
  if (ELIGIBILITY_WORDS.test(text)) return "eligibility";
  return "general";
}

function normalizeRequirement(text: string): string {
  let cleaned = cleanText(text);
  cleaned = cleaned.replace(REQUIREMENT_PREFIX, "").trim();
  cleaned = cleaned.replace(/^[;:,]+|[;:,]+$/g, "").trim();
  return cleaned;
}

export function splitRequirementStatements(text: string): string[] {
  let cleaned = stripBoilerplate(text);
  if (!cleaned) return [];
  let parts: string[];
  const numberedMatches = cleaned.match(NUMBERED_REQUIREMENT_GLOBAL) ?? [];
  const yourMatches = cleaned.match(/\bYour\b/g) ?? [];
  if (numberedMatches.length >= 2) {
    parts = cleaned.split(NUMBERED_REQUIREMENT_SPLIT);
  } else if (yourMatches.length >= 2) {
    const first = /\bYour\b/.exec(cleaned);
    if (first && /:\s*$/.test(cleaned.slice(0, first.index))) {
      cleaned = cleaned.slice(first.index);
    }
    parts = cleaned.split(/\s+(?=Your\b)/);
  } else {
    parts = cleaned.split(/\s*;\s*|\s*\n+\s*/);
  }
  const statements: string[] = [];
  for (const part of parts) {
    const statement = normalizeRequirement(part);
    if (
      statement.length >= 3 &&
      statement.length <= 1200 &&
      /[A-Za-z]/.test(statement)
    ) {
      statements.push(statement);
    }
  }
  return statements;
}

function focusNearKeyword(
  text: string,
  pattern: RegExp,
  before = 120,
  after = 260,
): string {
  const match = pattern.exec(text);
  if (!match) return text;
  const start = Math.max(0, match.index - before);
  return cleanText(text.slice(start, match.index + match[0].length + after));
}

function deadlineLabel(text: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/late\s+documents?/i, "Late document submission"],
    [/submission\s+of\s+(?:documents|requirements)/i, "Document submission"],
    [/exam(?:ination)?\s+(?:date|schedule)/i, "Entrance examination date"],
    [/application\s+(?:period|window)/i, "Application period"],
    [/deadline|due\s+date|closing\s+date|last\s+day/i, "Application deadline"],
    [/opening|starts?/i, "Application opening"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }
  return "Application date (verify meaning)";
}

function dateWindow(text: string, dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) return text;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  const monthName = MONTH_NAMES[monthIdx];
  if (!monthName) return text;
  const monthPattern = `(?:${escapeRegExp(monthName)}|${escapeRegExp(monthName.slice(0, 3))})\\.?`;
  const re = new RegExp(
    `(?:(?:${monthPattern})\\s+${day}(?:st|nd|rd|th)?,?\\s+${year}|${day}\\s+(?:${monthPattern})\\s+${year}|${escapeRegExp(dateIso)})`,
    "i",
  );
  const match = re.exec(text);
  return match ? text.slice(Math.max(0, match.index - 110), match.index) : text;
}

function examName(text: string): string | null {
  const match =
    EXAM_ACRONYM.exec(text) ||
    GENERIC_EXAM.exec(text) ||
    SHORT_EXAM.exec(text);
  if (!match) return null;
  const name = cleanText(match[1]);
  if (["test", "exam", "examination"].includes(name.toLowerCase())) return null;
  return name;
}

function feeBasis(text: string, fallback?: unknown): string {
  const bases = FEE_BASIS_PATTERNS.filter(([, re]) => re.test(text || "")).map(
    ([name]) => name,
  );
  if (bases.length === 1) return bases[0];
  if (bases.length > 1) return "unspecified";
  if (
    typeof fallback === "string" &&
    ["semester", "trimester", "unit", "year"].includes(fallback)
  ) {
    return fallback;
  }
  return "unspecified";
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

export interface RequirementRow {
  text: string;
  category: string;
  academic_year: string | null;
  source_url: string | null;
  last_verified_at?: string | null;
}

export interface DeadlineRow {
  label: string;
  date_iso: string | null;
  raw_text: string;
  academic_year: string | null;
  source_url: string | null;
  last_verified_at?: string | null;
}

export interface ExamRow {
  exam_name: string | null;
  coverage: string;
  academic_year: string | null;
  source_url: string | null;
  last_verified_at?: string | null;
}

export interface FeeRow {
  amount_min: number | null;
  amount_max: number | null;
  currency: string | null;
  basis: string;
  raw_text: string;
  academic_year: string | null;
  source_url: string | null;
  last_verified_at?: string | null;
}

export interface ApplicationLinkRow {
  label: string;
  url: string;
  source_url: string | null;
  last_verified_at?: string | null;
}

export interface ConflictRow {
  field: string;
  kept_value: string;
  discarded_value: string;
  reason: string;
}

export interface StructuredProfile {
  algorithm: string;
  university_name: string;
  campus_location: string;
  detected_name: string | null;
  academic_year: string | null;
  academic_years: string[];
  programs: Array<{
    name: string;
    strand_alignment: string | null;
    source_url: string | null;
  }>;
  admission_requirements: RequirementRow[];
  application_deadlines: DeadlineRow[];
  entrance_examinations: ExamRow[];
  tuition_fees: FeeRow[];
  application_links: ApplicationLinkRow[];
  source_urls: string[];
  last_verified_at: string | null;
  conflicts: ConflictRow[];
  missing: {
    admission_requirements: boolean;
    application_deadlines: boolean;
    entrance_examinations: boolean;
    tuition_fees: boolean;
    application_links: boolean;
    academic_year: boolean;
  };
}

function buildRequirements(
  items: unknown[],
  defaultYear: string | null = null,
): RequirementRow[] {
  const rows: RequirementRow[] = [];
  for (const raw of items) {
    const item =
      typeof raw === "string"
        ? { text: raw }
        : raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : null;
    if (!item) continue;
    const text = stripHeadingLabel(
      String(item.text ?? ""),
      SECTION_LABELS.admission_requirements,
    );
    if (!text) continue;
    const year =
      (typeof item.academic_year === "string" && item.academic_year) ||
      firstYear(text) ||
      defaultYear;
    for (const statement of splitRequirementStatements(text)) {
      rows.push({
        text: statement,
        category: classifyRequirement(statement),
        academic_year: year,
        source_url:
          typeof item.source_url === "string" ? item.source_url : null,
      });
    }
  }
  return rows;
}

function buildDeadlines(
  items: unknown[],
  defaultYear: string | null = null,
): DeadlineRow[] {
  const rows: DeadlineRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = stripHeadingLabel(
      String(item.text ?? ""),
      SECTION_LABELS.application_deadlines,
    );
    if (!text) continue;
    let dates = Array.isArray(item.dates_iso)
      ? (item.dates_iso as unknown[]).filter(
          (d): d is string => typeof d === "string",
        )
      : [];
    if (!dates.length) {
      dates = normalizedDates(text);
    }
    const year =
      (typeof item.academic_year === "string" && item.academic_year) ||
      firstYear(text) ||
      defaultYear;
    const sourceUrl =
      typeof item.source_url === "string" ? item.source_url : null;

    if (dates.length) {
      for (const date of dates) {
        const label =
          deadlineLabel(dateWindow(text, date)) || deadlineLabel(text);
        rows.push({
          label,
          date_iso: date,
          raw_text: text,
          academic_year: year,
          source_url: sourceUrl,
        });
      }
    } else {
      rows.push({
        label: deadlineLabel(text),
        date_iso: null,
        raw_text: text,
        academic_year: year,
        source_url: sourceUrl,
      });
    }
  }
  return rows;
}

function buildExams(
  items: unknown[],
  defaultYear: string | null = null,
): ExamRow[] {
  const rows: ExamRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = stripHeadingLabel(
      String(item.text ?? ""),
      SECTION_LABELS.entrance_exam_coverage,
    );
    if (!text) continue;
    const year =
      (typeof item.academic_year === "string" && item.academic_year) ||
      firstYear(text) ||
      defaultYear;
    rows.push({
      exam_name: examName(text),
      coverage: text,
      academic_year: year,
      source_url: typeof item.source_url === "string" ? item.source_url : null,
    });
  }
  return rows;
}

function buildFees(
  items: unknown[],
  defaultYear: string | null = null,
): FeeRow[] {
  const rows: FeeRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = stripHeadingLabel(
      String(item.text ?? ""),
      SECTION_LABELS.tuition_estimates,
    );
    if (!text) continue;
    const year =
      (typeof item.academic_year === "string" && item.academic_year) ||
      firstYear(text) ||
      defaultYear;
    const basis = feeBasis(text, item.basis);
    const sourceUrl =
      typeof item.source_url === "string" ? item.source_url : null;
    const explicit: Array<[number | null, number | null]> = [];
    if (Array.isArray(item.amounts)) {
      for (const amt of item.amounts) {
        if (!amt || typeof amt !== "object") continue;
        const a = amt as Record<string, unknown>;
        const low = finiteNumber(a.min_php ?? a.min);
        const high = finiteNumber(a.max_php ?? a.max);
        if (low !== null || high !== null) {
          explicit.push([low, high]);
        }
      }
    }
    if (explicit.length) {
      for (const [low, high] of explicit) {
        rows.push({
          amount_min: low,
          amount_max: high !== null ? high : low,
          currency: "PHP",
          basis,
          raw_text: text,
          academic_year: year,
          source_url: sourceUrl,
        });
      }
    } else {
      const summary =
        text.length <= 500
          ? text
          : focusNearKeyword(text, /tuition|school\s+fees?|\bfees?\b/i);
      rows.push({
        amount_min: null,
        amount_max: null,
        currency: null,
        basis,
        raw_text: summary,
        academic_year: year,
        source_url: sourceUrl,
      });
    }
  }
  return rows;
}

function rankTuple<T extends object>(
  item: T,
  priority: number,
  valueGetter: (item: T) => string,
): [number, number, number] {
  let completeness = 0;
  for (const [key, value] of Object.entries(item)) {
    if (key === "source_url" || key === "academic_year") continue;
    if (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      completeness += 1;
    }
  }
  return [priority, -completeness, -valueGetter(item).length];
}

function compareTuples(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function reconcile<T extends object>(
  items: T[],
  keyGetter: (item: T) => string,
  valueGetter: (item: T) => string,
  priorityGetter: (item: T) => number,
  fieldName: string,
): [T[], ConflictRow[]] {
  const winners = new Map<string, { order: number; item: T }>();
  const conflicts: ConflictRow[] = [];

  items.forEach((item, order) => {
    const key = keyGetter(item);
    if (!key) return;
    const existing = winners.get(key);
    if (!existing) {
      winners.set(key, { order, item });
      return;
    }
    const current = existing.item;
    const itemRank = rankTuple(item, priorityGetter(item), valueGetter);
    const currentRank = rankTuple(
      current,
      priorityGetter(current),
      valueGetter,
    );
    const [winner, loser] =
      compareTuples(itemRank, currentRank) < 0
        ? [item, current]
        : [current, item];
    winners.set(key, { order: existing.order, item: winner });
    const keptValue = valueGetter(winner);
    const discardedValue = valueGetter(loser);
    if (normalizeKey(keptValue) !== normalizeKey(discardedValue)) {
      conflicts.push({
        field: fieldName,
        kept_value: keptValue,
        discarded_value: discardedValue,
        reason:
          "Kept the higher-priority/more complete source value; the conflicting statement is preserved here for review.",
      });
    }
  });

  const ordered = Array.from(winners.values())
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.item);
  return [ordered, conflicts];
}

function dedupePrograms(
  programs: unknown[],
): Array<{
  name: string;
  strand_alignment: string | null;
  source_url: string | null;
}> {
  const rows: Array<{
    name: string;
    strand_alignment: string | null;
    source_url: string | null;
  }> = [];
  const seen = new Map<
    string,
    { name: string; strand_alignment: string | null; source_url: string | null }
  >();
  for (const raw of programs) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const name = cleanText(p.name ?? "");
    const key = normalizeKey(name);
    if (!key) continue;
    const row = {
      name,
      strand_alignment: cleanText(p.strand_alignment ?? "") || null,
      source_url: typeof p.source_url === "string" ? p.source_url : null,
    };
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, row);
      rows.push(row);
    } else if (!existing.strand_alignment && row.strand_alignment) {
      existing.strand_alignment = row.strand_alignment;
    }
  }
  return rows;
}

function sourcePriorityMap(
  record: Record<string, unknown>,
): Record<string, number> {
  const mapping: Record<string, number> = {};
  const sources = Array.isArray(record.sources) ? record.sources : [];
  sources.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const source = raw as Record<string, unknown>;
    for (const key of ["requested_url", "final_url"]) {
      const url = source[key];
      if (typeof url === "string" && url && !(url in mapping)) {
        mapping[url] = index;
      }
    }
  });
  return mapping;
}

function priorityFor(
  item: { source_url: string | null },
  priorities: Record<string, number>,
): number {
  return item.source_url && item.source_url in priorities
    ? priorities[item.source_url]
    : 100;
}

export function structureRecord(
  record: Record<string, unknown>,
  sourcePriority?: Record<string, number>,
): StructuredProfile {
  const existing = record.structured as Record<string, unknown> | undefined;
  if (
    existing &&
    typeof existing === "object" &&
    existing.algorithm === ALGORITHM_VERSION
  ) {
    return existing as unknown as StructuredProfile;
  }

  const priorities = sourcePriority ?? sourcePriorityMap(record);
  const evidence: Record<EvidenceField, unknown[]> = {
    tuition_estimates: Array.isArray(record.tuition_estimates)
      ? record.tuition_estimates
      : [],
    admission_requirements: Array.isArray(record.admission_requirements)
      ? record.admission_requirements
      : [],
    entrance_exam_coverage: Array.isArray(record.entrance_exam_coverage)
      ? record.entrance_exam_coverage
      : [],
    application_deadlines: Array.isArray(record.application_deadlines)
      ? record.application_deadlines
      : [],
    application_status: Array.isArray(record.application_status)
      ? record.application_status
      : [],
  };

  const allItems: Array<Record<string, unknown>> = [];
  for (const name of EVIDENCE_FIELDS) {
    for (const item of evidence[name]) {
      if (item && typeof item === "object") {
        allItems.push(item as Record<string, unknown>);
      }
    }
  }

  const textPool: string[] = [
    cleanText(record.university_name ?? ""),
    cleanText(record.campus_location ?? ""),
  ];
  for (const item of allItems) {
    textPool.push(cleanText(item.text ?? ""));
    if (Array.isArray(item.source_context)) {
      for (const ctx of item.source_context) {
        textPool.push(cleanText(ctx));
      }
    }
  }
  if (Array.isArray(record.source_notes)) {
    for (const note of record.source_notes) {
      textPool.push(cleanText(note));
    }
  }

  const [academicYear, academicYears] = resolveAcademicYear(textPool);

  const reqInput =
    Array.isArray(record.requirement_items) && record.requirement_items.length
      ? record.requirement_items
      : evidence.admission_requirements;
  const [requirements, requirementConflicts] = reconcile(
    buildRequirements(reqInput, academicYear),
    (row) => normalizeKey(row.text),
    (row) => row.text,
    (row) => priorityFor(row, priorities),
    "admission_requirements",
  );

  const [deadlines, deadlineConflicts] = reconcile(
    buildDeadlines(evidence.application_deadlines, academicYear),
    (row) => normalizeKey(`${row.label} ${row.date_iso || row.raw_text}`),
    (row) => `${row.date_iso || ""} ${row.raw_text}`,
    (row) => priorityFor(row, priorities),
    "application_deadlines",
  );

  const [exams, examConflicts] = reconcile(
    buildExams(evidence.entrance_exam_coverage, academicYear),
    (row) => normalizeKey(`${row.exam_name || ""} ${row.coverage}`),
    (row) => row.coverage,
    (row) => priorityFor(row, priorities),
    "entrance_examinations",
  );

  const [fees, feeConflicts] = reconcile(
    buildFees(evidence.tuition_estimates, academicYear),
    (row) =>
      normalizeKey(`${row.amount_min} ${row.amount_max} ${row.basis}`),
    (row) => row.raw_text,
    (row) => priorityFor(row, priorities),
    "tuition_fees",
  );

  const rawLinks = Array.isArray(record.application_links)
    ? record.application_links
    : [];
  const cleanLinks: ApplicationLinkRow[] = [];
  const seenLinks = new Set<string>();
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== "object") continue;
    const link = raw as Record<string, unknown>;
    const url = link.url;
    if (
      typeof url !== "string" ||
      (!url.startsWith("https://") && !url.startsWith("http://")) ||
      seenLinks.has(url)
    ) {
      continue;
    }
    seenLinks.add(url);
    cleanLinks.push({
      label: cleanText(link.label ?? "") || "Application page",
      url,
      source_url:
        typeof link.source_url === "string" ? link.source_url : null,
    });
  }

  const sourceUrls: string[] = [];
  const rawSources = Array.isArray(record.sources) ? record.sources : [];
  for (const raw of rawSources) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    for (const key of ["final_url", "requested_url"]) {
      const url = source[key];
      if (typeof url === "string" && url && !sourceUrls.includes(url)) {
        sourceUrls.push(url);
      }
    }
  }
  for (const item of allItems) {
    const url = item.source_url;
    if (typeof url === "string" && url && !sourceUrls.includes(url)) {
      sourceUrls.push(url);
    }
  }

  const verifiedAt =
    typeof record.retrieved_at_utc === "string"
      ? record.retrieved_at_utc
      : null;

  return {
    algorithm: ALGORITHM_VERSION,
    university_name: cleanText(record.university_name ?? ""),
    campus_location: cleanText(record.campus_location ?? ""),
    detected_name: cleanText(record.detected_name ?? "") || null,
    academic_year: academicYear,
    academic_years: academicYears,
    programs: dedupePrograms(
      Array.isArray(record.programs) ? record.programs : [],
    ),
    admission_requirements: requirements,
    application_deadlines: deadlines,
    entrance_examinations: exams,
    tuition_fees: fees,
    application_links: cleanLinks,
    source_urls: sourceUrls,
    last_verified_at: verifiedAt,
    conflicts: [
      ...requirementConflicts,
      ...deadlineConflicts,
      ...examConflicts,
      ...feeConflicts,
    ],
    missing: {
      admission_requirements: requirements.length === 0,
      application_deadlines: deadlines.length === 0,
      entrance_examinations: exams.length === 0,
      tuition_fees: fees.length === 0,
      application_links: cleanLinks.length === 0,
      academic_year: academicYear === null,
    },
  };
}
