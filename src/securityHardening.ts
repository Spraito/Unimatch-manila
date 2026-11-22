/**
 * Security hardening primitives for UniMatch PH:
 * - Bounded in-memory rate limiting with Retry-After support
 * - Same-origin verification for cookie-authenticated state-changing requests
 * - Strict, iframe- and Firebase-compatible Content Security Policy builder
 * - Defensive payload sanitizers matching firebase-blueprint.json bounds
 */
import type { NextFunction, Request, Response } from "express";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtMs: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  maxBuckets?: number;
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

export class SlidingFixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly keyPrefix: string;
  private readonly maxBuckets: number;

  constructor(options: RateLimiterOptions) {
    this.windowMs = Math.max(1000, Math.floor(options.windowMs));
    this.max = Math.max(1, Math.floor(options.max));
    this.keyPrefix = options.keyPrefix;
    this.maxBuckets = options.maxBuckets ?? 5000;
  }

  private prune(nowMs: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= nowMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= this.maxBuckets) {
      // Evict oldest entries to prevent unbounded memory growth
      const overflow = this.buckets.size - Math.floor(this.maxBuckets * 0.75);
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  check(subjectKey: string, nowMs = Date.now()): RateLimitResult {
    this.prune(nowMs);
    const fullKey = `${this.keyPrefix}:${subjectKey || "unknown"}`;
    const existing = this.buckets.get(fullKey);
    if (!existing || existing.resetAtMs <= nowMs) {
      const resetAtMs = nowMs + this.windowMs;
      this.buckets.set(fullKey, { count: 1, resetAtMs });
      return {
        allowed: true,
        limit: this.max,
        remaining: Math.max(0, this.max - 1),
        retryAfterSeconds: 0,
        resetAtMs,
      };
    }

    if (existing.count >= this.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAtMs - nowMs) / 1000),
      );
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        retryAfterSeconds,
        resetAtMs: existing.resetAtMs,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      limit: this.max,
      remaining: Math.max(0, this.max - existing.count),
      retryAfterSeconds: 0,
      resetAtMs: existing.resetAtMs,
    };
  }

  reset(subjectKey?: string): void {
    if (subjectKey) {
      this.buckets.delete(`${this.keyPrefix}:${subjectKey}`);
    } else {
      this.buckets.clear();
    }
  }
}

export function extractClientIp(req: Request): string {
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : "";
  if (ip) return ip.slice(0, 128);
  const remote = req.socket?.remoteAddress || "unknown";
  return String(remote).slice(0, 128);
}

export function createRateLimitMiddleware(
  limiter: SlidingFixedWindowLimiter,
  onLimited?: (
    req: Request,
    res: Response,
    result: RateLimitResult,
  ) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = limiter.check(extractClientIp(req));
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      if (onLimited) {
        return onLimited(req, res, result);
      }
      if (req.path.startsWith("/api/")) {
        return res.status(429).json({
          error: `Too many requests. Please wait ${result.retryAfterSeconds} seconds and try again.`,
          retry_after: result.retryAfterSeconds,
        });
      }
      return res
        .status(429)
        .send(
          `Too many requests. Please wait ${result.retryAfterSeconds} seconds and try again.`,
        );
    }
    return next();
  };
}

function normalizeHost(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split(",")[0].trim().toLowerCase();
}

export function isSameOriginHeaders(headers: {
  origin?: string;
  referer?: string;
  host?: string;
  "x-forwarded-host"?: string;
}): boolean {
  const expectedHost =
    normalizeHost(headers["x-forwarded-host"]) || normalizeHost(headers.host);
  if (!expectedHost) return false;

  const originHeader = (headers.origin || "").trim();
  if (originHeader) {
    if (originHeader.toLowerCase() === "null") return false;
    try {
      const parsed = new URL(originHeader);
      return parsed.host.toLowerCase() === expectedHost;
    } catch {
      return false;
    }
  }

  const refererHeader = (headers.referer || "").trim();
  if (refererHeader) {
    try {
      const parsed = new URL(refererHeader);
      return parsed.host.toLowerCase() === expectedHost;
    } catch {
      return false;
    }
  }

  // Non-browser clients without Origin/Referer still must pass CSRF token checks on HTML POST routes
  return true;
}

