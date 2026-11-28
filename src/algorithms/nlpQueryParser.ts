/**
 * Offline Classical NLP Match Assistant for UniMatch PH.
 *
 * Pure TypeScript (Node + Browser safe), zero external AI APIs, zero network
 * dependencies, and 100% isolated from UniMatch PH's deterministic search,
 * strict hard-constraint filtering, and weighted rule-based scoring engines.
 *
 * Pipeline stages:
 *   1. Text normalization & diacritic folding (preserving original spans)
 *   2. Rule-based Named Entity Recognition (NER) with span masking:
 *      - Tuition budget & billing basis extraction (PHP / k / ranges / free)
 *      - University type (sector) & negation rule detection
 *      - Manila campus area & student landmark resolution
 *   3. Phrase chunking, stop-word stripping & lexical program extraction:
 *      - Explicit degree phrases & Philippine degree abbreviations (case-safe)
 *      - Live catalog program title matching
 *      - Offline interest/career-to-degree lexicon
 *      - Verified residual academic phrase fallback
 *   4. Transparent entity attribution & human-readable summary generation
 */
import { cleanText } from "./extraction.js";
import {
  PROGRAM_ALIASES,
  evaluateProgramMatch,
  normalizeProgramText,
  stripDegreePrefix,
  stripParentheticalAnnotations,
} from "./programSearch.js";

export type NlpBudgetBasis = "semester" | "trimester" | "year" | "unit";
export type NlpSectorValue = "Public" | "Private" | "Public,Private";

export interface NlpCatalogContext {
  programNames?: string[];
  campusAreas?: string[];
}

export interface NlpDetectedEntity {
  field: "program" | "city" | "sector" | "budget";
  label: string;
  value: string;
  matchedPhrase: string;
  method:
    | "currency_ner"
    | "free_tuition_rule"
    | "sector_ner"
    | "negation_rule"
    | "location_ner"
    | "landmark_ner"
    | "degree_phrase"
    | "alias_ner"
    | "catalog_phrase"
    | "interest_lexicon"
    | "residual_phrase";
  confidence: number;
}

export interface ParsedMatchPreferences {
  program: string | null;
  city: string | null;
  sector: NlpSectorValue | null;
  budget: number | null;
  budget_basis: NlpBudgetBasis | null;
}

export interface ParsedMatchQuery {
  originalText: string;
  normalizedText: string;
  preferences: ParsedMatchPreferences;
  entities: NlpDetectedEntity[];
  unmatchedTokens: string[];
  hasMatches: boolean;
  summary: string;
  engine: "classical-offline-nlp-v1";
}

interface TextSpan {
  start: number;
  end: number;
}

const MAX_SENTENCE_LENGTH = 500;

/**
 * 2-letter aliases that collide with common English/Tagalog words.
 * Only matched when UPPERCASE in the original sentence (e.g. "IT", "IS", "ME")
 * or preceded by an explicit degree prefix (e.g. "BS IT", "BS IS", "BS ME").
 */
const CASE_SENSITIVE_SHORT_ALIASES = new Set([
  "it",
  "is",
  "me",
  "ce",
  "ee",
  "ie",
  "ge",
  "ot",
  "pt",
  "nd",
  "se",
  "hm",
  "tm",
  "ds",
]);

/**
 * Manila districts & everyday student landmarks mapped to UniMatch PH's
 * canonical campus areas. Ordered longest/most-specific first.
 */
const LOCATION_PATTERNS: Array<{
  pattern: RegExp;
  area: string;
  method: "location_ner" | "landmark_ner";
  confidence: number;
}> = [
  // Intramuros
  {
    pattern: /\bintramuros\b/i,
    area: "Intramuros",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern: /\b(?:walled\s+city|muralla(?:\s+st(?:reet)?)?|general\s+luna(?:\s+st(?:reet)?)?|gen\.?\s+luna)\b/i,
    area: "Intramuros",
    method: "landmark_ner",
    confidence: 0.9,
  },

  // Ermita
  {
    pattern: /\bermita\b/i,
    area: "Ermita",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern:
      /\b(?:padre\s+faura(?:\s+st(?:reet)?)?|faura|san\s+marcelino(?:\s+st(?:reet)?)?|ayala\s+b(?:ou)?l(?:e)?v(?:ar)?d\.?|un\s+ave(?:nue)?|united\s+nations\s+ave(?:nue)?|luneta|rizal\s+park|kalaw(?:\s+ave(?:nue)?)?)\b/i,
    area: "Ermita",
    method: "landmark_ner",
    confidence: 0.9,
  },

  // Malate
  {
    pattern: /\bmalate\b/i,
    area: "Malate",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern:
      /\b(?:vito\s+cruz|pedro\s+gil(?:\s+st(?:reet)?)?|taft(?:\s+ave(?:nue)?)?|quirino\s+ave(?:nue)?|p\.?\s+ocampo)\b/i,
    area: "Malate",
    method: "landmark_ner",
    confidence: 0.88,
  },

  // Sampaloc
  {
    pattern: /\bsampaloc\b/i,
    area: "Sampaloc",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern:
      /\b(?:espana(?:\s+b(?:ou)?l(?:e)?v(?:ar)?d\.?)?|u[-\s]?belt|university\s+belt|morayta|nicanor\s+reyes(?:\s+st(?:reet)?)?|c\.?\s*m\.?\s*recto(?:\s+ave(?:nue)?)?|recto(?:\s+ave(?:nue)?)?|dapitan|lacson|legarda)\b/i,
    area: "Sampaloc",
    method: "landmark_ner",
    confidence: 0.9,
  },

  // San Miguel
  {
    pattern: /\bsan\s+miguel\b/i,
    area: "San Miguel",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern: /\b(?:mendiola(?:\s+st(?:reet)?)?|malacanang)\b/i,
    area: "San Miguel",
    method: "landmark_ner",
    confidence: 0.9,
  },

  // Sta. Mesa
  {
    pattern: /\b(?:sta\.?\s+mesa|santa\s+mesa)\b/i,
    area: "Sta. Mesa",
    method: "location_ner",
    confidence: 0.98,
  },
  {
    pattern: /\b(?:pureza|anonas(?:\s+st(?:reet)?)?|teresa\s+st(?:reet)?)\b/i,
    area: "Sta. Mesa",
    method: "landmark_ner",
    confidence: 0.9,
  },
];

