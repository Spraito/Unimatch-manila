/**
 * Polite Web Collector, SSRF guard, robots.txt parser, JSON snapshot importer,
 * and baseline catalog exporter for UniMatch PH.
 *
 * All live fetches are strictly admin-triggered, HTTPS-only, restricted to the
 * approved official .edu.ph allowlist in config/collection.json, DNS-checked
 * against private/metadata IP ranges, robots.txt-compliant, and politely spaced.
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import * as cheerio from "cheerio";
import {
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
  ROOT,
  getUniversityDetail,
  initStore,
  universities,
} from "./store.js";

function ensureStoreInitialized(): void {
  if (universities.size === 0) {
    initStore();
  }
}

export const COLLECTOR_USER_AGENT =
  "UniMatchPH-ResearchBot/1.0 (Academic Admissions Directory; respectful robots.txt collector)";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB HTML cap
const MAX_REDIRECTS = 3;
export const MAX_PAGES_PER_RUN = 12; // Hard politeness cap including configured, pasted & discovered pages

export interface CollectionConfig {
  contact: string;
  min_delay_seconds: number;
  max_delay_seconds: number;
  timeout_seconds: number;
  approved_domains: string[];
}

export interface UniversityTargetPage {
  label?: string;
  url: string;
  fields?: string[];
  content_selector?: string;
  context_selector?: string;
  program_line_selector?: string;
  selectors?: Record<string, string>;
}

export interface UniversityTargetConfig {
  name: string;
  campus_location: string;
  approved_domains: string[];
  source_notes?: string[];
  pages: UniversityTargetPage[];
}

export interface CatalogProgramItem {
  id: string;
  name: string;
  topic: string;
  strandAlignment: string;
  sourceUrl: string;
}

export interface CatalogUniversityDraft {
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
  programs: CatalogProgramItem[];
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
    reason: string;
  }>;
  sourceUrls: string[];
  sourceNotes: string[];
  collectedAt: string;
  lastVerifiedAt: string;
}

export interface UrlFetchAudit {
  url: string;
  finalUrl: string;
  robotsAllowed: boolean;
  robotsReason: string;
  httpStatus: number | null;
  status: "fetched" | "blocked_by_robots" | "blocked_by_site" | "error";
  detail: string;
  discovered?: boolean;
  sourceKind?: "configured" | "pasted" | "discovered";
}

export interface CollectionAuditReport {
  universityId: string;
  universityName: string;
  mode: "polite-web" | "json-import";
  status: "completed" | "partial" | "blocked_by_robots" | "failed";
  fetchedUrlCount: number;
  programCount: number;
  conflictCount: number;
  robotsSummary: string;
  notes: string;
  urls: UrlFetchAudit[];
}

const VALID_COLORS = new Set(["green", "maroon", "gold", "rust", "lilac"]);
const VALID_TOPICS: Record<string, string[]> = {
  Computing: ["computer", "information technology", "data science", "software", "cybersecurity"],
  Engineering: [
    "engineering",
    "architecture",
    "environmental planning",
    "interior design",
  ],
  Education: ["education", "library", "teaching"],
  Business: [
    "business",
    "accountancy",
    "accounting",
    "entrepreneur",
    "office",
    "tourism",
    "hospitality",
    "finance",
    "marketing",
    "management",
    "economics",
  ],
  "Science & health": [
    "science",
    "mathematics",
    "statistics",
    "biology",
    "chemistry",
    "physics",
    "nutrition",
    "psychology",
    "nursing",
    "pharmacy",
    "medical",
    "medicine",
    "dentistry",
    "physical therapy",
  ],
};

function classifyProgramTopic(name: string): string {
  const lower = name.toLowerCase();
  for (const [topic, keywords] of Object.entries(VALID_TOPICS)) {
    if (keywords.some((kw) => lower.includes(kw))) return topic;
  }
  return "Arts, humanities & social sciences";
}

function slugifyId(value: string): string {
  const slug = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "university-entry";
}

export function loadCollectionConfig(): CollectionConfig {
  const filePath = path.join(ROOT, "config", "collection.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CollectionConfig>;
  const domains = Array.isArray(raw.approved_domains)
    ? raw.approved_domains
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => d && d !== "example.test" && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    : [];
  return {
    contact: typeof raw.contact === "string" ? raw.contact : "",
    min_delay_seconds: Math.max(2, Number(raw.min_delay_seconds ?? 2)),
    max_delay_seconds: Math.max(2, Math.min(10, Number(raw.max_delay_seconds ?? 5))),
    timeout_seconds: Math.max(5, Math.min(25, Number(raw.timeout_seconds ?? 15))),
    approved_domains: domains,
  };
}

export function loadUniversityTargets(): UniversityTargetConfig[] {
  const filePath = path.join(ROOT, "config", "universities.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(raw) ? (raw as UniversityTargetConfig[]) : [];
}

export function getCollectorConfig() {
  ensureStoreInitialized();
  const cfg = loadCollectionConfig();
  const targets = loadUniversityTargets();
  const byName = new Map<string, string>();
  for (const u of universities.values()) {
    byName.set(u.name.toLowerCase(), u.id);
  }
  return {
    userAgent: COLLECTOR_USER_AGENT,
    minDelaySeconds: cfg.min_delay_seconds,
    maxDelaySeconds: cfg.max_delay_seconds,
    timeoutSeconds: cfg.timeout_seconds,
    maxPagesPerRun: MAX_PAGES_PER_RUN,
    approvedDomains: cfg.approved_domains,
    targets: targets.map((t) => ({
      universityId: byName.get(t.name.toLowerCase()) || slugifyId(t.name),
      name: t.name,
      approvedDomains: (t.approved_domains || []).filter((d) => d !== "example.test"),
      pages: (t.pages || []).map((p) => ({
        label: p.label || "",
        url: p.url,
        fields: Array.isArray(p.fields) ? p.fields : [],
      })),
    })),
  };
}

// --- SSRF & Domain Allowlist Defense ---
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase();
  const ipType = net.isIP(ip);
  if (ipType === 0) return true;

  if (ipType === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    const a = (n >>> 24) & 255;
    const b = (n >>> 16) & 255;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  // IPv6 checks
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    return true;
  }
  const firstHextet = parseInt(ip.split(":")[0] || "0", 16);
  if (Number.isNaN(firstHextet)) return true;
  // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  return false;
}

export function validateApprovedUrl(
  rawUrl: string,
  approvedDomains: string[],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL must be a valid HTTPS address.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS university URLs are permitted.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Non-standard ports are not allowed.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || net.isIP(host) !== 0) {
    throw new Error("Direct IP addresses are not allowed.");
  }
  const allowed = approvedDomains.some((domain) => {
    const clean = domain.toLowerCase();
    return host === clean || host.endsWith(`.${clean}`);
  });
  if (!allowed) {
    throw new Error(
      `Domain "${host}" is not in the approved official university allowlist.`,
    );
  }
  return parsed;
}

async function assertPublicDnsResolution(hostname: string): Promise<void> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error(`Could not resolve host "${hostname}".`);
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error(
        `Resolved address for "${hostname}" is not a public routable address.`,
      );
    }
  }
}

// --- RFC 9309 robots.txt Parser ---
export interface RobotsPolicy {
  allowed: boolean;
  crawlDelaySeconds: number | null;
  matchedRule: string;
}

export function evaluateRobotsTxt(
  robotsContent: string,
  targetPathWithQuery: string,
  botToken = "unimatchph-researchbot",
): RobotsPolicy {
  const lines = robotsContent.split(/\r?\n/);
  interface Group {
    agents: string[];
    rules: Array<{ type: "allow" | "disallow"; path: string }>;
    crawlDelay: number | null;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let seenDirective = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      if (current && seenDirective) {
        groups.push(current);
        current = null;
        seenDirective = false;
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || seenDirective) {
        if (current) groups.push(current);
        current = { agents: [], rules: [], crawlDelay: null };
        seenDirective = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current) {
      seenDirective = true;
      if (key === "disallow") {
        if (value !== "") {
          current.rules.push({ type: "disallow", path: value });
        }
      } else if (key === "allow") {
        if (value !== "") {
          current.rules.push({ type: "allow", path: value });
        }
      } else if (key === "crawl-delay") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          current.crawlDelay = parsed;
        }
      }
    }
  }
  if (current) groups.push(current);

  const lowerBot = botToken.toLowerCase();
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && (lowerBot.includes(a) || a.includes(lowerBot))),
  );
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const activeGroups = specific.length ? specific : wildcard;

  let crawlDelaySeconds: number | null = null;
  const rules: Array<{ type: "allow" | "disallow"; path: string }> = [];
  for (const g of activeGroups) {
    if (g.crawlDelay !== null) {
      crawlDelaySeconds =
        crawlDelaySeconds === null
          ? g.crawlDelay
          : Math.max(crawlDelaySeconds, g.crawlDelay);
    }
    rules.push(...g.rules);
  }

  let bestMatch: { type: "allow" | "disallow"; path: string; len: number } | null = null;
  for (const rule of rules) {
    const escaped = rule.path
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const anchored = escaped.endsWith("\\$")
      ? `^${escaped.slice(0, -2)}$`
      : `^${escaped}`;
    const re = new RegExp(anchored);
    if (re.test(targetPathWithQuery)) {
      const len = rule.path.length;
      if (
        !bestMatch ||
        len > bestMatch.len ||
        (len === bestMatch.len && rule.type === "allow")
      ) {
        bestMatch = { type: rule.type, path: rule.path, len };
      }
    }
  }

  if (bestMatch && bestMatch.type === "disallow") {
    return {
      allowed: false,
      crawlDelaySeconds,
      matchedRule: `Disallow: ${bestMatch.path}`,
    };
  }
  return {
    allowed: true,
    crawlDelaySeconds,
    matchedRule: bestMatch ? `Allow: ${bestMatch.path}` : "Allowed by robots.txt",
  };
}

async function readBoundedText(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

async function fetchAllowlistedWithRedirects(
  initialUrl: URL,
  approvedDomains: string[],
  timeoutMs: number,
): Promise<{ response: Response; finalUrl: string }> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDnsResolution(current.hostname);
    const resp = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": COLLECTOR_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-PH,en;q=0.9",
      },
    });
    if (
      resp.status >= 300 &&
      resp.status < 400 &&
      resp.headers.has("location")
    ) {
      const location = resp.headers.get("location") || "";
      const nextUrl = new URL(location, current);
      current = validateApprovedUrl(nextUrl.toString(), approvedDomains);
      continue;
    }
    return { response: resp, finalUrl: current.toString() };
  }
  throw new Error("Too many redirects while fetching university page.");
}

// --- Semantic HTML & JSON-LD Extraction for Algorithm 1 ---
function normalizePesoText(input: string): string {
  return cleanText(
    input
      .replace(/₱/g, "PHP ")
      .replace(/\u20b1/g, "PHP ")
      .replace(/\bPhP\b|\bPhp\b/g, "PHP"),
  );
}

function extractPhpAmounts(text: string): Array<{ min_php: number; max_php: number }> {
  const normalized = normalizePesoText(text);
  const out: Array<{ min_php: number; max_php: number }> = [];
  const rangeRe =
    /(?:PHP|P)\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{1,2})?)\s*(?:[-–—]|to)\s*(?:PHP|P)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{1,2})?)/gi;
  for (const m of normalized.matchAll(rangeRe)) {
    const low = Number(m[1].replace(/,/g, ""));
    const high = Number(m[2].replace(/,/g, ""));
    if (
      Number.isFinite(low) &&
      Number.isFinite(high) &&
      low > 0 &&
      high >= low &&
      high <= 2_000_000
    ) {
      out.push({ min_php: low, max_php: high });
    }
  }
  if (!out.length) {
    const singleRe = /(?:PHP)\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{1,2})?)/gi;
    for (const m of normalized.matchAll(singleRe)) {
      const val = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(val) && val > 0 && val <= 2_000_000) {
        out.push({ min_php: val, max_php: val });
      }
    }
  }
  return out.slice(0, 8);
}

export interface ExtractedHtmlEvidence {
  tuition_estimates: Array<Record<string, unknown>>;
  admission_requirements: Array<Record<string, unknown>>;
  entrance_exam_coverage: Array<Record<string, unknown>>;
  application_deadlines: Array<Record<string, unknown>>;
  application_status: Array<Record<string, unknown>>;
  programs: Array<{ name: string; strand_alignment: string | null; source_url: string }>;
  application_links: Array<{ label: string; url: string; source_url: string }>;
}

type SectionContext =
  | "general"
  | "programs"
  | "requirements"
  | "deadlines"
  | "exams"
  | "tuition";

const SHS_STRAND_RE =
  /\b(STEM|ABM|HUMSS|GAS|TVL(?:-ICT|-HE|-IA)?|ADT|Arts\s+and\s+Design|Sports\s+Track)\b/gi;

const FULL_DEGREE_PREFIX_RE =
  /^(?:Bachelor\s+(?:of|in)\s+(?:Science|Arts|Secondary|Elementary|Fine\s+Arts|Music|Multimedia|Performing|Physical\s+Education|Public\s+Administration|Early\s+Childhood|Special\s+Needs|Technology|Landscape|Library|Industrial|Accountancy|Advertising|Laws|Sport|Interior|Human|Community|Technical|Business|Engineering|Communication|Design|Culture)|Doctor\s+of\s+(?:Dental\s+Medicine|Medicine|Veterinary\s+Medicine|Optometry|Pharmacy)|Juris\s+Doctor)/i;

const ABBREV_DEGREE_PREFIX_RE =
  /^(?:B\.?S\.?\s+(?:in\s+)?[A-Z][A-Za-z]|B\.?A\.?\s+(?:in\s+)?[A-Z][A-Za-z]|A\.?B\.?\s+(?:in\s+)?[A-Z][A-Za-z]|B\.?F\.?A\.?\s+|B\.?M\.?M\.?A\.?\b|B\.?S\.?E\.?D\.?\b|B\.?E\.?E\.?D\.?\b|B\.?S\.?C\.?S\.?\b|B\.?S\.?I\.?T\.?\b|B\.?S\.?I\.?S\.?\b|B\.?S\.?B\.?A\.?\b|B\.?S\.?A\.?\b|B\.?S\.?N\.?\b|B\.?S\.?C\.?E\.?\b|B\.?S\.?M\.?E\.?\b|B\.?S\.?E\.?E\.?\b|B\.?S\.?E\.?C\.?E\.?\b|B\.?S\.?C\.?h\.?E\.?\b|B\.?S\.?I\.?E\.?\b|B\.?S\.?P\.?T\.?\b|B\.?S\.?O\.?T\.?\b|B\.?S\.?M\.?T\.?\b|B\.?S\.?M\.?L\.?S\.?\b|BS\s+Arch(?:itecture)?|BS\s+Psych(?:ology)?)/;

const GRADUATE_OR_NOISE_PROGRAM_RE =
  /^(?:Master\s+(?:of|in)|M\.?S\.?\s|M\.?A\.?\s|M\.?B\.?A\.?|Ph\.?D\.?|Doctor\s+of\s+Philosophy|Post-?Graduate|Diploma\s+in|Certificate\s+in|Open\s+University|Short\s+Course|Senior\s+High|Junior\s+High|Grade\s+\d)/i;

const PROGRAM_CTA_SUFFIX_RE =
  /\s*(?:[-–—|•·]\s*)?(?:learn\s+more|read\s+more|apply\s+now|view\s+(?:curriculum|details|program|brochure)|download\s+brochure|see\s+details|more\s+info)\s*$/i;

function extractStrands(text: string): string | null {
  const found = new Set<string>();
  SHS_STRAND_RE.lastIndex = 0;
  for (const m of text.matchAll(SHS_STRAND_RE)) {
    found.add(m[1].toUpperCase().replace(/\s+/g, " "));
  }
  return found.size ? Array.from(found).join(", ") : null;
}

export function parseProgramCandidate(
  rawText: string,
  strandHint: string | null = null,
): { name: string; strand_alignment: string | null } | null {
  let text = cleanText(rawText)
    .replace(/^\s*(?:[-•●▪*–—]|\d{1,3}[.)])\s*/, "")
    .replace(PROGRAM_CTA_SUFFIX_RE, "")
    .trim();

  if (text.length < 3 || text.length > 180) return null;
  if (GRADUATE_OR_NOISE_PROGRAM_RE.test(text)) return null;
  // Reject full sentences / paragraphs masquerading as a program title
  if (/[?!]/.test(text) || text.split(/\s+/).length > 22) return null;
  if (/(?:tuition|deadline|requirement|applicant|must\s+submit|click\s+here|for\s+more\s+information)/i.test(text)) {
    return null;
  }

  if (!FULL_DEGREE_PREFIX_RE.test(text) && !ABBREV_DEGREE_PREFIX_RE.test(text)) {
    return null;
  }

  const inlineStrands = extractStrands(text);
  // Strip trailing parenthetical strand annotation like "(STEM)" or "(STEM / ABM)" from title
  text = text
    .replace(
      /\s*\(\s*(?:(?:STEM|ABM|HUMSS|GAS|TVL|ADT|Sports)(?:\s*[/,&]\s*|\s+or\s+)?){1,5}\s*\)\s*$/i,
      "",
    )
    .replace(/\s*[-–—|:]\s*(?:Recommended\s+Strand|Strand)\s*:?\s*(?:STEM|ABM|HUMSS|GAS|TVL|ADT|Sports).*$/i, "")
    .trim();

  if (text.length < 3) return null;
  return {
    name: text,
    strand_alignment: inlineStrands || strandHint,
  };
}

