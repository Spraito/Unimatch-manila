/**
 * Algorithm 2 — rule-based matching with weighted criteria.
 *
 * Ranks candidates via our hand-written stable merge sort (mergeSort.ts).
 */
import { cleanText, normalizeKey } from "./extraction.js";
import { mergeSort, mergeSortByScore } from "./mergeSort.js";

export const CRITERIA = ["program", "location", "budget", "sector"] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Record<Criterion, string> = {
  program: "Preferred program",
  location: "Preferred location",
  budget: "Budget fit",
  sector: "University type",
};

export const DEFAULT_WEIGHTS: Record<Criterion, number> = {
  program: 0.45,
  location: 0.2,
  budget: 0.2,
  sector: 0.15,
};

export const BUDGET_BASES = ["semester", "trimester", "year", "unit"] as const;

export const FORMULA =
  "score = 100 × Σ(weight[c] × points[c]) / Σ(weight[c]) over the criteria the student supplied. Missing data scores 0 and is labelled unknown.";

/**
 * Only grammatical filler words — discipline words like "science" and "arts"
 * are intentionally NOT stripped because degree prefixes ("Bachelor of Science in")
 * are removed separately before tokenization.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "bachelor",
  "bs",
  "ba",
  "ab",
  "degree",
  "for",
  "in",
  "major",
  "of",
  "program",
  "the",
  "with",
]);

/**
 * Common Philippine undergraduate degree abbreviations & aliases mapped to
 * canonical discipline names so student queries match official catalog titles.
 */
const PROGRAM_ALIASES: Record<string, string> = {
  cs: "computer science",
  compsci: "computer science",
  "comp sci": "computer science",
  bscs: "computer science",
  it: "information technology",
  bsit: "information technology",
  is: "information systems",
  bsis: "information systems",
  ce: "civil engineering",
  bsce: "civil engineering",
  cpe: "computer engineering",
  bscpe: "computer engineering",
  ee: "electrical engineering",
  bsee: "electrical engineering",
  ece: "electronics engineering",
  bsece: "electronics engineering",
  me: "mechanical engineering",
  bsme: "mechanical engineering",
  ie: "industrial engineering",
  bsie: "industrial engineering",
  che: "chemical engineering",
  bsche: "chemical engineering",
  bsa: "accountancy",
  accounting: "accountancy",
  bsn: "nursing",
  medtech: "medical technology",
  "med tech": "medical technology",
  bsmt: "medical technology",
  psych: "psychology",
  archi: "architecture",
  bsarch: "architecture",
  pharma: "pharmacy",
  dentistry: "dental medicine",
  dmd: "dental medicine",
  polsci: "political science",
  "pol sci": "political science",
  bio: "biology",
  chem: "chemistry",
  econ: "economics",
  educ: "education",
  beed: "elementary education",
  bsed: "secondary education",
  hrm: "hospitality management",
  hm: "hospitality management",
  bshm: "hospitality management",
  tm: "tourism management",
  bstm: "tourism management",
  bsba: "business administration",
  crim: "criminology",
  comm: "communication",
  masscomm: "communication",
  "mass comm": "communication",
  pt: "physical therapy",
  ot: "occupational therapy",
  slp: "speech language pathology",
  "fine arts": "fine arts",
  mma: "multimedia arts",
};

const DEGREE_PREFIX_PATTERNS: RegExp[] = [
  /^bachelor\s+of\s+science\s+in\s+/,
  /^bachelor\s+of\s+arts\s+in\s+/,
  /^bachelor\s+of\s+fine\s+arts\s+in\s+/,
  /^bachelor\s+of\s+music\s+in\s+/,
  /^bachelor\s+of\s+laws\s+in\s+/,
  /^bachelor\s+of\s+[a-z]+\s+in\s+/,
  /^bachelor\s+of\s+/,
  /^doctor\s+of\s+/,
  /^bs\s+in\s+/,
  /^ba\s+in\s+/,
  /^ab\s+in\s+/,
  /^bfa\s+in\s+/,
  /^bs\s+/,
  /^ba\s+/,
  /^ab\s+/,
  /^bfa\s+/,
];

