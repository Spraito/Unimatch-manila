import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlidingFixedWindowLimiter,
  buildCspHeader,
  isSameOriginHeaders,
  sanitizeCloudPreferences,
  sanitizeDisplayName,
  sanitizeIdList,
} from "./securityHardening.js";
import {
  decryptPii,
  encryptPii,
  generateTotpSecret,
  isSafeNextUrl,
  loadResetToken,
  makeResetToken,
  totpCode,
  verifyTotp,
} from "./security.js";

describe("SlidingFixedWindowLimiter", () => {
  it("allows requests up to max and blocks subsequent attempts with Retry-After", () => {
    const limiter = new SlidingFixedWindowLimiter({
      windowMs: 60_000,
      max: 3,
      keyPrefix: "test-login",
    });
    const t0 = 1_700_000_000_000;
    assert.equal(limiter.check("1.2.3.4", t0).allowed, true);
    assert.equal(limiter.check("1.2.3.4", t0 + 1000).allowed, true);
    const third = limiter.check("1.2.3.4", t0 + 2000);
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = limiter.check("1.2.3.4", t0 + 5000);
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.remaining, 0);
    assert.equal(fourth.retryAfterSeconds, 55);

    // Different IP is unaffected
    assert.equal(limiter.check("5.6.7.8", t0 + 5000).allowed, true);

    // After window elapses, requests are allowed again
    assert.equal(limiter.check("1.2.3.4", t0 + 60_001).allowed, true);
  });

  it("bounds internal bucket map under unique IP floods", () => {
    const limiter = new SlidingFixedWindowLimiter({
      windowMs: 60_000,
      max: 5,
      keyPrefix: "flood",
      maxBuckets: 20,
    });
    const now = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) {
      const res = limiter.check(`10.0.0.${i}`, now);
      assert.equal(res.allowed, true);
    }
  });
});

describe("isSameOriginHeaders", () => {
  it("accepts matching Origin or Referer against Host / X-Forwarded-Host", () => {
    assert.equal(
      isSameOriginHeaders({
        origin: "https://unimatch.example.app",
        host: "unimatch.example.app",
      }),
      true,
    );
    assert.equal(
      isSameOriginHeaders({
        origin: "https://preview.run.app",
        host: "localhost:3000",
        "x-forwarded-host": "preview.run.app",
      }),
      true,
    );
    assert.equal(
      isSameOriginHeaders({
        referer: "http://localhost:3000/login",
        host: "localhost:3000",
      }),
      true,
    );
  });

  it("rejects cross-origin Origin, null Origin, and cross-origin Referer", () => {
    assert.equal(
      isSameOriginHeaders({
        origin: "https://evil.attacker.test",
        host: "unimatch.example.app",
      }),
      false,
    );
    assert.equal(
      isSameOriginHeaders({
        origin: "null",
        host: "unimatch.example.app",
      }),
      false,
    );
    assert.equal(
      isSameOriginHeaders({
        referer: "https://evil.attacker.test/phish",
        host: "unimatch.example.app",
      }),
      false,
    );
  });
});

describe("buildCspHeader", () => {
  it("builds a strict iframe-compatible CSP with Firebase endpoints and no unsafe-inline", () => {
    const csp = buildCspHeader("kingly-wind-xg33w.firebaseapp.com");
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("style-src 'self'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("base-uri 'self'"));
    assert.ok(csp.includes("form-action 'self'"));
    assert.ok(csp.includes("https://kingly-wind-xg33w.firebaseapp.com"));
    assert.ok(csp.includes("https://firestore.googleapis.com"));
    assert.equal(csp.includes("'unsafe-inline'"), false);
    assert.equal(csp.includes("frame-ancestors 'none'"), false);
  });
});

describe("Cloud payload sanitizers (blueprint contract)", () => {
  it("sanitizes display names and ID lists with strict caps", () => {
    assert.equal(sanitizeDisplayName("  Juan   Dela Cruz  "), "Juan Dela Cruz");
    assert.equal(sanitizeDisplayName("".padEnd(120, "A")).length, 80);
    assert.equal(sanitizeDisplayName("   ", "Student"), "Student");

    const ids = sanitizeIdList(
      ["pup", "dlsu", "pup", "../evil", "bad id!", 123, "up-diliman", "ust"],
      3,
    );
    assert.deepEqual(ids, ["pup", "dlsu", "up-diliman"]);
  });

  it("sanitizes preferences and normalizes weights to 1.0", () => {
    const prefs = sanitizeCloudPreferences({
      program: "  Computer Science  ".padEnd(250, "x"),
      city: "Manila",
      sector: "InvalidSector",
      budget: -500,
      budgetBasis: "weekly",
      weights: { program: 60, location: 20, budget: 10, sector: 10 },
    });
    assert.equal(prefs.program.length, 200);
    assert.equal(prefs.sector, "");
    assert.equal(prefs.budget, null);
    assert.equal(prefs.budgetBasis, "semester");
    const sum =
      prefs.weights.program +
      prefs.weights.location +
      prefs.weights.budget +
      prefs.weights.sector;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });
});

describe("Core cryptographic and redirect safety helpers", () => {
  it("blocks open redirect vectors in isSafeNextUrl", () => {
    assert.equal(isSafeNextUrl("/explore"), true);
    assert.equal(isSafeNextUrl("/profile?tab=1"), true);
    assert.equal(isSafeNextUrl("//evil.com"), false);
    assert.equal(isSafeNextUrl("https://evil.com"), false);
    assert.equal(isSafeNextUrl("/\\evil.com"), false);
    assert.equal(isSafeNextUrl("/login\r\nSet-Cookie: a=1"), false);
  });

  it("encrypts and authenticates PII with AES-256-GCM", () => {
    const enc = encryptPii("student@example.edu.ph");
    assert.notEqual(enc, "student@example.edu.ph");
    assert.equal(decryptPii(enc), "student@example.edu.ph");
    // Flip a character inside the authenticated payload to verify tag rejection
    const mid = Math.floor(enc.length / 2);
    const tampered =
      enc.slice(0, mid) + (enc[mid] === "A" ? "B" : "A") + enc.slice(mid + 1);
    assert.throws(() => decryptPii(tampered));
  });

  it("signs and verifies timed reset tokens and RFC 6238 TOTP codes", () => {
    const token = makeResetToken("usr-123", 2);
    const parsed = loadResetToken(token);
    assert.equal(parsed.user_id, "usr-123");
    assert.equal(parsed.session_version, 2);
    assert.throws(() => loadResetToken(token + "tamper"));

    const secret = generateTotpSecret();
    const fixedTime = 1_700_000_000;
    const code = totpCode(secret, fixedTime);
    assert.equal(verifyTotp(secret, code, fixedTime), true);
    assert.equal(verifyTotp(secret, "000000", fixedTime), false);
  });

  it("defaults UNIMATCH_ENV to production whenever unset or blank", async () => {
    const { resolveUnimatchEnv, isProductionEnv } = await import("./env.js");
    assert.equal(resolveUnimatchEnv(undefined), "production");
    assert.equal(resolveUnimatchEnv(""), "production");
    assert.equal(resolveUnimatchEnv("   "), "production");
    assert.equal(isProductionEnv(undefined), true);
    assert.equal(isProductionEnv(""), true);
    assert.equal(resolveUnimatchEnv("development"), "development");
    assert.equal(isProductionEnv("development"), false);
    assert.equal(resolveUnimatchEnv("PRODUCTION"), "production");
    assert.equal(isProductionEnv("PRODUCTION"), true);
  });
});