function classifyHeadingSection(headingText: string): SectionContext | null {
  const h = headingText.toLowerCase();
  if (/(?:tuition|school\s+fees?|estimated\s+fees?|fee\s+schedule|cost\s+of\s+study|free\s+higher\s+education)/i.test(h)) {
    return "tuition";
  }
  if (/(?:deadline|important\s+dates|application\s+(?:schedule|calendar|period)|schedule\s+of\s+(?:application|admission|exam)|key\s+dates)/i.test(h)) {
    return "deadlines";
  }
  if (/(?:entrance\s+exam|admission\s+test|exam\s+coverage|test\s+coverage|subtests?|upcat|pupcet|dcat|ustet|feucat|plmat|plmee|tupstat|tupcet|pnuat|uecet|mpass|aducet)/i.test(h)) {
    return "exams";
  }
  if (/(?:requirement|qualification|eligib|documentary|freshman\s+(?:admission|procedure|application)|how\s+to\s+apply|who\s+may\s+apply)/i.test(h)) {
    return "requirements";
  }
  if (/(?:degree\s+program|undergraduate\s+program|academic\s+program|courses?\s+offered|program\s+offerings|college\s+of\s+|school\s+of\s+|faculty\s+of\s+|institute\s+of\s+)/i.test(h)) {
    return "programs";
  }
  return null;
}

