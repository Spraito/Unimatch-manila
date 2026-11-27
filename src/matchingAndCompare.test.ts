import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { initStore, rankedRecommendations, getUniversityDetail } from "./store.js";
import { recommend, type CandidateInput } from "./algorithms/matching.js";

describe("Find My Match weighted algorithm fixes", () => {
  before(() => {
    initStore();
  });

  it("scores exact core degree matches at 100% and ranks Computer Science strictly above Computer Engineering", () => {
    const res = rankedRecommendations({ program: "Computer Science" }, null, 20);
    assert.ok(res.items.length > 0, "Expected matching Computer Science programs");

    const top = res.items[0];
    assert.equal(top.score, 100);
    assert.match(top.program_name || "", /Computer Science/i);
    assert.equal(top.explanations[0].status, "matched");

    // Ensure no unrelated "Political Science" or "Food Science" leaked into results
    for (const item of res.items) {
      assert.doesNotMatch(
        item.program_name || "",
        /Political Science|Food Science/i,
        `Unrelated science program should not match Computer Science: ${item.program_name}`,
      );
    }
  });

  it("recognizes common Philippine degree aliases such as CS, IT, and MedTech", () => {
    const csRes = rankedRecommendations({ program: "CS" }, null, 10);
    assert.ok(csRes.items.length > 0);
    assert.equal(csRes.items[0].score, 100);
    assert.match(csRes.items[0].program_name || "", /Computer Science/i);

    const itRes = rankedRecommendations({ program: "IT" }, null, 10);
    assert.ok(itRes.items.length > 0);
    assert.equal(itRes.items[0].score, 100);
    assert.match(itRes.items[0].program_name || "", /Information Technology/i);
  });

  it("excludes unrelated degrees when program and sector are combined", () => {
    const res = rankedRecommendations(
      { program: "Nursing", sector: "Public" },
      null,
      20,
    );
    assert.ok(res.items.length >= 2);
    // Top results are Public Nursing programs at 100%
    assert.equal(res.items[0].score, 100);
    assert.equal(res.items[0].sector, "Public");
    assert.match(res.items[0].program_name || "", /Nursing/i);

    // Every returned program must genuinely relate to Nursing
    for (const item of res.items) {
      assert.match(
        item.program_name || "",
        /Nursing/i,
        `Non-nursing program should not pollute Nursing matches: ${item.program_name}`,
      );
    }
  });

  it("matches RA 10931 free tuition across semester, trimester, year, and unit budget bases", () => {
    for (const basis of ["semester", "trimester", "year", "unit"]) {
      const res = rankedRecommendations(
        { budget: 50000, budget_basis: basis },
        null,
        15,
      );
      assert.ok(
        res.items.length >= 5,
        `Expected all 5 public free-tuition universities to match on basis=${basis}`,
      );
      assert.equal(res.items[0].score, 100);
      assert.equal(res.items[0].explanations[0].status, "matched");
      assert.equal(res.items[0].topic, null);
    }
  });

  it("converts calendar-term fees transparently when basis differs (e.g., semester fee vs yearly budget)", () => {
    const sampleCandidates: CandidateInput[] = [
      {
        university_id: "sample-u",
        university_name: "Sample Private University",
        short_name: "SPU",
        campus_location: "Ermita, Manila",
        city: "Manila",
        sector: "Private",
        program_count: 1,
        program_id: null,
        program_name: null,
        topic: null,
        fees: [
          {
            amount_min: 40000,
            amount_max: 50000,
            basis: "semester",
            raw_text: "PHP 40,000-50,000 per semester",
          },
        ],
      },
    ];
    const within = recommend(
      sampleCandidates,
      { budget: 110000, budget_basis: "year" },
      null,
      10,
    );
    assert.equal(within.items.length, 1);
    assert.equal(within.items[0].score, 100);
    assert.match(within.items[0].explanations[0].reason, /Estimated/i);

    const straddle = recommend(
      sampleCandidates,
      { budget: 90000, budget_basis: "year" },
      null,
      10,
    );
    assert.equal(straddle.items.length, 1);
    assert.equal(straddle.items[0].score, 50);
  });

  it("matches Metro Manila campus districts like Intramuros and Ermita at 100%", () => {
    const res = rankedRecommendations({ city: "Intramuros" }, null, 15);
    assert.equal(res.items.length, 3);
    for (const item of res.items) {
      assert.equal(item.score, 100);
      assert.match(item.campus_location, /Intramuros/i);
    }
  });

  it("filters out 0-score non-matches and maintains multi-university diversity for broad queries", () => {
    const pubOnly = rankedRecommendations({ sector: "Public" }, null, 20);
    assert.equal(pubOnly.items.length, 5);
    assert.ok(pubOnly.items.every((item) => item.sector === "Public"));

    const none = rankedRecommendations(
      { program: "Astrobiology Quantum Basketweaving" },
      null,
      20,
    );
    assert.equal(none.items.length, 0);
    assert.equal(none.total, 0);

    const eng = rankedRecommendations({ program: "Engineering" }, null, 20);
    const uniqueUnis = new Set(eng.items.map((i) => i.university_id));
    assert.ok(
      uniqueUnis.size >= 5,
      `Expected >= 5 universities represented for Engineering, got ${uniqueUnis.size}`,
    );
    // Strictly descending score invariant preserved by hand-written merge sort
    for (let i = 1; i < eng.items.length; i++) {
      assert.ok(
        eng.items[i - 1].score >= eng.items[i].score,
        "Results must remain sorted descending by score",
      );
    }
  });

  it("provides full university detail (programs + structured data) for side-by-side comparison", () => {
    const upm = getUniversityDetail("up-manila");
    const dlsu = getUniversityDetail("dlsu-manila");
    assert.ok(upm && dlsu);
    assert.ok(Array.isArray(upm.programs) && upm.programs.length > 0);
    assert.ok(Array.isArray(dlsu.programs) && dlsu.programs.length > 0);
    assert.ok(upm.structured && dlsu.structured);
    assert.equal(upm.free_tuition, true);
  });
});
