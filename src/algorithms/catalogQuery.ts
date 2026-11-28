/**
 * Shared catalog search & hard-filtering queries for both Node backend
 * (src/store.ts) and browser live-catalog mirror (client/catalogService.ts).
 *
 * Guarantees identical search relevance, deduplication, and strict hard
 * filtering across Express API and client live-catalog modes.
 */
import { cleanText } from "./extraction.js";
import { mergeSort } from "./mergeSort.js";
import {
  deduplicatePrograms,
  normalizeProgramText,
  searchAndRankPrograms,
  type MatchCategory,
  type SearchableProgram,
} from "./programSearch.js";
import {
  applyUniversityHardFilters,
  type AppliedFilters,
} from "./universityFilter.js";

export interface CatalogUniversityItem {
  id: string;
  name: string;
  short_name: string;
  city: string;
  campus_location: string;
  sector: string;
  program_count: number;
  exam_summary?: string | null;
}

export interface MatchedProgramPreview {
  id: string;
  name: string;
  topic: string;
  match_category: MatchCategory;
  match_tier: number;
}

export type UniversitySearchResult<T extends CatalogUniversityItem> = T & {
  search_match?: {
    tier: number;
    category: MatchCategory;
    relevance_score: number;
    matched_via: "university" | "program";
    matched_programs: MatchedProgramPreview[];
    matched_program_count: number;
  } | null;
};

export function searchCatalogUniversities<
  T extends CatalogUniversityItem,
  P extends SearchableProgram & { id: string; topic: string },
>(
  schools: T[],
  getPrograms: (schoolId: string) => P[],
  options: {
    search?: string;
    city?: string;
    sector?: string | string[];
    sort?: string;
  },
): {
  items: Array<UniversitySearchResult<T>>;
  total: number;
  excluded_by_filters: number;
  applied_filters: AppliedFilters;
} {
  const sort = cleanText(options.sort || "featured") || "featured";
  if (!["name", "programs", "featured"].includes(sort)) {
    throw new Error("Unknown sort order");
  }

  // Stage 1: Apply strict hard filters BEFORE search/ranking
  const { eligible, excludedCount, applied } = applyUniversityHardFilters(
    schools,
    {
      sector: options.sector,
      city: options.city,
    },
  );

  const rawQuery = cleanText(options.search || "");
  if (!rawQuery) {
    const sorted = [...eligible].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (b.program_count !== a.program_count) {
        return b.program_count - a.program_count;
      }
      return a.name.localeCompare(b.name);
    });
    return {
      items: sorted.map((u) => ({ ...u, search_match: null })),
      total: sorted.length,
      excluded_by_filters: excludedCount,
      applied_filters: applied,
    };
  }

  const normQuery = normalizeProgramText(rawQuery);
  const matched: Array<UniversitySearchResult<T>> = [];

  for (const school of eligible) {
    // Check direct university identity match (name, short_name, campus, exam)
    const normName = normalizeProgramText(school.name);
    const normShort = normalizeProgramText(school.short_name);
    const normLoc = normalizeProgramText(school.campus_location);
    const normExam = normalizeProgramText(school.exam_summary || "");

    let uniTier: number | null = null;
    let uniScore = 0;
    let uniCategory: MatchCategory = "Very Close Match";

    if (normQuery && (normQuery === normShort || normQuery === normName)) {
      uniTier = 1;
      uniScore = 1.0;
      uniCategory = "Exact Match";
    } else if (
      normQuery &&
      (` ${normName} `.includes(` ${normQuery} `) ||
        ` ${normShort} `.includes(` ${normQuery} `))
    ) {
      uniTier = 2;
      uniScore = 0.96;
      uniCategory = "Exact Match";
    } else if (
      normQuery.length >= 3 &&
      (normName.includes(normQuery) ||
        normShort.includes(normQuery) ||
        normLoc.includes(normQuery) ||
        (normExam && normExam.includes(normQuery)))
    ) {
      uniTier = 3;
      uniScore = 0.88;
      uniCategory = "Very Close Match";
    }

    // Evaluate all programs of this university using the hybrid search engine
    const rankedProgs = searchAndRankPrograms(
      getPrograms(school.id),
      rawQuery,
      { includeUniversityContext: false },
    );

    const bestProg = rankedProgs[0] ?? null;
    if (uniTier === null && !bestProg) {
      continue;
    }

    const useUniMatch =
      uniTier !== null && (!bestProg || uniTier <= bestProg.match.tier);

    const bestTier = useUniMatch ? uniTier! : bestProg!.match.tier;
    const bestScore = useUniMatch ? uniScore : bestProg!.match.relevanceScore;
    const bestCategory = useUniMatch
      ? uniCategory
      : bestProg!.match.category;

    const previewPrograms: MatchedProgramPreview[] = rankedProgs
      .slice(0, 3)
      .map((r) => ({
        id: r.item.id,
        name: r.item.name,
        topic: r.item.topic,
        match_category: r.match.category,
        match_tier: r.match.tier,
      }));

    matched.push({
      ...school,
      search_match: {
        tier: bestTier,
        category: bestCategory,
        relevance_score: bestScore,
        matched_via: useUniMatch ? "university" : "program",
        matched_programs: previewPrograms,
        matched_program_count: rankedProgs.length,
      },
    });
  }

  let ordered: Array<UniversitySearchResult<T>>;
  if (sort === "name") {
    ordered = [...matched].sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "programs") {
    ordered = [...matched].sort(
      (a, b) =>
        b.program_count - a.program_count || a.name.localeCompare(b.name),
    );
  } else {
    // Relevance-first ranking when searching in featured mode
    const byName = [...matched].sort((a, b) => a.name.localeCompare(b.name));
    const byHitCount = mergeSort(
      byName,
      (u) => u.search_match?.matched_program_count ?? 0,
      true,
    );
    const byScore = mergeSort(
      byHitCount,
      (u) => u.search_match?.relevance_score ?? 0,
      true,
    );
    ordered = mergeSort(byScore, (u) => u.search_match?.tier ?? 99, false);
  }

  return {
    items: ordered,
    total: ordered.length,
    excluded_by_filters: excludedCount,
    applied_filters: applied,
  };
}