function extractJsonLdEvidence(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  evidence: ExtractedHtmlEvidence,
  seenPrograms: Set<string>,
): void {
  const scripts = $('script[type="application/ld+json"]');
  const visitNode = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) visitNode(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const rawType = obj["@type"];
    const types = Array.isArray(rawType)
      ? rawType.map((t) => String(t).toLowerCase())
      : typeof rawType === "string"
        ? [rawType.toLowerCase()]
        : [];

    if (
      types.some((t) => t === "course" || t === "educationaloccupationalprogram") &&
      typeof obj.name === "string"
    ) {
      const parsed = parseProgramCandidate(obj.name);
      if (parsed) {
        const key = parsed.name.toLowerCase();
        if (!seenPrograms.has(key) && evidence.programs.length < 300) {
          seenPrograms.add(key);
          evidence.programs.push({
            name: parsed.name,
            strand_alignment: parsed.strand_alignment,
            source_url: pageUrl,
          });
        }
      }
    }

    if (types.includes("event") && typeof obj.name === "string") {
      const dateStr = cleanText(
        [obj.name, obj.startDate, obj.endDate, obj.description]
          .filter((v) => typeof v === "string" && v)
          .join(" — "),
      );
      if (
        dateStr.length >= 12 &&
        /(?:admission|application|exam|deadline|enrollment|upcat|dcat|ustet|pupcet|feucat|plmat|tupstat|pnuat)/i.test(
          dateStr,
        ) &&
        evidence.application_deadlines.length < 30
      ) {
        evidence.application_deadlines.push({ text: dateStr.slice(0, 400), source_url: pageUrl });
      }
    }

    if (types.includes("question") && typeof obj.name === "string") {
      const ansObj = obj.acceptedAnswer as Record<string, unknown> | undefined;
      const ansText =
        ansObj && typeof ansObj.text === "string" ? cleanText(ansObj.text) : "";
      const combined = cleanText(`${obj.name} ${ansText}`);
      if (combined.length >= 15) {
        if (/(?:tuition|fee|cost|php|free\s+higher)/i.test(combined) && evidence.tuition_estimates.length < 20) {
          evidence.tuition_estimates.push({
            text: combined.slice(0, 500),
            amounts: extractPhpAmounts(combined),
            source_url: pageUrl,
          });
        } else if (/(?:requirement|form\s*138|report\s+card|psa|good\s+moral|eligib)/i.test(combined) && evidence.admission_requirements.length < 35) {
          evidence.admission_requirements.push({ text: combined.slice(0, 500), source_url: pageUrl });
        } else if (/(?:deadline|schedule|date|open|close)/i.test(combined) && evidence.application_deadlines.length < 30) {
          evidence.application_deadlines.push({ text: combined.slice(0, 500), source_url: pageUrl });
        } else if (/(?:exam|test|coverage|subtest|upcat|dcat|ustet|pupcet|feucat|plmat)/i.test(combined) && evidence.entrance_exam_coverage.length < 20) {
          evidence.entrance_exam_coverage.push({ text: combined.slice(0, 500), source_url: pageUrl });
        }
      }
    }

    if (obj["@graph"]) visitNode(obj["@graph"], depth + 1);
    if (obj.mainEntity) visitNode(obj.mainEntity, depth + 1);
    if (obj.hasCourse) visitNode(obj.hasCourse, depth + 1);
    if (obj.itemListElement) visitNode(obj.itemListElement, depth + 1);
  };

  scripts.each((_idx, el) => {
    const raw = $(el).text().trim();
    if (!raw || raw.length > 250_000) return;
    try {
      const parsed = JSON.parse(raw);
      visitNode(parsed, 0);
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  });
}

function safeSelectRoot(
  $: cheerio.CheerioAPI,
  pageConfig?: UniversityTargetPage,
): cheerio.Cheerio<any> {
  if (pageConfig?.content_selector) {
    try {
      const custom = $(pageConfig.content_selector);
      if (custom.length > 0) return custom;
    } catch {
      // Fall back safely if custom selector uses unsupported pseudo-selectors
    }
  }
  const candidates = [
    "main",
    "[role='main']",
    ".page-content",
    ".entry-content",
    "article",
    "#main-content",
    "#content",
  ];
  for (const sel of candidates) {
    const matched = $(sel);
    if (matched.length > 0 && cleanText(matched.text()).length >= 80) {
      return matched;
    }
  }
  return $("body");
}

function looksLikeRequirementText(text: string): boolean {
  return /(?:requirement|form\s*137|form\s*138|sf9|sf10|report\s+card|good\s+moral|psa\s+birth|nso\s+birth|grade\s+1[12]|senior\s+high|high\s+school\s+graduate|qualified\s+to\s+apply|applicant\s+must|eligibility|general\s+weighted\s+average|gwa|id\s+picture|2x2|1x1|transcript|diploma|als\s+passer|pept|recommendation\s+letter|medical\s+certificate)/i.test(
    text,
  );
}

function looksLikeTuitionText(text: string): boolean {
  return /(?:tuition|school\s+fees?|miscellaneous\s+fees?|laboratory\s+fees?|per\s+(?:unit|sem(?:ester)?|trimester|term|quarter|year)|matrikula|free\s+(?:tuition|higher\s+education)|ra\s*10931|universal\s+access\s+to\s+quality\s+tertiary|php\s*[0-9]{1,3},[0-9]{3})/i.test(
    text,
  );
}

function looksLikeExamText(text: string): boolean {
  return /(?:upcat|pupcet|dcat|ustet|plmat|plmee|feucat|feu-cat|uecet|tupstat|tupcet|pnuat|aducet|mpass|sbca|entrance\s+exam|admission\s+test|subtests?|exam(?:ination)?\s+coverage|test\s+coverage|reading\s+comprehension.*mathematics|verbal\s+reasoning|abstract\s+reasoning|mental\s+ability)/i.test(
    text,
  );
}

function looksLikeDeadlineText(text: string): boolean {
  return /(?:deadline|application\s+(?:period|schedule|dates?|window)|important\s+dates|last\s+day|schedule\s+of\s+(?:application|admission|exam)|closing\s+date|cut-?off|submission\s+of\s+(?:requirements|documents)|release\s+of\s+results|enrollment\s+period)/i.test(
    text,
  );
}

function looksLikeStatusText(text: string): boolean {
  return /(?:application\s+(?:is\s+)?(?:now\s+)?(?:open|closed|ongoing)|admissions?\s+(?:is\s+|are\s+)?(?:now\s+)?(?:open|closed|ongoing)|now\s+accepting\s+applications)/i.test(
    text,
  );
}