const TERMS_PER_YEAR: Record<string, number> = {
  year: 1,
  semester: 2,
  trimester: 3,
  quarter: 4,
};

function textOf(value: unknown): string {
  return typeof value === "string" ? cleanText(value) : "";
}

function stripDegreePrefix(normalized: string): string {
  let current = normalized.trim();
  for (const pattern of DEGREE_PREFIX_PATTERNS) {
    if (pattern.test(current)) {
      const stripped = current.replace(pattern, "").trim();
      if (stripped.length > 0) {
        current = stripped;
        break;
      }
    }
  }
  return current;
}

function expandProgramPreference(preference: string): string {
  const key = normalizeKey(preference);
  if (PROGRAM_ALIASES[key]) {
    return PROGRAM_ALIASES[key];
  }
  const stripped = stripDegreePrefix(key);
  if (PROGRAM_ALIASES[stripped]) {
    return PROGRAM_ALIASES[stripped];
  }
  return stripped || key;
}

function tokensOf(value: string): Set<string> {
  const words = normalizeKey(value).split(/\s+/).filter(Boolean);
  const meaningful = new Set(words.filter((w) => !STOP_WORDS.has(w)));
  return meaningful.size > 0 ? meaningful : new Set(words);
}

function stemMatches(wantedWord: string, availableWord: string): boolean {
  if (wantedWord === availableWord) return true;
  if (wantedWord.length < 4 || availableWord.length < 4) return false;
  // Simple plural/inflection tolerance without false positives on short words
  if (
    wantedWord + "s" === availableWord ||
    availableWord + "s" === wantedWord ||
    wantedWord + "es" === availableWord ||
    availableWord + "es" === wantedWord
  ) {
    return true;
  }
  const minLen = Math.min(wantedWord.length, availableWord.length);
  if (minLen >= 5) {
    const prefixLen = Math.min(minLen, 6);
    if (
      wantedWord.startsWith(availableWord.slice(0, prefixLen)) &&
      availableWord.startsWith(wantedWord.slice(0, prefixLen))
    ) {
      return true;
    }
  }
  return false;
}

function hasWholePhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function normalizeWeights(
  weights?: Record<string, unknown> | null,
): Record<Criterion, number> {
  const merged: Record<Criterion, number> = { ...DEFAULT_WEIGHTS };
  if (weights) {
    for (const [name, value] of Object.entries(weights)) {
      if (!(name in DEFAULT_WEIGHTS)) {
        throw new Error(`Unknown weight criterion: ${name}`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(
          `Weight for ${name} must be a finite non-negative number`,
        );
      }
      merged[name as Criterion] = value;
    }
  }
  const total = CRITERIA.reduce((acc, c) => acc + merged[c], 0);
  if (total <= 0) {
    throw new Error("At least one criterion weight must be greater than zero");
  }
  return {
    program: roundTo(merged.program / total, 4),
    location: roundTo(merged.location / total, 4),
    budget: roundTo(merged.budget / total, 4),
    sector: roundTo(merged.sector / total, 4),
  };
}

export function parseWeights(
  value?: string | null,
): Record<Criterion, number> | null {
  if (!value) return null;
  const parsed: Record<string, number> = {};
  for (const part of value.split(",")) {
    if (!part.trim()) continue;
    const colon = part.indexOf(":");
    if (colon === -1) {
      throw new Error("Weights must use criterion:value pairs");
    }
    const name = part.slice(0, colon).trim();
    const raw = part.slice(colon + 1).trim();
    const num = Number(raw);
    if (!raw || Number.isNaN(num)) {
      throw new Error(`Invalid weight value for ${name}`);
    }
    parsed[name] = num;
  }
  return normalizeWeights(parsed);
}

export interface CleanedPreferences {
  program: string | null;
  city: string | null;
  sector: string | null;
  budget: number | null;
  budget_basis: string | null;
}

export function validatePreferences(
  preferences?: Record<string, unknown> | null,
): CleanedPreferences {
  const raw = preferences ?? {};
  const program = textOf(raw.program);
  const city = textOf(raw.city ?? raw.location);
  const sector = textOf(raw.sector);

  if (program.length > 200 || city.length > 200) {
    throw new Error(
      "Program and location preferences must be at most 200 characters",
    );
  }
  if (sector && sector !== "Public" && sector !== "Private") {
    throw new Error("Sector must be Public or Private");
  }

  const budgetRaw = raw.budget;
  let budget: number | null = null;
  if (budgetRaw !== undefined && budgetRaw !== null && budgetRaw !== "") {
    if (typeof budgetRaw === "boolean") {
      throw new Error("Budget must be a number");
    }
    const num = Number(budgetRaw);
    if (!Number.isFinite(num)) {
      throw new Error("Budget must be a number");
    }
    if (num < 0 || num > 10_000_000) {
      throw new Error("Budget must be between 0 and 10,000,000 PHP");
    }
    budget = num;
  }

  const rawBasis = textOf(raw.budget_basis);
  const basis = rawBasis || "semester";
  if (!(BUDGET_BASES as readonly string[]).includes(basis)) {
    throw new Error("Budget basis must be semester, trimester, year or unit");
  }
  if (budget === null && rawBasis) {
    throw new Error("Provide a budget when choosing a budget basis");
  }

  const cleaned: CleanedPreferences = {
    program: program || null,
    city: city || null,
    sector: sector || null,
    budget,
    budget_basis: budget !== null ? basis : null,
  };

  if (!cleaned.program && !cleaned.city && !cleaned.sector && budget === null) {
    throw new Error(
      "Provide at least one preference: program, location, budget or sector",
    );
  }
  return cleaned;
}

interface CriterionResult {
  points: number;
  unknown: boolean;
  reason: string;
}

const GENERIC_DISCIPLINE_SUFFIXES = new Set([
  "science",
  "sciences",
  "arts",
  "studies",
]);

function programMatch(
  preference: string,
  programName: unknown,
  topic?: unknown,
): CriterionResult {
  const name = textOf(programName);
  if (!name) {
    return {
      points: 0,
      unknown: true,
      reason: "No program information is available.",
    };
  }
  const prefKey = normalizeKey(preference);
  const nameKey = normalizeKey(name);
  const prefCore = expandProgramPreference(preference);
  const nameCore = stripDegreePrefix(nameKey);

  // 1. Exact program title or exact core discipline match (e.g. "Nursing" == "BS in Nursing")
  if (prefKey === nameKey || (prefCore && prefCore === nameCore)) {
    return {
      points: 1,
      unknown: false,
      reason: `Exact program match: ${name}.`,
    };
  }

  // 2. Exact core discipline as a contiguous phrase inside a major/track/double degree
  if (prefCore && prefCore.length >= 3 && hasWholePhrase(nameCore, prefCore)) {
    const isSpecialization =
      nameCore.startsWith(prefCore + " major") ||
      nameCore.startsWith(prefCore + " specialization") ||
      nameCore.startsWith(prefCore + " with") ||
      nameCore.startsWith(prefCore + " track") ||
      nameCore.startsWith(prefCore + " minor");
    const points = isSpecialization ? 0.94 : 0.9;
    return {
      points,
      unknown: false,
      reason: `Strong program match in '${name}'.`,
    };
  }

  // 3. Token & stem matching against the core program name (degree prefix already stripped)
  const wanted = tokensOf(prefCore || preference);
  const availableArr = Array.from(tokensOf(nameCore || name));
  const exactMatched: string[] = [];
  const fuzzyMatched: string[] = [];

  for (const w of wanted) {
    if (availableArr.includes(w)) {
      exactMatched.push(w);
    } else if (availableArr.some((a) => stemMatches(w, a))) {
      fuzzyMatched.push(w);
    }
  }

  const totalMatched = exactMatched.length + fuzzyMatched.length;
  if (wanted.size > 0 && exactMatched.length === wanted.size) {
    return {
      points: 0.88,
      unknown: false,
      reason: `All preferred keywords appear in '${name}'.`,
    };
  }
  if (wanted.size > 0 && totalMatched === wanted.size) {
    return {
      points: 0.82,
      unknown: false,
      reason: `Closely related program match in '${name}'.`,
    };
  }
  if (totalMatched > 0) {
    const matchedLabels = [...exactMatched, ...fuzzyMatched];
    // For multi-word queries (e.g. "Computer Science"), matching ONLY a generic
    // suffix like "science" or "arts" in an unrelated degree (e.g. "Political Science")
    // is not a genuine match.
    const hasNonGenericMatch =
      wanted.size === 1 ||
      matchedLabels.some((word) => !GENERIC_DISCIPLINE_SUFFIXES.has(word));
    if (hasNonGenericMatch) {
      const weightedMatch = exactMatched.length + fuzzyMatched.length * 0.85;
      const ratio = weightedMatch / wanted.size;
      const points = roundTo(Math.min(0.75, 0.75 * ratio), 3);
      return {
        points,
        unknown: false,
        reason: `Partial program match in '${name}' (${matchedLabels.sort().join(", ")} of ${Array.from(wanted).sort().join(", ")}).`,
      };
    }
  }

  // 4. Fallback: check broad topic field (e.g., "Computing", "Business", "Health")
  const topicText = textOf(topic);
  if (topicText && wanted.size > 0) {
    const topicTokens = Array.from(tokensOf(topicText));
    const topicHit = Array.from(wanted).filter((w) =>
      topicTokens.some((t) => stemMatches(w, t)),
    );
    const meaningfulTopicHit =
      topicHit.length === wanted.size ||
      (wanted.size === 1 && topicHit.length > 0);
    if (meaningfulTopicHit) {
      const ratio = topicHit.length / wanted.size;
      const points = roundTo(Math.min(0.55, 0.55 * ratio), 3);
      return {
        points,
        unknown: false,
        reason: `Matches the '${topicText}' field (${name}).`,
      };
    }
  }

  return {
    points: 0,
    unknown: false,
    reason: `The program name '${name}' does not match the preferred field.`,
  };
}

function locationMatch(
  preference: string,
  city: unknown,
  campus: unknown,
): CriterionResult {
  const cityText = textOf(city);
  const campusText = textOf(campus);
  if (!cityText && !campusText) {
    return {
      points: 0,
      unknown: true,
      reason: "No campus location is available.",
    };
  }
  if (`${cityText} ${campusText}`.toLowerCase().includes("not specified")) {
    return {
      points: 0,
      unknown: true,
      reason: "No campus location is available.",
    };
  }
  let campusFocus = campusText;
  if (!preference.toLowerCase().includes("metro")) {
    campusFocus = campusText.replace(/\bmetro\s+manila\b/gi, "");
  }
  const available = [cityText, cleanText(campusFocus)]
    .filter(Boolean)
    .join(" ");
  const prefKey = normalizeKey(preference);
  const cityKey = normalizeKey(cityText);
  const campusKey = normalizeKey(campusFocus);
  const campusSegments = campusFocus
    .split(",")
    .map((segment) => normalizeKey(segment))
    .filter(Boolean);

  if (prefKey && (prefKey === cityKey || campusSegments.includes(prefKey))) {
    return {
      points: 1,
      unknown: false,
      reason: `Campus location matches ${preference} (${campusText || cityText}).`,
    };
  }
  if (prefKey && (cityKey.includes(prefKey) || campusKey.includes(prefKey))) {
    return {
      points: 0.85,
      unknown: false,
      reason: `Preferred location appears in '${campusText || available}'.`,
    };
  }
  const wanted = tokensOf(preference);
  const availTokens = tokensOf(available);
  const matched = Array.from(wanted).filter((w) => availTokens.has(w));
  if (matched.length > 0) {
    return {
      points: 0.5,
      unknown: false,
      reason: `Partial location match in '${campusText || available}'.`,
    };
  }
  return {
    points: 0,
    unknown: false,
    reason: `'${campusText || available}' is outside the preferred location.`,
  };
}

function formatPhp(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function formatFeeRange(min: number, max: number, basis: string): string {
  if (min === 0 && max === 0) {
    return "Free tuition (RA 10931)";
  }
  if (min === max) {
    return `PHP ${formatPhp(min)} per ${basis}`;
  }
  return `PHP ${formatPhp(min)}–${formatPhp(max)} per ${basis}`;
}

function budgetMatch(
  budget: number,
  basis: string,
  fees: Array<{
    amount_min?: number | null;
    amount_max?: number | null;
    basis?: string;
  }>,
): CriterionResult {
  // 1. Free tuition (PHP 0, e.g., RA 10931) is PHP 0 regardless of billing basis.
  const hasFreeTuition = fees.some(
    (fee) =>
      fee &&
      typeof fee.amount_min === "number" &&
      typeof fee.amount_max === "number" &&
      fee.amount_min === 0 &&
      fee.amount_max === 0,
  );
  if (hasFreeTuition) {
    return {
      points: 1,
      unknown: false,
      reason: "Free tuition (RA 10931) is within your budget.",
    };
  }

  // 2. Exact billing basis comparison
  const exactComparable: Array<{ min: number; max: number }> = [];
  for (const fee of fees) {
    if (!fee || fee.basis !== basis) continue;
    const low = fee.amount_min;
    const high = fee.amount_max;
    if (typeof low !== "number" || typeof high !== "number") continue;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low)
      continue;
    exactComparable.push({ min: low, max: high });
  }
  if (exactComparable.length > 0) {
    exactComparable.sort((a, b) => a.min - b.min || a.max - b.max);
    const cheapest = exactComparable[0];
    const amount = formatFeeRange(cheapest.min, cheapest.max, basis);
    if (cheapest.max <= budget) {
      return {
        points: 1,
        unknown: false,
        reason: `Published tuition (${amount}) is within the budget.`,
      };
    }
    if (cheapest.min <= budget) {
      return {
        points: 0.5,
        unknown: false,
        reason: `Published tuition (${amount}) straddles the budget.`,
      };
    }
    return {
      points: 0,
      unknown: false,
      reason: `Published tuition (${amount}) exceeds the budget.`,
    };
  }

  // 3. Transparent calendar-term conversion (semester <-> trimester <-> quarter <-> year)
  const targetTermsPerYear = TERMS_PER_YEAR[basis];
  if (targetTermsPerYear) {
    const converted: Array<{
      min: number;
      max: number;
      sourceBasis: string;
      origMin: number;
      origMax: number;
    }> = [];
    for (const fee of fees) {
      if (!fee || !fee.basis) continue;
      const sourceTermsPerYear = TERMS_PER_YEAR[fee.basis];
      if (!sourceTermsPerYear) continue;
      const low = fee.amount_min;
      const high = fee.amount_max;
      if (typeof low !== "number" || typeof high !== "number") continue;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low)
        continue;
      const factor = sourceTermsPerYear / targetTermsPerYear;
      converted.push({
        min: Math.round(low * factor),
        max: Math.round(high * factor),
        sourceBasis: fee.basis,
        origMin: low,
        origMax: high,
      });
    }
    if (converted.length > 0) {
      converted.sort((a, b) => a.min - b.min || a.max - b.max);
      const cheapest = converted[0];
      const est = formatFeeRange(cheapest.min, cheapest.max, basis);
      const orig = formatFeeRange(
        cheapest.origMin,
        cheapest.origMax,
        cheapest.sourceBasis,
      );
      if (cheapest.max <= budget) {
        return {
          points: 1,
          unknown: false,
          reason: `Estimated ${est} (from ${orig}) is within the budget.`,
        };
      }
      if (cheapest.min <= budget) {
        return {
          points: 0.5,
          unknown: false,
          reason: `Estimated ${est} (from ${orig}) straddles the budget.`,
        };
      }
      return {
        points: 0,
        unknown: false,
        reason: `Estimated ${est} (from ${orig}) exceeds the budget.`,
      };
    }
  }

  return {
    points: 0,
    unknown: true,
    reason: `No published tuition amount with a '${basis}' basis is available; budget fit cannot be confirmed.`,
  };
}

