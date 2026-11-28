/**
 * Hybrid academic program search & relevance ranking engine for UniMatch PH.
 *
 * Pure TypeScript (Node + Browser safe) so both Express API routes and the
 * client live-catalog mirror produce identical search rankings.
 *
 * Strict ranking priority (lower tier ALWAYS outranks higher tier):
 *   1. Exact official program name or exact normalized core degree match
 *   2. Exact match via recognized degree abbreviation / alias
 *   3. Strong phrase / specialization match (exact degree with major/track)
 *   4. Close phrase / all-keywords / minor-typo match
 *   5. Meaningful partial keyword match (never generic suffix-only noise)
 *   6. Curated closely related academic programs (secondary results)
 *   7. Broad academic category match (only for broad field queries)
 *
 * Official university-provided program names are NEVER modified.
 */
import { cleanText } from "./extraction.js";
import { mergeSort } from "./mergeSort.js";

export type MatchCategory =
  | "Exact Match"
  | "Very Close Match"
  | "Related Match"
  | "Broad Match";

export interface ProgramSearchMatch {
  tier: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  category: MatchCategory;
  relevanceScore: number; // 0..1
  programPoints: number; // 0..1 for recommendation criterion
  matchedVia:
    | "exact_title"
    | "normalized_exact"
    | "alias_exact"
    | "specialization"
    | "strong_phrase"
    | "all_keywords"
    | "typo_exact"
    | "partial_keyword"
    | "related_program"
    | "broad_category"
    | "university_match";
  reason: string;
}

export interface SearchableProgram {
  id?: string;
  university_id?: string;
  university_name?: string;
  short_name?: string;
  name: string;
  topic?: string | null;
}

export interface RankedProgramResult<T extends SearchableProgram> {
  item: T;
  match: ProgramSearchMatch;
}

/**
 * Common Philippine undergraduate degree abbreviations & variations mapped to
 * their exact canonical discipline core. Different academic degrees are NEVER
 * collapsed onto the same alias (e.g. CS != CpE != IT != IS != DS).
 */