export function extractHtmlEvidence(
  html: string,
  pageUrl: string,
  pageConfig?: UniversityTargetPage,
): ExtractedHtmlEvidence {
  const evidence: ExtractedHtmlEvidence = {
    tuition_estimates: [],
    admission_requirements: [],
    entrance_exam_coverage: [],
    application_deadlines: [],
    application_status: [],
    programs: [],
    application_links: [],
  };

  const $ = cheerio.load(html);
  const seenPrograms = new Set<string>();
  const seenBlocks = new Set<string>();

  // 1. Parse Schema.org JSON-LD before removing <script> tags
  extractJsonLdEvidence($, pageUrl, evidence, seenPrograms);

  // 2. Strip non-content chrome cleanly via DOM
  $(
    "script, style, noscript, svg, iframe, nav, footer, form, [role='navigation'], [aria-hidden='true'], .breadcrumb, .breadcrumbs, .cookie-notice, .cookie-banner, #cookie-notice",
  ).remove();

  const root = safeSelectRoot($, pageConfig);

  const pushProgram = (raw: string, strandHint: string | null) => {
    if (evidence.programs.length >= 300) return;
    const candidate = parseProgramCandidate(raw, strandHint);
    if (!candidate) return;
    const key = candidate.name.toLowerCase();
    if (seenPrograms.has(key)) return;
    seenPrograms.add(key);
    evidence.programs.push({
      name: candidate.name,
      strand_alignment: candidate.strand_alignment,
      source_url: pageUrl,
    });
  };

  const classifyAndRecordText = (
    rawText: string,
    section: SectionContext,
    strandHint: string | null,
  ) => {
    const text = normalizePesoText(rawText);
    if (text.length < 6 || text.length > 950) return;
    const dedupKey = `${section}:${text.toLowerCase()}`;
    if (seenBlocks.has(dedupKey)) return;
    seenBlocks.add(dedupKey);

    // Check degree programs first (especially inside programs sections or lists/cards)
    pushProgram(text, strandHint);

    // Tuition & fees (keyword match or inside tuition section with numbers/free-tuition cue)
    const amounts = extractPhpAmounts(text);
    if (
      (looksLikeTuitionText(text) ||
        (section === "tuition" && (amounts.length > 0 || text.length >= 18))) &&
      evidence.tuition_estimates.length < 25
    ) {
      evidence.tuition_estimates.push({
        text,
        amounts,
        source_url: pageUrl,
      });
    }

    // Admission requirements (keyword match or list item/paragraph under Requirements heading)
    if (
      (looksLikeRequirementText(text) ||
        (section === "requirements" &&
          text.length >= 14 &&
          text.length <= 500 &&
          !/^(?:step\s*\d|note:|click\s+here|apply\s+now)/i.test(text))) &&
      evidence.admission_requirements.length < 45
    ) {
      evidence.admission_requirements.push({ text, source_url: pageUrl });
    }

    // Entrance exam & coverage
    if (
      (looksLikeExamText(text) ||
        (section === "exams" && text.length >= 14 && text.length <= 500)) &&
      evidence.entrance_exam_coverage.length < 25
    ) {
      evidence.entrance_exam_coverage.push({ text, source_url: pageUrl });
    }

    // Deadlines & schedule (keyword match or date inside deadlines section)
    if (
      (looksLikeDeadlineText(text) ||
        (section === "deadlines" &&
          /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|202\d)/i.test(text))) &&
      evidence.application_deadlines.length < 35
    ) {
      evidence.application_deadlines.push({ text, source_url: pageUrl });
    }

    // Application open/closed status
    if (looksLikeStatusText(text) && evidence.application_status.length < 10) {
      evidence.application_status.push({ text, source_url: pageUrl });
    }
  };

  // 3. Walk DOM elements in document order while tracking heading context & SHS strand context
  let currentSection: SectionContext = "general";
  let currentStrandHint: string | null = null;
  let excludedSubtreeHeading = false;

  root
    .find("h1, h2, h3, h4, h5, summary, dt, dd, p, li, table, a")
    .each((_idx, el) => {
      const tag = (el.tagName || "").toLowerCase();
      const $el = $(el);

      // Skip links/paragraphs nested inside tables (handled structurally by table parser)
      if (tag !== "table" && $el.closest("table").length > 0) {
        return;
      }

      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "summary" || tag === "dt") {
        const headingText = cleanText($el.text());
        if (!headingText) return;
        // Skip Open University / Graduate School / Institute of Technology sections when collecting undergrad programs
        if (/(?:graduate\s+school|post-?graduate|open\s+university\s+system|institute\s+of\s+technology|senior\s+high\s+school\s+program)/i.test(headingText)) {
          excludedSubtreeHeading = true;
          return;
        }
        excludedSubtreeHeading = false;
        const detectedSection = classifyHeadingSection(headingText);
        if (detectedSection) {
          currentSection = detectedSection;
        }
        const headingStrand = extractStrands(headingText);
        if (headingStrand) {
          currentStrandHint = headingStrand;
        } else if (tag === "h1" || tag === "h2") {
          currentStrandHint = null;
        }
        // Headings themselves may be degree titles (e.g. card headers on program directories)
        pushProgram(headingText, currentStrandHint);
        return;
      }

      if (excludedSubtreeHeading) return;

      if (tag === "table") {
        const headers: string[] = [];
        $el
          .find("thead th, tr:first-child th")
          .each((_i, th) => {
            headers.push(cleanText($(th).text()));
          });
        const headerJoined = headers.join(" ").toLowerCase();
        let tableSection: SectionContext = currentSection;
        if (/(?:tuition|fee|amount|php|unit)/i.test(headerJoined)) tableSection = "tuition";
        else if (/(?:deadline|date|schedule|period|intake)/i.test(headerJoined)) tableSection = "deadlines";
        else if (/(?:program|degree|course|major|strand)/i.test(headerJoined)) tableSection = "programs";
        else if (/(?:requirement|document)/i.test(headerJoined)) tableSection = "requirements";

        const strandColIdx = headers.findIndex((h) => /strand|track/i.test(h));
        const programColIdx = headers.findIndex((h) => /program|degree|course/i.test(h));

        $el.find("tr").each((rowIdx, tr) => {
          const cells: string[] = [];
          $(tr)
            .find("td")
            .each((_cIdx, td) => {
              cells.push(normalizePesoText($(td).text()));
            });
          if (!cells.length || (rowIdx === 0 && !cells.some(Boolean))) return;

          const rowStrand =
            strandColIdx >= 0 && cells[strandColIdx]
              ? extractStrands(cells[strandColIdx]) || cleanText(cells[strandColIdx])
              : currentStrandHint;

          if (programColIdx >= 0 && cells[programColIdx]) {
            pushProgram(cells[programColIdx], rowStrand);
          } else {
            for (const cell of cells) {
              pushProgram(cell, rowStrand);
            }
          }

          const formatted =
            headers.length === cells.length && headers.some(Boolean)
              ? cells
                  .map((c, idx) => (c ? `${headers[idx]}: ${c}` : ""))
                  .filter(Boolean)
                  .join(" | ")
              : cells.filter(Boolean).join(" | ");

          if (formatted.length >= 10) {
            classifyAndRecordText(formatted, tableSection, rowStrand);
          }
        });
        return;
      }

      if (tag === "a") {
        // Links inside program grids/cards often carry degree titles directly
        const linkText = cleanText($el.text());
        if (linkText.length >= 8 && linkText.length <= 160) {
          pushProgram(linkText, currentStrandHint);
        }
        return;
      }

      // p, li, dd — check for bold section subheaders inside <p> (like PUP's <p><strong>College of...</strong><br>...</p>)
      if (tag === "p") {
        const strongLead = cleanText($el.children("strong, b").first().text());
        if (strongLead) {
          if (/(?:open\s+university\s+system|institute\s+of\s+technology|graduate\s+school)/i.test(strongLead)) {
            return;
          }
          const subSection = classifyHeadingSection(strongLead);
          if (subSection) currentSection = subSection;
        }
        // Split <br>-separated degree program lines inside a single <p>
        const htmlContent = $el.html() || "";
        if (/<br\s*\/?>/i.test(htmlContent)) {
          const brParts = htmlContent
            .split(/<br\s*\/?>/i)
            .map((frag) => cleanText(cheerio.load(`<span>${frag}</span>`)("span").text()))
            .filter(Boolean);
          for (const part of brParts) {
            classifyAndRecordText(part, currentSection, currentStrandHint);
          }
          return;
        }
      }

      // Skip parent <li> that wraps child <ul>/<ol> to avoid duplicating nested lists as one giant blob
      if (tag === "li" && $el.children("ul, ol").length > 0) {
        const clone = $el.clone();
        clone.children("ul, ol").remove();
        const ownText = cleanText(clone.text());
        if (ownText) classifyAndRecordText(ownText, currentSection, currentStrandHint);
        return;
      }

      classifyAndRecordText($el.text(), currentSection, currentStrandHint);
    });

  // 4. Extract official HTTPS application portal links & official PDF guides
  const seenLinks = new Set<string>();
  root.find("a[href]").each((_idx, el) => {
    if (evidence.application_links.length >= 16) return;
    const href = ($(el).attr("href") || "").trim();
    const label = cleanText($(el).text());
    if (!href || !label || label.length > 110) return;

    const isPdf = /\.pdf(?:$|\?)/i.test(href);
    const matchesAction =
      /(?:apply|admission|portal|iapply|freshm|application|enroll|register|tuition|fee|requirement|brochure|prospectus|curriculum|guide|schedule)/i.test(
        `${label} ${href}`,
      );
    if (!matchesAction && !isPdf) return;

    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.protocol !== "https:") return;
      if (seenLinks.has(resolved.href)) return;
      seenLinks.add(resolved.href);
      const displayLabel =
        isPdf && !/\bpdf\b/i.test(label) ? `${label} (Official PDF)` : label;
      evidence.application_links.push({
        label: displayLabel.slice(0, 120),
        url: resolved.href,
        source_url: pageUrl,
      });
    } catch {
      // Ignore malformed relative hrefs
    }
  });

  return evidence;
}