function sectorMatch(preference: string, sector: unknown): CriterionResult {
  const value = textOf(sector);
  if (
    !value ||
    value.toLowerCase() === "not specified" ||
    value.toLowerCase() === "unknown"
  ) {
    return {
      points: 0,
      unknown: true,
      reason: "University type is not available.",
    };
  }
  if (value.toLowerCase() === preference.toLowerCase()) {
    return {
      points: 1,
      unknown: false,
      reason: `Confirmed ${value} university.`,
    };
  }
  return {
    points: 0,
    unknown: false,
    reason: `University is ${value}, not ${preference}.`,
  };
}

export interface CandidateInput {
  university_id: string;
  university_name: string;
  short_name: string;
  campus_location: string;
  city: string;
  sector: string;
  program_count: number;
  program_id: string | null;
  program_name: string | null;
  topic: string | null;
  fees: Array<{
    amount_min: number | null;
    amount_max: number | null;
    basis: string;
    raw_text: string;
  }>;
}

export interface ExplanationItem {
  criterion: Criterion;
  label: string;
  weight: number;
  points: number;
  status: "unknown" | "matched" | "partial" | "not_matched";
  reason: string;
}

export interface ScoredCandidate {
  university_id: string;
  university_name: string;
  short_name: string;
  campus_location: string;
  city: string;
  sector: string;
  program_id: string | null;
  program_name: string | null;
  topic: string | null;
  score: number;
  explanations: ExplanationItem[];
  missing: string[];
  unknown: boolean;
}