export const PROGRAM_ALIASES: Record<string, string> = {
  // Computing & IT (strictly distinct degrees)
  cs: "computer science",
  bscs: "computer science",
  "bs cs": "computer science",
  compsci: "computer science",
  "comp sci": "computer science",
  "computer sci": "computer science",
  "com sci": "computer science",
  comsci: "computer science",

  cpe: "computer engineering",
  bscpe: "computer engineering",
  "bs cpe": "computer engineering",
  compeng: "computer engineering",
  "comp eng": "computer engineering",
  "computer eng": "computer engineering",

  it: "information technology",
  bsit: "information technology",
  "bs it": "information technology",
  infotech: "information technology",
  "info tech": "information technology",

  is: "information systems",
  bsis: "information systems",
  "bs is": "information systems",
  infosys: "information systems",
  "info sys": "information systems",

  ds: "data science",
  bsds: "data science",
  "bs ds": "data science",
  datasci: "data science",
  "data sci": "data science",

  se: "software engineering",
  bsse: "software engineering",
  softeng: "software engineering",
  "soft eng": "software engineering",

  infosec: "information security",
  cybersec: "information security",
  cybersecurity: "information security",

  emc: "entertainment and multimedia computing",
  bsemc: "entertainment and multimedia computing",

  // Engineering
  ce: "civil engineering",
  bsce: "civil engineering",
  ee: "electrical engineering",
  bsee: "electrical engineering",
  ece: "electronics engineering",
  bsece: "electronics engineering",
  "electronics and communications engineering": "electronics engineering",
  me: "mechanical engineering",
  bsme: "mechanical engineering",
  ie: "industrial engineering",
  bsie: "industrial engineering",
  che: "chemical engineering",
  bsche: "chemical engineering",
  ge: "geodetic engineering",
  bsge: "geodetic engineering",
  sanitary: "sanitary engineering",
  mining: "mining engineering",

  // Business & Accountancy
  bsa: "accountancy",
  accounting: "accountancy",
  bsais: "accounting information systems",
  ais: "accounting information systems",
  bsma: "management accounting",
  bsba: "business administration",
  busad: "business administration",
  econ: "economics",
  bsecon: "economics",
  ab_econ: "economics",
  entrep: "entrepreneurship",
  hrm: "hospitality management",
  hm: "hospitality management",
  bshm: "hospitality management",
  bshrm: "hospitality management",
  tm: "tourism management",
  bstm: "tourism management",
  rem: "real estate management",
  bsrem: "real estate management",

  // Health & Sciences
  bsn: "nursing",
  medtech: "medical technology",
  "med tech": "medical technology",
  bsmt: "medical technology",
  mls: "medical laboratory science",
  bsmls: "medical laboratory science",
  pharma: "pharmacy",
  bspharma: "pharmacy",
  bsp: "pharmacy",
  dentistry: "dental medicine",
  dmd: "dental medicine",
  pt: "physical therapy",
  bspt: "physical therapy",
  ot: "occupational therapy",
  bsot: "occupational therapy",
  slp: "speech language pathology",
  bsslp: "speech language pathology",
  radtech: "radiologic technology",
  "rad tech": "radiologic technology",
  nd: "nutrition and dietetics",
  bsnd: "nutrition and dietetics",
  bio: "biology",
  bsbio: "biology",
  chem: "chemistry",
  bschem: "chemistry",
  biochem: "biochemistry",
  math: "mathematics",
  bsmath: "mathematics",
  stat: "statistics",
  stats: "statistics",
  bsstat: "statistics",
  physics: "physics",

  // Humanities, Social Sciences, Design, Education
  psych: "psychology",
  bspsych: "psychology",
  abpsych: "psychology",
  archi: "architecture",
  arch: "architecture",
  bsarch: "architecture",
  bsarchi: "architecture",
  polsci: "political science",
  "pol sci": "political science",
  abpolsci: "political science",
  educ: "education",
  beed: "elementary education",
  bsed: "secondary education",
  btled: "technology and livelihood education",
  crim: "criminology",
  bscrim: "criminology",
  comm: "communication",
  masscomm: "communication",
  "mass comm": "communication",
  journ: "journalism",
  "fine arts": "fine arts",
  bfa: "fine arts",
  mma: "multimedia arts",
  bmma: "multimedia arts",
  abmma: "multimedia arts",
  id: "interior design",
  bsid: "interior design",
  legma: "legal management",
  "legal mgmt": "legal management",
  lm: "legal management",
  blis: "library and information science",
  lis: "library and information science",
};

/**
 * Curated academic relatedness taxonomy.
 * Related programs are strictly secondary (Tier 6) and NEVER outrank Exact
 * or Very Close matches.
 */