export interface CatalogProgramRow extends SearchableProgram {
  id: string;
  university_id: string;
  university_name: string;
  short_name: string;
  city: string;
  campus_location?: string;
  sector?: string;
  color: string;
  name: string;
  topic: string;
  strand_alignment?: string | null;
  source_url?: string | null;
}

export type ProgramSearchResultRow<T extends CatalogProgramRow> = T & {
  match_category: MatchCategory | null;
  match_tier: number | null;
  relevance_score: number | null;
  match_reason: string | null;
};

export function searchCatalogPrograms<T extends CatalogProgramRow>(
  rows: T[],
  options: {
    search?: string;
    university_id?: string;
    topic?: string;
    sector?: string | string[];
    city?: string;
    page?: number;
    limit?: number;
  },
): {
  items: Array<ProgramSearchResultRow<T>>;
  total: number;
  exact_count: number;
  related_count: number;
  page: number;
  limit: number;
  applied_filters: AppliedFilters & {
    university_id: string | null;
    topic: string | null;
  };
} {
  const schoolId = cleanText(options.university_id || "");
  const topic = cleanText(options.topic || "");
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));

  // Stage 1: Hard filters first (university_id, topic, sector, city)
  const bySchoolAndTopic = rows.filter((p) => {
    if (schoolId && p.university_id !== schoolId) return false;
    if (topic && p.topic !== topic) return false;
    return true;
  });

  const { eligible, applied } = applyUniversityHardFilters(bySchoolAndTopic, {
    sector: options.sector,
    city: options.city,
  });

  // Deduplicate identical programs per university while keeping official names
  const deduped = deduplicatePrograms(eligible);

  const rawQuery = cleanText(options.search || "");
  let rankedRows: Array<ProgramSearchResultRow<T>>;
  let exactCount = 0;
  let relatedCount = 0;

  if (rawQuery) {
    const ranked = searchAndRankPrograms(deduped, rawQuery, {
      includeUniversityContext: true,
    });
    rankedRows = ranked.map(({ item, match }) => {
      if (match.tier <= 5) exactCount++;
      else relatedCount++;
      return {
        ...item,
        match_category: match.category,
        match_tier: match.tier,
        relevance_score: match.relevanceScore,
        match_reason: match.reason,
      };
    });
  } else {
    rankedRows = [...deduped]
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .map((item) => ({
        ...item,
        match_category: null,
        match_tier: null,
        relevance_score: null,
        match_reason: null,
      }));
  }

  const start = (page - 1) * limit;
  return {
    items: rankedRows.slice(start, start + limit),
    total: rankedRows.length,
    exact_count: exactCount,
    related_count: relatedCount,
    page,
    limit,
    applied_filters: {
      ...applied,
      university_id: schoolId || null,
      topic: topic || null,
    },
  };
}
