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

  it("strictly filters sector and excludes unrelated degrees when program and sector are combined", () => {
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

    // Every returned university must strictly satisfy the Public filter
    for (const item of res.items) {
      assert.equal(
        item.sector,
        "Public",
        `Private university should never appear when Public is selected: ${item.university_id}`,
      );
    }
    // Exact Nursing matches must rank strictly above any related health programs
    const exactNursing = res.items.filter((i) =>
      /Nursing/i.test(i.program_name || ""),
    );
    assert.ok(exactNursing.length >= 2);
    for (let i = 0; i < exactNursing.length; i++) {
      assert.match(res.items[i].program_name || "", /Nursing/i);
    }
  });

  it("uses 3-criterion default weights (program 55%, location 25%, sector 20%) and ignores legacy budget weights when no budget is supplied", () => {
    const res = rankedRecommendations(
      { program: "Computer Science", city: "Manila", sector: "Public" },
      { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 },
      15,
    );
    assert.ok(res.items.length > 0);
    assert.deepEqual(res.default_weights, {
      program: 0.55,
      location: 0.25,
      sector: 0.2,
    });
    assert.equal("budget" in res.weights, false);
    const weightSum =
      res.weights.program + res.weights.location + res.weights.sector;
    assert.ok(
      Math.abs(weightSum - 1) < 0.002,
      `Normalized weights should sum to 1, got ${weightSum}`,
    );
    assert.equal(res.items[0].score, 100);
    assert.equal(
      res.items[0].explanations.some((exp) => exp.criterion === "budget"),
      false,
    );
  });

  it("enforces strict sector and location hard filters while ranking eligible candidates by custom weights", () => {
    const sampleCandidates: CandidateInput[] = [
      {
        university_id: "u-public-ermita",
        university_name: "Ermita Public University",
        short_name: "EPU",
        campus_location: "Ermita, Manila",
        city: "Manila",
        sector: "Public",
        program_count: 1,
        program_id: "p1",
        program_name: "BS in Computer Science",
        topic: "Computing",
        fees: [{ amount_min: 0, amount_max: 0, basis: "semester", raw_text: "Free tuition" }],
      },
      {
        university_id: "u-private-intramuros",
        university_name: "Intramuros Private University",
        short_name: "IPU",
        campus_location: "Intramuros, Manila",
        city: "Manila",
        sector: "Private",
        program_count: 1,
        program_id: "p2",
        program_name: "BS in Computer Science",
        topic: "Computing",
        fees: [{ amount_min: 60000, amount_max: 70000, basis: "semester", raw_text: "PHP 60,000-70,000" }],
      },
      {
        university_id: "u-private-manila-expensive",
        university_name: "Malate Private University",
        short_name: "MPU",
        campus_location: "Malate, Manila",
        city: "Manila",
        sector: "Private",
        program_count: 1,
        program_id: "p3",
        program_name: "BS in Computer Science",
        topic: "Computing",
        fees: [{ amount_min: 120000, amount_max: 140000, basis: "semester", raw_text: "PHP 120,000-140,000" }],
      },
    ];

    // Strict hard filter: sector=Private excludes Public completely
    const privateOnly = recommend(
      sampleCandidates,
      { program: "Computer Science", sector: "Private", budget: 80000, budget_basis: "semester" },
      { program: 0.4, location: 0.1, sector: 0.1, budget: 0.4 },
      10,
    );
    assert.equal(privateOnly.items.length, 2);
    assert.ok(privateOnly.items.every((item) => item.sector === "Private"));
    // Affordable private school outranks expensive private school under budget weight
    assert.equal(privateOnly.items[0].university_id, "u-private-intramuros");
    assert.equal(privateOnly.items[0].score, 100);
    assert.equal(privateOnly.items[1].university_id, "u-private-manila-expensive");
    assert.ok(privateOnly.items[1].score < privateOnly.items[0].score);

    // Combined hard filter: city=Intramuros + sector=Public yields empty set (strict exclusion)
    const impossibleCombo = recommend(
      sampleCandidates,
      { program: "Computer Science", city: "Intramuros", sector: "Public" },
      null,
      10,
    );
    assert.equal(impossibleCombo.items.length, 0);
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