const RELATED_DISCIPLINES: Record<string, Array<{ core: string; score: number }>> = {
  "computer science": [
    { core: "information technology", score: 0.66 },
    { core: "data science", score: 0.65 },
    { core: "information systems", score: 0.63 },
    { core: "computer engineering", score: 0.62 },
    { core: "software engineering", score: 0.68 },
    { core: "information security", score: 0.64 },
    { core: "entertainment and multimedia computing", score: 0.6 },
  ],
  "computer engineering": [
    { core: "computer science", score: 0.66 },
    { core: "computer engineering technology", score: 0.68 },
    { core: "electronics engineering", score: 0.64 },
    { core: "electrical engineering", score: 0.61 },
    { core: "information technology", score: 0.59 },
  ],
  "information technology": [
    { core: "information systems", score: 0.67 },
    { core: "computer science", score: 0.65 },
    { core: "data science", score: 0.62 },
    { core: "information security", score: 0.64 },
    { core: "computer engineering", score: 0.6 },
    { core: "entertainment and multimedia computing", score: 0.6 },
  ],
  "information systems": [
    { core: "information technology", score: 0.67 },
    { core: "computer science", score: 0.64 },
    { core: "data science", score: 0.62 },
    { core: "accounting information systems", score: 0.65 },
    { core: "information security", score: 0.61 },
  ],
  "data science": [
    { core: "computer science", score: 0.66 },
    { core: "statistics", score: 0.65 },
    { core: "mathematics", score: 0.62 },
    { core: "data analytics", score: 0.67 },
    { core: "information technology", score: 0.6 },
    { core: "information systems", score: 0.59 },
  ],
  "software engineering": [
    { core: "computer science", score: 0.68 },
    { core: "information technology", score: 0.64 },
    { core: "computer engineering", score: 0.62 },
    { core: "information systems", score: 0.6 },
  ],
  "information security": [
    { core: "computer science", score: 0.65 },
    { core: "information technology", score: 0.65 },
    { core: "information systems", score: 0.62 },
  ],
  accountancy: [
    { core: "accounting information systems", score: 0.66 },
    { core: "management accounting", score: 0.67 },
    { core: "internal auditing", score: 0.65 },
    { core: "business administration", score: 0.58 },
  ],
  "accounting information systems": [
    { core: "accountancy", score: 0.66 },
    { core: "information systems", score: 0.64 },
    { core: "management accounting", score: 0.62 },
  ],
  nursing: [
    { core: "medical technology", score: 0.58 },
    { core: "physical therapy", score: 0.58 },
    { core: "pharmacy", score: 0.58 },
    { core: "public health", score: 0.61 },
    { core: "midwifery", score: 0.62 },
  ],
  "medical technology": [
    { core: "medical laboratory science", score: 0.68 },
    { core: "biology", score: 0.58 },
    { core: "pharmacy", score: 0.58 },
    { core: "biochemistry", score: 0.6 },
    { core: "public health", score: 0.58 },
  ],
  "medical laboratory science": [
    { core: "medical technology", score: 0.68 },
    { core: "biology", score: 0.58 },
    { core: "biochemistry", score: 0.6 },
  ],
  psychology: [
    { core: "behavioral sciences", score: 0.64 },
    { core: "guidance and counseling", score: 0.63 },
    { core: "sociology", score: 0.58 },
  ],
  architecture: [
    { core: "interior design", score: 0.62 },
    { core: "civil engineering", score: 0.6 },
    { core: "landscape architecture", score: 0.65 },
    { core: "industrial design", score: 0.58 },
  ],
  "civil engineering": [
    { core: "architecture", score: 0.6 },
    { core: "sanitary engineering", score: 0.64 },
    { core: "geodetic engineering", score: 0.62 },
    { core: "environmental engineering", score: 0.62 },
  ],
  "electrical engineering": [
    { core: "electronics engineering", score: 0.66 },
    { core: "computer engineering", score: 0.62 },
    { core: "mechanical engineering", score: 0.58 },
  ],
  "electronics engineering": [
    { core: "electrical engineering", score: 0.66 },
    { core: "computer engineering", score: 0.65 },
  ],
  "mechanical engineering": [
    { core: "industrial engineering", score: 0.6 },
    { core: "manufacturing engineering", score: 0.64 },
    { core: "electrical engineering", score: 0.58 },
  ],
  "industrial engineering": [
    { core: "mechanical engineering", score: 0.6 },
    { core: "management engineering", score: 0.65 },
    { core: "manufacturing engineering", score: 0.63 },
  ],
  "hospitality management": [
    { core: "tourism management", score: 0.66 },
    { core: "culinary management", score: 0.63 },
    { core: "business administration", score: 0.58 },
  ],
  "tourism management": [
    { core: "hospitality management", score: 0.66 },
    { core: "business administration", score: 0.58 },
  ],
  "multimedia arts": [
    { core: "fine arts", score: 0.63 },
    { core: "communication", score: 0.61 },
    { core: "entertainment and multimedia computing", score: 0.64 },
    { core: "interactive entertainment", score: 0.64 },
  ],
  communication: [
    { core: "journalism", score: 0.65 },
    { core: "broadcasting", score: 0.64 },
    { core: "multimedia arts", score: 0.61 },
    { core: "advertising", score: 0.62 },
  ],
};

/**
 * Broad category queries that intentionally target a whole academic field
 * rather than a single specific degree.
 */
const BROAD_CATEGORY_TERMS = new Set([
  "computing",
  "engineering",
  "business",
  "health",
  "science",
  "sciences",
  "education",
  "arts",
  "humanities",
  "social sciences",
  "law",
  "hospitality",
  "tourism",
  "design",
  "medicine",
  "allied health",
]);