export function scoreCandidate(
  candidate: CandidateInput,
  preferences: CleanedPreferences,
  weights: Record<Criterion, number>,
): ScoredCandidate {
  const explanations: ExplanationItem[] = [];
  let numerator = 0;
  let denominator = 0;
  const missing: string[] = [];

  for (const criterion of CRITERIA) {
    const preference =
      criterion === "program"
        ? preferences.program
        : criterion === "location"
          ? preferences.city
          : criterion === "budget"
            ? preferences.budget
            : preferences.sector;
    if (preference === null || preference === undefined || preference === "") {
      continue;
    }

    let result: CriterionResult;
    if (criterion === "program") {
      result = programMatch(
        String(preference),
        candidate.program_name,
        candidate.topic,
      );
    } else if (criterion === "location") {
      result = locationMatch(
        String(preference),
        candidate.city,
        candidate.campus_location,
      );
    } else if (criterion === "budget") {
      result = budgetMatch(
        Number(preference),
        preferences.budget_basis || "semester",
        candidate.fees || [],
      );
    } else {
      result = sectorMatch(String(preference), candidate.sector);
    }

    const weight = weights[criterion] ?? 0;
    const points = result.points;
    const status: ExplanationItem["status"] = result.unknown
      ? "unknown"
      : points >= 1
        ? "matched"
        : points > 0
          ? "partial"
          : "not_matched";
    if (result.unknown) {
      missing.push(CRITERION_LABELS[criterion]);
    }
    numerator += weight * points;
    denominator += weight;
    explanations.push({
      criterion,
      label: CRITERION_LABELS[criterion],
      weight: roundTo(weight, 4),
      points: roundTo(points, 3),
      status,
      reason: result.reason,
    });
  }

  const score = denominator > 0 ? roundTo((100 * numerator) / denominator, 1) : 0;
  return {
    university_id: candidate.university_id,
    university_name: candidate.university_name,
    short_name: candidate.short_name,
    campus_location: candidate.campus_location,
    city: candidate.city,
    sector: candidate.sector,
    program_id: candidate.program_id,
    program_name: candidate.program_name,
    topic: candidate.topic,
    score,
    explanations,
    missing,
    unknown: missing.length > 0,
  };
}

