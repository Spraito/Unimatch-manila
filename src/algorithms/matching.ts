/**
 * Algorithm 2 — Transparent rule-based recommendation engine with strict
 * separation between:
 *   1. Hard university filtering (universityFilter.ts) — excludes non-matching
 *      universities BEFORE scoring (e.g., Private filter strictly excludes Public).
 *   2. Academic program search relevance (programSearch.ts) — exact degree matches
 *      always rank above specializations, partial matches, and related programs.
 *   3. Weighted compatibility scoring — mathematically exact over supplied criteria
 *      with available data. Missing/unavailable university data is labeled
 *      "Information Unavailable" and excluded from the denominator rather than
 *      penalized as a 0% mismatch.
 *
 * Ranks candidates via our hand-written stable merge sort (mergeSort.ts).
 */
import { cleanText } from "./extraction.js";
import { mergeSort, mergeSortByScore } from "./mergeSort.js";
import {
  deduplicatePrograms,
  evaluateProgramMatch,
  normalizeProgramText,
  type MatchCategory,
  type ProgramSearchMatch,
} from "./programSearch.js";
import {
  applyUniversityHardFilters,
  normalizeUniversitySector,
  parseSectorFilter,
  type AppliedFilters,
  type ValidSector,
} from "./universityFilter.js";

export const CRITERIA = ["program", "location", "sector"] as const;
export type Criterion = (typeof CRITERIA)[number];
export type ExtendedCriterion = Criterion | "budget";

export const CRITERION_LABELS: Record<ExtendedCriterion, string> = {
  program: "Preferred program",
  location: "Preferred location",
  sector: "University type",
  budget: "Tuition & budget",
};

export const DEFAULT_WEIGHTS: Record<Criterion, number> = {
  program: 0.55,
  location: 0.25,
  sector: 0.2,
};

export const DEFAULT_BUDGET_WEIGHT = 0.2;

export const FORMULA =
  "score = 100 × Σ(effective_weight[c] × points[c]) over supplied criteria with available data. Missing university data is labeled 'Information Unavailable' and excluded from the denominator rather than penalized as a mismatch.";

export const UNKNOWN_POLICY =
  "Missing or unavailable university data (such as unpublished private tuition) is labeled 'Information Unavailable' and excluded from the score denominator rather than penalized as a mismatch.";

export type ExplanationStatus =
  | "matched"
  | "partial"
  | "not_matched"
  | "unavailable"
  | "not_applicable";

export const STATUS_LABELS: Record<ExplanationStatus, string> = {
  matched: "Match",
  partial: "Partial Match",
  not_matched: "No Match",
  unavailable: "Information Unavailable",
  not_applicable: "Not Applicable",
};

function textOf(value: unknown): string {
  return typeof value === "string" ? cleanText(value) : "";
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const VALID_BUDGET_BASES = new Set(["semester", "trimester", "year", "unit"]);

export function normalizeWeights(
  weights?: Record<string, unknown> | null,
): Record<Criterion, number> {
  const merged: Record<Criterion, number> = { ...DEFAULT_WEIGHTS };
  if (weights) {
    for (const [name, value] of Object.entries(weights)) {
      if (name === "budget") {
        // Core 3-criterion weights ignore budget unless budget preference is supplied
        continue;
      }
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
    sector: roundTo(merged.sector / total, 4),
  };
}

function resolveScoringWeights(
  rawWeights: Record<string, unknown> | null | undefined,
  includeBudget: boolean,
): {
  coreWeights: Record<Criterion, number>;
  activeWeights: Record<ExtendedCriterion, number>;
} {
  const coreWeights = normalizeWeights(rawWeights);
  if (!includeBudget) {
    return {
      coreWeights,
      activeWeights: {
        program: coreWeights.program,
        location: coreWeights.location,
        sector: coreWeights.sector,
        budget: 0,
      },
    };
  }

  // Budget preference supplied: honor explicit budget weight if given, else 0.20
  let budgetRaw = DEFAULT_BUDGET_WEIGHT;
  if (
    rawWeights &&
    typeof rawWeights.budget === "number" &&
    Number.isFinite(rawWeights.budget) &&
    rawWeights.budget >= 0
  ) {
    budgetRaw = rawWeights.budget;
  }
  const baseProgram =
    rawWeights &&
    typeof rawWeights.program === "number" &&
    Number.isFinite(rawWeights.program) &&
    rawWeights.program >= 0
      ? rawWeights.program
      : coreWeights.program * (1 - DEFAULT_BUDGET_WEIGHT);
  const baseLocation =
    rawWeights &&
    typeof rawWeights.location === "number" &&
    Number.isFinite(rawWeights.location) &&
    rawWeights.location >= 0
      ? rawWeights.location
      : coreWeights.location * (1 - DEFAULT_BUDGET_WEIGHT);
  const baseSector =
    rawWeights &&
    typeof rawWeights.sector === "number" &&
    Number.isFinite(rawWeights.sector) &&
    rawWeights.sector >= 0
      ? rawWeights.sector
      : coreWeights.sector * (1 - DEFAULT_BUDGET_WEIGHT);

  const sum = baseProgram + baseLocation + baseSector + budgetRaw;
  if (sum <= 0) {
    return {
      coreWeights,
      activeWeights: {
        program: 0.44,
        location: 0.2,
        sector: 0.16,
        budget: 0.2,
      },
    };
  }
  return {
    coreWeights,
    activeWeights: {
      program: roundTo(baseProgram / sum, 4),
      location: roundTo(baseLocation / sum, 4),
      sector: roundTo(baseSector / sum, 4),
      budget: roundTo(budgetRaw / sum, 4),
    },
  };
}

export function parseWeights(
  value?: string | null,
): Record<string, number> | null {
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
    if (name !== "budget" && !(name in DEFAULT_WEIGHTS)) {
      throw new Error(`Unknown weight criterion: ${name}`);
    }
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(
        `Weight for ${name} must be a finite non-negative number`,
      );
    }
    parsed[name] = num;
  }
  // Validate core weights are well-formed
  normalizeWeights(parsed);
  return parsed;
}

