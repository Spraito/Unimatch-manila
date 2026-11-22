/**
 * Unit tests for polite web collector security guards, RFC 9309 robots.txt
 * parser, HTML evidence extraction, JSON snapshot import, and baseline export.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverOfficialSubpages,
  evaluateRobotsTxt,
  exportBaselineCatalog,
  extractHtmlEvidence,
  getCollectorConfig,
  isPrivateOrReservedIp,
  parseCollectorJsonImport,
  parseProgramCandidate,
  validateApprovedUrl,
} from "./collector.js";
import { structureRecord } from "./algorithms/extraction.js";
import { mergeLiveAndBaselineCatalog } from "./algorithms/catalogMerge.js";
import { ROOT } from "./store.js";

test("isPrivateOrReservedIp blocks loopback, private, link-local, metadata, and IPv6 local addresses", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.12.4",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "not-an-ip",
  ];
  for (const ip of blocked) {
    assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "202.92.128.1", "172.32.0.1", "2606:4700:4700::1111"];
  for (const ip of allowed) {
    assert.equal(isPrivateOrReservedIp(ip), false, `Expected ${ip} to be allowed`);
  }
});

test("validateApprovedUrl permits approved HTTPS .edu.ph URLs and rejects unsafe inputs", () => {
  const cfg = getCollectorConfig();
  assert.ok(cfg.approvedDomains.length >= 10, "Should load approved official .edu.ph domains");
  assert.equal(cfg.approvedDomains.includes("example.test"), false, "example.test must be stripped");

  const valid = validateApprovedUrl("https://www.dlsu.edu.ph/admissions/", cfg.approvedDomains);
  assert.equal(valid.hostname, "www.dlsu.edu.ph");

  const subdomainValid = validateApprovedUrl("https://admissions.upm.edu.ph/upcat/", cfg.approvedDomains);
  assert.equal(subdomainValid.hostname, "admissions.upm.edu.ph");

  const rejected = [
    "http://www.dlsu.edu.ph/admissions/",
    "https://evil.com/admissions/",
    "https://dlsu.edu.ph.evil.com/",
    "https://127.0.0.1/admin",
    "https://169.254.169.254/latest/meta-data/",
    "https://user:pass@www.dlsu.edu.ph/admissions/",
    "https://www.dlsu.edu.ph:8443/admissions/",
    "https://example.test/page",
    "javascript:alert(1)",
  ];
  for (const bad of rejected) {
    assert.throws(
      () => validateApprovedUrl(bad, cfg.approvedDomains),
      `Expected ${bad} to be rejected`,
    );
  }
});

test("evaluateRobotsTxt honors Disallow, longer Allow precedence, Crawl-delay, and bot-specific groups", () => {
  const sampleRobots = `
# University robots.txt
User-agent: *
Disallow: /wp-admin/
Disallow: /admissions/private/
Allow: /admissions/private/public-faq
Crawl-delay: 4

User-agent: UniMatchPH-ResearchBot
Disallow: /restricted/
Allow: /admissions/
Crawl-delay: 5
`;

  // Bot-specific section overrides wildcard
  const specificAllowed = evaluateRobotsTxt(sampleRobots, "/admissions/undergraduate");
  assert.equal(specificAllowed.allowed, true);
  assert.equal(specificAllowed.crawlDelaySeconds, 5);

  const specificBlocked = evaluateRobotsTxt(sampleRobots, "/restricted/internal");
  assert.equal(specificBlocked.allowed, false);
  assert.match(specificBlocked.matchedRule, /Disallow: \/restricted\//);

  // Wildcard fallback for another bot token
  const wildcardBlocked = evaluateRobotsTxt(sampleRobots, "/admissions/private/draft", "other-bot");
  assert.equal(wildcardBlocked.allowed, false);
  assert.equal(wildcardBlocked.crawlDelaySeconds, 4);

  const wildcardLongerAllow = evaluateRobotsTxt(
    sampleRobots,
    "/admissions/private/public-faq",
    "other-bot",
  );
  assert.equal(wildcardLongerAllow.allowed, true);
});

test("extractHtmlEvidence strips scripts/styles and extracts structured admissions signals", () => {
  const html = `
<!doctype html>
<html>
  <head>
    <style>.fee { color: red; } PHP 999,999</style>
    <script>const secret = "Bachelor of Science in Fake Script";</script>
  </head>
  <body>
    <main>
      <h1>Undergraduate Admissions AY 2025-2026</h1>
      <p>Estimated tuition fee is PHP 85,000 - PHP 98,000 per trimester for incoming freshmen.</p>
      <p>Application deadline is October 15, 2025 for Freshman Term 1.</p>
      <p>Entrance exam coverage: DCAT covers Mathematics, Science, English, and Logic.</p>
      <ul>
        <li>Requirement: Original Form 138 report card and PSA Birth Certificate.</li>
        <li>Bachelor of Science in Computer Science</li>
        <li>Bachelor of Science in Accountancy</li>
      </ul>
      <a href="/apply/freshmen">Apply Online Portal</a>
      <a href="javascript:void(0)">Apply Unsafe</a>
    </main>
  </body>
</html>`;

  const evidence = extractHtmlEvidence(html, "https://www.dlsu.edu.ph/admissions/");
  assert.equal(evidence.tuition_estimates.length, 1);
  assert.equal(evidence.application_deadlines.length, 1);
  assert.equal(evidence.entrance_exam_coverage.length, 1);
  assert.equal(evidence.admission_requirements.length, 1);
  assert.equal(evidence.programs.length, 2);
  assert.equal(
    evidence.programs.some((p) => p.name.includes("Fake Script")),
    false,
    "Script contents must be stripped",
  );
  assert.equal(evidence.application_links.length, 1);
  assert.equal(evidence.application_links[0].url, "https://www.dlsu.edu.ph/apply/freshmen");
});

test("parseCollectorJsonImport structures real DLSU collector snapshot via Algorithm 1", () => {
  const samplePath = path.join(ROOT, "data", "dlsu", "unimatch_ph_raw_data.json");
  const rawJson = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const { draft, audit } = parseCollectorJsonImport(rawJson);

  assert.equal(draft.id, "dlsu-manila");
  assert.equal(draft.name, "De La Salle University");
  assert.ok(draft.programs.length >= 20, "Should extract DLSU degree programs");
  assert.ok(draft.tuitionFees.length >= 1, "Should extract structured tuition fees");
  assert.equal(audit.mode, "json-import");
  assert.equal(audit.status, "completed");

  assert.throws(() => parseCollectorJsonImport([]), /valid university collector object/i);
  assert.throws(() => parseCollectorJsonImport({}), /university_name/i);
});

test("exportBaselineCatalog populates all 15 Metro Manila universities with verified programs, requirements, links, and zero fabricated private tuition", () => {
  const baseline = exportBaselineCatalog();
  assert.equal(baseline.length, 15, "Should export all 15 baseline universities");
  const totalPrograms = baseline.reduce((sum, u) => sum + u.programs.length, 0);
  assert.ok(totalPrograms >= 600, `Expected >= 600 baseline programs across 15 schools, got ${totalPrograms}`);

  for (const u of baseline) {
    assert.ok(/^[a-z0-9-]+$/.test(u.id), `Invalid university id slug: ${u.id}`);
    assert.ok(u.sector === "Public" || u.sector === "Private");
    assert.equal(u.isPublished, true);
    assert.notEqual(u.collectionStatus, "pending", `${u.name} should no longer be empty/pending`);
    assert.ok(u.programs.length >= 15, `${u.name} should have >= 15 verified programs (got ${u.programs.length})`);
    assert.ok(u.admissionRequirements.length >= 3, `${u.name} should have >= 3 verified requirements`);
    assert.ok(u.applicationLinks.length >= 2, `${u.name} should have >= 2 verified official links`);

    if (u.sector === "Public") {
      assert.ok(
        u.tuitionFees.some((f) => f.amountMin === 0 && f.amountMax === 0),
        `Public university ${u.name} should carry verified RA 10931 PHP 0 tuition coverage`,
      );
    } else if (u.id !== "dlsu-manila") {
      assert.equal(
        u.tuitionFees.length,
        0,
        `Private university ${u.name} must not have fabricated default tuition fees`,
      );
    }
  }
});

test("parseProgramCandidate handles PH abbreviations, inline SHS strands, CTA trimming, and rejects graduate noise", () => {
  const stemProg = parseProgramCandidate("BS Civil Engineering (STEM) - Learn More");
  assert.deepEqual(stemProg, {
    name: "BS Civil Engineering",
    strand_alignment: "STEM",
  });

  const dmd = parseProgramCandidate("Doctor of Dental Medicine");
  assert.deepEqual(dmd, {
    name: "Doctor of Dental Medicine",
    strand_alignment: null,
  });

  const abbrev = parseProgramCandidate("BSN", "STEM");
  assert.deepEqual(abbrev, {
    name: "BSN",
    strand_alignment: "STEM",
  });

  assert.equal(parseProgramCandidate("Master of Science in Computer Science"), null);
  assert.equal(parseProgramCandidate("PhD in Education"), null);
  assert.equal(parseProgramCandidate("Diploma in Information Technology"), null);
});

test("extractHtmlEvidence extracts JSON-LD courses, structured tables, heading-scoped requirements, and official PDFs", () => {
  const html = `
<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Course", "name": "Bachelor of Multimedia Arts" },
          {
            "@type": "Event",
            "name": "FEUCAT Application Period",
            "startDate": "2026-01-15",
            "endDate": "2026-03-31"
          }
        ]
      }
    </script>
  </head>
  <body>
    <nav><a href="/home">Home</a></nav>
    <main>
      <h2>Admission Requirements</h2>
      <ul>
        <li>Certified true copy of Grade 11 and Grade 12 report card</li>
        <li>Two recent 2x2 ID photos on white background</li>
      </ul>

      <h2>Undergraduate Degree Programs</h2>
      <table>
        <thead>
          <tr><th>Program</th><th>Recommended Strand</th></tr>
        </thead>
        <tbody>
          <tr><td>BS Computer Science</td><td>STEM</td></tr>
          <tr><td>BS Accountancy</td><td>ABM</td></tr>
        </tbody>
      </table>

      <h2>Tuition and Fees</h2>
      <table>
        <thead>
          <tr><th>Category</th><th>Estimated Tuition</th></tr>
        </thead>
        <tbody>
          <tr><td>Undergraduate</td><td>₱58,000 - ₱72,000 per semester</td></tr>
        </tbody>
      </table>

      <h2>Graduate School</h2>
      <ul>
        <li>Master of Business Administration</li>
      </ul>

      <a href="/files/freshman-tuition-2026.pdf">Tuition &amp; Fees Schedule</a>
    </main>
  </body>
</html>`;

  const evidence = extractHtmlEvidence(html, "https://www.feu.edu.ph/admissions/");
  const names = evidence.programs.map((p) => p.name);
  assert.ok(names.includes("Bachelor of Multimedia Arts"), "Should extract JSON-LD Course");
  assert.ok(names.includes("BS Computer Science"), "Should extract table program");
  assert.ok(names.includes("BS Accountancy"), "Should extract second table program");
  assert.equal(
    names.some((n) => /Master of Business/i.test(n)),
    false,
    "Should skip Graduate School section",
  );

  const cs = evidence.programs.find((p) => p.name === "BS Computer Science");
  assert.equal(cs?.strand_alignment, "STEM");

  assert.ok(
    evidence.admission_requirements.some((r) => String(r.text).includes("2x2 ID photos")),
    "Should capture requirement under Admission Requirements heading",
  );
  assert.ok(
    evidence.tuition_estimates.some(
      (f) => Array.isArray(f.amounts) && (f.amounts as Array<{ min_php: number }>)[0]?.min_php === 58000,
    ),
    "Should parse peso amounts from tuition table",
  );
  assert.ok(
    evidence.application_links.some(
      (l) => l.url.endsWith("/files/freshman-tuition-2026.pdf") && /Official PDF/i.test(l.label),
    ),
    "Should label official PDF documents clearly",
  );
});

test("Algorithm 1 recognizes RA 10931 free public tuition and same-month date ranges", () => {
  const structured = structureRecord({
    university_name: "University of the Philippines Manila",
    campus_location: "Ermita, Manila",
    tuition_estimates: [
      {
        text: "Eligible undergraduate Filipino students enjoy Free Tuition under RA 10931 (Universal Access to Quality Tertiary Education).",
        amounts: [],
        source_url: "https://www.upm.edu.ph/admissions/",
      },
    ],
    application_deadlines: [
      {
        text: "UPCAT application period runs October 1 - 31, 2025 for AY 2026-2027.",
        source_url: "https://www.upm.edu.ph/admissions/",
      },
    ],
  });

  assert.equal(structured.tuition_fees.length, 1);
  assert.equal(structured.tuition_fees[0].amount_min, 0);
  assert.equal(structured.tuition_fees[0].amount_max, 0);
  assert.equal(structured.tuition_fees[0].currency, "PHP");

  const isoDates = structured.application_deadlines.map((d) => d.date_iso);
  assert.ok(isoDates.includes("2025-10-01"));
  assert.ok(isoDates.includes("2025-10-31"));
});

test("discoverOfficialSubpages stays strictly within approved domains and prioritizes missing admissions categories", () => {
  const html = `
    <main>
      <a href="/academics/undergraduate-programs/">Undergraduate Degree Programs</a>
      <a href="/admissions/tuition-and-fees/">Tuition and School Fees</a>
      <a href="/admissions/requirements/">Freshman Requirements</a>
      <a href="/wp-admin/">Admin Login</a>
      <a href="/graduate-school/programs/">Graduate Programs</a>
      <a href="/files/brochure.pdf">PDF Brochure</a>
      <a href="https://evil.com/undergraduate-programs/">External Evil Site</a>
    </main>
  `;
  const found = discoverOfficialSubpages(
    html,
    "https://www.ust.edu.ph/admissions/",
    ["ust.edu.ph"],
    new Set(["https://www.ust.edu.ph/admissions/"]),
    new Set(["programs", "tuition", "requirements"]),
  );

  const urls = found.map((f) => f.url);
  assert.ok(urls.includes("https://www.ust.edu.ph/academics/undergraduate-programs/"));
  assert.ok(urls.includes("https://www.ust.edu.ph/admissions/tuition-and-fees/"));
  assert.ok(urls.includes("https://www.ust.edu.ph/admissions/requirements/"));
  assert.equal(urls.some((u) => u.includes("evil.com")), false);
  assert.equal(urls.some((u) => u.includes("wp-admin")), false);
  assert.equal(urls.some((u) => u.includes("graduate-school")), false);
  assert.equal(urls.some((u) => u.endsWith(".pdf")), false);
});

test("config/universities.json configures >=2 approved official .edu.ph pages per university", () => {
  const cfg = getCollectorConfig();
  assert.equal(cfg.maxPagesPerRun, 12, "Politeness cap should be 12 pages per run");
  assert.equal(cfg.targets.length, 15, "All 15 Metro Manila universities should be configured");

  for (const target of cfg.targets) {
    assert.ok(
      target.pages.length >= 2,
      `${target.name} should have at least 2 pre-filled official pages (got ${target.pages.length})`,
    );
    for (const page of target.pages) {
      assert.ok(
        page.label && page.label.trim().length > 0,
        `${target.name} page ${page.url} must have a human-readable label`,
      );
      // Must pass both school-specific and global approved domain checks
      validateApprovedUrl(page.url, target.approvedDomains);
      validateApprovedUrl(page.url, cfg.approvedDomains);
    }
  }
});

test("Algorithm 1 flags cross-page disagreements on tuition, deadlines, and academic year while keeping higher-priority official pages", () => {
  const officialTuitionUrl = "https://www.dlsu.edu.ph/admissions/undergraduate/tuition-and-fees/";
  const secondaryPageUrl = "https://www.dlsu.edu.ph/colleges/ccs/faq/";
  const sourcePriority: Record<string, number> = {
    [officialTuitionUrl]: 0,
    [secondaryPageUrl]: 25,
  };

  const structured = structureRecord(
    {
      university_name: "De La Salle University",
      campus_location: "Taft Avenue, Manila",
      tuition_estimates: [
        {
          text: "Estimated undergraduate tuition is PHP 70,000 per trimester (AY 2025-2026).",
          amounts: [{ min_php: 70000, max_php: 70000 }],
          source_url: secondaryPageUrl,
        },
        {
          text: "Undergraduate tuition is PHP 88,000 - PHP 98,000 per trimester for AY 2026-2027.",
          amounts: [{ min_php: 88000, max_php: 98000 }],
          source_url: officialTuitionUrl,
        },
      ],
      application_deadlines: [
        {
          text: "Freshman Application Deadline: October 15, 2026.",
          source_url: officialTuitionUrl,
        },
        {
          text: "Freshman Application Deadline: November 30, 2026.",
          source_url: secondaryPageUrl,
        },
      ],
    },
    sourcePriority,
  );

  // Academic year conflict flagged
  const ayConflict = structured.conflicts.find((c) => c.field === "academic_year");
  assert.ok(ayConflict, "Should flag multiple academic years across official pages");
  assert.equal(ayConflict.kept_value, "2026-2027");

  // Tuition conflict flagged and higher-priority page wins
  const tuitionConflict = structured.conflicts.find((c) => c.field === "tuition_fees");
  assert.ok(tuitionConflict, "Should flag differing tuition amounts across pages");
  assert.match(tuitionConflict.kept_value, /88,000/);
  assert.match(tuitionConflict.discarded_value, /70,000/);
  assert.equal(structured.tuition_fees[0].amount_min, 88000);

  // Deadline conflict flagged and higher-priority page wins
  const deadlineConflict = structured.conflicts.find((c) => c.field === "application_deadlines");
  assert.ok(deadlineConflict, "Should flag differing deadline dates for the same milestone");
  assert.match(deadlineConflict.kept_value, /2026-10-15/);
  assert.match(deadlineConflict.discarded_value, /2026-11-30/);
  assert.equal(structured.application_deadlines[0].date_iso, "2026-10-15");
});

test("buildCollectorUrlQueue validates official .edu.ph domains, deduplicates URLs, and enforces the 12-page cap", async () => {
  const { buildCollectorUrlQueue } = await import("./algorithms/collectorUrlQueue.js");

  const validRun = buildCollectorUrlQueue(
    [
      "https://www.dlsu.edu.ph/admissions/undergraduate/",
      "https://www.dlsu.edu.ph/admissions/undergraduate/degree-programs/",
    ],
    [
      "https://www.dlsu.edu.ph/colleges/ccs/undergraduate-degree-programs/",
      "https://www.dlsu.edu.ph/admissions/undergraduate/",
      "",
    ].join("\n"),
    ["dlsu.edu.ph"],
    12,
  );
  assert.equal(validRun.canRun, true);
  assert.equal(validRun.queuedUrls.length, 3);
  assert.equal(validRun.checkedCount, 2);
  assert.equal(validRun.pastedValidCount, 1);
  assert.equal(validRun.duplicateCount, 1);
  assert.equal(validRun.invalidLines.length, 0);

  const invalidRun = buildCollectorUrlQueue(
    ["https://www.dlsu.edu.ph/admissions/undergraduate/"],
    [
      "http://www.dlsu.edu.ph/insecure",
      "https://edukasyon.ph/schools/dlsu",
      "https://www.ust.edu.ph/admissions/",
    ].join("\n"),
    ["dlsu.edu.ph"],
    12,
  );
  assert.equal(invalidRun.canRun, false);
  assert.equal(invalidRun.invalidLines.length, 3);

  const overCap = buildCollectorUrlQueue(
    Array.from({ length: 13 }, (_, i) => `https://www.dlsu.edu.ph/page-${i}`),
    "",
    ["dlsu.edu.ph"],
    12,
  );
  assert.equal(overCap.exceedsMax, true);
  assert.equal(overCap.canRun, false);
});

test("mergeLiveAndBaselineCatalog fills legacy empty Firestore placeholders and stale notes while preserving verified or populated admin records", () => {
  const baseline = exportBaselineCatalog();
  const upBaseline = baseline.find((u) => u.id === "up-manila")!;
  const ustBaseline = baseline.find((u) => u.id === "ust-manila")!;
  const feuBaseline = baseline.find((u) => u.id === "feu-manila")!;

  const stalePlaceholder = {
    ...upBaseline,
    collectionStatus: "pending" as const,
    programs: [],
    admissionRequirements: [],
    entranceExaminations: [],
    tuitionFees: [],
    applicationLinks: [],
    sourceUrls: [],
    sourceNotes: ["Only the official admissions page is configured; programs and fees are shown as not available."],
  };

  const sparseUnverified = {
    ...feuBaseline,
    collectionStatus: "partial" as const,
    programs: [
      {
        id: "noise-1",
        name: "BSBA students win contest",
        topic: "Business",
        strandAlignment: "",
        sourceUrl: "https://www.feu.edu.ph/",
      },
    ],
  };

  const verifiedAdminDoc = {
    ...ustBaseline,
    collectionStatus: "verified" as const,
    programs: [
      {
        id: "ust-custom",
        name: "BS Custom Admin Verified Program",
        topic: "Computing",
        strandAlignment: "STEM",
        sourceUrl: "https://www.ust.edu.ph/academics/programs/",
      },
    ],
    tuitionFees: [],
  };

  const merged = mergeLiveAndBaselineCatalog(
    [stalePlaceholder, sparseUnverified, verifiedAdminDoc],
    baseline,
  );
  assert.equal(merged.length, 15, "All 15 universities should remain present");

  const upMerged = merged.find((u) => u.id === "up-manila")!;
  assert.equal(upMerged.collectionStatus, "partial", "Pending placeholder should upgrade to partial");
  assert.equal(upMerged.programs.length, upBaseline.programs.length, "Empty programs should inherit baseline");
  assert.equal(upMerged.tuitionFees.length, 1, "Empty fees should inherit RA 10931 baseline");
  assert.equal(
    upMerged.sourceNotes.some((n) => /programs and fees are shown as not available/i.test(n)),
    false,
    "Stale pending placeholder note must be replaced by verified baseline notes",
  );

  const feuMerged = merged.find((u) => u.id === "feu-manila")!;
  assert.equal(
    feuMerged.programs.length,
    feuBaseline.programs.length,
    "Sparse (<5 programs) unverified pre-baseline doc should upgrade to verified baseline programs",
  );

  const ustMerged = merged.find((u) => u.id === "ust-manila")!;
  assert.equal(ustMerged.collectionStatus, "verified", "Verified status must be preserved");
  assert.equal(ustMerged.programs.length, 1, "Verified admin programs must not be overwritten");
  assert.equal(ustMerged.programs[0].name, "BS Custom Admin Verified Program");
});
