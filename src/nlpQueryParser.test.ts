import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMatchSentence } from "./algorithms/nlpQueryParser.js";
import {
  initStore,
  parseNaturalMatchQuery,
  rankedRecommendations,
} from "./store.js";

initStore();

describe("Offline Classical NLP Match Assistant (nlpQueryParser)", () => {
  it("extracts degree, campus area, sector, and budget from a full English sentence", () => {
    const res = parseNaturalMatchQuery(
      "I want a private university near Intramuros for computer science under 70k per sem",
    );
    assert.equal(res.engine, "classical-offline-nlp-v1");
    assert.equal(res.hasMatches, true);
    assert.equal(res.preferences.program, "Computer Science");
    assert.equal(res.preferences.city, "Intramuros");
    assert.equal(res.preferences.sector, "Private");
    assert.equal(res.preferences.budget, 70000);
    assert.equal(res.preferences.budget_basis, "semester");
    assert.equal(res.entities.length, 4);
  });

  it("handles Taglish phrasing and Manila landmarks accurately", () => {
    const res1 = parseNaturalMatchQuery(
      "Gusto ko ng Civil Engineering malapit sa Sta. Mesa",
    );
    assert.equal(res1.preferences.program, "Civil Engineering");
    assert.equal(res1.preferences.city, "Sta. Mesa");
    assert.equal(res1.preferences.sector, null);
    assert.equal(res1.preferences.budget, null);

    const res2 = parseNaturalMatchQuery(
      "Naghahanap ako ng libreng tuition na nursing sa Padre Faura",
    );
    assert.equal(res2.preferences.program, "Nursing");
    assert.equal(res2.preferences.city, "Ermita");
    assert.equal(res2.preferences.sector, "Public");
    assert.equal(res2.preferences.budget, null);

    const res3 = parseNaturalMatchQuery(
      "Ayaw ko ng public school, gusto ko BSIT bandang Vito Cruz under 75k per sem",
    );
    assert.equal(res3.preferences.program, "Information Technology");
    assert.equal(res3.preferences.city, "Malate");
    assert.equal(res3.preferences.sector, "Private");
    assert.equal(res3.preferences.budget, 75000);
    assert.equal(res3.preferences.budget_basis, "semester");
  });

  it("resolves everyday Manila landmarks to canonical UniMatch PH campus areas", () => {
    assert.equal(
      parseNaturalMatchQuery("Accountancy near Mendiola").preferences.city,
      "San Miguel",
    );
    assert.equal(
      parseNaturalMatchQuery("Pharmacy along España Blvd").preferences.city,
      "Sampaloc",
    );
    assert.equal(
      parseNaturalMatchQuery("Architecture in U-Belt").preferences.city,
      "Sampaloc",
    );
    assert.equal(
      parseNaturalMatchQuery("Engineering in Walled City").preferences.city,
      "Intramuros",
    );
    assert.equal(
      parseNaturalMatchQuery("Biology near Pureza").preferences.city,
      "Sta. Mesa",
    );
    assert.equal(
      parseNaturalMatchQuery("Psychology along Taft Avenue").preferences.city,
      "Malate",
    );
  });

  it("handles sector negation rules and explicit both-sector requests", () => {
    assert.equal(
      parseNaturalMatchQuery("not private university for BSCS").preferences.sector,
      "Public",
    );
    assert.equal(
      parseNaturalMatchQuery("no public schools for Accountancy").preferences.sector,
      "Private",
    );
    assert.equal(
      parseNaturalMatchQuery("either public or private for Nursing").preferences.sector,
      "Public,Private",
    );
    assert.equal(
      parseNaturalMatchQuery("free tuition engineering via RA 10931").preferences.sector,
      "Public",
    );
  });

  it("parses budget ranges, shorthand multipliers, and billing periods without confusing years", () => {
    const rangeRes = parseNaturalMatchQuery(
      "Private BSCS tuition between 40k and 80k per semester",
    );
    assert.equal(rangeRes.preferences.budget, 80000);
    assert.equal(rangeRes.preferences.budget_basis, "semester");

    const unitRes = parseNaturalMatchQuery(
      "Computer Engineering around 1.5k per unit",
    );
    assert.equal(unitRes.preferences.program, "Computer Engineering");
    assert.equal(unitRes.preferences.budget, 1500);
    assert.equal(unitRes.preferences.budget_basis, "unit");

    const yearRes = parseNaturalMatchQuery(
      "Psychology budget of ₱150,000 per year",
    );
    assert.equal(yearRes.preferences.budget, 150000);
    assert.equal(yearRes.preferences.budget_basis, "year");

    const triRes = parseNaturalMatchQuery("BSIT max 60,000 per trimester");
    assert.equal(triRes.preferences.budget, 60000);
    assert.equal(triRes.preferences.budget_basis, "trimester");

    // Must NOT misread academic year 2027-2028 or RA 10931 as a peso budget
    const yearGuard = parseNaturalMatchQuery(
      "Computer Science admissions for 2027-2028 with RA 10931 free tuition",
    );
    assert.equal(yearGuard.preferences.program, "Computer Science");
    assert.equal(yearGuard.preferences.sector, "Public");
    assert.equal(yearGuard.preferences.budget, null);
  });

  it("prevents false positives on ambiguous English words (me, is, it) while supporting uppercase degree abbreviations", () => {
    const safeRes = parseNaturalMatchQuery(
      "help me find a school that is cheap and make it private",
    );
    assert.equal(safeRes.preferences.sector, "Private");
    assert.equal(safeRes.preferences.program, null);

    const upperIT = parseNaturalMatchQuery("Private university for IT in Malate");
    assert.equal(upperIT.preferences.program, "Information Technology");
    assert.equal(upperIT.preferences.sector, "Private");
    assert.equal(upperIT.preferences.city, "Malate");

    const explicitBsIt = parseNaturalMatchQuery("Looking for BS IT in Sampaloc");
    assert.equal(explicitBsIt.preferences.program, "Information Technology");
    assert.equal(explicitBsIt.preferences.city, "Sampaloc");
  });

  it("maps career and interest phrases to real degree programs when no explicit degree is named", () => {
    assert.equal(
      parseNaturalMatchQuery("I love coding and software development").preferences.program,
      "Computer Science",
    );
    assert.equal(
      parseNaturalMatchQuery("Private school for game development").preferences.program,
      "Entertainment and Multimedia Computing",
    );
    assert.equal(
      parseNaturalMatchQuery("I want to study building design in Intramuros").preferences.program,
      "Architecture",
    );
    assert.equal(
      parseNaturalMatchQuery("Looking for hotel management in Malate").preferences.program,
      "Hospitality Management",
    );
  });

  it("handles gibberish, empty, and oversized inputs cleanly without crashing", () => {
    const gibberish = parseNaturalMatchQuery("hello how are you doing today");
    assert.equal(gibberish.hasMatches, false);
    assert.equal(gibberish.entities.length, 0);
    assert.equal(gibberish.preferences.program, null);

    assert.throws(
      () => parseMatchSentence("   "),
      /enter a sentence/i,
    );
    assert.throws(
      () => parseMatchSentence("a".repeat(501)),
      /at most 500 characters/i,
    );
  });

  it("integrates seamlessly with existing strict filters and weighted rule-based matching", () => {
    const parsed = parseNaturalMatchQuery(
      "Private university in Malate for Information Technology",
    );
    assert.equal(parsed.preferences.program, "Information Technology");
    assert.equal(parsed.preferences.city, "Malate");
    assert.equal(parsed.preferences.sector, "Private");

    const rec = rankedRecommendations(
      {
        program: parsed.preferences.program,
        city: parsed.preferences.city,
        sector: parsed.preferences.sector,
      },
      null,
      20,
    );
    assert.ok(rec.items.length > 0, "Expected matching Private universities in Malate");
    for (const item of rec.items) {
      assert.equal(
        item.sector,
        "Private",
        "Private filter extracted by NLP must strictly exclude Public universities",
      );
    }
    const dlsu = rec.items.find((i) => i.university_id === "dlsu-manila");
    assert.ok(dlsu, "Expected DLSU (Malate, Private) in results");
    assert.equal(dlsu!.score, 100);
  });
});