/**
 * Curated offline interest / career-to-degree lexicon (longest phrases first).
 * Used ONLY when no explicit degree name or recognized abbreviation was found.
 */
const INTEREST_TO_DEGREE: Array<{
  phrase: string;
  program: string;
  confidence: number;
}> = [
  { phrase: "software development", program: "Computer Science", confidence: 0.88 },
  { phrase: "software developer", program: "Computer Science", confidence: 0.88 },
  { phrase: "software programming", program: "Computer Science", confidence: 0.88 },
  { phrase: "artificial intelligence", program: "Computer Science", confidence: 0.88 },
  { phrase: "machine learning", program: "Computer Science", confidence: 0.88 },
  { phrase: "web development", program: "Information Technology", confidence: 0.85 },
  { phrase: "app development", program: "Computer Science", confidence: 0.85 },
  { phrase: "mobile development", program: "Information Technology", confidence: 0.85 },
  { phrase: "game development", program: "Entertainment and Multimedia Computing", confidence: 0.88 },
  { phrase: "game design", program: "Entertainment and Multimedia Computing", confidence: 0.86 },
  { phrase: "game dev", program: "Entertainment and Multimedia Computing", confidence: 0.86 },
  { phrase: "cyber security", program: "Information Technology", confidence: 0.84 },
  { phrase: "ethical hacking", program: "Information Technology", confidence: 0.82 },
  { phrase: "network administration", program: "Information Technology", confidence: 0.85 },
  { phrase: "tech support", program: "Information Technology", confidence: 0.8 },
  { phrase: "data analytics", program: "Data Science", confidence: 0.88 },
  { phrase: "data analysis", program: "Data Science", confidence: 0.86 },
  { phrase: "business analytics", program: "Information Systems", confidence: 0.84 },
  { phrase: "big data", program: "Data Science", confidence: 0.85 },
  { phrase: "embedded systems", program: "Computer Engineering", confidence: 0.88 },
  { phrase: "hardware engineering", program: "Computer Engineering", confidence: 0.88 },
  { phrase: "microcontrollers", program: "Computer Engineering", confidence: 0.86 },
  { phrase: "robotics", program: "Computer Engineering", confidence: 0.84 },
  { phrase: "coding", program: "Computer Science", confidence: 0.82 },
  { phrase: "programming", program: "Computer Science", confidence: 0.82 },
  { phrase: "programmer", program: "Computer Science", confidence: 0.82 },

  // Health & Medicine
  { phrase: "patient care", program: "Nursing", confidence: 0.84 },
  { phrase: "registered nurse", program: "Nursing", confidence: 0.9 },
  { phrase: "become a nurse", program: "Nursing", confidence: 0.9 },
  { phrase: "clinical laboratory", program: "Medical Technology", confidence: 0.88 },
  { phrase: "lab testing", program: "Medical Technology", confidence: 0.82 },
  { phrase: "pre-med", program: "Biology", confidence: 0.82 },
  { phrase: "premed", program: "Biology", confidence: 0.82 },
  { phrase: "pre med", program: "Biology", confidence: 0.82 },
  { phrase: "become a doctor", program: "Biology", confidence: 0.8 },
  { phrase: "pharmacist", program: "Pharmacy", confidence: 0.9 },
  { phrase: "dentist", program: "Dental Medicine", confidence: 0.9 },
  { phrase: "oral health", program: "Dental Medicine", confidence: 0.85 },
  { phrase: "sports therapy", program: "Physical Therapy", confidence: 0.84 },
  { phrase: "rehabilitation", program: "Physical Therapy", confidence: 0.82 },
  { phrase: "mental health", program: "Psychology", confidence: 0.85 },
  { phrase: "counseling", program: "Psychology", confidence: 0.84 },
  { phrase: "human behavior", program: "Psychology", confidence: 0.82 },
  { phrase: "dietitian", program: "Nutrition and Dietetics", confidence: 0.88 },
  { phrase: "nutrition", program: "Nutrition and Dietetics", confidence: 0.85 },

  // Business, Finance & Hospitality
  { phrase: "auditing", program: "Accountancy", confidence: 0.85 },
  { phrase: "taxation", program: "Accountancy", confidence: 0.84 },
  { phrase: "bookkeeping", program: "Accountancy", confidence: 0.84 },
  { phrase: "cpa", program: "Accountancy", confidence: 0.88 },
  { phrase: "corporate finance", program: "Financial Management", confidence: 0.86 },
  { phrase: "banking", program: "Financial Management", confidence: 0.82 },
  { phrase: "investing", program: "Financial Management", confidence: 0.8 },
  { phrase: "digital marketing", program: "Marketing Management", confidence: 0.85 },
  { phrase: "advertising", program: "Marketing Management", confidence: 0.82 },
  { phrase: "starting a business", program: "Entrepreneurship", confidence: 0.85 },
  { phrase: "startup", program: "Entrepreneurship", confidence: 0.82 },
  { phrase: "entrepreneur", program: "Entrepreneurship", confidence: 0.86 },
  { phrase: "restaurant management", program: "Hospitality Management", confidence: 0.88 },
  { phrase: "hotel management", program: "Hospitality Management", confidence: 0.9 },
  { phrase: "culinary", program: "Hospitality Management", confidence: 0.84 },
  { phrase: "chef", program: "Hospitality Management", confidence: 0.8 },
  { phrase: "flight attendant", program: "Tourism Management", confidence: 0.86 },
  { phrase: "travel and tourism", program: "Tourism Management", confidence: 0.9 },
  { phrase: "tour guide", program: "Tourism Management", confidence: 0.82 },
  { phrase: "real estate", program: "Real Estate Management", confidence: 0.88 },

  // Architecture & Engineering
  { phrase: "building design", program: "Architecture", confidence: 0.86 },
  { phrase: "designing buildings", program: "Architecture", confidence: 0.86 },
  { phrase: "architect", program: "Architecture", confidence: 0.9 },
  { phrase: "interior design", program: "Interior Design", confidence: 0.9 },
  { phrase: "structural design", program: "Civil Engineering", confidence: 0.86 },
  { phrase: "construction", program: "Civil Engineering", confidence: 0.84 },
  { phrase: "bridges", program: "Civil Engineering", confidence: 0.82 },
  { phrase: "telecommunications", program: "Electronics Engineering", confidence: 0.86 },
  { phrase: "circuits", program: "Electronics Engineering", confidence: 0.82 },
  { phrase: "automotive", program: "Mechanical Engineering", confidence: 0.84 },
  { phrase: "machines", program: "Mechanical Engineering", confidence: 0.8 },
  { phrase: "power systems", program: "Electrical Engineering", confidence: 0.84 },
  { phrase: "supply chain", program: "Industrial Engineering", confidence: 0.84 },

  // Education, Law, Media & Arts
  { phrase: "elementary teacher", program: "Elementary Education", confidence: 0.88 },
  { phrase: "high school teacher", program: "Secondary Education", confidence: 0.88 },
  { phrase: "early childhood", program: "Early Childhood Education", confidence: 0.88 },
  { phrase: "become a teacher", program: "Education", confidence: 0.86 },
  { phrase: "teaching", program: "Education", confidence: 0.84 },
  { phrase: "teacher", program: "Education", confidence: 0.82 },
  { phrase: "pre-law", program: "Political Science", confidence: 0.84 },
  { phrase: "prelaw", program: "Political Science", confidence: 0.84 },
  { phrase: "pre law", program: "Political Science", confidence: 0.84 },
  { phrase: "lawyer", program: "Legal Management", confidence: 0.8 },
  { phrase: "diplomacy", program: "International Studies", confidence: 0.84 },
  { phrase: "journalism", program: "Journalism", confidence: 0.9 },
  { phrase: "broadcasting", program: "Communication", confidence: 0.86 },
  { phrase: "filmmaking", program: "Communication", confidence: 0.82 },
  { phrase: "public relations", program: "Communication", confidence: 0.84 },
  { phrase: "graphic design", program: "Multimedia Arts", confidence: 0.86 },
  { phrase: "digital arts", program: "Multimedia Arts", confidence: 0.86 },
  { phrase: "animation", program: "Multimedia Arts", confidence: 0.84 },
  { phrase: "visual arts", program: "Fine Arts", confidence: 0.84 },
  { phrase: "law enforcement", program: "Criminology", confidence: 0.86 },
  { phrase: "forensics", program: "Criminology", confidence: 0.84 },
  { phrase: "police", program: "Criminology", confidence: 0.8 },
];