export interface RecommendationResponse {
  items: ScoredCandidate[];
  total: number;
  preferences: CleanedPreferences;
  weights: Record<Criterion, number>;
  default_weights: Record<Criterion, number>;
  criteria: Record<Criterion, string>;
  formula: string;
  algorithm: string;
  unknown_policy: string;
  limit: number;
}

/**
 * Selects up to `limit` items while preventing a single large catalog
 * (e.g. a university with 250+ double degrees) from crowding out all other
 * matching universities. Always preserves strict descending score order
 * via our hand-written stable merge sort.
 */
function selectDiverseTopMatches(
  ranked: ScoredCandidate[],
  limit: number,
  perUniversityCap: number,
): ScoredCandidate[] {
  if (ranked.length <= limit) return ranked;
  const picked: ScoredCandidate[] = [];
  const overflow: ScoredCandidate[] = [];
  const counts = new Map<string, number>();

  for (const item of ranked) {
    const seen = counts.get(item.university_id) ?? 0;
    if (seen < perUniversityCap && picked.length < limit) {
      picked.push(item);
      counts.set(item.university_id, seen + 1);
    } else {
      overflow.push(item);
    }
  }

  for (const item of overflow) {
    if (picked.length >= limit) break;
    picked.push(item);
  }

  return mergeSortByScore(picked);
}