export interface CleanedPreferences {
  program: string | null;
  city: string | null;
  sector: string | null;
  sectors: ValidSector[];
  budget: number | null;
  budget_basis: "semester" | "trimester" | "year" | "unit" | null;
}

export function validatePreferences(
  preferences?: Record<string, unknown> | null,
): CleanedPreferences {
  const raw = preferences ?? {};
  const program = textOf(raw.program);
  const city = textOf(raw.city ?? raw.location);
  const sectors = parseSectorFilter(raw.sectors ?? raw.sector);
  const sector =
    sectors.length === 1
      ? sectors[0]
      : sectors.length > 1
        ? sectors.join(",")
        : null;

  if (program.length > 200 || city.length > 200) {
    throw new Error(
      "Program and location preferences must be at most 200 characters",
    );
  }

  let budget: number | null = null;
  if (
    raw.budget !== null &&
    raw.budget !== undefined &&
    String(raw.budget).trim() !== ""
  ) {
    const parsedBudget = Number(raw.budget);
    if (
      !Number.isFinite(parsedBudget) ||
      parsedBudget < 0 ||
      parsedBudget > 10_000_000
    ) {
      throw new Error("Budget must be a number between 0 and 10,000,000 PHP");
    }
    budget = roundTo(parsedBudget, 2);
  }

  const rawBasis = textOf(raw.budget_basis ?? raw.budgetBasis).toLowerCase();
  const budget_basis =
    budget !== null
      ? ((VALID_BUDGET_BASES.has(rawBasis)
          ? rawBasis
          : "semester") as CleanedPreferences["budget_basis"])
      : null;

  const cleaned: CleanedPreferences = {
    program: program || null,
    city: city || null,
    sector,
    sectors,
    budget,
    budget_basis,
  };

  if (
    !cleaned.program &&
    !cleaned.city &&
    cleaned.sectors.length === 0 &&
    cleaned.budget === null
  ) {
    throw new Error(
      "Provide at least one preference: program, location, university type, or budget",
    );
  }
  return cleaned;
}

interface CriterionResult {
  points: number | null;
  unavailable: boolean;
  reason: string;
}