const NON_HTML_ASSET_RE =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|css|js|xml|json)(?:$|\?)/i;

const SKIP_SUBPAGE_PATH_RE =
  /\/(?:wp-admin|wp-login|wp-content|wp-json|login|logout|signin|cart|checkout|feed|tag|author|category|news|announcements?|events?|gallery|alumni|careers?|jobs?|contact|privacy|terms|search|calendar|graduate|postgraduate|master|doctorate|phd|law-school|senior-high|basic-education|elementary|junior-high)\b/i;

export interface DiscoveredSubpage {
  url: string;
  category: "programs" | "tuition" | "requirements" | "deadlines" | "exams";
  score: number;
  label: string;
}

/**
 * Politely discovers high-value official admissions/programs/tuition subpages
 * strictly within the university's approved .edu.ph domain allowlist.
 */
export function discoverOfficialSubpages(
  html: string,
  pageUrl: string,
  approvedDomains: string[],
  alreadySeenUrls: Set<string>,
  missingCategories: Set<string> = new Set([
    "programs",
    "tuition",
    "requirements",
    "deadlines",
    "exams",
  ]),
): DiscoveredSubpage[] {
  const $ = cheerio.load(html);
  const candidates = new Map<string, DiscoveredSubpage>();

  $("a[href]").each((_idx, el) => {
    const rawHref = ($(el).attr("href") || "").trim();
    if (!rawHref || rawHref.startsWith("#") || /^(?:mailto:|tel:|javascript:)/i.test(rawHref)) {
      return;
    }
    let resolved: URL;
    try {
      resolved = new URL(rawHref, pageUrl);
      resolved.hash = "";
    } catch {
      return;
    }
    const normalizedUrl = resolved.toString();
    if (alreadySeenUrls.has(normalizedUrl)) return;
    if (NON_HTML_ASSET_RE.test(resolved.pathname)) return;
    if (SKIP_SUBPAGE_PATH_RE.test(resolved.pathname)) return;

    try {
      validateApprovedUrl(normalizedUrl, approvedDomains);
    } catch {
      return;
    }

    const label = cleanText($(el).text()).slice(0, 120);
    const combined = `${resolved.pathname} ${resolved.search} ${label}`.toLowerCase();

    let category: DiscoveredSubpage["category"] | null = null;
    let score = 0;

    if (/(?:degree-?programs?|undergraduate-?programs?|courses?-?offered|academic-?programs?|colleges?\/?$|undergrad)/i.test(combined)) {
      category = "programs";
      score = 10;
    } else if (/(?:tuition|school-?fees?|fees?-?and-?tuition|estimated-?fees?|cost-?of-?education)/i.test(combined)) {
      category = "tuition";
      score = 9;
    } else if (/(?:freshm(?:an|en)|admission-?requirements?|requirements?|how-?to-?apply|procedures?|eligibility)/i.test(combined)) {
      category = "requirements";
      score = 8;
    } else if (/(?:entrance-?exam|admission-?test|upcat|pupcet|dcat|ustet|feucat|plmat|plmee|tupstat|tupcet|pnuat|uecet|mpass|aducet)/i.test(combined)) {
      category = "exams";
      score = 8;
    } else if (/(?:deadlines?|important-?dates|application-?schedule|admission-?schedule)/i.test(combined)) {
      category = "deadlines";
      score = 7;
    }

    if (!category) return;

    // Prioritize missing categories so we gather complete coverage within our 6-page budget
    if (missingCategories.has(category)) {
      score += 5;
    }
    // Prefer cleaner, shallower URLs
    const depth = resolved.pathname.split("/").filter(Boolean).length;
    if (depth <= 3) score += 2;
    if (resolved.search) score -= 2;

    const existing = candidates.get(normalizedUrl);
    if (!existing || score > existing.score) {
      candidates.set(normalizedUrl, {
        url: normalizedUrl,
        category,
        score,
        label: label || resolved.pathname,
      });
    }
  });

  // Return top-ranked unique candidates, favoring category diversity
  const sorted = Array.from(candidates.values()).sort((a, b) => b.score - a.score);
  const picked: DiscoveredSubpage[] = [];
  const usedCategories = new Set<string>();
  for (const item of sorted) {
    if (!usedCategories.has(item.category)) {
      picked.push(item);
      usedCategories.add(item.category);
    }
    if (picked.length >= 4) break;
  }
  for (const item of sorted) {
    if (picked.length >= 4) break;
    if (!picked.some((p) => p.url === item.url)) {
      picked.push(item);
    }
  }
  return picked;
}