export function recommend(
  candidates: CandidateInput[],
  preferences: Record<string, unknown> | null,
  weights?: Record<string, unknown> | null,
  limit = 20,
): RecommendationResponse {
  const cleanedPreferences = validatePreferences(preferences);
  const normalizedWeights = normalizeWeights(weights);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }

  const scored = candidates
    .map((candidate) =>
      scoreCandidate(candidate, cleanedPreferences, normalizedWeights),
    )
    .filter((item) => {
      // Never return 0-score non-matches
      if (item.score <= 0) return false;
      // When the student explicitly requested a program, exclude unrelated degrees
      if (cleanedPreferences.program) {
        const progExp = item.explanations.find(
          (exp) => exp.criterion === "program",
        );
        if (!progExp || progExp.points <= 0) return false;
      }
      return true;
    });

  // Stable multi-key ranking using our hand-written top-down merge sort:
  // 1) Fewer unknown criteria first (higher data confidence)
  // 2) Stronger program fit first (when program preference is supplied)
  // 3) Primary key: overall weighted score descending
  const byCompleteness = mergeSort(scored, (item) => item.missing.length, false);
  const byProgramFit = cleanedPreferences.program
    ? mergeSort(
        byCompleteness,
        (item) =>
          item.explanations.find((exp) => exp.criterion === "program")
            ?.points ?? 0,
        true,
      )
    : byCompleteness;
  const ranked = mergeSortByScore(byProgramFit);

  const items = cleanedPreferences.program
    ? selectDiverseTopMatches(ranked, limit, 3)
    : ranked.slice(0, limit);

  return {
    items,
    total: ranked.length,
    preferences: cleanedPreferences,
    weights: normalizedWeights,
    default_weights: { ...DEFAULT_WEIGHTS },
    criteria: { ...CRITERION_LABELS },
    formula: FORMULA,
    algorithm: "Hand-written stable merge sort (src/algorithms/mergeSort.ts)",
    unknown_policy:
      "Missing source data scores 0 for that criterion and is reported as unknown; it is never treated as a match.",
    limit,
  };
}