function locationMatch(
  preference: string,
  city: unknown,
  campus: unknown,
): CriterionResult {
  const cityText = textOf(city);
  const campusText = textOf(campus);
  if (
    (!cityText && !campusText) ||
    `${cityText} ${campusText}`.toLowerCase().includes("not specified")
  ) {
    return {
      points: null,
      unavailable: true,
      reason:
        "Campus location information is unavailable for this university; excluded from score denominator.",
    };
  }
  let campusFocus = campusText;
  if (!preference.toLowerCase().includes("metro")) {
    campusFocus = campusText.replace(/\bmetro\s+manila\b/gi, "");
  }
  const available = [cityText, cleanText(campusFocus)]
    .filter(Boolean)
    .join(" ");
  const prefKey = normalizeProgramText(preference);
  const cityKey = normalizeProgramText(cityText);
  const campusKey = normalizeProgramText(campusFocus);
  const campusSegments = campusFocus
    .split(",")
    .map((segment) => normalizeProgramText(segment))
    .filter(Boolean);

  if (prefKey && (prefKey === cityKey || campusSegments.includes(prefKey))) {
    return {
      points: 1,
      unavailable: false,
      reason: `Campus location matches ${preference} (${campusText || cityText}).`,
    };
  }
  if (
    prefKey &&
    (` ${cityKey} `.includes(` ${prefKey} `) ||
      ` ${campusKey} `.includes(` ${prefKey} `))
  ) {
    return {
      points: 1,
      unavailable: false,
      reason: `Campus is located in ${preference} (${campusText || available}).`,
    };
  }
  if (prefKey && (cityKey.includes(prefKey) || campusKey.includes(prefKey))) {
    return {
      points: 0.85,
      unavailable: false,
      reason: `Preferred location appears in '${campusText || available}'.`,
    };
  }
  return {
    points: 0,
    unavailable: false,
    reason: `'${campusText || available}' is outside the preferred location (${preference}).`,
  };
}

function sectorMatch(
  allowedSectors: ValidSector[],
  sector: unknown,
): CriterionResult {
  const actual = normalizeUniversitySector(sector);
  if (!actual) {
    return {
      points: null,
      unavailable: true,
      reason:
        "University type information is unavailable; excluded from score denominator.",
    };
  }
  if (allowedSectors.length === 0 || allowedSectors.includes(actual)) {
    return {
      points: 1,
      unavailable: false,
      reason:
        allowedSectors.length === 1
          ? `Confirmed ${actual} university (matches selected filter).`
          : `Confirmed ${actual} university.`,
    };
  }
  return {
    points: 0,
    unavailable: false,
    reason: `University is ${actual}, not ${allowedSectors.join(" or ")}.`,
  };
}

function convertToAnnualPhp(amount: number, basis: string): number | null {
  const b = basis.trim().toLowerCase();
  if (b === "year" || b === "annual") return amount;
  if (b === "semester" || b === "sem") return amount * 2;
  if (b === "trimester" || b === "term") return amount * 3;
  if (b === "unit") return amount * 36; // typical ~18 units × 2 semesters
  return null;
}