/**
 * Generic discipline suffixes that MUST NOT produce false-positive partial matches
 * by themselves in multi-word specific degree queries (e.g., "technology" in
 * "Information Technology" must NOT match "Medical Technology"; "science" in
 * "Computer Science" must NOT match "Political Science"; "engineering" in
 * "Computer Engineering" must NOT match "Civil Engineering").
 */
const GENERIC_DISCIPLINE_WORDS = new Set([
  "science",
  "sciences",
  "technology",
  "technologies",
  "engineering",
  "management",
  "administration",
  "studies",
  "arts",
  "systems",
  "system",
  "education",
  "applied",
  "general",
  "business",
  "university",
  "college",
  "school",
  "institute",
  "campus",
  "manila",
  "philippines",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "bachelor",
  "bs",
  "ba",
  "ab",
  "bfa",
  "bm",
  "course",
  "courses",
  "degree",
  "degrees",
  "for",
  "in",
  "major",
  "minor",
  "of",
  "program",
  "programs",
  "specialization",
  "specializing",
  "the",
  "track",
  "with",
]);

const DEGREE_PREFIX_PATTERNS: RegExp[] = [
  /^bachelor\s+of\s+science\s+in\s+/,
  /^bachelor\s+of\s+arts\s+in\s+/,
  /^bachelor\s+of\s+fine\s+arts\s+in\s+/,
  /^bachelor\s+of\s+music\s+in\s+/,
  /^bachelor\s+of\s+laws\s+in\s+/,
  /^bachelor\s+of\s+engineering\s+technology\s+major\s+in\s+/,
  /^bachelor\s+of\s+engineering\s+in\s+/,
  /^bachelor\s+of\s+secondary\s+education\s+major\s+in\s+/,
  /^bachelor\s+of\s+elementary\s+education\s+major\s+in\s+/,
  /^bachelor\s+of\s+library\s+and\s+/,
  /^bachelor\s+of\s+[a-z]+\s+in\s+/,
  /^bachelor\s+of\s+/,
  /^doctor\s+of\s+/,
  /^master\s+of\s+science\s+in\s+/,
  /^master\s+of\s+arts\s+in\s+/,
  /^bs\s+in\s+/,
  /^ba\s+in\s+/,
  /^ab\s+in\s+/,
  /^bfa\s+in\s+/,
  /^bs\s+/,
  /^ba\s+/,
  /^ab\s+/,
  /^bfa\s+/,
];

const TRAILING_FILLER_RE = /\s+(?:degree|program|course|degrees|programs|courses)$/;

/**
 * Normalizes capitalization, diacritics, abbreviations with dots ("B.S." -> "bs"),
 * punctuation, and repeated whitespace while preserving alphanumeric words.
 */