function structuredToDraft(
  base: {
    id: string;
    name: string;
    shortName: string;
    city: string;
    campusLocation: string;
    sector: "Public" | "Private";
    color: "green" | "maroon" | "gold" | "rust" | "lilac";
    officialUrl: string;
    collectionStatus: "pending" | "partial" | "verified";
    sourceNotes: string[];
    collectedAt: string;
    lastVerifiedAt: string;
  },
  structured: ReturnType<typeof structureRecord>,
): CatalogUniversityDraft {
  const programs: CatalogProgramItem[] = structured.programs
    .slice(0, 400)
    .map((p, idx) => ({
      id: `${base.id}-prog-${idx + 1}`,
      name: p.name.slice(0, 200),
      topic: classifyProgramTopic(p.name),
      strandAlignment: (p.strand_alignment || "").slice(0, 200),
      sourceUrl: (p.source_url || "").slice(0, 500),
    }));

  return {
    id: base.id,
    name: base.name.slice(0, 200),
    shortName: base.shortName.slice(0, 60),
    city: base.city.slice(0, 100),
    campusLocation: base.campusLocation.slice(0, 300),
    sector: base.sector,
    color: base.color,
    officialUrl: base.officialUrl.slice(0, 500),
    collectionStatus: base.collectionStatus,
    academicYear: (structured.academic_year || "").slice(0, 40),
    academicYears: structured.academic_years.slice(0, 10).map((y) => y.slice(0, 40)),
    isPublished: true,
    programs,
    admissionRequirements: structured.admission_requirements
      .slice(0, 100)
      .map((r: RequirementRow) => ({
        text: r.text.slice(0, 500),
        category: (r.category || "general").slice(0, 40),
        academicYear: (r.academic_year || "").slice(0, 40),
        sourceUrl: (r.source_url || "").slice(0, 500),
      })),
    applicationDeadlines: structured.application_deadlines
      .slice(0, 50)
      .map((d: DeadlineRow) => ({
        label: (d.label || "Application date").slice(0, 120),
        dateIso: (d.date_iso || "").slice(0, 20),
        rawText: (d.raw_text || "").slice(0, 400),
        academicYear: (d.academic_year || "").slice(0, 40),
        sourceUrl: (d.source_url || "").slice(0, 500),
      })),
    entranceExaminations: structured.entrance_examinations
      .slice(0, 30)
      .map((e: ExamRow) => ({
        examName: (e.exam_name || "Entrance examination").slice(0, 120),
        coverage: (e.coverage || "").slice(0, 500),
        academicYear: (e.academic_year || "").slice(0, 40),
        sourceUrl: (e.source_url || "").slice(0, 500),
      })),
    tuitionFees: structured.tuition_fees.slice(0, 50).map((f: FeeRow) => ({
      amountMin: typeof f.amount_min === "number" ? f.amount_min : null,
      amountMax: typeof f.amount_max === "number" ? f.amount_max : null,
      currency: (f.currency || "PHP").slice(0, 12),
      basis: (f.basis || "unspecified").slice(0, 30),
      rawText: (f.raw_text || "").slice(0, 400),
      academicYear: (f.academic_year || "").slice(0, 40),
      sourceUrl: (f.source_url || "").slice(0, 500),
    })),
    applicationLinks: structured.application_links
      .slice(0, 50)
      .map((l: ApplicationLinkRow) => ({
        label: (l.label || "Application page").slice(0, 120),
        url: l.url.slice(0, 500),
        sourceUrl: (l.source_url || "").slice(0, 500),
      })),
    declaredConflicts: structured.conflicts
      .slice(0, 50)
      .map((c: ConflictRow) => ({
        field: (c.field || "").slice(0, 60),
        keptValue: (c.kept_value || "").slice(0, 300),
        discardedValue: (c.discarded_value || "").slice(0, 300),
        reason: (c.reason || "").slice(0, 300),
      })),
    sourceUrls: structured.source_urls
      .filter((u) => u.startsWith("https://"))
      .slice(0, 50)
      .map((u) => u.slice(0, 500)),
    sourceNotes: base.sourceNotes.slice(0, 30).map((n) => n.slice(0, 600)),
    collectedAt: base.collectedAt.slice(0, 64),
    lastVerifiedAt: base.lastVerifiedAt.slice(0, 64),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectUniversityPolite(options: {
  universityId: string;
  urls?: string[];
  customUrl?: string;
  discoverSubpages?: boolean;
}): Promise<{ draft: CatalogUniversityDraft; audit: CollectionAuditReport }> {
  ensureStoreInitialized();
  const cfg = loadCollectionConfig();
  const targets = loadUniversityTargets();
  const existingSchool = universities.get(options.universityId);
  const matchingTarget = targets.find(
    (t) =>
      (existingSchool && t.name.toLowerCase() === existingSchool.name.toLowerCase()) ||
      slugifyId(t.name) === options.universityId,
  );

  if (!existingSchool && !matchingTarget) {
    throw new Error("University is not configured in the approved directory.");
  }

  const allowedDomains = matchingTarget?.approved_domains?.length
    ? matchingTarget.approved_domains.filter((d) =>
        cfg.approved_domains.includes(d.toLowerCase()),
      )
    : cfg.approved_domains;

  if (!allowedDomains.length) {
    throw new Error("No approved .edu.ph domains configured for this university.");
  }

  const configuredByNormalizedUrl = new Map<string, UniversityTargetPage>();
  for (const p of matchingTarget?.pages || []) {
    try {
      const parsed = validateApprovedUrl(p.url, allowedDomains);
      parsed.hash = "";
      configuredByNormalizedUrl.set(parsed.toString(), p);
    } catch {
      // Ignore invalid configured entries
    }
  }

  interface QueueEntry {
    url: string;
    pageConfig?: UniversityTargetPage;
    discovered: boolean;
    sourceKind: "configured" | "pasted" | "discovered";
  }

  const queue: QueueEntry[] = [];
  const queuedUrls = new Set<string>();
  const enqueueStrict = (
    rawUrl: string,
    sourceKind: "configured" | "pasted" | "discovered",
    pageConfig?: UniversityTargetPage,
  ) => {
    const validated = validateApprovedUrl(rawUrl, allowedDomains);
    validated.hash = "";
    const normalized = validated.toString();
    if (queuedUrls.has(normalized) || queue.length >= MAX_PAGES_PER_RUN) return;
    queuedUrls.add(normalized);
    const matchedCfg = pageConfig || configuredByNormalizedUrl.get(normalized);
    queue.push({
      url: normalized,
      discovered: sourceKind === "discovered",
      sourceKind: matchedCfg && sourceKind === "pasted" ? "configured" : sourceKind,
      pageConfig: matchedCfg,
    });
  };

  const enqueueSilent = (
    rawUrl: string,
    sourceKind: "configured" | "pasted" | "discovered",
    pageConfig?: UniversityTargetPage,
  ) => {
    try {
      enqueueStrict(rawUrl, sourceKind, pageConfig);
    } catch {
      // Skip non-allowlisted URLs silently when auto-discovering
    }
  };

  if (Array.isArray(options.urls) && options.urls.length > 0) {
    for (const raw of options.urls.slice(0, MAX_PAGES_PER_RUN)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      enqueueStrict(trimmed, "pasted");
    }
  } else if (options.customUrl && options.customUrl.trim()) {
    enqueueStrict(options.customUrl.trim(), "pasted");
  } else if (matchingTarget?.pages?.length) {
    for (const p of matchingTarget.pages.slice(0, MAX_PAGES_PER_RUN)) {
      enqueueSilent(p.url, "configured", p);
    }
  } else if (existingSchool?.official_url) {
    enqueueSilent(existingSchool.official_url, "configured");
  }

  if (!queue.length) {
    throw new Error("No approved HTTPS pages available to collect for this university.");
  }

  const allowSubpageDiscovery = options.discoverSubpages !== false;
  const robotsCache = new Map<string, { raw: string; status: string }>();
  const urlAudits: UrlFetchAudit[] = [];
  const combined: ExtractedHtmlEvidence = {
    tuition_estimates: [],
    admission_requirements: [],
    entrance_exam_coverage: [],
    application_deadlines: [],
    application_status: [],
    programs: [],
    application_links: [],
  };
  const fetchedSources: Array<Record<string, unknown>> = [];
  const sourcePriority: Record<string, number> = {};
  const timeoutMs = cfg.timeout_seconds * 1000;
  const lastFetchByOrigin = new Map<string, number>();
  const blockedOrigins = new Set<string>();

  for (let i = 0; i < queue.length && i < MAX_PAGES_PER_RUN; i++) {
    const entry = queue[i];
    const rawUrl = entry.url;
    const parsedUrl = validateApprovedUrl(rawUrl, allowedDomains);
    const origin = parsedUrl.origin;

    if (blockedOrigins.has(origin)) {
      urlAudits.push({
        url: rawUrl,
        finalUrl: rawUrl,
        robotsAllowed: true,
        robotsReason: "Skipped after earlier host block",
        httpStatus: null,
        status: "blocked_by_site",
        detail:
          "Skipped remaining pages on this host after an earlier 403/429/503 response to stay polite.",
        discovered: entry.discovered,
        sourceKind: entry.sourceKind,
      });
      continue;
    }

    // 1. Respect robots.txt first (once per origin)
    if (!robotsCache.has(origin)) {
      try {
        const robotsUrl = new URL("/robots.txt", origin);
        const { response } = await fetchAllowlistedWithRedirects(
          robotsUrl,
          allowedDomains,
          Math.min(timeoutMs, 10_000),
        );
        if (response.ok) {
          const text = await readBoundedText(response, 128 * 1024);
          robotsCache.set(origin, { raw: text, status: `HTTP ${response.status}` });
        } else if (response.status === 404 || response.status === 410) {
          robotsCache.set(origin, { raw: "", status: "No robots.txt (allowed)" });
        } else {
          robotsCache.set(origin, {
            raw: "User-agent: *\nDisallow: /",
            status: `robots.txt returned HTTP ${response.status} (fail-closed)`,
          });
        }
      } catch {
        robotsCache.set(origin, {
          raw: "User-agent: *\nDisallow: /",
          status: "robots.txt unreachable (fail-closed)",
        });
      }
    }

    const robotsEntry = robotsCache.get(origin)!;
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
    const policy = evaluateRobotsTxt(robotsEntry.raw, pathAndQuery);

    if (!policy.allowed) {
      urlAudits.push({
        url: rawUrl,
        finalUrl: rawUrl,
        robotsAllowed: false,
        robotsReason: `${robotsEntry.status} — ${policy.matchedRule}`,
        httpStatus: null,
        status: "blocked_by_robots",
        detail: "Skipped respectfully according to robots.txt.",
        discovered: entry.discovered,
        sourceKind: entry.sourceKind,
      });
      continue;
    }

    // 2. Enforce polite spacing (2-5s or Crawl-delay) between requests to the same host
    const requiredDelaySec = Math.min(
      10,
      Math.max(cfg.min_delay_seconds, policy.crawlDelaySeconds ?? cfg.min_delay_seconds),
    );
    const prevTs = lastFetchByOrigin.get(origin);
    if (prevTs !== undefined) {
      const elapsedMs = Date.now() - prevTs;
      const waitMs = requiredDelaySec * 1000 - elapsedMs;
      if (waitMs > 0) await delay(waitMs);
    }
    lastFetchByOrigin.set(origin, Date.now());

    // 3. Polite HTTPS fetch with redirect allowlist + DNS validation
    try {
      const { response, finalUrl } = await fetchAllowlistedWithRedirects(
        parsedUrl,
        allowedDomains,
        timeoutMs,
      );
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        blockedOrigins.add(origin);
        urlAudits.push({
          url: rawUrl,
          finalUrl,
          robotsAllowed: true,
          robotsReason: policy.matchedRule,
          httpStatus: response.status,
          status: "blocked_by_site",
          detail:
            "University server declined automated access (HTTP " +
            response.status +
            "). Stopped politely on this host without retrying — use JSON import or manual entry.",
          discovered: entry.discovered,
          sourceKind: entry.sourceKind,
        });
        continue;
      }
      if (!response.ok) {
        urlAudits.push({
          url: rawUrl,
          finalUrl,
          robotsAllowed: true,
          robotsReason: policy.matchedRule,
          httpStatus: response.status,
          status: "error",
          detail: `Returned HTTP ${response.status}.`,
          discovered: entry.discovered,
          sourceKind: entry.sourceKind,
        });
        continue;
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        urlAudits.push({
          url: rawUrl,
          finalUrl,
          robotsAllowed: true,
          robotsReason: policy.matchedRule,
          httpStatus: response.status,
          status: "error",
          detail: `Skipped non-HTML content (${contentType || "unknown"}).`,
          discovered: entry.discovered,
          sourceKind: entry.sourceKind,
        });
        continue;
      }

      const html = await readBoundedText(response, MAX_RESPONSE_BYTES);
      const extracted = extractHtmlEvidence(html, finalUrl, entry.pageConfig);
      combined.tuition_estimates.push(...extracted.tuition_estimates);
      combined.admission_requirements.push(...extracted.admission_requirements);
      combined.entrance_exam_coverage.push(...extracted.entrance_exam_coverage);
      combined.application_deadlines.push(...extracted.application_deadlines);
      combined.application_status.push(...extracted.application_status);
      combined.programs.push(...extracted.programs);
      combined.application_links.push(...extracted.application_links);
      fetchedSources.push({
        requested_url: rawUrl,
        final_url: finalUrl,
        http_status: response.status,
      });

      // Authoritative official priority: configured official pages > pasted official URLs > discovered subpages
      const prioBase =
        entry.sourceKind === "configured" ? 0 : entry.sourceKind === "pasted" ? 20 : 40;
      const prioScore = prioBase + i;
      sourcePriority[rawUrl] = Math.min(sourcePriority[rawUrl] ?? 999, prioScore);
      sourcePriority[finalUrl] = Math.min(sourcePriority[finalUrl] ?? 999, prioScore);

      // 4. Respectfully discover linked official subpages (only from seed pages, never deeper than 1 hop)
      let newlyQueued = 0;
      if (
        allowSubpageDiscovery &&
        !entry.discovered &&
        !blockedOrigins.has(origin) &&
        queue.length < MAX_PAGES_PER_RUN
      ) {
        const missing = new Set<string>();
        if (combined.programs.length < 5) missing.add("programs");
        if (combined.tuition_estimates.length === 0) missing.add("tuition");
        if (combined.admission_requirements.length < 3) missing.add("requirements");
        if (combined.application_deadlines.length === 0) missing.add("deadlines");
        if (combined.entrance_exam_coverage.length === 0) missing.add("exams");

        const discoveredLinks = discoverOfficialSubpages(
          html,
          finalUrl,
          allowedDomains,
          queuedUrls,
          missing,
        );
        for (const sub of discoveredLinks) {
          if (queue.length >= MAX_PAGES_PER_RUN) break;
          const before = queue.length;
          enqueueSilent(sub.url, "discovered");
          if (queue.length > before) newlyQueued += 1;
        }
      }

      urlAudits.push({
        url: rawUrl,
        finalUrl,
        robotsAllowed: true,
        robotsReason: policy.matchedRule,
        httpStatus: response.status,
        status: "fetched",
        detail:
          `Extracted ${extracted.programs.length} programs, ${extracted.admission_requirements.length} requirements, ${extracted.tuition_estimates.length} fee notes, ${extracted.application_deadlines.length} date notes` +
          (newlyQueued > 0 ? ` · queued ${newlyQueued} official subpage(s)` : "") +
          ".",
        discovered: entry.discovered,
        sourceKind: entry.sourceKind,
      });
    } catch (err) {
      urlAudits.push({
        url: rawUrl,
        finalUrl: rawUrl,
        robotsAllowed: true,
        robotsReason: policy.matchedRule,
        httpStatus: null,
        status: "error",
        detail: err instanceof Error ? err.message : "Network error while fetching page.",
        discovered: entry.discovered,
        sourceKind: entry.sourceKind,
      });
    }
  }

  const nowIso = new Date().toISOString();
  const uniName = existingSchool?.name || matchingTarget?.name || options.universityId;
  const campusLocation =
    existingSchool?.campus_location || matchingTarget?.campus_location || "Manila";
  const structured = structureRecord(
    {
      university_name: uniName,
      campus_location: campusLocation,
      retrieved_at_utc: nowIso,
      sources: fetchedSources,
      source_notes: matchingTarget?.source_notes || [],
      ...combined,
    },
    sourcePriority,
  );

  const fetchedCount = urlAudits.filter((a) => a.status === "fetched").length;
  const discoveredFetchedCount = urlAudits.filter(
    (a) => a.status === "fetched" && a.discovered,
  ).length;
  const robotsBlockedCount = urlAudits.filter(
    (a) => a.status === "blocked_by_robots",
  ).length;

  let auditStatus: CollectionAuditReport["status"] = "completed";
  if (fetchedCount === 0 && robotsBlockedCount > 0) {
    auditStatus = "blocked_by_robots";
  } else if (fetchedCount === 0) {
    auditStatus = "failed";
  } else if (fetchedCount < urlAudits.length) {
    auditStatus = "partial";
  }

  const colorCandidate = existingSchool?.color || "green";
  const color = (VALID_COLORS.has(colorCandidate) ? colorCandidate : "green") as
    | "green"
    | "maroon"
    | "gold"
    | "rust"
    | "lilac";

  const draft = structuredToDraft(
    {
      id: existingSchool?.id || options.universityId,
      name: uniName,
      shortName: existingSchool?.short_name || uniName.slice(0, 20),
      city: existingSchool?.city || "Manila",
      campusLocation,
      sector: existingSchool?.sector === "Public" ? "Public" : "Private",
      color,
      officialUrl:
        existingSchool?.official_url ||
        fetchedSources[0]?.final_url?.toString() ||
        queue[0]?.url ||
        "",
      collectionStatus: fetchedCount > 0 ? "partial" : "pending",
      sourceNotes: [
        ...(matchingTarget?.source_notes || []),
        `Polite collection run on ${nowIso.slice(0, 10)}: ${fetchedCount}/${urlAudits.length} approved page(s) fetched${discoveredFetchedCount ? ` (including ${discoveredFetchedCount} discovered official subpage${discoveredFetchedCount === 1 ? "" : "s"})` : ""} after robots.txt check.`,
      ],
      collectedAt: fetchedCount > 0 ? nowIso : existingSchool?.collected_at || "",
      lastVerifiedAt: fetchedCount > 0 ? nowIso : existingSchool?.last_verified_at || "",
    },
    structured,
  );

  return {
    draft,
    audit: {
      universityId: draft.id,
      universityName: draft.name,
      mode: "polite-web",
      status: auditStatus,
      fetchedUrlCount: fetchedCount,
      programCount: draft.programs.length,
      conflictCount: draft.declaredConflicts.length,
      robotsSummary: `${urlAudits.filter((a) => a.robotsAllowed).length}/${urlAudits.length} URLs permitted by robots.txt; polite ${cfg.min_delay_seconds}–${cfg.max_delay_seconds}s spacing enforced (max ${MAX_PAGES_PER_RUN} pages).`,
      notes:
        fetchedCount > 0
          ? `Fetched ${fetchedCount} of ${urlAudits.length} official pages${discoveredFetchedCount ? ` (${discoveredFetchedCount} discovered)` : ""} and extracted ${draft.programs.length} programs, ${draft.admissionRequirements.length} requirements, ${draft.tuitionFees.length} fee notes, and ${draft.applicationDeadlines.length} deadlines.`
          : "No pages could be fetched automatically (site policy or access block respected). Use JSON Snapshot Import or manual editing.",
      urls: urlAudits,
    },
  };
}

export function parseCollectorJsonImport(
  rawPayload: unknown,
): { draft: CatalogUniversityDraft; audit: CollectionAuditReport } {
  ensureStoreInitialized();
  let candidate: unknown = rawPayload;
  if (Array.isArray(rawPayload)) {
    if (rawPayload.length === 0) {
      throw new Error("JSON snapshot must be a valid university collector object.");
    }
    candidate = rawPayload[0];
  } else if (
    rawPayload &&
    typeof rawPayload === "object" &&
    Array.isArray((rawPayload as Record<string, unknown>).universities) &&
    ((rawPayload as Record<string, unknown>).universities as unknown[]).length > 0
  ) {
    candidate = ((rawPayload as Record<string, unknown>).universities as unknown[])[0];
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("JSON snapshot must be a valid university collector object.");
  }
  const record = candidate as Record<string, unknown>;
  const name = cleanText(record.university_name ?? record.name ?? "");
  if (!name) {
    throw new Error("JSON snapshot must include university_name (or name).");
  }

  let matchedExisting = Array.from(universities.values()).find(
    (u) => u.name.toLowerCase() === name.toLowerCase(),
  );
  if (!matchedExisting && typeof record.id === "string") {
    matchedExisting = universities.get(record.id.trim());
  }

  const structured = structureRecord(record);
  const nowIso = new Date().toISOString();
  const id = matchedExisting?.id || slugifyId(typeof record.id === "string" ? record.id : name);
  const sectorRaw = String(record.sector ?? matchedExisting?.sector ?? "Private");
  const sector: "Public" | "Private" = sectorRaw === "Public" ? "Public" : "Private";
  const colorRaw = String(record.color ?? matchedExisting?.color ?? "green");
  const color = (VALID_COLORS.has(colorRaw) ? colorRaw : "green") as
    | "green"
    | "maroon"
    | "gold"
    | "rust"
    | "lilac";

  const sourceNotes = Array.isArray(record.source_notes)
    ? record.source_notes.map((n) => cleanText(n)).filter(Boolean)
    : [];

  const firstHttpsSource = structured.source_urls.find((u) => u.startsWith("https://")) || "";
  const officialUrlRaw = cleanText(record.official_url ?? matchedExisting?.official_url ?? firstHttpsSource);
  const officialUrl = officialUrlRaw.startsWith("https://") ? officialUrlRaw : "";

  const draft = structuredToDraft(
    {
      id,
      name: matchedExisting?.name || name,
      shortName: matchedExisting?.short_name || cleanText(record.short_name ?? name).slice(0, 30),
      city: matchedExisting?.city || cleanText(record.city ?? "Manila") || "Manila",
      campusLocation:
        cleanText(record.campus_location ?? matchedExisting?.campus_location ?? "Manila") ||
        "Manila",
      sector,
      color,
      officialUrl,
      collectionStatus: "partial",
      sourceNotes,
      collectedAt:
        typeof record.retrieved_at_utc === "string" && record.retrieved_at_utc
          ? record.retrieved_at_utc
          : nowIso,
      lastVerifiedAt: structured.last_verified_at || nowIso,
    },
    structured,
  );

  return {
    draft,
    audit: {
      universityId: draft.id,
      universityName: draft.name,
      mode: "json-import",
      status: "completed",
      fetchedUrlCount: draft.sourceUrls.length,
      programCount: draft.programs.length,
      conflictCount: draft.declaredConflicts.length,
      robotsSummary: "Offline collector JSON snapshot validated and structured via Algorithm 1.",
      notes: `Imported ${draft.programs.length} programs, ${draft.tuitionFees.length} fee entries, ${draft.applicationDeadlines.length} deadlines, and ${draft.declaredConflicts.length} flagged conflicts.`,
      urls: [],
    },
  };
}

export function exportBaselineCatalog(): CatalogUniversityDraft[] {
  ensureStoreInitialized();
  const results: CatalogUniversityDraft[] = [];
  const sorted = Array.from(universities.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const u of sorted) {
    const detail = getUniversityDetail(u.id);
    if (!detail) continue;
    const structured = detail.structured as ReturnType<typeof structureRecord> | null;
    const progs = Array.isArray(detail.programs)
      ? (detail.programs as Array<{
          id?: string;
          name: string;
          topic?: string;
          strand_alignment?: string | null;
          source_url?: string | null;
        }>)
      : [];
    const conflicts = Array.isArray(detail.declared_conflicts)
      ? (detail.declared_conflicts as ConflictRow[])
      : [];
    const rawNotes = Array.isArray((u.evidence as Record<string, unknown>)?.source_notes)
      ? ((u.evidence as Record<string, unknown>).source_notes as unknown[])
          .map((n) => cleanText(n))
          .filter(Boolean)
      : [];
    const color = (VALID_COLORS.has(u.color) ? u.color : "green") as
      | "green"
      | "maroon"
      | "gold"
      | "rust"
      | "lilac";

    results.push({
      id: u.id,
      name: u.name.slice(0, 200),
      shortName: u.short_name.slice(0, 60),
      city: u.city.slice(0, 100),
      campusLocation: u.campus_location.slice(0, 300),
      sector: u.sector === "Public" ? "Public" : "Private",
      color,
      officialUrl:
        u.official_url && u.official_url.startsWith("https://")
          ? u.official_url.slice(0, 500)
          : "",
      collectionStatus:
        u.collection_status === "verified"
          ? "verified"
          : u.collection_status === "partial"
            ? "partial"
            : "pending",
      academicYear: (structured?.academic_year || u.academic_year || "").slice(0, 40),
      academicYears: (structured?.academic_years || u.academic_years || [])
        .slice(0, 10)
        .map((y) => y.slice(0, 40)),
      isPublished: true,
      programs: progs.slice(0, 400).map((p, idx) => ({
        id: (p.id || `${u.id}-prog-${idx + 1}`).slice(0, 128),
        name: cleanText(p.name).slice(0, 200),
        topic: cleanText(p.topic || classifyProgramTopic(p.name)).slice(0, 80),
        strandAlignment: cleanText(p.strand_alignment || "").slice(0, 200),
        sourceUrl:
          p.source_url && p.source_url.startsWith("https://")
            ? p.source_url.slice(0, 500)
            : "",
      })),
      admissionRequirements: (structured?.admission_requirements || [])
        .slice(0, 100)
        .map((r) => ({
          text: cleanText(r.text).slice(0, 500),
          category: cleanText(r.category || "general").slice(0, 40),
          academicYear: cleanText(r.academic_year || "").slice(0, 40),
          sourceUrl:
            r.source_url && r.source_url.startsWith("https://")
              ? r.source_url.slice(0, 500)
              : "",
        })),
      applicationDeadlines: (structured?.application_deadlines || [])
        .slice(0, 50)
        .map((d) => ({
          label: cleanText(d.label || "Application date").slice(0, 120),
          dateIso: cleanText(d.date_iso || "").slice(0, 20),
          rawText: cleanText(d.raw_text || "").slice(0, 400),
          academicYear: cleanText(d.academic_year || "").slice(0, 40),
          sourceUrl:
            d.source_url && d.source_url.startsWith("https://")
              ? d.source_url.slice(0, 500)
              : "",
        })),
      entranceExaminations: (structured?.entrance_examinations || [])
        .slice(0, 30)
        .map((e) => ({
          examName: cleanText(e.exam_name || "Entrance examination").slice(0, 120),
          coverage: cleanText(e.coverage || "").slice(0, 500),
          academicYear: cleanText(e.academic_year || "").slice(0, 40),
          sourceUrl:
            e.source_url && e.source_url.startsWith("https://")
              ? e.source_url.slice(0, 500)
              : "",
        })),
      tuitionFees: (structured?.tuition_fees || []).slice(0, 50).map((f) => ({
        amountMin: typeof f.amount_min === "number" ? f.amount_min : null,
        amountMax: typeof f.amount_max === "number" ? f.amount_max : null,
        currency: cleanText(f.currency || "PHP").slice(0, 12),
        basis: cleanText(f.basis || "unspecified").slice(0, 30),
        rawText: cleanText(f.raw_text || "").slice(0, 400),
        academicYear: cleanText(f.academic_year || "").slice(0, 40),
        sourceUrl:
          f.source_url && f.source_url.startsWith("https://")
            ? f.source_url.slice(0, 500)
            : "",
      })),
      applicationLinks: (structured?.application_links || [])
        .filter((l) => l.url && l.url.startsWith("https://"))
        .slice(0, 50)
        .map((l) => ({
          label: cleanText(l.label || "Application page").slice(0, 120),
          url: l.url.slice(0, 500),
          sourceUrl:
            l.source_url && l.source_url.startsWith("https://")
              ? l.source_url.slice(0, 500)
              : "",
        })),
      declaredConflicts: conflicts.slice(0, 50).map((c) => ({
        field: cleanText(c.field).slice(0, 60),
        keptValue: cleanText(c.kept_value).slice(0, 300),
        discardedValue: cleanText(c.discarded_value).slice(0, 300),
        reason: cleanText(c.reason).slice(0, 300),
      })),
      sourceUrls: (structured?.source_urls || [])
        .filter((url) => typeof url === "string" && url.startsWith("https://"))
        .slice(0, 50)
        .map((url) => url.slice(0, 500)),
      sourceNotes: rawNotes.slice(0, 30).map((n) => n.slice(0, 600)),
      collectedAt: (u.collected_at || "").slice(0, 64),
      lastVerifiedAt: (
        structured?.last_verified_at ||
        u.last_verified_at ||
        ""
      ).slice(0, 64),
    });
  }

  return results;
}
