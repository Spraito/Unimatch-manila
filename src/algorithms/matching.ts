/**
 * Algorithm 2 — rule-based matching with weighted criteria.
 *
 * Ranks candidates via our hand-written stable merge sort (mergeSort.ts).
 */
import { cleanText, normalizeKey } from "./extraction.js";
import { mergeSortByScore } from "./mergeSort.js";

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

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "arts",
  "bachelor",
  "bs",
  "ba",
  "degree",
  "for",
  "in",
  "major",
  "of",
  "program",
  "science",
  "the",
]);

function textOf(value: unknown): string {
  return typeof value === "string" ? cleanText(value) : "";
}

function tokensOf(value: string): Set<string> {
  const words = normalizeKey(value).split(/\s+/).filter(Boolean);
  const meaningful = new Set(words.filter((w) => !STOP_WORDS.has(w)));
  return meaningful.size > 0 ? meaningful : new Set(words);
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

function programMatch(
  preference: string,
  programName: unknown,
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
  if (prefKey === nameKey) {
    return {
      points: 1,
      unknown: false,
      reason: `Exact program match: ${name}.`,
    };
  }
  const wanted = tokensOf(preference);
  const available = tokensOf(name);
  const matched = Array.from(wanted).filter((w) => available.has(w));
  if (wanted.size > 0 && matched.length === wanted.size) {
    return {
      points: 0.9,
      unknown: false,
      reason: `All preferred keywords appear in '${name}'.`,
    };
  }
  if (matched.length > 0) {
    const ratio = matched.length / wanted.size;
    const points = roundTo(Math.min(0.85, 0.85 * ratio), 3);
    return {
      points,
      unknown: false,
      reason: `Partial program match in '${name}' (${matched.sort().join(", ")} of ${Array.from(wanted).sort().join(", ")}).`,
    };
  }
  return {
    points: 0,
    unknown: false,
    reason: `The program name '${name}' does not contain the preferred keywords.`,
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
  if (prefKey && prefKey === cityKey) {
    return {
      points: 1,
      unknown: false,
      reason: `Campus city matches ${cityText}.`,
    };
  }
  if (prefKey && (cityKey.includes(prefKey) || campusKey.includes(prefKey))) {
    return {
      points: 0.85,
      unknown: false,
      reason: `Preferred location appears in '${available}'.`,
    };
  }
  const wanted = tokensOf(preference);
  const availTokens = tokensOf(available);
  const matched = Array.from(wanted).filter((w) => availTokens.has(w));
  if (matched.length > 0) {
    return {
      points: 0.5,
      unknown: false,
      reason: `Partial location match in '${available}'.`,
    };
  }
  return {
    points: 0,
    unknown: false,
    reason: `'${available}' is outside the preferred location.`,
  };
}

function formatPhp(n: number): string {
  return Math.round(n).toLocaleString("en-US");
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
  const comparable: Array<{ min: number; max: number }> = [];
  for (const fee of fees) {
    if (!fee || fee.basis !== basis) continue;
    const low = fee.amount_min;
    const high = fee.amount_max;
    if (typeof low !== "number" || typeof high !== "number") continue;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low)
      continue;
    comparable.push({ min: low, max: high });
  }
  if (comparable.length === 0) {
    return {
      points: 0,
      unknown: true,
      reason: `No published tuition amount with a '${basis}' basis is available; budget fit cannot be confirmed.`,
    };
  }
  comparable.sort((a, b) => a.min - b.min || a.max - b.max);
  const cheapest = comparable[0];
  const amount = `PHP ${formatPhp(cheapest.min)}–${formatPhp(cheapest.max)} per ${basis}`;
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
      result = programMatch(String(preference), candidate.program_name);
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

  const scored = candidates.map((candidate) =>
    scoreCandidate(candidate, cleanedPreferences, normalizedWeights),
  );
  const ranked = mergeSortByScore(scored);

  return {
    items: ranked.slice(0, limit),
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
