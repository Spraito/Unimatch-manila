/**
 * Pure multi-page official URL queue parser and validator shared between the
 * Admin Polite Web Collector UI and unit tests.
 */

export interface CollectorUrlValidationIssue {
  lineNumber: number;
  rawLine: string;
  reason: string;
}

export interface CollectorUrlQueueResult {
  queuedUrls: string[];
  checkedCount: number;
  pastedValidCount: number;
  duplicateCount: number;
  invalidLines: CollectorUrlValidationIssue[];
  exceedsMax: boolean;
  maxPages: number;
  canRun: boolean;
}

export function hostMatchesApprovedDomains(
  hostname: string,
  approvedDomains: string[],
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return approvedDomains.some((rawDomain) => {
    const domain = rawDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function buildCollectorUrlQueue(
  checkedConfiguredUrls: string[],
  pastedRawText: string,
  approvedDomains: string[],
  maxPages = 12,
): CollectorUrlQueueResult {
  const seen = new Set<string>();
  const queuedUrls: string[] = [];
  let checkedCount = 0;
  let pastedValidCount = 0;
  let duplicateCount = 0;
  const invalidLines: CollectorUrlValidationIssue[] = [];

  for (const raw of checkedConfiguredUrls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queuedUrls.push(trimmed);
    checkedCount += 1;
  }

  const lines = pastedRawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    if (rawLine.length > 500) {
      invalidLines.push({
        lineNumber: i + 1,
        rawLine,
        reason: "URL exceeds 500 characters.",
      });
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawLine);
    } catch {
      invalidLines.push({
        lineNumber: i + 1,
        rawLine,
        reason: "Not a valid URL (must start with https://).",
      });
      continue;
    }

    if (parsed.protocol !== "https:") {
      invalidLines.push({
        lineNumber: i + 1,
        rawLine,
        reason: "Only official https:// URLs are allowed.",
      });
      continue;
    }

    if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
      invalidLines.push({
        lineNumber: i + 1,
        rawLine,
        reason: "Credentials and custom ports are not allowed.",
      });
      continue;
    }

    if (!hostMatchesApprovedDomains(parsed.hostname, approvedDomains)) {
      invalidLines.push({
        lineNumber: i + 1,
        rawLine,
        reason: `Domain "${parsed.hostname}" is not in this university's approved official .edu.ph domains (${approvedDomains.join(", ")}).`,
      });
      continue;
    }

    const normalized = parsed.toString();
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    queuedUrls.push(normalized);
    pastedValidCount += 1;
  }

  const exceedsMax = queuedUrls.length > maxPages;
  const canRun =
    queuedUrls.length > 0 && invalidLines.length === 0 && !exceedsMax;

  return {
    queuedUrls,
    checkedCount,
    pastedValidCount,
    duplicateCount,
    invalidLines,
    exceedsMax,
    maxPages,
    canRun,
  };
}
