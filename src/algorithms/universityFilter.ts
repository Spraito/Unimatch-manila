/**
 * Strict hard-constraint university filtering engine for UniMatch PH.
 *
 * Filters MUST exclude non-matching universities BEFORE recommendation scoring.
 * Selecting "Private" strictly excludes all Public universities; selecting
 * "Public" strictly excludes all Private universities; selecting both or none
 * allows all eligible universities. The same strict constraint rule applies to
 * location/city, university ID, and topic filters.
 */
import { cleanText } from "./extraction.js";
import { normalizeProgramText } from "./programSearch.js";

export type ValidSector = "Public" | "Private";

export interface FilterableUniversity {
  sector?: string | null;
  city?: string | null;
  campus_location?: string | null;
}

export interface AppliedFilters {
  sectors: ValidSector[];
  city: string | null;
}

/**
 * Parses a sector filter from a string ("Private", "Public", "Public,Private"),
 * an array (["Public", "Private"]), or empty/null.
 * Throws an explicit validation error on unknown values.
 */
export function parseSectorFilter(raw: unknown): ValidSector[] {
  if (raw === null || raw === undefined || raw === "") return [];

  const parts: string[] = Array.isArray(raw)
    ? raw.flatMap((v) => String(v ?? "").split(","))
    : String(raw).split(",");

  const normalized: ValidSector[] = [];
  const seen = new Set<ValidSector>();

  for (const part of parts) {
    const cleaned = cleanText(part);
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (lower === "all" || lower === "any" || lower === "both") {
      return [];
    }
    if (lower === "public") {
      if (!seen.has("Public")) {
        seen.add("Public");
        normalized.push("Public");
      }
    } else if (lower === "private") {
      if (!seen.has("Private")) {
        seen.add("Private");
        normalized.push("Private");
      }
    } else {
      throw new Error("Sector must be Public or Private");
    }
  }

  return normalized;
}

/**
 * Normalizes a university's stored sector value into a canonical ValidSector
 * or null if missing/unrecognized.
 */
export function normalizeUniversitySector(raw: unknown): ValidSector | null {
  const cleaned = cleanText(typeof raw === "string" ? raw : "").toLowerCase();
  if (cleaned === "public") return "Public";
  if (cleaned === "private") return "Private";
  return null;
}

/**
 * Hard constraint check for university sector.
 * - No selection OR both Public & Private selected -> passes all universities
 * - Private only -> ONLY Private universities pass
 * - Public only -> ONLY Public universities pass
 */
export function matchesSectorFilter(
  universitySector: unknown,
  allowedSectors: ValidSector[],
): boolean {
  if (allowedSectors.length === 0 || allowedSectors.length >= 2) {
    return true;
  }
  const actual = normalizeUniversitySector(universitySector);
  if (!actual) return false;
  return allowedSectors.includes(actual);
}

/**
 * Hard constraint check for location (city or campus district such as
 * Intramuros, Ermita, Malate, Sampaloc, San Miguel, Sta. Mesa, Manila).
 */
export function matchesLocationFilter(
  city: unknown,
  campusLocation: unknown,
  locationFilter: string | null | undefined,
): boolean {
  const filter = cleanText(locationFilter ?? "");
  if (!filter) return true;

  const cityText = cleanText(typeof city === "string" ? city : "");
  const campusText = cleanText(
    typeof campusLocation === "string" ? campusLocation : "",
  );
  if (!cityText && !campusText) return false;
  if (`${cityText} ${campusText}`.toLowerCase().includes("not specified")) {
    return false;
  }

  let campusFocus = campusText;
  if (!filter.toLowerCase().includes("metro")) {
    campusFocus = campusText.replace(/\bmetro\s+manila\b/gi, "");
  }

  const filterKey = normalizeProgramText(filter);
  const cityKey = normalizeProgramText(cityText);
  const campusKey = normalizeProgramText(campusFocus);
  const segments = campusFocus
    .split(",")
    .map((s) => normalizeProgramText(s))
    .filter(Boolean);

  if (!filterKey) return true;
  if (filterKey === cityKey || segments.includes(filterKey)) {
    return true;
  }
  // Whole-phrase match inside campus address (e.g. "Taft", "España", "Mendiola", "Sta Mesa")
  if (
    ` ${campusKey} `.includes(` ${filterKey} `) ||
    ` ${cityKey} `.includes(` ${filterKey} `)
  ) {
    return true;
  }
  return false;
}

/**
 * Applies all hard university filters before scoring or ranking.
 */
export function applyUniversityHardFilters<T extends FilterableUniversity>(
  items: T[],
  filters: {
    sector?: unknown;
    city?: string | null;
  },
): {
  eligible: T[];
  excludedCount: number;
  applied: AppliedFilters;
} {
  const sectors = parseSectorFilter(filters.sector);
  const city = cleanText(filters.city ?? "") || null;

  const eligible: T[] = [];
  for (const item of items) {
    if (!matchesSectorFilter(item.sector, sectors)) continue;
    if (!matchesLocationFilter(item.city, item.campus_location, city)) continue;
    eligible.push(item);
  }

  return {
    eligible,
    excludedCount: items.length - eligible.length,
    applied: { sectors, city },
  };
}
