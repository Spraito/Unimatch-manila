/**
 * Comprehensive audit & verification tests for UniMatch PH's:
 *   1. Hybrid Academic Program Search & Relevance Ranking (programSearch.ts)
 *   2. Strict Hard-Constraint University Filtering (universityFilter.ts)
 *   3. Transparent, Mathematically Exact Recommendation Scoring (matching.ts)
 *   4. Backend & Client Live-Catalog Parity + System Integration
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  deduplicatePrograms,
  evaluateProgramMatch,
  searchAndRankPrograms,
} from "./algorithms/programSearch.js";
import {
  applyUniversityHardFilters,
  parseSectorFilter,
} from "./algorithms/universityFilter.js";
import { recommend, type CandidateInput } from "./algorithms/matching.js";
import {
  getUniversityDetail,
  initStore,
  queryPrograms,
  queryUniversities,
  rankedRecommendations,
} from "./store.js";
import {
  searchCatalogPrograms,
  searchCatalogUniversities,
} from "./algorithms/catalogQuery.js";
import {
  initCatalogStoreFromBaseline,
  listPublishedCatalogUniversities,
} from "./catalogStore.js";

describe("1. Hybrid Program Search Relevance & Ranking", () => {
  before(() => {
    initStore();
  });

  it("ranks exact Computer Science matches above specializations and strictly above Computer Engineering & IT", () => {
    const res = queryPrograms("Computer Science", "", "", 1, 50);
    assert.ok(res.items.length > 0, "Expected Computer Science search results");

    const firstExact = res.items[0];
    assert.equal(firstExact.match_category, "Exact Match");
    assert.match(firstExact.name, /Computer Science/i);

    let lastExactIdx = -1;
    for (let i = res.items.length - 1; i >= 0; i--) {
      if (res.items[i].match_category === "Exact Match") {
        lastExactIdx = i;
        break;
      }
    }
    const firstSpecIdx = res.items.findIndex(
      (p) =>
        p.match_category === "Very Close Match" &&
        /Computer Science/i.test(p.name),
    );
    const firstRelatedIdx = res.items.findIndex(
      (p) => p.match_category === "Related Match",
    );
    const firstCpeIdx = res.items.findIndex((p) =>
      /Computer Engineering/i.test(p.name),
    );

    assert.ok(lastExactIdx >= 0, "Expected Exact Match Computer Science programs");
    if (firstSpecIdx >= 0) {
      assert.ok(
        lastExactIdx < firstSpecIdx,
        `All Exact Match CS programs (last=${lastExactIdx}) must outrank specializations (first=${firstSpecIdx})`,
      );
    }
    assert.ok(firstRelatedIdx > lastExactIdx, "Related programs must appear strictly after Exact Matches");
    assert.ok(
      firstCpeIdx === -1 || firstCpeIdx > lastExactIdx,
      "Computer Engineering must NEVER outrank Computer Science",
    );
    if (firstSpecIdx >= 0 && firstCpeIdx >= 0) {
      assert.ok(
        firstCpeIdx > firstSpecIdx,
        "Computer Engineering must rank below CS specializations",
      );
    }

    // No irrelevant broad-category or generic-word noise
    for (const item of res.items) {
      assert.doesNotMatch(
        item.name,
        /Political Science|Food Science|Medical Technology|Nursing|Civil Engineering/i,
        `Irrelevant program leaked into Computer Science search: ${item.name}`,
      );
    }
  });

  it("distinguishes exact academic degrees: Computer Engineering, Information Technology, Information Systems, Data Science", () => {
    const cases: Array<{ query: string; expectedExactRe: RegExp; excludedNoiseRe: RegExp }> = [
      {
        query: "Computer Engineering",
        expectedExactRe: /Computer Engineering/i,
        excludedNoiseRe: /Civil Engineering|Chemical Engineering/i,
      },
      {
        query: "Information Technology",
        expectedExactRe: /Information Technology/i,
        excludedNoiseRe: /Medical Technology|Chemical Process Technology|Library and Information Science/i,
      },
      {
        query: "Information Systems",
        expectedExactRe: /Information Systems/i,
        excludedNoiseRe: /Medical Technology|Civil Engineering/i,
      },
      {
        query: "Data Science",
        expectedExactRe: /Data Science/i,
        excludedNoiseRe: /Political Science|Food Science/i,
      },
    ];

    for (const tc of cases) {
      const res = queryPrograms(tc.query, "", "", 1, 40);
      assert.ok(res.items.length > 0, `Expected results for ${tc.query}`);
      assert.equal(
        res.items[0].match_category,
        "Exact Match",
        `Top result for '${tc.query}' should be Exact Match, got ${res.items[0].match_category} (${res.items[0].name})`,
      );
      assert.match(res.items[0].name, tc.expectedExactRe);

      // Verify strict tier monotonicity across all results
      for (let i = 1; i < res.items.length; i++) {
        assert.ok(
          (res.items[i - 1].match_tier ?? 99) <= (res.items[i].match_tier ?? 99),
          `Match tier order violated for '${tc.query}' at index ${i}`,
        );
      }

      for (const item of res.items) {
        assert.doesNotMatch(
          item.name,
          tc.excludedNoiseRe,
          `Irrelevant program '${item.name}' should not match '${tc.query}'`,
        );
      }
    }
  });

  it("recognizes degree abbreviations, prefixes, punctuation, capitalization, spacing, and word-order variations", () => {
    const aliasChecks: Array<[string, RegExp]> = [
      ["BSCS", /Computer Science/i],
      ["CS", /Computer Science/i],
      ["BSIT", /Information Technology/i],
      ["IT", /Information Technology/i],
      ["BSCpE", /Computer Engineering/i],
      ["CpE", /Computer Engineering/i],
      ["BSIS", /Information Systems/i],
      ["IS", /Information Systems/i],
      ["DS", /Data Science/i],
      ["BS Computer Science", /Computer Science/i],
      ["Bachelor of Science in Computer Science", /Computer Science/i],
      ["B.S. Computer Science", /Computer Science/i],
      ["Computer Science Degree", /Computer Science/i],
      ["   cOmPuTeR    sCiEnCe  ", /Computer Science/i],
    ];

    for (const [q, re] of aliasChecks) {
      const res = queryPrograms(q, "", "", 1, 10);
      assert.ok(res.items.length > 0, `Expected matches for '${q}'`);
      assert.equal(
        res.items[0].match_category,
        "Exact Match",
        `Expected Exact Match for '${q}', got ${res.items[0].match_category} (${res.items[0].name})`,
      );
      assert.match(res.items[0].name, re, `Top match for '${q}' was '${res.items[0].name}'`);
    }

    // Word-order variation ("Science Computer") still matches Computer Science
    const swapped = queryPrograms("Science Computer", "", "", 1, 10);
    assert.ok(swapped.items.length > 0);
    assert.match(swapped.items[0].name, /Computer Science/i);
  });

  it("handles minor spelling mistakes (typos) without losing accuracy", () => {
    const typoCases: Array<[string, RegExp]> = [
      ["Computr Scince", /Computer Science/i],
      ["Informtion Techology", /Information Technology/i],
      ["Comuter Enginering", /Computer Engineering/i],
      ["Psycholgy", /Psychology/i],
    ];
    for (const [typo, expectedRe] of typoCases) {
      const res = queryPrograms(typo, "", "", 1, 10);
      assert.ok(res.items.length > 0, `Expected typo-tolerant matches for '${typo}'`);
      assert.match(
        res.items[0].name,
        expectedRe,
        `Typo query '${typo}' matched '${res.items[0].name}' instead of ${expectedRe}`,
      );
    }
  });

  it("deduplicates duplicate programs per university while preserving official names verbatim", () => {
    const sample = [
      {
        id: "p1",
        university_id: "dlsu-manila",
        university_name: "De La Salle University",
        short_name: "DLSU",
        name: "Bachelor of Science in Information Technology",
        topic: "Computing",
      },
      {
        id: "p2",
        university_id: "dlsu-manila",
        university_name: "De La Salle University",
        short_name: "DLSU",
        name: "  Bachelor of Science in Information Technology  ",
        topic: "Computing",
      },
      {
        id: "p3",
        university_id: "ust-manila",
        university_name: "University of Santo Tomas",
        short_name: "UST",
        name: "Bachelor of Science in Information Technology",
        topic: "Computing",
      },
    ];
    const deduped = deduplicatePrograms(sample);
    assert.equal(deduped.length, 2, "Duplicate entry within same university must be removed");
    assert.equal(deduped[0].name, "Bachelor of Science in Information Technology");

    const ranked = searchAndRankPrograms(sample, "BSIT");
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].item.name, "Bachelor of Science in Information Technology");
  });

  it("treats parenthetical abbreviations/delivery-mode annotations as Exact Match while distinguishing cross-degree specializations", () => {
    const cbl = evaluateProgramMatch(
      "Bachelor of Science in Information Technology",
      "Bachelor of Science in Information Technology (Challenge-Based Learning)",
      "Computing",
    );
    const pupBsit = evaluateProgramMatch(
      "Bachelor of Science in Information Technology",
      "Bachelor of Science in Information Technology (BSIT)",
      "Computing",
    );
    const ieWithIt = evaluateProgramMatch(
      "Bachelor of Science in Information Technology",
      "Bachelor of Science in Industrial Engineering with specialization in Information Technology",
      "Computing",
    );

    assert.ok(cbl && pupBsit && ieWithIt);
    assert.equal(cbl.category, "Exact Match");
    assert.equal(cbl.programPoints, 1);
    assert.equal(pupBsit.category, "Exact Match");
    assert.equal(pupBsit.programPoints, 1);
    assert.equal(ieWithIt.category, "Very Close Match");
    assert.ok(ieWithIt.tier > cbl.tier, "IE with IT specialization must rank below exact BSIT");
    assert.ok(ieWithIt.programPoints < 1, "IE with IT specialization must not score 100% as exact BSIT");
  });
});

describe("2. Strict Hard-Constraint University Filtering", () => {
  before(() => {
    initStore();
  });

  it("strictly excludes Public universities when Private is selected (Explore, Programs, and Recommendations)", () => {
    // Explore universities
    const privateUnis = queryUniversities("", "", "Private", "featured");
    assert.equal(privateUnis.length, 10);
    assert.ok(privateUnis.every((u) => u.sector === "Private"));

    // Degree programs with Private filter
    const privateProgs = queryPrograms("Computer Science", "", "", 1, 50, "Private");
    assert.ok(privateProgs.items.length > 0);
    assert.ok(privateProgs.items.every((p) => p.sector === "Private"));

    // Recommendations with Private filter — previously leaked Public universities!
    const privateRecs = rankedRecommendations(
      { program: "Computer Science", sector: "Private" },
      null,
      50,
    );
    assert.ok(privateRecs.items.length > 0);
    assert.ok(
      privateRecs.items.every((item) => item.sector === "Private"),
      `Public university leaked into Private recommendations: ${privateRecs.items.filter((i) => i.sector !== "Private").map((i) => i.university_id).join(", ")}`,
    );
    assert.ok(privateRecs.excluded_by_filters > 0);
  });

  it("strictly excludes Private universities when Public is selected", () => {
    const publicUnis = queryUniversities("", "", "Public", "featured");
    assert.equal(publicUnis.length, 5);
    assert.ok(publicUnis.every((u) => u.sector === "Public"));

    const publicRecs = rankedRecommendations(
      { program: "Computer Science", sector: "Public" },
      null,
      50,
    );
    assert.ok(publicRecs.items.length > 0);
    assert.ok(publicRecs.items.every((item) => item.sector === "Public"));
  });

  it("allows both Public and Private when both are selected or no filter is selected", () => {
    const bothUnis = queryUniversities("", "", "Public,Private", "featured");
    const allUnis = queryUniversities("", "", "", "featured");
    assert.equal(bothUnis.length, 15);
    assert.equal(allUnis.length, 15);

    const bothRecs = rankedRecommendations(
      { program: "Computer Science", sector: "Public,Private" },
      null,
      50,
    );
    const sectors = new Set(bothRecs.items.map((i) => i.sector));
    assert.ok(sectors.has("Public") && sectors.has("Private"));
    assert.deepEqual(parseSectorFilter(["public", "PRIVATE"]), ["Public", "Private"]);
  });

  it("strictly enforces combined program + location + sector filters and handles empty results cleanly", () => {
    // Intramuros Private Computer Science -> LPU Manila (and Mapua CpE as related)
    const intraPriv = rankedRecommendations(
      { program: "Computer Science", city: "Intramuros", sector: "Private" },
      null,
      20,
    );
    assert.ok(intraPriv.items.length > 0);
    for (const item of intraPriv.items) {
      assert.equal(item.sector, "Private");
      assert.match(item.campus_location, /Intramuros/i);
    }

    // Sta. Mesa + Private -> 0 universities (only PUP is in Sta. Mesa and PUP is Public)
    const emptyCombo = rankedRecommendations(
      { program: "Computer Science", city: "Sta. Mesa", sector: "Private" },
      null,
      20,
    );
    assert.equal(emptyCombo.items.length, 0);
    assert.equal(emptyCombo.total, 0);

    // Clearing filters restores all universities
    const restored = queryUniversities("", "", "", "featured");
    assert.equal(restored.length, 15);
  });

  it("rejects invalid sector values cleanly", () => {
    assert.throws(
      () => applyUniversityHardFilters([], { sector: "SemiPrivate" }),
      /Sector must be Public or Private/i,
    );
  });
});

describe("3. Recommendation Scoring Accuracy, DLSU BSIT Fix & Missing Data Handling", () => {
  before(() => {
    initStore();
  });

  it("scores DLSU exact BS Information Technology at 100% (fixes the 92.5 anomaly) with transparent breakdown", () => {
    // Scenario A: program + Private (exact scenario that previously scored 92.5)
    const resA = rankedRecommendations(
      {
        program: "Bachelor of Science in Information Technology",
        sector: "Private",
      },
      null,
      30,
    );
    const dlsuItemsA = resA.items.filter((i) => i.university_id === "dlsu-manila");
    assert.ok(dlsuItemsA.length > 0, "Expected DLSU in Private BSIT recommendations");

    const dlsuExact = dlsuItemsA.find(
      (i) => i.program_name === "Bachelor of Science in Information Technology",
    );
    assert.ok(dlsuExact, "Expected DLSU exact BSIT program");
    assert.equal(dlsuExact.score, 100, `Expected DLSU exact BSIT to score 100, got ${dlsuExact.score}`);
    assert.equal(dlsuExact.search_match?.category, "Exact Match");

    const dlsuCbl = dlsuItemsA.find(
      (i) =>
        i.program_name ===
        "Bachelor of Science in Information Technology (Challenge-Based Learning)",
    );
    assert.ok(dlsuCbl, "Expected DLSU BSIT (Challenge-Based Learning)");
    assert.equal(dlsuCbl.score, 100, `Expected DLSU BSIT (CBL) to score 100, got ${dlsuCbl.score}`);
    assert.equal(dlsuCbl.search_match?.category, "Exact Match");

    // Scenario B: program + Private + Budget (missing private tuition MUST NOT penalize DLSU!)
    const resB = rankedRecommendations(
      {
        program: "Bachelor of Science in Information Technology",
        sector: "Private",
        budget: 80000,
        budget_basis: "semester",
      },
      null,
      30,
    );
    const dlsuExactB = resB.items.find(
      (i) =>
        i.university_id === "dlsu-manila" &&
        i.program_name === "Bachelor of Science in Information Technology",
    );
    assert.ok(dlsuExactB);
    assert.equal(
      dlsuExactB.score,
      100,
      "Unavailable private tuition must NOT be penalized as 0% mismatch",
    );
    const budgetExp = dlsuExactB.explanations.find((e) => e.criterion === "budget");
    assert.ok(budgetExp, "Expected transparent budget explanation");
    assert.equal(budgetExp.status, "unavailable");
    assert.equal(budgetExp.status_label, "Information Unavailable");
    assert.equal(budgetExp.points, null);
    assert.equal(budgetExp.effective_weight, 0);
  });

  it("maintains exact mathematical consistency between weights, points, and final scores", () => {
    const res = rankedRecommendations(
      {
        program: "Computer Science",
        city: "Manila",
        sector: "Public,Private",
        budget: 50000,
        budget_basis: "semester",
      },
      { program: 0.5, location: 0.2, sector: 0.1, budget: 0.2 },
      30,
    );
    assert.ok(res.items.length > 0);
    for (const item of res.items) {
      const evaluated = item.explanations.filter(
        (e) =>
          e.status !== "unavailable" &&
          e.status !== "not_applicable" &&
          e.points !== null,
      );
      const effSum = evaluated.reduce((s, e) => s + e.effective_weight, 0);
      assert.ok(
        Math.abs(effSum - 1) < 0.005,
        `Effective weights must sum to 1 for ${item.university_id}/${item.program_name}, got ${effSum}`,
      );
      const recomputed =
        Math.round(
          evaluated.reduce(
            (s, e) => s + e.effective_weight * (e.points ?? 0) * 100,
            0,
          ) * 10,
        ) / 10;
      assert.ok(
        Math.abs(recomputed - item.score) <= 0.2,
        `Score mismatch for ${item.university_id}: reported ${item.score}, recomputed ${recomputed}`,
      );
    }
  });

  it("prevents a Related Match with higher preference score from outranking an Exact Match", () => {
    const candidates: CandidateInput[] = [
      {
        university_id: "u-exact-cs-expensive",
        university_name: "Alpha University",
        short_name: "AU",
        campus_location: "Malate, Manila",
        city: "Manila",
        sector: "Private",
        program_count: 1,
        program_id: "p1",
        program_name: "Bachelor of Science in Computer Science",
        topic: "Computing",
        fees: [{ amount_min: 150000, amount_max: 160000, basis: "semester", raw_text: "PHP 150k" }],
      },
      {
        university_id: "u-related-cpe-free",
        university_name: "Beta University",
        short_name: "BU",
        campus_location: "Malate, Manila",
        city: "Manila",
        sector: "Public",
        program_count: 1,
        program_id: "p2",
        program_name: "Bachelor of Science in Computer Engineering",
        topic: "Computing",
        fees: [{ amount_min: 0, amount_max: 0, basis: "semester", raw_text: "Free tuition" }],
      },
    ];
    const res = recommend(
      candidates,
      { program: "Computer Science", budget: 20000, budget_basis: "semester" },
      { program: 0.4, location: 0.1, sector: 0.1, budget: 0.4 },
      10,
    );
    assert.equal(res.items.length, 2);
    assert.equal(res.items[0].university_id, "u-exact-cs-expensive");
    assert.equal(res.items[0].search_match?.category, "Exact Match");
    assert.equal(res.items[1].university_id, "u-related-cpe-free");
    assert.equal(res.items[1].search_match?.category, "Related Match");
  });
});

describe("4. Backend & Client Live-Catalog Parity + Integration Check", () => {
  before(() => {
    initStore();
    initCatalogStoreFromBaseline();
  });

  it("produces identical results between store queries and shared catalogQuery/recommend over published baseline records", () => {
    const baseline = listPublishedCatalogUniversities();
    const mappedSchools = baseline.map((u) => ({
      id: u.id,
      name: u.name,
      short_name: u.shortName,
      city: u.city,
      campus_location: u.campusLocation,
      sector: u.sector,
      program_count: u.programs.length,
      exam_summary: u.entranceExaminations[0]?.examName || null,
    }));
    const programsById = new Map(
      baseline.map((u) => [
        u.id,
        u.programs.map((p) => ({
          id: p.id,
          university_id: u.id,
          university_name: u.name,
          short_name: u.shortName,
          city: u.city,
          campus_location: u.campusLocation,
          sector: u.sector,
          color: u.color,
          name: p.name,
          topic: p.topic,
        })),
      ]),
    );

    // University search + Private hard filter parity
    const serverUnis = queryUniversities("Computer Science", "", "Private", "featured");
    const clientUnis = searchCatalogUniversities(
      mappedSchools,
      (id) => programsById.get(id) ?? [],
      { search: "Computer Science", sector: "Private", sort: "featured" },
    );
    assert.deepEqual(
      clientUnis.items.map((u) => u.id),
      serverUnis.map((u) => u.id),
      "Shared catalogQuery and store university search rankings must match exactly",
    );

    // Program search parity
    const serverProgs = queryPrograms("BSCS", "", "", 1, 20, "Private");
    const allPrograms = baseline.flatMap((u) => programsById.get(u.id) ?? []);
    const clientProgs = searchCatalogPrograms(allPrograms, {
      search: "BSCS",
      sector: "Private",
      page: 1,
      limit: 20,
    });
    assert.deepEqual(
      clientProgs.items.map((p) => `${p.university_id}::${p.name}`),
      serverProgs.items.map((p) => `${p.university_id}::${p.name}`),
      "Shared catalogQuery and store program search rankings must match exactly",
    );

    // Recommendation parity
    const serverRec = rankedRecommendations(
      { program: "Bachelor of Science in Information Technology", sector: "Private" },
      null,
      20,
    );
    const clientCandidates: CandidateInput[] = baseline.flatMap((u) => {
      const fees = u.tuitionFees.map((f) => ({
        amount_min: f.amountMin,
        amount_max: f.amountMax,
        basis: f.basis,
        raw_text: f.rawText,
      }));
      return u.programs.map((p) => ({
        university_id: u.id,
        university_name: u.name,
        short_name: u.shortName,
        city: u.city,
        campus_location: u.campusLocation,
        sector: u.sector,
        program_count: u.programs.length,
        program_id: p.id,
        program_name: p.name,
        topic: p.topic,
        fees,
      }));
    });
    const clientRec = recommend(
      clientCandidates,
      { program: "Bachelor of Science in Information Technology", sector: "Private" },
      null,
      20,
    );
    assert.deepEqual(
      clientRec.items.map((i) => `${i.university_id}::${i.program_name}::${i.score}`),
      serverRec.items.map((i) => `${i.university_id}::${i.program_name}::${i.score}`),
      "Shared recommend engine and store recommendation outputs must match exactly",
    );
  });

  it("preserves full university details for Compare, Save, and Details modal", () => {
    const dlsu = getUniversityDetail("dlsu-manila");
    const ust = getUniversityDetail("ust-manila");
    assert.ok(dlsu && ust);
    assert.ok(Array.isArray(dlsu.programs) && dlsu.programs.length > 0);
    assert.ok(Array.isArray(ust.programs) && ust.programs.length > 0);
    assert.ok(dlsu.structured && ust.structured);
  });
});