function budgetMatch(
  budget: number,
  basis: string,
  fees: CandidateInput["fees"],
): CriterionResult {
  const safeFees = Array.isArray(fees) ? fees : [];
  const isFree = safeFees.some(
    (f) => f.amount_min === 0 && f.amount_max === 0,
  );
  if (isFree) {
    return {
      points: 1,
      unavailable: false,
      reason: `Free undergraduate tuition under RA 10931 fits within your PHP ${budget.toLocaleString("en-PH")} / ${basis} budget.`,
    };
  }

  const numericFees = safeFees.filter(
    (f) =>
      (typeof f.amount_min === "number" && Number.isFinite(f.amount_min)) ||
      (typeof f.amount_max === "number" && Number.isFinite(f.amount_max)),
  );
  if (numericFees.length === 0) {
    return {
      points: null,
      unavailable: true,
      reason:
        "Official tuition rates are not published in our dataset; not penalized in your match score.",
    };
  }

  const budgetAnnual = convertToAnnualPhp(budget, basis);
  let bestPoints = -1;
  let bestReason = "";

  for (const fee of numericFees) {
    const minAmt =
      typeof fee.amount_min === "number" ? fee.amount_min : (fee.amount_max ?? 0);
    const maxAmt =
      typeof fee.amount_max === "number" ? fee.amount_max : minAmt;
    const feeBasis = (fee.basis || "semester").toLowerCase();

    let compMin = minAmt;
    let compMax = maxAmt;
    let compBudget = budget;

    if (feeBasis !== basis && budgetAnnual !== null) {
      const feeMinAnnual = convertToAnnualPhp(minAmt, feeBasis);
      const feeMaxAnnual = convertToAnnualPhp(maxAmt, feeBasis);
      if (feeMinAnnual !== null && feeMaxAnnual !== null) {
        compMin = feeMinAnnual;
        compMax = feeMaxAnnual;
        compBudget = budgetAnnual;
      }
    }

    let pts = 0;
    let reason = "";
    if (compMax <= compBudget) {
      pts = 1;
      reason = `Published tuition (PHP ${minAmt.toLocaleString("en-PH")}–${maxAmt.toLocaleString("en-PH")} / ${feeBasis}) fits within your budget.`;
    } else if (compMin <= compBudget) {
      pts = 0.8;
      reason = `Lower tuition estimate (PHP ${minAmt.toLocaleString("en-PH")} / ${feeBasis}) fits within your budget; upper range may exceed it.`;
    } else if (compBudget > 0 && compMin <= compBudget * 1.2) {
      pts = 0.5;
      reason = `Published tuition starts slightly above your budget (within 20%).`;
    } else {
      pts = 0;
      reason = `Published tuition (PHP ${minAmt.toLocaleString("en-PH")} / ${feeBasis}) exceeds your PHP ${budget.toLocaleString("en-PH")} / ${basis} budget.`;
    }

    if (pts > bestPoints) {
      bestPoints = pts;
      bestReason = reason;
    }
  }

  return {
    points: bestPoints >= 0 ? bestPoints : null,
    unavailable: bestPoints < 0,
    reason:
      bestReason ||
      "Official tuition rates are unavailable; not penalized in your match score.",
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
  criterion: ExtendedCriterion;
  label: string;
  weight: number;
  effective_weight: number;
  points: number | null;
  status: ExplanationStatus;
  status_label: string;
  reason: string;
}

export interface SearchMatchSummary {
  tier: ProgramSearchMatch["tier"];
  category: MatchCategory;
  relevance_score: number;
  matched_via: ProgramSearchMatch["matchedVia"];
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
  search_match: SearchMatchSummary | null;
  explanations: ExplanationItem[];
  missing: string[];
  unknown: boolean;
}

export function scoreCandidate(
  candidate: CandidateInput,
  preferences: CleanedPreferences,
  weights: Record<ExtendedCriterion, number>,
  precomputedProgramMatch?: ProgramSearchMatch | null,
): ScoredCandidate {
  const evaluatedEntries: Array<{
    criterion: ExtendedCriterion;
    weight: number;
    result: CriterionResult;
    status: ExplanationStatus;
  }> = [];
  const notApplicableEntries: ExplanationItem[] = [];
  const missing: string[] = [];

  const criteriaToCheck: ExtendedCriterion[] =
    preferences.budget !== null
      ? ["program", "location", "sector", "budget"]
      : ["program", "location", "sector"];

  for (const criterion of criteriaToCheck) {
    const isSupplied =
      criterion === "program"
        ? Boolean(preferences.program)
        : criterion === "location"
          ? Boolean(preferences.city)
          : criterion === "sector"
            ? preferences.sectors.length > 0
            : preferences.budget !== null;

    if (!isSupplied) {
      notApplicableEntries.push({
        criterion,
        label: CRITERION_LABELS[criterion],
        weight: roundTo(weights[criterion] ?? 0, 4),
        effective_weight: 0,
        points: null,
        status: "not_applicable",
        status_label: STATUS_LABELS.not_applicable,
        reason: "Not specified in your preferences.",
      });
      continue;
    }

    let result: CriterionResult;
    if (criterion === "program") {
      if (!candidate.program_name) {
        result = {
          points: null,
          unavailable: true,
          reason: "No program catalog is available for this university.",
        };
      } else {
        const pm =
          precomputedProgramMatch !== undefined
            ? precomputedProgramMatch
            : evaluateProgramMatch(
                preferences.program!,
                candidate.program_name,
                candidate.topic,
              );
        if (pm) {
          result = {
            points: pm.programPoints,
            unavailable: false,
            reason: pm.reason,
          };
        } else {
          result = {
            points: 0,
            unavailable: false,
            reason: `'${candidate.program_name}' does not match '${preferences.program}'.`,
          };
        }
      }
    } else if (criterion === "location") {
      result = locationMatch(
        preferences.city!,
        candidate.city,
        candidate.campus_location,
      );
    } else if (criterion === "sector") {
      result = sectorMatch(preferences.sectors, candidate.sector);
    } else {
      result = budgetMatch(
        preferences.budget!,
        preferences.budget_basis || "semester",
        candidate.fees,
      );
    }

    const weight = weights[criterion] ?? 0;
    let status: ExplanationStatus;
    if (result.unavailable || result.points === null) {
      status = "unavailable";
      missing.push(CRITERION_LABELS[criterion]);
    } else if (result.points >= 1) {
      status = "matched";
    } else if (result.points > 0) {
      status = "partial";
    } else {
      status = "not_matched";
    }

    evaluatedEntries.push({ criterion, weight, result, status });
  }

  // Denominator includes ONLY supplied criteria with available data so missing
  // data (e.g. unpublished private tuition) is NEVER penalized as a 0% mismatch.
  const availableWeightSum = evaluatedEntries.reduce(
    (sum, entry) =>
      entry.status !== "unavailable" ? sum + entry.weight : sum,
    0,
  );

  let numerator = 0;
  const explanations: ExplanationItem[] = [];

  for (const entry of evaluatedEntries) {
    const isAvailable =
      entry.status !== "unavailable" && entry.result.points !== null;
    const effectiveWeight =
      isAvailable && availableWeightSum > 0
        ? entry.weight / availableWeightSum
        : 0;
    if (isAvailable && entry.result.points !== null) {
      numerator += effectiveWeight * entry.result.points;
    }
    explanations.push({
      criterion: entry.criterion,
      label: CRITERION_LABELS[entry.criterion],
      weight: roundTo(entry.weight, 4),
      effective_weight: roundTo(effectiveWeight, 4),
      points:
        entry.result.points !== null ? roundTo(entry.result.points, 3) : null,
      status: entry.status,
      status_label: STATUS_LABELS[entry.status],
      reason: entry.result.reason,
    });
  }

  // Append not-applicable criteria AFTER evaluated criteria for full transparency
  explanations.push(...notApplicableEntries);

  const score =
    availableWeightSum > 0 ? roundTo(100 * numerator, 1) : 0;

  const searchMatchSummary: SearchMatchSummary | null =
    precomputedProgramMatch
      ? {
          tier: precomputedProgramMatch.tier,
          category: precomputedProgramMatch.category,
          relevance_score: precomputedProgramMatch.relevanceScore,
          matched_via: precomputedProgramMatch.matchedVia,
          reason: precomputedProgramMatch.reason,
        }
      : null;

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
    search_match: searchMatchSummary,
    explanations,
    missing,
    unknown: missing.length > 0,
  };
}