/**
 * English + Taglish conversational stop words stripped before checking
 * residual academic noun phrases.
 */
const STOP_WORDS = new Set([
  // English pronouns, determiners, prepositions, filler
  "i",
  "im",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "some",
  "any",
  "all",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "from",
  "with",
  "without",
  "about",
  "around",
  "near",
  "nearby",
  "close",
  "around",
  "within",
  "under",
  "below",
  "above",
  "over",
  "between",
  "and",
  "or",
  "but",
  "if",
  "so",
  "as",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "will",
  "want",
  "wanted",
  "wanting",
  "need",
  "needed",
  "like",
  "love",
  "prefer",
  "preferred",
  "looking",
  "look",
  "find",
  "finding",
  "search",
  "searching",
  "show",
  "give",
  "recommend",
  "suggest",
  "help",
  "please",
  "pls",
  "plz",
  "take",
  "taking",
  "study",
  "studying",
  "pursue",
  "pursuing",
  "interested",
  "into",
  "offer",
  "offers",
  "offering",
  "has",
  "have",
  "having",
  "good",
  "great",
  "best",
  "top",
  "nice",
  "affordable",
  "cheap",
  "budget",
  "tuition",
  "fee",
  "fees",
  "cost",
  "price",
  "expensive",
  "only",
  "just",
  "really",
  "very",
  "also",
  "maybe",
  "somewhere",
  "anywhere",
  "where",
  "which",
  "what",
  "who",
  "how",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank",
  "today",
  // Institutional & generic nouns
  "university",
  "universities",
  "college",
  "colleges",
  "school",
  "schools",
  "campus",
  "campuses",
  "institute",
  "institution",
  "program",
  "programs",
  "degree",
  "degrees",
  "course",
  "courses",
  "major",
  "majors",
  "track",
  "field",
  "manila",
  "metro",
  "philippines",
  "ph",
  "ncr",
  "city",
  "area",
  "location",
  "per",
  "semester",
  "sem",
  "trimester",
  "term",
  "year",
  "yearly",
  "annual",
  "unit",
  "units",
  "php",
  "peso",
  "pesos",
  // Tagalog / Taglish filler
  "gusto",
  "ko",
  "ako",
  "ng",
  "nang",
  "sa",
  "na",
  "ang",
  "mga",
  "yung",
  "ung",
  "iyong",
  "mag",
  "aral",
  "magaral",
  "kunin",
  "kumuha",
  "hanap",
  "naghahanap",
  "pahingi",
  "pwede",
  "puwede",
  "po",
  "opo",
  "lang",
  "lamang",
  "sana",
  "malapit",
  "bandang",
  "banda",
  "may",
  "meron",
  "mayroon",
  "mura",
  "murang",
  "libre",
  "libreng",
  "walang",
  "hindi",
  "di",
  "ayaw",
  "wag",
  "huwag",
  "kurso",
  "paaralan",
  "eskwelahan",
  "unibersidad",
  "kolehiyo",
  "kada",
  "taon",
  "ba",
  "naman",
  "kasi",
  "para",
]);

function foldDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSpans(text: string, spans: TextSpan[]): string {
  if (spans.length === 0) return text;
  const chars = text.split("");
  for (const span of spans) {
    const start = Math.max(0, span.start);
    const end = Math.min(chars.length, span.end);
    for (let i = start; i < end; i++) {
      chars[i] = " ";
    }
  }
  return chars.join("");
}

function titleCaseProgram(raw: string): string {
  const minor = new Set([
    "in",
    "of",
    "and",
    "for",
    "to",
    "with",
    "on",
    "the",
    "a",
    "an",
  ]);
  const upperKeep = new Set([
    "BS",
    "BA",
    "AB",
    "IT",
    "IS",
    "CS",
    "AI",
    "CPA",
    "HR",
    "UI",
    "UX",
  ]);
  return raw
    .trim()
    .split(/\s+/)
    .map((word, idx) => {
      const upper = word.toUpperCase();
      if (upperKeep.has(upper)) return upper;
      const lower = word.toLowerCase();
      if (idx > 0 && minor.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function parseBasisFromText(text: string): NlpBudgetBasis | null {
  const lower = text.toLowerCase();
  if (/\b(?:per\s+|\/\s*|a\s+|kada\s+)?units?\b/.test(lower)) return "unit";
  if (/\b(?:per\s+|\/\s*|a\s+|kada\s+)?(?:trimesters?|trimestral|terms?|tri)\b/.test(lower)) {
    return "trimester";
  }
  if (/\b(?:per\s+|\/\s*|a\s+|kada\s+)?(?:years?|yearly|annual(?:ly)?|yrs?|taon)\b/.test(lower)) {
    return "year";
  }
  if (/\b(?:per\s+|\/\s*|a\s+|kada\s+)?(?:semesters?|semestral|sems?)\b/.test(lower)) {
    return "semester";
  }
  return null;
}

function parseNumericAmount(numStr: string, multiplier?: string): number | null {
  const cleaned = numStr.replace(/,/g, "");
  const base = Number(cleaned);
  if (!Number.isFinite(base) || base < 0) return null;
  const mult = (multiplier || "").trim().toLowerCase();
  const value = mult === "k" || mult === "thousand" ? base * 1000 : base;
  if (value > 10_000_000) return null;
  return Math.round(value * 100) / 100;
}

interface BudgetExtractionResult {
  budget: number | null;
  basis: NlpBudgetBasis | null;
  freeTuitionPhrase: string | null;
  entity: NlpDetectedEntity | null;
  spans: TextSpan[];
}

function extractBudget(
  original: string,
  folded: string,
): BudgetExtractionResult {
  const spans: TextSpan[] = [];
  let freeTuitionPhrase: string | null = null;

  // 1. Free tuition indicators (inform Public sector via RA 10931)
  const freeRe =
    /\b(?:free\s+tuition|tuition[-\s]?free|no\s+tuition(?:\s+fee)?|zero\s+tuition|0\s+tuition|walang\s+tuition|libre(?:ng)?\s+tuition|ra\s*10931)\b/gi;
  for (const m of folded.matchAll(freeRe)) {
    if (m.index === undefined) continue;
    const end = m.index + m[0].length;
    if (!freeTuitionPhrase) {
      freeTuitionPhrase = original.slice(m.index, end).trim();
    }
    spans.push({ start: m.index, end });
  }

  const periodSuffix =
    `(?:\\s*(?:per\\s+|\\/\\s*|a\\s+|kada\\s+)?(?:semesters?|semestral|sems?|trimesters?|trimestral|terms?|years?|yearly|annual(?:ly)?|yrs?|taon|units?))?`;

  // 2. Tuition range (e.g. "between 40k and 70k per sem", "40,000 - 70,000/yr")
  const rangeRe = new RegExp(
    `(?:(?:between|from|budget(?:\\s+of|\\s+is)?|tuition(?:\\s+of)?)\\s+)?(?:₱|php\\.?\\s*|p\\s*)?(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(k|thousand)?\\s*(?:to|and|-|–|—)\\s*(?:₱|php\\.?\\s*|p\\s*)?(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(k|thousand)?(?:\\s*(?:pesos?|php))?${periodSuffix}`,
    "i",
  );
  const rangeMatch = rangeRe.exec(folded);
  if (rangeMatch && rangeMatch.index !== undefined) {
    const rawMatched = rangeMatch[0];
    const startIdx = rangeMatch.index;
    const endIdx = startIdx + rawMatched.length;
    const lowNum = parseNumericAmount(
      rangeMatch[1],
      rangeMatch[2] || rangeMatch[4],
    );
    const highNum = parseNumericAmount(rangeMatch[3], rangeMatch[4]);
    const looksLikeAcademicYear =
      !rangeMatch[2] &&
      !rangeMatch[4] &&
      lowNum !== null &&
      highNum !== null &&
      lowNum >= 2020 &&
      lowNum <= 2035 &&
      highNum >= 2020 &&
      highNum <= 2036 &&
      !/₱|php|peso|budget|tuition|sem|term|unit/i.test(rawMatched);

    if (!looksLikeAcademicYear && highNum !== null && highNum > 0) {
      const basis =
        parseBasisFromText(rawMatched) ||
        parseBasisFromText(folded) ||
        "semester";
      spans.push({ start: startIdx, end: endIdx });
      return {
        budget: highNum,
        basis,
        freeTuitionPhrase,
        entity: {
          field: "budget",
          label: "Budget",
          value: `PHP ${highNum.toLocaleString("en-PH")} / ${basis}`,
          matchedPhrase: original.slice(startIdx, endIdx).trim(),
          method: "currency_ner",
          confidence: 0.94,
        },
        spans,
      };
    }
  }

  // 3. Single budget expression
  const singlePatterns: RegExp[] = [
    // Qualifier + number (e.g. "under 70k per sem", "budget of 60,000", "max 80k", "below 50000")
    new RegExp(
      `(?:\\b(?:under|below|less\\s+than|max(?:imum)?|up\\s+to|at\\s+most|within|around|about|not\\s+more\\s+than|budget(?:\\s+of|\\s+is|\\s+around)?|tuition(?:\\s+of|\\s+under|\\s+below)?)\\s*|<=\\s*)(?:₱|php\\.?\\s*|p(?=\\d)\\s*)?(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(k|thousand)?(?:\\s*(?:pesos?|php))?${periodSuffix}`,
      "i",
    ),
    // Explicit currency symbol + number (e.g. "₱60,000/sem", "PHP 50k", "P75,000 per year")
    new RegExp(
      `(?:₱|\\bphp\\.?\\s*|\\bp(?=\\d))(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(k|thousand)?(?:\\s*(?:pesos?|php))?${periodSuffix}`,
      "i",
    ),
    // Number with 'k' / 'thousand' / 'pesos' (e.g. "70k per sem", "1.5k/unit", "50 thousand per year")
    new RegExp(
      `\\b(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(k|thousand|pesos?)\\b${periodSuffix}`,
      "i",
    ),
    // Comma-formatted number (e.g. "60,000 per semester", "120,000 yearly")
    new RegExp(`\\b(\\d{1,3}(?:,\\d{3})+)\\b${periodSuffix}`, "i"),
    // Plain number directly tied to a billing period (e.g. "1500 per unit", "50000 per sem")
    new RegExp(
      `\\b(\\d{3,7})\\s*(?:per\\s+|\\/\\s*|a\\s+|kada\\s+)(?:semesters?|semestral|sems?|trimesters?|trimestral|terms?|years?|yearly|annual(?:ly)?|yrs?|taon|units?)\\b`,
      "i",
    ),
  ];

  for (const re of singlePatterns) {
    const m = re.exec(folded);
    if (!m || m.index === undefined) continue;
    const rawMatched = m[0];
    const startIdx = m.index;
    const endIdx = startIdx + rawMatched.length;

    // Skip RA 10931 or calendar years when not currency-qualified
    const prefixWindow = folded.slice(Math.max(0, startIdx - 6), startIdx);
    if (/\bra\s*$/i.test(prefixWindow) && /10931/.test(rawMatched)) continue;

    const multiplier = m[2] && /^(?:k|thousand)$/i.test(m[2]) ? m[2] : undefined;
    const amount = parseNumericAmount(m[1], multiplier);
    if (amount === null) continue;

    const looksLikeYear =
      !multiplier &&
      amount >= 2020 &&
      amount <= 2035 &&
      !/₱|php|peso|budget|tuition|unit|sem|term|under|below|max|within/i.test(
        rawMatched,
      );
    if (looksLikeYear) continue;

    const basis =
      parseBasisFromText(rawMatched) ||
      parseBasisFromText(folded) ||
      "semester";

    spans.push({ start: startIdx, end: endIdx });
    return {
      budget: amount,
      basis,
      freeTuitionPhrase,
      entity: {
        field: "budget",
        label: "Budget",
        value: `PHP ${amount.toLocaleString("en-PH")} / ${basis}`,
        matchedPhrase: original.slice(startIdx, endIdx).trim(),
        method: "currency_ner",
        confidence: 0.95,
      },
      spans,
    };
  }

  return {
    budget: null,
    basis: null,
    freeTuitionPhrase,
    entity: null,
    spans,
  };
}

interface SectorExtractionResult {
  sector: NlpSectorValue | null;
  entity: NlpDetectedEntity | null;
  spans: TextSpan[];
}

function extractSector(
  original: string,
  folded: string,
  freeTuitionPhrase: string | null,
): SectorExtractionResult {
  const spans: TextSpan[] = [];

  const rules: Array<{
    re: RegExp;
    sector: NlpSectorValue;
    method: "sector_ner" | "negation_rule";
    confidence: number;
  }> = [
    // Explicit both
    {
      re: /\b(?:(?:both|either)\s+)?(?:public\s+(?:or|and|\/)\s+private|private\s+(?:or|and|\/)\s+public)(?:\s+(?:universit(?:y|ies)|colleges?|schools?))?\b/i,
      sector: "Public,Private",
      method: "sector_ner",
      confidence: 0.96,
    },
    // Negated private -> Public
    {
      re: /\b(?:not|no|non[-\s]?|hindi(?:\s+ko(?:\s+gusto)?)?(?:\s+ng|\s+sa)?|di|ayaw(?:\s+ko)?(?:\s+ng|\s+sa)?|wag(?:\s+na)?|huwag(?:\s+na)?)\s+(?:a\s+)?private(?:\s+(?:universit(?:y|ies)|colleges?|schools?))?\b/i,
      sector: "Public",
      method: "negation_rule",
      confidence: 0.93,
    },
    // Negated public / state -> Private
    {
      re: /\b(?:not|no|non[-\s]?|hindi(?:\s+ko(?:\s+gusto)?)?(?:\s+ng|\s+sa)?|di|ayaw(?:\s+ko)?(?:\s+ng|\s+sa)?|wag(?:\s+na)?|huwag(?:\s+na)?)\s+(?:a\s+)?(?:public|state(?:\s+u)?|suc)(?:\s+(?:universit(?:y|ies)|colleges?|schools?))?\b/i,
      sector: "Private",
      method: "negation_rule",
      confidence: 0.93,
    },
    // Explicit private
    {
      re: /\b(?:private|pribado(?:ng)?|catholic|sectarian)(?:\s+(?:universit(?:y|ies)|colleges?|schools?|institutions?))?\b/i,
      sector: "Private",
      method: "sector_ner",
      confidence: 0.96,
    },
    // Explicit public / state university
    {
      re: /\b(?:public|publiko(?:ng)?|pampubliko(?:ng)?|state\s+(?:universit(?:y|ies)|colleges?|u)|sucs?|local\s+universit(?:y|ies)|city\s+universit(?:y|ies)|government\s+(?:universit(?:y|ies)|colleges?|schools?))(?:\s+(?:universit(?:y|ies)|colleges?|schools?|institutions?))?\b/i,
      sector: "Public",
      method: "sector_ner",
      confidence: 0.96,
    },
  ];

  for (const rule of rules) {
    const m = rule.re.exec(folded);
    if (!m || m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    spans.push({ start, end });
    const labelValue =
      rule.sector === "Public,Private"
        ? "Public & Private"
        : `${rule.sector} only`;
    return {
      sector: rule.sector,
      entity: {
        field: "sector",
        label: "University type",
        value: labelValue,
        matchedPhrase: original.slice(start, end).trim(),
        method: rule.method,
        confidence: rule.confidence,
      },
      spans,
    };
  }

  if (freeTuitionPhrase) {
    return {
      sector: "Public",
      entity: {
        field: "sector",
        label: "University type",
        value: "Public only (Free tuition via RA 10931)",
        matchedPhrase: freeTuitionPhrase,
        method: "free_tuition_rule",
        confidence: 0.9,
      },
      spans,
    };
  }

  return { sector: null, entity: null, spans };
}

interface LocationExtractionResult {
  city: string | null;
  mentionedManila: boolean;
  manilaPhrase: string | null;
  entity: NlpDetectedEntity | null;
  spans: TextSpan[];
}

function extractLocation(
  original: string,
  folded: string,
  extraCampusAreas: string[] = [],
): LocationExtractionResult {
  const spans: TextSpan[] = [];

  // Mask generic "in Manila" / "Metro Manila" phrases from program text,
  // but remember them in case no specific district or other preference exists.
  let mentionedManila = false;
  let manilaPhrase: string | null = null;
  const manilaRe = /\b(?:(?:in|near|around|within|sa|malapit\s+sa)\s+)?(?:metro\s+)?manila\b/gi;
  for (const m of folded.matchAll(manilaRe)) {
    if (m.index === undefined) continue;
    mentionedManila = true;
    if (!manilaPhrase) {
      manilaPhrase = original.slice(m.index, m.index + m[0].length).trim();
    }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }

  // First check dynamic campus areas from live catalog (longest first)
  const sortedExtra = [...new Set(extraCampusAreas.map((a) => cleanText(a)).filter(Boolean))]
    .filter((a) => a.toLowerCase() !== "manila")
    .sort((a, b) => b.length - a.length);

  for (const area of sortedExtra) {
    const foldedArea = foldDiacritics(area);
    const re = new RegExp(
      `(?:\\b(?:in|near|around|at|within|sa|malapit\\s+sa|bandang)\\s+)?\\b${escapeRegExp(foldedArea)}\\b`,
      "i",
    );
    const m = re.exec(folded);
    if (!m || m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    spans.push({ start, end });
    return {
      city: area,
      mentionedManila,
      manilaPhrase,
      entity: {
        field: "city",
        label: "Campus area",
        value: area,
        matchedPhrase: original.slice(start, end).trim(),
        method: "location_ner",
        confidence: 0.98,
      },
      spans,
    };
  }

  // Next check built-in Manila districts & landmarks
  for (const item of LOCATION_PATTERNS) {
    const prepRe = new RegExp(
      `(?:\\b(?:in|near|around|at|within|sa|malapit\\s+sa|bandang)\\s+)?${item.pattern.source}`,
      "i",
    );
    const m = prepRe.exec(folded);
    if (!m || m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    spans.push({ start, end });
    return {
      city: item.area,
      mentionedManila,
      manilaPhrase,
      entity: {
        field: "city",
        label: "Campus area",
        value: item.area,
        matchedPhrase: original.slice(start, end).trim(),
        method: item.method,
        confidence: item.confidence,
      },
      spans,
    };
  }

  return {
    city: null,
    mentionedManila,
    manilaPhrase,
    entity: null,
    spans,
  };
}

interface ProgramExtractionResult {
  program: string | null;
  entity: NlpDetectedEntity | null;
  unmatchedTokens: string[];
}

function buildCatalogCores(programNames: string[]): Array<{ core: string; display: string }> {
  const seen = new Map<string, string>();
  for (const raw of programNames) {
    const stripped = stripParentheticalAnnotations(cleanText(raw));
    const normalized = normalizeProgramText(stripped);
    const core = stripDegreePrefix(normalized);
    if (!core || core.length < 3) continue;
    if (!seen.has(core)) {
      seen.set(core, titleCaseProgram(core));
    }
  }
  return [...seen.entries()]
    .map(([core, display]) => ({ core, display }))
    .sort((a, b) => b.core.length - a.core.length);
}

function extractProgram(
  original: string,
  remainingFolded: string,
  catalogProgramNames: string[],
): ProgramExtractionResult {
  const cleanedRemaining = remainingFolded
    .replace(/[^a-zA-Z0-9&+.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedRemaining) {
    return { program: null, entity: null, unmatchedTokens: [] };
  }

  // 1. Explicit degree-prefixed phrase (e.g. "BS Computer Science", "Bachelor of Science in Nursing", "BS IT")
  const degreePrefixRe =
    /\b(?:bachelor\s+of\s+(?:science|arts|fine\s+arts|elementary|secondary|physical|music|public|library|architecture)\s+(?:in\s+)?|b\.?\s*s\.?\s+|b\.?\s*a\.?\s+|a\.?\s*b\.?\s+)([a-z][a-z\s&-]{1,60})/i;
  const degMatch = degreePrefixRe.exec(cleanedRemaining);
  if (degMatch) {
    const rawCore = degMatch[1]
      .split(/\b(?:with|under|near|in|at|from|for|below|around|that|which|sa|na|ng|malapit)\b/i)[0]
      .trim();
    const normCore = normalizeProgramText(rawCore);
    if (normCore) {
      const aliasTarget = PROGRAM_ALIASES[normCore] || PROGRAM_ALIASES[`bs ${normCore}`];
      const canonical = aliasTarget ? titleCaseProgram(aliasTarget) : titleCaseProgram(normCore);
      const matchedPhrase = cleanText(
        degMatch[0].slice(0, degMatch[0].indexOf(degMatch[1]) + rawCore.length),
      );
      return {
        program: canonical,
        entity: {
          field: "program",
          label: "Preferred program",
          value: canonical,
          matchedPhrase,
          method: "degree_phrase",
          confidence: 0.96,
        },
        unmatchedTokens: [],
      };
    }
  }

  // 2. Live catalog core title match (longest phrase first, e.g. "Computer Science", "Civil Engineering", "Medical Technology")
  const normalizedRemaining = normalizeProgramText(cleanedRemaining);
  const paddedRemaining = ` ${normalizedRemaining} `;
  const catalogCores = buildCatalogCores(catalogProgramNames);
  for (const entry of catalogCores) {
    if (paddedRemaining.includes(` ${entry.core} `)) {
      const re = new RegExp(`\\b${escapeRegExp(entry.core)}\\b`, "i");
      const origHit = re.exec(foldDiacritics(original));
      return {
        program: entry.display,
        entity: {
          field: "program",
          label: "Preferred program",
          value: entry.display,
          matchedPhrase: origHit
            ? original.slice(origHit.index, origHit.index + origHit[0].length)
            : entry.display,
          method: "catalog_phrase",
          confidence: 0.95,
        },
        unmatchedTokens: [],
      };
    }
  }

  // 3. Recognized Philippine degree aliases & canonical names (longest key first)
  const sortedAliases = Object.entries(PROGRAM_ALIASES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  // First check canonical target values (e.g. "computer science", "information technology", "nursing")
  const uniqueCanonicalTargets = [...new Set(Object.values(PROGRAM_ALIASES))].sort(
    (a, b) => b.length - a.length,
  );
  for (const target of uniqueCanonicalTargets) {
    if (paddedRemaining.includes(` ${target} `)) {
      const re = new RegExp(`\\b${escapeRegExp(target)}\\b`, "i");
      const origHit = re.exec(foldDiacritics(original));
      const display = titleCaseProgram(target);
      return {
        program: display,
        entity: {
          field: "program",
          label: "Preferred program",
          value: display,
          matchedPhrase: origHit
            ? original.slice(origHit.index, origHit.index + origHit[0].length)
            : display,
          method: "alias_ner",
          confidence: 0.94,
        },
        unmatchedTokens: [],
      };
    }
  }

  // Next check abbreviations (with strict uppercase guard on ambiguous 2-letter words like it/is/me)
  for (const [alias, canonical] of sortedAliases) {
    if (alias.includes("_")) continue;
    const isShortAmbiguous = CASE_SENSITIVE_SHORT_ALIASES.has(alias);
    if (isShortAmbiguous) {
      const upperRe = new RegExp(`\\b${escapeRegExp(alias.toUpperCase())}\\b`);
      const maskedOriginal = maskSpans(original, []);
      // Verify the uppercase token actually appears in the unmasked portion of remainingFolded
      const remainingUpperHit = upperRe.exec(cleanedRemaining);
      if (!remainingUpperHit) continue;
      // Also confirm it was uppercase in the user's original sentence (prevents "help me" -> ME, "that is" -> IS, "make it" -> IT)
      if (!upperRe.test(maskedOriginal)) continue;
      const display = titleCaseProgram(canonical);
      return {
        program: display,
        entity: {
          field: "program",
          label: "Preferred program",
          value: display,
          matchedPhrase: remainingUpperHit[0],
          method: "alias_ner",
          confidence: 0.92,
        },
        unmatchedTokens: [],
      };
    } else if (paddedRemaining.includes(` ${alias} `)) {
      const re = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i");
      const origHit = re.exec(foldDiacritics(original));
      const display = titleCaseProgram(canonical);
      return {
        program: display,
        entity: {
          field: "program",
          label: "Preferred program",
          value: display,
          matchedPhrase: origHit
            ? original.slice(origHit.index, origHit.index + origHit[0].length)
            : alias,
          method: "alias_ner",
          confidence: 0.92,
        },
        unmatchedTokens: [],
      };
    }
  }

  // 4. Offline interest / career-to-degree lexicon (longest phrase first)
  const sortedInterests = [...INTEREST_TO_DEGREE].sort(
    (a, b) => b.phrase.length - a.phrase.length,
  );
  for (const entry of sortedInterests) {
    const normPhrase = normalizeProgramText(entry.phrase);
    if (paddedRemaining.includes(` ${normPhrase} `)) {
      const re = new RegExp(`\\b${escapeRegExp(entry.phrase)}\\b`, "i");
      const origHit = re.exec(foldDiacritics(original));
      return {
        program: entry.program,
        entity: {
          field: "program",
          label: "Preferred program",
          value: entry.program,
          matchedPhrase: origHit
            ? original.slice(origHit.index, origHit.index + origHit[0].length)
            : entry.phrase,
          method: "interest_lexicon",
          confidence: entry.confidence,
        },
        unmatchedTokens: [],
      };
    }
  }

  // 5. Stop-word stripping & verified residual academic phrase fallback
  const residualTokens = normalizedRemaining
    .split(/\s+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok) && !/^\d+$/.test(tok));

  if (residualTokens.length === 0) {
    return { program: null, entity: null, unmatchedTokens: [] };
  }

  // Try residual phrase (up to 4 meaningful tokens) against catalog programs
  // so typo-tolerant matches (e.g. "computr scince", "enginering") still work
  // while pure non-academic gibberish ("hello banana purple") is cleanly ignored!
  const candidatePhrase = residualTokens.slice(0, 4).join(" ");
  if (catalogProgramNames.length > 0) {
    let bestMatch = false;
    for (const progName of catalogProgramNames) {
      const m = evaluateProgramMatch(candidatePhrase, progName, null);
      if (m && m.tier <= 5) {
        bestMatch = true;
        break;
      }
    }
    if (bestMatch) {
      const display = titleCaseProgram(candidatePhrase);
      return {
        program: display,
        entity: {
          field: "program",
          label: "Preferred program",
          value: display,
          matchedPhrase: candidatePhrase,
          method: "residual_phrase",
          confidence: 0.78,
        },
        unmatchedTokens: residualTokens.slice(4),
      };
    }
    return {
      program: null,
      entity: null,
      unmatchedTokens: residualTokens,
    };
  }

  // Fallback when invoked without catalog context: only accept known broad academic stems
  const broadAcademicRe =
    /\b(?:engineering|science|technology|management|studies|arts|design|education|medicine|health|business|economics|finance|marketing|accounting|law|music|literature|history|philosophy|sociology|anthropology|journalism|communication|biology|chemistry|physics|mathematics|statistics|psychology|nursing|pharmacy|architecture|criminology|hospitality|tourism)\b/i;
  if (broadAcademicRe.test(candidatePhrase)) {
    const display = titleCaseProgram(candidatePhrase);
    return {
      program: display,
      entity: {
        field: "program",
        label: "Preferred program",
        value: display,
        matchedPhrase: candidatePhrase,
        method: "residual_phrase",
        confidence: 0.75,
      },
      unmatchedTokens: residualTokens.slice(4),
    };
  }

  return {
    program: null,
    entity: null,
    unmatchedTokens: residualTokens,
  };
}

/**
 * Parses a natural-language student preference sentence (English or Taglish)
 * into UniMatch PH's structured Find My Match filters using classical offline NLP.
 */
export function parseMatchSentence(
  rawSentence: string,
  context: NlpCatalogContext = {},
): ParsedMatchQuery {
  if (typeof rawSentence !== "string") {
    throw new Error("Please enter a sentence describing what you are looking for.");
  }
  const originalText = cleanText(rawSentence);
  if (!originalText) {
    throw new Error("Please enter a sentence describing what you are looking for.");
  }
  if (originalText.length > MAX_SENTENCE_LENGTH) {
    throw new Error(
      `Description must be at most ${MAX_SENTENCE_LENGTH} characters.`,
    );
  }

  const folded = foldDiacritics(originalText);
  const maskedSpans: TextSpan[] = [];
  const entities: NlpDetectedEntity[] = [];

  // Stage 1: Budget & period NER
  const budgetRes = extractBudget(originalText, folded);
  maskedSpans.push(...budgetRes.spans);

  // Stage 2: University sector & negation NER
  const afterBudget = maskSpans(folded, maskedSpans);
  const sectorRes = extractSector(
    originalText,
    afterBudget,
    budgetRes.freeTuitionPhrase,
  );
  maskedSpans.push(...sectorRes.spans);

  // Stage 3: Manila campus area & landmark NER
  const afterSector = maskSpans(folded, maskedSpans);
  const locationRes = extractLocation(
    originalText,
    afterSector,
    context.campusAreas || [],
  );
  maskedSpans.push(...locationRes.spans);

  // Stage 4: Program phrase chunking, alias NER & interest lexicon on unmasked text
  const remainingForProgram = maskSpans(folded, maskedSpans);
  const programRes = extractProgram(
    originalText,
    remainingForProgram,
    context.programNames || [],
  );

  // Assemble detected entities in a clean user-facing order
  if (programRes.entity) entities.push(programRes.entity);

  // Only set generic "Manila" as city if no specific district AND no other filter was found
  let finalCity = locationRes.city;
  if (locationRes.entity) {
    entities.push(locationRes.entity);
  } else if (
    locationRes.mentionedManila &&
    !programRes.program &&
    !sectorRes.sector &&
    budgetRes.budget === null
  ) {
    finalCity = "Manila";
    entities.push({
      field: "city",
      label: "Campus area",
      value: "Manila",
      matchedPhrase: locationRes.manilaPhrase || "Manila",
      method: "location_ner",
      confidence: 0.9,
    });
  }

  if (sectorRes.entity) entities.push(sectorRes.entity);
  if (budgetRes.entity) entities.push(budgetRes.entity);

  const preferences: ParsedMatchPreferences = {
    program: programRes.program,
    city: finalCity,
    sector: sectorRes.sector,
    budget: budgetRes.budget,
    budget_basis: budgetRes.budget !== null ? budgetRes.basis : null,
  };

  const hasMatches = entities.length > 0;
  const summary = hasMatches
    ? `Detected ${entities.map((ent) => `${ent.label}: ${ent.value}`).join(" · ")}.`
    : "No specific degree, Manila campus area, university type, or budget was recognized. Try mentioning a degree (e.g. Computer Science, Nursing), campus area (e.g. Intramuros, Malate), school type (Public/Private), or budget (e.g. under 70k/sem).";

  return {
    originalText,
    normalizedText: normalizeProgramText(originalText),
    preferences,
    entities,
    unmatchedTokens: programRes.unmatchedTokens,
    hasMatches,
    summary,
    engine: "classical-offline-nlp-v1",
  };
}