export function normalizeProgramText(value: string): string {
  const cleaned = cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // Collapse dotted initials like "B.S." -> "bs", "A.B." -> "ab", "B.S.C.S." -> "bscs"
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

/**
 * Strips non-discipline parenthetical annotations from official catalog titles
 * (e.g. "(BSIT)", "(BSCS)", "(Challenge-Based Learning)", "(2 years in Laguna, 2 years in Manila)")
 * so that canonical degree matching recognizes exact degrees accurately while
 * preserving the original official name for display.
 */
export function stripParentheticalAnnotations(officialName: string): string {
  return cleanText(officialName)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripDegreePrefix(normalized: string): string {
  let current = normalized.trim();
  // Strip trailing generic words like "degree" / "program" / "course"
  while (TRAILING_FILLER_RE.test(current)) {
    const next = current.replace(TRAILING_FILLER_RE, "").trim();
    if (!next) break;
    current = next;
  }
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

export interface InterpretedQuery {
  raw: string;
  normalized: string;
  core: string;
  expandedCore: string;
  usedAlias: boolean;
  tokens: string[];
  isBroadCategory: boolean;
}

export function interpretProgramQuery(rawQuery: string): InterpretedQuery {
  const raw = cleanText(rawQuery);
  const normalized = normalizeProgramText(raw);
  const stripped = stripDegreePrefix(normalized);

  let expandedCore = stripped || normalized;
  let usedAlias = false;

  if (PROGRAM_ALIASES[normalized]) {
    expandedCore = PROGRAM_ALIASES[normalized];
    usedAlias = true;
  } else if (PROGRAM_ALIASES[stripped]) {
    expandedCore = PROGRAM_ALIASES[stripped];
    usedAlias = true;
  } else {
    // Also check if stripping trailing degree words reveals an alias (e.g. "BSCS degree")
    const strippedRaw = normalized.replace(TRAILING_FILLER_RE, "").trim();
    if (PROGRAM_ALIASES[strippedRaw]) {
      expandedCore = PROGRAM_ALIASES[strippedRaw];
      usedAlias = true;
    }
  }

  const tokens = tokenizeMeaningful(expandedCore || normalized);
  const isBroadCategory =
    BROAD_CATEGORY_TERMS.has(expandedCore) ||
    (tokens.length === 1 && BROAD_CATEGORY_TERMS.has(tokens[0]));

  return {
    raw,
    normalized,
    core: stripped || normalized,
    expandedCore,
    usedAlias,
    tokens,
    isBroadCategory,
  };
}

export function tokenizeMeaningful(normalizedText: string): string[] {
  const words = normalizeProgramText(normalizedText).split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

/**
 * Optimal string alignment / Damerau-Levenshtein distance for minor typo handling
 * (handles missing letter, extra letter, wrong letter, and adjacent swaps).
 */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (a === b) return 0;
  if (m === 0) return n;
  if (n === 0) return m;
  if (Math.abs(m - n) > 2) return 3;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        val = Math.min(val, dp[i - 2][j - 2] + cost);
      }
      dp[i][j] = val;
    }
  }
  return dp[m][n];
}

function tokenExactOrInflection(wanted: string, available: string): boolean {
  if (wanted === available) return true;
  if (wanted.length < 4 || available.length < 4) return false;
  if (
    wanted + "s" === available ||
    available + "s" === wanted ||
    wanted + "es" === available ||
    available + "es" === wanted
  ) {
    return true;
  }
  return false;
}

function tokenTypoMatches(wanted: string, available: string): boolean {
  if (wanted === available) return true;
  const minLen = Math.min(wanted.length, available.length);
  if (minLen < 4) return false;
  // First letter must match for 4-5 char words to avoid false swaps like "data"/"date"
  if (minLen <= 5 && wanted[0] !== available[0]) return false;
  const maxDist = minLen >= 7 ? 2 : 1;
  return damerauLevenshtein(wanted, available) <= maxDist;
}

function hasWholePhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function isSpecializationOf(programCore: string, queriedCore: string): boolean {
  if (!programCore || !queriedCore) return false;
  return (
    programCore.startsWith(`${queriedCore} major `) ||
    programCore.startsWith(`${queriedCore} with `) ||
    programCore.startsWith(`${queriedCore} specialization `) ||
    programCore.startsWith(`${queriedCore} track `) ||
    programCore.startsWith(`${queriedCore} minor `) ||
    programCore.startsWith(`${queriedCore} concentration `) ||
    programCore.startsWith(`${queriedCore} option `) ||
    programCore.startsWith(`${queriedCore} honors `) ||
    programCore.startsWith(`${queriedCore} and master `)
  );
}

/**
 * Checks whether a program's core discipline matches a known related program
 * for the interpreted query. Also resolves minor-typo queries to their canonical
 * discipline before looking up related programs.
 */