export interface RecommendationResponse {
  items: ScoredCandidate[];
  total: number;
  exact_match_count: number;
  related_match_count: number;
  excluded_by_filters: number;
  applied_filters: AppliedFilters & {
    program: string | null;
    budget: number | null;
    budget_basis: string | null;
  };
  preferences: CleanedPreferences;
  weights: Record<Criterion, number>;
  active_weights: Record<ExtendedCriterion, number>;
  default_weights: Record<Criterion, number>;
  criteria: Record<ExtendedCriterion, string>;
  formula: string;
  algorithm: string;
  unknown_policy: string;
  limit: number;
}

/**
 * Selects up to `limit` items while preventing a single university with many
 * tracks/double degrees from crowding out other matching universities.
 * STRICTLY preserves tier-first (Exact before Related), then score-descending!
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

  // Preserve strict tier-first, then score-descending order
  const byScore = mergeSortByScore(picked);
  return mergeSort(byScore, (item) => item.search_match?.tier ?? 99, false);
}

export function recommend(
  candidates: CandidateInput[],
  preferences: Record<string, unknown> | null,
  weights?: Record<string, unknown> | null,
  limit = 20,
): RecommendationResponse {
  const cleanedPreferences = validatePreferences(preferences);
  const { coreWeights, activeWeights } = resolveScoringWeights(
    weights,
    cleanedPreferences.budget !== null,
  );
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }

  // -------------------------------------------------------------------------
  // STAGE 1: Hard university filters (strictly exclude violating universities
  // BEFORE recommendation scoring — e.g. Private strictly excludes Public)
  // -------------------------------------------------------------------------
  const { eligible, excludedCount, applied } = applyUniversityHardFilters(
    candidates,
    {
      sector: cleanedPreferences.sectors,
      city: cleanedPreferences.city,
    },
  );

  // Deduplicate identical (university_id, normalized_program_name) candidates
  const dedupedEligible = cleanedPreferences.program
    ? deduplicatePrograms(
        eligible
          .filter((c) => Boolean(c.program_name))
          .map((c) => ({ ...c, name: c.program_name || "" })),
      ).map(({ name: _ignored, ...rest }) => rest as CandidateInput)
    : (() => {
        // When browsing without a program query, keep one university-level row per school
        const seenUni = new Set<string>();
        const uniRows: CandidateInput[] = [];
        for (const c of eligible) {
          if (seenUni.has(c.university_id)) continue;
          seenUni.add(c.university_id);
          uniRows.push({
            ...c,
            program_id: null,
            program_name: null,
            topic: null,
          });
        }
        return uniRows;
      })();

  // -------------------------------------------------------------------------
  // STAGE 2 & 3: Evaluate program search relevance + compute independent
  // recommendation score over eligible candidates
  // -------------------------------------------------------------------------
  const scored: ScoredCandidate[] = [];
  for (const candidate of dedupedEligible) {
    let progMatch: ProgramSearchMatch | null = null;
    if (cleanedPreferences.program) {
      progMatch = evaluateProgramMatch(
        cleanedPreferences.program,
        candidate.program_name || "",
        candidate.topic,
      );
      if (!progMatch) continue; // Exclude unrelated programs
    }

    const result = scoreCandidate(
      candidate,
      cleanedPreferences,
      activeWeights,
      cleanedPreferences.program ? progMatch : undefined,
    );

    // Exclude genuine 0-score mismatches unless every supplied criterion was unavailable
    const allSuppliedUnavailable =
      result.explanations.some((ex) => ex.status === "unavailable") &&
      !result.explanations.some(
        (ex) =>
          ex.status === "matched" ||
          ex.status === "partial" ||
          ex.status === "not_matched",
      );
    if (result.score <= 0 && !allSuppliedUnavailable) continue;

    scored.push(result);
  }

  // -------------------------------------------------------------------------
  // STAGE 4: Ranking (Strictly separate search relevance from preference score)
  // When a program is searched:
  //   1) Search match tier ASC (Exact > Very Close > Partial > Related > Broad)
  //      — a Related Match NEVER outranks an Exact Match!
  //   2) Recommendation compatibility score DESC (via stable merge sort)
  //   3) Search relevance score DESC
  //   4) Data completeness (fewer unavailable fields first)
  //   5) University / program name alphabetically
  // When no program is searched:
  //   1) Recommendation compatibility score DESC
  //   2) Fewer unavailable fields first
  //   3) University name alphabetically
  // -------------------------------------------------------------------------
  const byName = [...scored].sort(
    (a, b) =>
      a.university_name.localeCompare(b.university_name) ||
      String(a.program_name || "").localeCompare(String(b.program_name || "")),
  );
  const byCompleteness = mergeSort(byName, (item) => item.missing.length, false);
  const byRelevance = cleanedPreferences.program
    ? mergeSort(
        byCompleteness,
        (item) => item.search_match?.relevance_score ?? 0,
        true,
      )
    : byCompleteness;
  const byScore = mergeSortByScore(byRelevance);
  const ranked = cleanedPreferences.program
    ? mergeSort(byScore, (item) => item.search_match?.tier ?? 99, false)
    : byScore;

  const exactMatchCount = ranked.filter(
    (item) =>
      item.search_match &&
      (item.search_match.category === "Exact Match" ||
        item.search_match.category === "Very Close Match"),
  ).length;
  const relatedMatchCount = ranked.filter(
    (item) =>
      item.search_match &&
      (item.search_match.category === "Related Match" ||
        item.search_match.category === "Broad Match"),
  ).length;

  const items = cleanedPreferences.program
    ? selectDiverseTopMatches(ranked, limit, 3)
    : ranked.slice(0, limit);

  return {
    items,
    total: ranked.length,
    exact_match_count: exactMatchCount,
    related_match_count: relatedMatchCount,
    excluded_by_filters: excludedCount,
    applied_filters: {
      sectors: applied.sectors,
      city: applied.city,
      program: cleanedPreferences.program,
      budget: cleanedPreferences.budget,
      budget_basis: cleanedPreferences.budget_basis,
    },
    preferences: cleanedPreferences,
    weights: coreWeights,
    active_weights: activeWeights,
    default_weights: { ...DEFAULT_WEIGHTS },
    criteria: { ...CRITERION_LABELS },
    formula: FORMULA,
    algorithm:
      "Hard-filter -> hybrid program search relevance -> independent weighted compatibility scoring (stable merge sort)",
    unknown_policy: UNKNOWN_POLICY,
    limit,
  };
}