export function verifySameOriginMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  const ok = isSameOriginHeaders({
    origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    referer: typeof req.headers.referer === "string" ? req.headers.referer : undefined,
    host: typeof req.headers.host === "string" ? req.headers.host : undefined,
    "x-forwarded-host":
      typeof req.headers["x-forwarded-host"] === "string"
        ? req.headers["x-forwarded-host"]
        : undefined,
  });
  if (!ok) {
    if (req.path.startsWith("/api/")) {
      return res
        .status(403)
        .json({ error: "Cross-origin state-changing request blocked." });
    }
    return res
      .status(403)
      .send("Cross-origin request rejected. Reload the page and try again.");
  }
  return next();
}

export function buildCspHeader(firebaseAuthDomain?: string): string {
  const authFrameHosts = ["'self'", "https://accounts.google.com"];
  if (
    firebaseAuthDomain &&
    /^[a-z0-9.-]+$/i.test(firebaseAuthDomain.trim())
  ) {
    authFrameHosts.push(`https://${firebaseAuthDomain.trim()}`);
  }
  const directives = [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com",
    "style-src 'self'",
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com wss://*.firestore.googleapis.com",
    `frame-src ${authFrameHosts.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  return directives.join("; ");
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_SECTORS = new Set(["", "Public", "Private"]);
const VALID_BASES = new Set(["semester", "trimester", "year", "unit"]);

export interface SanitizedCloudPreferences {
  program: string;
  city: string;
  sector: "" | "Public" | "Private";
  budget: number | null;
  budgetBasis: "semester" | "trimester" | "year" | "unit";
  weights: {
    program: number;
    location: number;
    budget: number;
    sector: number;
  };
}

export function sanitizeDisplayName(value: unknown, fallback = "Student"): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return cleaned || fallback;
}

export function sanitizeIdList(values: unknown, maxSize: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!VALID_ID_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxSize) break;
  }
  return out;
}

export function sanitizeCloudPreferences(input: {
  program?: unknown;
  city?: unknown;
  sector?: unknown;
  budget?: unknown;
  budgetBasis?: unknown;
  weights?: Record<string, unknown>;
}): SanitizedCloudPreferences {
  const program = String(input.program ?? "").trim().slice(0, 200);
  const city = String(input.city ?? "").trim().slice(0, 200);
  const rawSector = String(input.sector ?? "").trim();
  const sector = (VALID_SECTORS.has(rawSector) ? rawSector : "") as
    | ""
    | "Public"
    | "Private";

  let budget: number | null = null;
  if (input.budget !== null && input.budget !== undefined && input.budget !== "") {
    const parsed = Number(input.budget);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000_000) {
      budget = Math.round(parsed * 100) / 100;
    }
  }

  const rawBasis = String(input.budgetBasis ?? "semester").trim().toLowerCase();
  const budgetBasis = (VALID_BASES.has(rawBasis) ? rawBasis : "semester") as
    | "semester"
    | "trimester"
    | "year"
    | "unit";

  const defaults = { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 };
  const rawWeights = input.weights ?? defaults;
  const clampWeight = (v: unknown, fb: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return fb;
    return n > 1 ? Math.min(1, n / 100) : n;
  };
  const w = {
    program: clampWeight(rawWeights.program, defaults.program),
    location: clampWeight(rawWeights.location, defaults.location),
    budget: clampWeight(rawWeights.budget, defaults.budget),
    sector: clampWeight(rawWeights.sector, defaults.sector),
  };
  const sum = w.program + w.location + w.budget + w.sector;
  const weights =
    sum > 0
      ? {
          program: Math.round((w.program / sum) * 10000) / 10000,
          location: Math.round((w.location / sum) * 10000) / 10000,
          budget: Math.round((w.budget / sum) * 10000) / 10000,
          sector: Math.round((w.sector / sum) * 10000) / 10000,
        }
      : defaults;

  return { program, city, sector, budget, budgetBasis, weights };
}