function resolveCanonicalDisciplineForRelated(query: InterpretedQuery): string | null {
  if (RELATED_DISCIPLINES[query.expandedCore]) {
    return query.expandedCore;
  }
  // Check typo closeness against canonical discipline keys (length >= 6)
  for (const key of Object.keys(RELATED_DISCIPLINES)) {
    const keyTokens = tokenizeMeaningful(key);
    if (keyTokens.length === query.tokens.length && keyTokens.length > 0) {
      const allClose = query.tokens.every((qt) =>
        keyTokens.some((kt) => tokenTypoMatches(qt, kt)),
      );
      if (allClose) return key;
    }
  }
  return null;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Evaluates how well a single official program matches a user query.
 * Returns null if the program is irrelevant and should NOT appear in results.
 */
export function evaluateProgramMatch(
  rawQuery: string,
  programName: string,
  topic?: string | null,
  universityContext?: { name?: string; short_name?: string } | null,
): ProgramSearchMatch | null {
  const query = interpretProgramQuery(rawQuery);
  if (!query.normalized) return null;

  const officialName = cleanText(programName);
  if (!officialName) return null;

  const fullNorm = normalizeProgramText(officialName);
  const fullCore = stripDegreePrefix(fullNorm);
  const baseNoParenNorm = normalizeProgramText(
    stripParentheticalAnnotations(officialName),
  );
  const baseCore = stripDegreePrefix(baseNoParenNorm);

  // -------------------------------------------------------------------------
  // TIER 1: Exact official title OR exact normalized core degree match
  // -------------------------------------------------------------------------
  if (!query.usedAlias && query.normalized === fullNorm) {
    return {
      tier: 1,
      category: "Exact Match",
      relevanceScore: 1.0,
      programPoints: 1.0,
      matchedVia: "exact_title",
      reason: `Exact program match: ${officialName}.`,
    };
  }

  if (
    !query.usedAlias &&
    query.expandedCore &&
    (query.expandedCore === fullCore || query.expandedCore === baseCore)
  ) {
    return {
      tier: 1,
      category: "Exact Match",
      relevanceScore: query.expandedCore === fullCore ? 1.0 : 0.995,
      programPoints: 1.0,
      matchedVia: "normalized_exact",
      reason: `Exact program match: ${officialName}.`,
    };
  }

  // -------------------------------------------------------------------------
  // TIER 2: Exact match via recognized degree abbreviation / alias
  // (e.g. "BSCS" / "CS" -> BS Computer Science; "BSIT" / "IT" -> BS Information Technology)
  // -------------------------------------------------------------------------
  if (
    query.usedAlias &&
    query.expandedCore &&
    (query.expandedCore === fullCore || query.expandedCore === baseCore)
  ) {
    return {
      tier: 2,
      category: "Exact Match",
      relevanceScore: query.expandedCore === fullCore ? 0.99 : 0.985,
      programPoints: 1.0,
      matchedVia: "alias_exact",
      reason: `Exact program match via abbreviation (${query.raw} → ${query.expandedCore}): ${officialName}.`,
    };
  }

  // -------------------------------------------------------------------------
  // TIER 3: Very Close Match — exact degree with specialization / major / track
  // (e.g. "BS Computer Science Major in Software Technology")
  // -------------------------------------------------------------------------
  if (
    query.expandedCore &&
    query.expandedCore.length >= 3 &&
    (isSpecializationOf(baseCore, query.expandedCore) ||
      isSpecializationOf(fullCore, query.expandedCore))
  ) {
    return {
      tier: 3,
      category: "Very Close Match",
      relevanceScore: 0.94,
      programPoints: 0.95,
      matchedVia: "specialization",
      reason: `Very close match — ${officialName} is a specialized track of ${query.expandedCore}.`,
    };
  }

  // -------------------------------------------------------------------------
  // TIER 4: Strong phrase match, word-order match, or exact-degree minor typo
  // (e.g. "BS Industrial Engineering with specialization in Information Technology",
  //  "BS Mathematics with Specialization in Data Science",
  //  "Science Computer" -> BS Computer Science,
  //  "Computr Scince" -> BS Computer Science)
  // -------------------------------------------------------------------------
  if (
    query.expandedCore &&
    query.expandedCore.length >= 3 &&
    (hasWholePhrase(baseCore, query.expandedCore) ||
      hasWholePhrase(fullCore, query.expandedCore))
  ) {
    return {
      tier: 4,
      category: "Very Close Match",
      relevanceScore: 0.88,
      programPoints: 0.88,
      matchedVia: "strong_phrase",
      reason: `Strong phrase match in '${officialName}'.`,
    };
  }

  const programTokens = tokenizeMeaningful(baseCore || fullCore || fullNorm);
  const queryTokens = query.tokens;

  if (queryTokens.length > 0) {
    const exactMatches: string[] = [];
    const typoMatches: string[] = [];
    for (const qt of queryTokens) {
      if (programTokens.some((pt) => tokenExactOrInflection(qt, pt))) {
        exactMatches.push(qt);
      } else if (programTokens.some((pt) => tokenTypoMatches(qt, pt))) {
        typoMatches.push(qt);
      }
    }

    // All query tokens matched (exact or word-order variation)
    if (exactMatches.length === queryTokens.length) {
      const sameTokenCount = programTokens.length === queryTokens.length;
      return {
        tier: sameTokenCount ? 3 : 4,
        category: "Very Close Match",
        relevanceScore: sameTokenCount ? 0.92 : 0.86,
        programPoints: sameTokenCount ? 0.95 : 0.88,
        matchedVia: "all_keywords",
        reason: `All query terms match '${officialName}'.`,
      };
    }

    // Minor spelling mistake covering the whole queried degree
    if (exactMatches.length + typoMatches.length === queryTokens.length) {
      const isSameCoreLength = programTokens.length === queryTokens.length;
      const isPrefixSpecialization =
        programTokens.length > queryTokens.length &&
        queryTokens.every((qt, idx) =>
          programTokens[idx] ? tokenTypoMatches(qt, programTokens[idx]) : false,
        );
      if (isSameCoreLength || isPrefixSpecialization) {
        return {
          tier: isSameCoreLength ? 3 : 4,
          category: "Very Close Match",
          relevanceScore: isSameCoreLength ? 0.91 : 0.84,
          programPoints: isSameCoreLength ? 0.95 : 0.85,
          matchedVia: "typo_exact",
          reason: `Matched '${officialName}' (accounting for spelling variation in "${query.raw}").`,
        };
      }
      return {
        tier: 4,
        category: "Very Close Match",
        relevanceScore: 0.82,
        programPoints: 0.84,
        matchedVia: "typo_exact",
        reason: `Close keyword match in '${officialName}'.`,
      };
    }

    // -----------------------------------------------------------------------
    // TIER 6 (check curated Related Academic Programs BEFORE generic partials
    // so e.g. "Computer Engineering" for "Computer Science" is clearly labeled
    // "Related Match" instead of noisy partial keyword overlap!)
    // -----------------------------------------------------------------------
    const canonicalForRelated = resolveCanonicalDisciplineForRelated(query);
    if (canonicalForRelated) {
      const relatedList = RELATED_DISCIPLINES[canonicalForRelated] ?? [];
      for (const rel of relatedList) {
        if (
          baseCore === rel.core ||
          fullCore === rel.core ||
          isSpecializationOf(baseCore, rel.core) ||
          hasWholePhrase(baseCore, rel.core)
        ) {
          const score =
            baseCore === rel.core || fullCore === rel.core
              ? rel.score
              : roundTo(rel.score - 0.04, 3);
          return {
            tier: 6,
            category: "Related Match",
            relevanceScore: score,
            programPoints: 0.65,
            matchedVia: "related_program",
            reason: `Related academic program to ${canonicalForRelated}: ${officialName}.`,
          };
        }
      }
    }

    // -----------------------------------------------------------------------
    // TIER 5: Meaningful partial keyword match (NEVER generic suffix-only noise)
    // -----------------------------------------------------------------------
    const matchedWords = [...exactMatches, ...typoMatches];
    if (matchedWords.length > 0) {
      const hasSpecificNonGenericWord = matchedWords.some(
        (w) => !GENERIC_DISCIPLINE_WORDS.has(w),
      );
      const weakCrossWords = new Set(["information", "communication", "media"]);
      const hasStrongSpecificWord =
        queryTokens.length === 1
          ? true
          : matchedWords.some(
              (w) =>
                !GENERIC_DISCIPLINE_WORDS.has(w) && !weakCrossWords.has(w),
            );
      const weighted = exactMatches.length + typoMatches.length * 0.85;
      const ratio = weighted / queryTokens.length;
      const meetsOverlapThreshold = queryTokens.length === 1 || ratio >= 0.5;

      if (
        hasSpecificNonGenericWord &&
        hasStrongSpecificWord &&
        meetsOverlapThreshold
      ) {
        const relevanceScore = roundTo(0.7 + 0.1 * ratio, 3);
        const programPoints = roundTo(Math.min(0.78, 0.78 * ratio), 3);
        return {
          tier: 5,
          category: "Very Close Match",
          relevanceScore,
          programPoints,
          matchedVia: "partial_keyword",
          reason: `Partial keyword match in '${officialName}' (${matchedWords.join(", ")}).`,
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // TIER 7: Broad category / topic match ONLY when user searched a broad field
  // (e.g. "Computing", "Engineering", "Health", "Business", "Education")
  // -------------------------------------------------------------------------
  const topicText = cleanText(topic ?? "");
  if (query.isBroadCategory && topicText) {
    const topicTokens = tokenizeMeaningful(topicText);
    const topicHit = queryTokens.filter((qt) =>
      topicTokens.some(
        (tt) => tokenExactOrInflection(qt, tt) || tokenTypoMatches(qt, tt),
      ),
    );
    if (topicHit.length > 0) {
      return {
        tier: 7,
        category: "Broad Match",
        relevanceScore: 0.48,
        programPoints: 0.55,
        matchedVia: "broad_category",
        reason: `Falls under the '${topicText}' academic area (${officialName}).`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Optional university name / short_name match (for program directory search
  // when a student types "UST" or "De La Salle" into the Degrees search bar)
  // -------------------------------------------------------------------------
  if (universityContext && query.normalized.length >= 2) {
    const uniNameNorm = normalizeProgramText(universityContext.name || "");
    const uniShortNorm = normalizeProgramText(
      universityContext.short_name || "",
    );
    if (
      (uniShortNorm &&
        (uniShortNorm === query.normalized ||
          hasWholePhrase(uniShortNorm, query.normalized))) ||
      (query.normalized.length >= 4 &&
        uniNameNorm &&
        uniNameNorm.includes(query.normalized))
    ) {
      return {
        tier: 7,
        category: "Broad Match",
        relevanceScore: 0.45,
        programPoints: 0.5,
        matchedVia: "university_match",
        reason: `Offered by ${universityContext.name || universityContext.short_name}.`,
      };
    }
  }

  return null;
}

/**
 * Deduplicates programs per university using normalized official title while
 * preserving the original official university-provided name verbatim.
 */
export function deduplicatePrograms<T extends SearchableProgram>(
  programs: T[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const prog of programs) {
    const uid = String(prog.university_id || "").toLowerCase();
    const normName = normalizeProgramText(prog.name);
    const key = `${uid}::${normName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(prog);
  }
  return unique;
}

/**
 * Ranks a list of programs for a search query with strict tier ordering:
 * Exact Match > Very Close Match > Related Match > Broad Match.
 * Uses stable merge sort so ties remain deterministic.
 */
export function searchAndRankPrograms<T extends SearchableProgram>(
  programs: T[],
  rawQuery: string,
  options: { includeUniversityContext?: boolean } = {},
): RankedProgramResult<T>[] {
  const deduped = deduplicatePrograms(programs);
  const query = cleanText(rawQuery);
  if (!query) return [];

  const matched: RankedProgramResult<T>[] = [];
  for (const item of deduped) {
    const match = evaluateProgramMatch(
      query,
      item.name,
      item.topic,
      options.includeUniversityContext
        ? { name: item.university_name, short_name: item.short_name }
        : null,
    );
    if (match) {
      matched.push({ item, match });
    }
  }

  // Multi-key stable merge sort (least significant key first):
  // 4) Official program name alphabetically
  // 3) Shorter canonical title first within same tier/score
  // 2) Relevance score descending
  // 1) Match tier ascending (STRICT primary key)
  const byName = [...matched].sort(
    (a, b) =>
      a.item.name.localeCompare(b.item.name) ||
      String(a.item.university_name || "").localeCompare(
        String(b.item.university_name || ""),
      ),
  );
  const byLength = mergeSort(byName, (r) => r.item.name.length, false);
  const byScore = mergeSort(byLength, (r) => r.match.relevanceScore, true);
  const byTier = mergeSort(byScore, (r) => r.match.tier, false);

  return byTier;
}
