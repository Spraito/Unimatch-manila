const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const e = escapeHTML;
const viewTitles = {
  universities: "Explore colleges",
  programs: "Degree programs",
  saved: "Saved schools",
  compare: "Compare schools",
  recommend: "Find my match",
};
const ACCOUNT_ID = document.body.dataset.account || "guest";
const STORAGE_PREFIX = `unimatch.v2.${ACCOUNT_ID}`;
function storageKey(name) {
  return `${STORAGE_PREFIX}.${name}`;
}
function storedList(name) {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey(name)) || "[]");
    return Array.isArray(list)
      ? [...new Set(list.filter((v) => typeof v === "string"))].slice(0, 100)
      : [];
  } catch {
    return [];
  }
}
const state = {
  view: "universities",
  query: "",
  city: "",
  sector: "",
  school: "",
  topic: "",
  sort: "featured",
  page: 1,
  saved: storedList("saved"),
  compare: storedList("compare").slice(0, 3),
  schools: [],
  stats: null,
  detail: null,
  tab: "overview",
  recommend: {
    program: "",
    city: "",
    sector: "",
    budget: "",
    budgetBasis: "semester",
    weights: {
      program: 0.45,
      location: 0.2,
      budget: 0.2,
      sector: 0.15,
    },
    result: null,
    error: "",
    loading: false,
  },
};
let renderVersion = 0,
  searchTimer,
  toastTimer,
  detailVersion = 0;

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(
      problem.error ||
        `The server returned ${response.status}. Please try again.`,
    );
  }
  return response.json();
}

function persist() {
  try {
    localStorage.setItem(storageKey("saved"), JSON.stringify(state.saved));
    localStorage.setItem(storageKey("compare"), JSON.stringify(state.compare));
  } catch {
    toast(
      "Your browser couldn't save this shortlist. It will last for this visit.",
    );
  }
  $("#saved-count").textContent = state.saved.length;
  $("#compare-count").textContent = state.compare.length;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3500);
}

function dateLabel(value) {
  if (!value) return "Not yet collected";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date not recorded"
    : new Intl.DateTimeFormat("en-PH", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Manila",
      }).format(date);
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function sourceLink(value, label = "View official source") {
  const url = safeURL(value);
  return url
    ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)} ↗</a>`
    : "";
}

function schoolMark(school, small = false) {
  const mark = String(school.short_name || "").startsWith("UP") ? "UP" : school.short_name;
  return `<span class="school-mark ${e(school.color)} ${small ? "small" : ""}" aria-hidden="true">${e(mark)}</span>`;
}

function statusTag(school) {
  return school.collection_status === "pending"
    ? '<span class="tag neutral"><span class="tag-dot"></span>Awaiting collection</span>'
    : '<span class="tag amber"><span class="tag-dot"></span>Partial data · needs review</span>';
}

function schoolCard(school) {
  const saved = state.saved.includes(school.id),
    compared = state.compare.includes(school.id);
  return `<article class="school-card ${e(school.color)}" data-school-card="${e(school.id)}">
    <div class="card-top">${schoolMark(school)}<button class="icon-button save-button" data-action="save" data-school="${e(school.id)}" aria-pressed="${saved}" aria-label="${saved ? "Unsave" : "Save"} ${e(school.short_name)}">${icon("save")}</button></div>
    <h3>${e(school.name)}</h3><p class="card-location">${icon("pin")}${e(school.campus_location)}</p>
    <div class="card-tags"><span class="tag">${e(school.sector)} university</span>${statusTag(school)}</div>
    <div class="card-metrics"><div><span class="metric-label">PROGRAM ENTRIES COLLECTED</span><span class="metric-value">${school.program_count ? `<strong>${school.program_count}</strong> entries` : "Not yet indexed"}</span></div><div><span class="metric-label">TUITION INFORMATION</span><span class="metric-value">${school.tuition_amount_count ? "See fee evidence" : "Amount not available"}</span></div></div>
    <div class="card-footer"><button class="text-button" data-action="details" data-school="${e(school.id)}">View university ${icon("arrow")}</button><button class="compare-button" data-action="compare" data-school="${e(school.id)}" aria-pressed="${compared}" aria-label="${compared ? "Remove" : "Add"} ${e(school.short_name)} ${compared ? "from" : "to"} comparison"><span class="compare-check">${icon("check")}</span>Compare</button></div>
  </article>`;
}

function programCard(program) {
  return `<article class="program-card"><div class="program-school">${schoolMark(program, true)}<span>${e(program.short_name)} <span aria-hidden="true">·</span> ${e(program.city)}</span></div>
    <h3>${e(program.name)}</h3><span class="tag">${e(program.topic)}</span>
    <p class="program-disclaimer">${program.strand_alignment ? `Published strand note: ${e(program.strand_alignment)}` : "Strand eligibility has not been published in this record."}</p>
    <button class="text-button" data-action="details" data-school="${e(program.university_id)}" data-tab="programs">View source university ${icon("arrow")}</button></article>`;
}

function emptyState(
  title,
  description,
  action = "reset",
  label = "Clear filters",
  symbol = "search",
) {
  return `<div class="empty-state"><div class="empty-icon">${icon(symbol)}</div><h3>${e(title)}</h3><p>${e(description)}</p><button class="button secondary" data-action="${action}">${e(label)} ${icon("arrow")}</button></div>`;
}

function controls() {
  const programs = state.view === "programs",
    compare = state.view === "compare",
    recommend = state.view === "recommend";
  $("#hero").hidden = state.view !== "universities";
  $("#filter-bar").hidden = compare || recommend;
  $("#results-meta").hidden = compare || recommend;
  $("#city-wrap").hidden = programs || recommend;
  $("#sector-wrap").hidden = programs || recommend;
  $("#school-wrap").hidden = !programs;
  $("#topic-wrap").hidden = !programs;
  $("#sort-wrap").hidden = programs || recommend;
  $("#search").placeholder = programs
    ? "Search a degree, subject, or university…"
    : "Search a university or program…";
  const descriptions = {
    universities: [
      "A PLACE TO BEGIN",
      "Explore universities",
      "Different paths. New possibilities. Find your starting point.",
    ],
    programs: [
      "FOLLOW YOUR CURIOSITY",
      "Discover degree programs",
      "Explore collected program entries. Topics are browsing aids, not eligibility advice.",
    ],
    saved: [
      "YOUR NEXT-CHAPTER SHORTLIST",
      "Saved schools",
      "A little collection of possibilities, saved in this browser.",
    ],
    compare: [
      "SEE THE POSSIBILITIES SIDE BY SIDE",
      "Compare your schools",
      "Choose up to three universities. Missing information stays visible.",
    ],
    recommend: [
      "A MATCH BUILT AROUND YOU",
      "Find my match",
      "Tell us what matters. We score collected records with weighted criteria and explain every match.",
    ],
  };
  ["#section-eyebrow", "#section-title", "#section-description"].forEach(
    (id, index) => {
      $(id).textContent = descriptions[state.view][index];
    },
  );
  $("#breadcrumb-view").textContent = viewTitles[state.view];
  document.querySelectorAll(".nav-item").forEach((button) => {
    const selected = button.dataset.view === state.view;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function closeMenu() {
  const wasOpen = $("#sidebar").classList.contains("open");
  $("#sidebar").classList.remove("open");
  $("#sidebar-shade").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  if (wasOpen) $("#menu-toggle").focus();
}

function setView(view, school = "") {
  clearTimeout(searchTimer);
  if (!viewTitles[view]) return;
  state.view = view;
  Object.assign(state, {
    query: "",
    city: "",
    sector: "",
    topic: "",
    school,
    sort: "featured",
    page: 1,
  });
  ["search", "city", "sector", "topic", "school", "sort"].forEach((id) => {
    $("#" + id).value = id === "search" ? "" : state[id];
  });
  history.replaceState(null, "", "#" + view);
  closeMenu();
  controls();
  render();
}

async function render() {
  const version = ++renderVersion;
  const results = $("#results");
  results.setAttribute("aria-busy", "true");
  $("#pagination").hidden = true;
  try {
    if (state.view === "recommend") {
      renderRecommend();
      return;
    }
    if (state.view === "compare") {
      if (!state.compare.length) {
        results.innerHTML = emptyState(
          "A clearer choice starts with a pair",
          "Select Compare on any university card to add it here. You can compare up to three schools.",
          "browse",
          "Explore colleges",
          "compare",
        );
      } else {
        const data = await api("/api/compare", {
          ids: state.compare.join(","),
        });
        if (version !== renderVersion) return;
        renderComparison(data.items);
      }
      return;
    }
    if (state.view === "programs") {
      const data = await api("/api/programs", {
        search: state.query,
        university_id: state.school,
        topic: state.topic,
        page: state.page,
        limit: 12,
      });
      if (version !== renderVersion) return;
      $("#results-count").innerHTML =
        `<strong>${data.total}</strong> collected program ${data.total === 1 ? "entry" : "entries"}`;
      results.innerHTML = data.items.length
        ? `<div class="program-grid">${data.items.map(programCard).join("")}</div>`
        : emptyState(
            "No collected programs match",
            "Try another search or school. An empty result does not mean a university offers no programs.",
          );
      const pages = Math.ceil(data.total / data.limit);
      if (pages > 1) {
        $("#pagination").hidden = false;
        $("#pagination").innerHTML =
          `<button data-action="previous" ${data.page === 1 ? "disabled" : ""}>Previous</button><span>Page ${data.page} of ${pages}</span><button data-action="next" ${data.page === pages ? "disabled" : ""}>Next</button>`;
      }
    } else {
      const data = await api("/api/universities", {
        search: state.query,
        city: state.city,
        sector: state.sector,
        sort: state.sort,
      });
      if (version !== renderVersion) return;
      const schools =
        state.view === "saved"
          ? data.items.filter((s) => state.saved.includes(s.id))
          : data.items;
      $("#results-count").innerHTML =
        `<strong>${schools.length}</strong> ${schools.length === 1 ? "university" : "universities"} ${state.view === "saved" ? "on your shortlist" : "to explore"}`;
      results.innerHTML = schools.length
        ? `<div class="school-grid">${schools.map(schoolCard).join("")}</div>`
        : state.view === "saved" && !state.saved.length
          ? emptyState(
              "Keep a few possibilities close",
              "Tap the bookmark on a university card to build your shortlist. It stays in this browser.",
              "browse",
              "Explore colleges",
              "save",
            )
          : emptyState(
              "A different search might open a door",
              "Try a university name, degree, or another location to explore more possibilities.",
            );
    }
  } catch (error) {
    if (version !== renderVersion) return;
    $("#results-count").textContent = "Unable to load results";
    results.innerHTML = `<div class="error-state"><p>${e(error.message)}</p><button class="button secondary" data-action="retry">Try again</button></div>`;
  } finally {
    if (version === renderVersion) results.setAttribute("aria-busy", "false");
  }
}

function renderComparison(schools) {
  const field = (school, key) => {
    const entries = school.evidence?.[key] || [];
    return entries.length
      ? entries
          .map(
            (entry) =>
              `<p>${e(entry.text || "See source evidence")}</p>${(entry.source_context || []).map((text) => `<p class="context">${e(text)}</p>`).join("")}`,
          )
          .join("")
      : '<span class="muted">Not available</span>';
  };
  const structuredField = (school, key, render) => {
    const rows = school.structured?.[key] || [];
    return rows.length
      ? rows.map(render).join("")
      : '<span class="muted">Not available</span>';
  };
  const feeText = (fee) =>
    typeof fee.amount_min === "number" && typeof fee.amount_max === "number"
      ? `<p>PHP ${Number(fee.amount_min).toLocaleString("en-PH")}${
          fee.amount_max === fee.amount_min
            ? ""
            : `–${Number(fee.amount_max).toLocaleString("en-PH")}`
        } per ${e(fee.basis || "unspecified")}</p>`
      : '<p class="muted">Published amount not available</p>';
  const rows = [
    [
      "Academic year",
      (school) => e(structuredYear(school.structured)),
    ],
    ["Campus", (school) => e(school.campus_location)],
    ["University type", (school) => e(school.sector)],
    [
      "Program entries",
      (school) =>
        school.program_count
          ? `${school.program_count} collected; verify campus availability`
          : "Not yet indexed",
    ],
    [
      "Admission requirements",
      (school) =>
        structuredField(
          school,
          "admission_requirements",
          (row) => `<p>${e(row.text)}</p>`,
        ),
    ],
    [
      "Application deadlines",
      (school) =>
        structuredField(
          school,
          "application_deadlines",
          (row) =>
            `<p><strong>${e(row.label || "Date")}</strong>${row.date_iso ? ` — ${e(dateLabel(row.date_iso))}` : ""}</p>`,
        ),
    ],
    [
      "Entrance examination",
      (school) =>
        structuredField(
          school,
          "entrance_examinations",
          (row) => `<p>${e(row.exam_name || row.coverage)}</p>`,
        ),
    ],
    [
      "Tuition fees",
      (school) => structuredField(school, "tuition_fees", feeText),
    ],
    [
      "Application link",
      (school) => applicationLinkList(school.structured),
    ],
    [
      "Last verified",
      (school) => e(dateLabel(school.structured?.last_verified_at)),
    ],
    ["Tuition evidence", (school) => field(school, "tuition_estimates")],
    ["Exam coverage", (school) => field(school, "entrance_exam_coverage")],
    [
      "Published application notice",
      (school) => field(school, "application_status"),
    ],
    ["Dated deadlines", (school) => field(school, "application_deadlines")],
    ["Collected", (school) => e(dateLabel(school.collected_at))],
    [
      "Review notes",
      (school) =>
        (school.evidence?.source_notes || [])
          .map((note) => `<p>${e(note)}</p>`)
          .join("") || "Confirm details with official admissions sources.",
    ],
  ];
  $("#results").innerHTML =
    `<div class="compare-scroll" role="region" aria-label="University comparison" tabindex="0"><table class="compare-table"><thead><tr><th scope="col">Your possibilities</th>${schools.map((school) => `<th scope="col" class="compare-school">${schoolMark(school)}<h3>${e(school.name)}</h3>${statusTag(school)}<br><button class="text-button" data-action="details" data-school="${e(school.id)}">View details ${icon("arrow")}</button><button class="compare-remove" data-action="compare" data-school="${e(school.id)}" aria-label="Remove ${e(school.short_name)} from comparison">Remove</button></th>`).join("")}</tr></thead><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${e(label)}</th>${schools.map((school) => `<td>${value(school)}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="comparison-note">Program counts describe this dataset’s coverage, not the university’s complete offerings or its quality. Published notices may refer to an earlier intake.</p><button class="button secondary" data-action="browse">Add another school ${icon("arrow")}</button>`;
}

const EXPLANATION_STATUS = {
  matched: "Matched",
  partial: "Partial",
  not_matched: "No match",
  unknown: "Unknown",
};

function groupRecommendations(items) {
  const groups = new Map();
  items.forEach((item, index) => {
    const key = item.university_id || item.university_name || `school-${index}`;
    if (!groups.has(key)) {
      groups.set(key, {
        university_id: item.university_id,
        university_name: item.university_name,
        short_name: item.short_name,
        campus_location: item.campus_location,
        items: [],
      });
    }
    groups.get(key).items.push({ ...item, rank: index + 1 });
  });
  return [...groups.values()];
}

function recommendationRow(item, rank) {
  const program = item.program_name || "All collected programs at this university";
  const explanations = (item.explanations || [])
    .map(
      (row) => `<li class="explain-row ${e(row.status)}">
        <span class="explain-label">${e(row.label)}</span>
        <span class="explain-status">${e(EXPLANATION_STATUS[row.status] || row.status)}</span>
        <span class="explain-points">${Math.round(Number(row.points || 0) * 100)}%</span>
        <p>${e(row.reason)}</p>
      </li>`,
    )
    .join("");
  const compared = state.compare.includes(item.university_id);
  return `<article class="match-card match-card-grouped">
    <div class="match-rank" aria-hidden="true">#${rank}</div>
    <div class="match-main">
      <div class="match-head">
        <div>
          <h4>${e(program)}</h4>
          <p class="match-program">${e(item.topic || "Topic not available")}${item.unknown ? ' <span class="tag neutral">Some data unknown</span>' : ""}</p>
        </div>
        <div class="match-score" aria-label="Match score ${e(item.score)} out of 100">
          <strong>${e(item.score)}</strong><span>match score</span>
        </div>
      </div>
      <div class="score-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, Number(item.score) || 0))}%"></span></div>
      <ul class="explain-list">${explanations}</ul>
      <div class="match-actions">
        <button class="text-button" data-action="details" data-school="${e(item.university_id)}">View university ${icon("arrow")}</button>
        <button class="compare-button" data-action="compare" data-school="${e(item.university_id)}" aria-pressed="${compared}" aria-label="${compared ? "Remove" : "Add"} ${e(item.short_name || item.university_name)} ${compared ? "from" : "to"} comparison"><span class="compare-check">${icon("check")}</span>Compare</button>
      </div>
    </div>
  </article>`;
}

function recommendationGroup(group) {
  const best = group.items.reduce(
    (highest, item) => Math.max(highest, Number(item.score) || 0),
    0,
  );
  return `<section class="match-group">
    <header class="match-group-head">
      <div>
        <h3>${e(group.university_name)}</h3>
        <p class="card-location">${icon("pin")}${e(group.campus_location || "Campus not available")}</p>
      </div>
      <div class="match-group-meta">
        <strong>${e(best)}<span>/100 best</span></strong>
        <span class="tag">${group.items.length} program${group.items.length === 1 ? "" : "s"}</span>
      </div>
    </header>
    <div class="match-group-list">${group.items.map((item) => recommendationRow(item, item.rank)).join("")}</div>
  </section>`;
}

function recommendationOutput(result, error, loading) {
  if (loading) {
    return '<div class="loading-state recommend-loading">Scoring collected records and ranking them with merge sort…</div>';
  }
  if (error) {
    return `<div class="error-state"><p>${e(error)}</p><p>Adjust a preference or try again.</p></div>`;
  }
  if (!result) {
    return `<div class="empty-state recommend-placeholder"><div class="empty-icon">${icon("spark")}</div><h3>Your match list will appear here</h3><p>Add a program, location, budget, or university type. Each score explains which preferences matched and which source data is unknown.</p></div>`;
  }
  if (!result.items?.length) {
    return emptyState(
      "No scored match yet",
      "The collected records did not produce a ranked match. Try a broader program keyword or another location.",
      "reset",
      "Start over",
      "spark",
    );
  }
  const weights = Object.entries(result.weights || {})
    .map(
      ([name, value]) =>
        `<span class="weight-chip">${e(result.criteria?.[name] || name)} ${Math.round(Number(value) * 100)}%</span>`,
    )
    .join("");
  const groups = groupRecommendations(result.items);
  return `<div class="recommend-summary">
      <div><span class="eyebrow">WEIGHTED, EXPLAINED, RANKED</span><h3>${result.items.length} of ${result.total} scored matches across ${groups.length} universit${groups.length === 1 ? "y" : "ies"}</h3></div>
      <div class="weight-chips">${weights}</div>
    </div>
    <p class="recommend-formula">${e(result.formula || "")}</p>
    <p class="recommend-policy">${e(result.unknown_policy || "")} Ranking algorithm: ${e(result.algorithm || "stable merge sort")}.</p>
    <div class="match-list">${groups.map(recommendationGroup).join("")}</div>`;
}

function renderRecommend() {
  const rec = state.recommend;
  const cities = state.stats?.cities || [];
  const weightInput = (name, label) => `<label class="weight-field"><span>${e(label)}</span><input id="rec-weight-${e(name)}" type="number" min="0" max="100" step="5" value="${Math.round(Number(rec.weights[name] || 0) * 100)}" aria-label="${e(label)} weight in percent"><span class="weight-unit">%</span></label>`;
  $("#results").innerHTML = `<div class="recommend-layout">
    <form class="recommend-form" id="recommend-form" novalidate>
      <div class="recommend-form-head">
        <span class="eyebrow">YOUR PREFERENCES</span>
        <h3>What matters most?</h3>
        <p>At least one preference is required. Blank fields are simply not scored.</p>
      </div>
      <label class="recommend-field"><span>Preferred program</span><input id="rec-program" type="search" maxlength="200" autocomplete="off" placeholder="e.g. Computer Science" value="${e(rec.program)}"></label>
      <label class="recommend-field"><span>Preferred location</span><select id="rec-city"><option value="">Any location</option>${cities.map((city) => `<option value="${e(city)}" ${city === rec.city ? "selected" : ""}>${e(city)}</option>`).join("")}</select></label>
      <label class="recommend-field"><span>University type</span><select id="rec-sector"><option value="">Any type</option><option ${rec.sector === "Public" ? "selected" : ""}>Public</option><option ${rec.sector === "Private" ? "selected" : ""}>Private</option></select></label>
      <div class="recommend-budget">
        <label class="recommend-field"><span>Budget (PHP)</span><input id="rec-budget" type="number" min="0" max="10000000" step="1000" inputmode="numeric" placeholder="Optional" value="${e(rec.budget)}"></label>
        <label class="recommend-field"><span>Budget basis</span><select id="rec-basis">${["semester", "trimester", "year", "unit"].map((basis) => `<option value="${basis}" ${basis === rec.budgetBasis ? "selected" : ""}>${basis}</option>`).join("")}</select></label>
      </div>
      <details class="weight-panel" ${rec.result ? "open" : ""}>
        <summary>Adjust criteria weights</summary>
        <p>Weights are normalised to 100%. Setting a weight to zero ignores that criterion.</p>
        <div class="weight-grid">
          ${weightInput("program", "Preferred program")}
          ${weightInput("location", "Preferred location")}
          ${weightInput("budget", "Budget fit")}
          ${weightInput("sector", "University type")}
        </div>
      </details>
      <button class="button primary recommend-submit" type="submit" ${rec.loading ? "disabled" : ""}>${icon("spark")}Find my matches</button>
      <p class="recommend-hint">Missing source information scores 0 for that criterion and is labelled unknown. It is never treated as a match.</p>
    </form>
    <div class="recommend-output" aria-live="polite">${recommendationOutput(rec.result, rec.error, rec.loading)}</div>
  </div>`;
  $("#results").setAttribute("aria-busy", "false");
}

async function runRecommendation() {
  const rec = state.recommend;
  const read = (id) => ($("#" + id)?.value || "").trim();
  rec.program = read("rec-program");
  rec.city = read("rec-city");
  rec.sector = read("rec-sector");
  rec.budget = read("rec-budget");
  rec.budgetBasis = read("rec-basis") || "semester";
  const weights = {};
  for (const name of ["program", "location", "budget", "sector"]) {
    const raw = Number(read("rec-weight-" + name));
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
      rec.error = "Each criterion weight must be a number from 0 to 100.";
      rec.result = null;
      renderRecommend();
      return;
    }
    weights[name] = raw / 100;
  }
  rec.weights = weights;
  if (!rec.program && !rec.city && !rec.sector && rec.budget === "") {
    rec.error =
      "Add at least one preference: a program, location, budget, or university type.";
    rec.result = null;
    renderRecommend();
    return;
  }
  if (rec.budget !== "" && (!Number.isFinite(Number(rec.budget)) || Number(rec.budget) < 0)) {
    rec.error = "Budget must be a non-negative number.";
    rec.result = null;
    renderRecommend();
    return;
  }
  rec.loading = true;
  rec.error = "";
  rec.result = null;
  renderRecommend();
  const params = {
    program: rec.program,
    city: rec.city,
    sector: rec.sector,
    limit: 20,
    weights: Object.entries(weights)
      .map(([name, value]) => `${name}:${value}`)
      .join(","),
  };
  if (rec.budget !== "") {
    params.budget = rec.budget;
    params.budget_basis = rec.budgetBasis;
  }
  try {
    rec.result = await api("/api/recommendations", params);
  } catch (error) {
    rec.error = error.message;
  } finally {
    rec.loading = false;
    renderRecommend();
  }
}

function evidenceBlock(school, name, label) {
  const entries = school.evidence?.[name] || [];
  return `<h3>${e(label)}</h3>${entries.length ? `<ul class="evidence-list">${entries.map((item) => `<li><p>${e(item.text || "Source evidence available")}</p>${(item.source_context || []).map((context) => `<p class="context">${e(context)}</p>`).join("")}${sourceLink(item.source_url)}</li>`).join("")}</ul>` : "<p>Not available in the collected sources. Check with the university for current information.</p>"}`;
}

function structuredYear(structured) {
  if (!structured) return "Not available";
  if (structured.academic_year) return structured.academic_year;
  if (structured.academic_years?.length)
    return `Unresolved: ${structured.academic_years.join(" / ")}`;
  return "Not available";
}

function applicationLinkList(structured) {
  const links = (structured?.application_links || []).filter((link) =>
    safeURL(link.url),
  );
  return links.length
    ? links
        .map((link) => sourceLink(link.url, link.label || "Application page"))
        .join('<span aria-hidden="true"> · </span>')
    : '<span class="muted">Not available</span>';
}

function profileFacts(structured) {
  return `<dl class="detail-facts profile-facts">
    <div><dt>ACADEMIC YEAR</dt><dd>${e(structuredYear(structured))}</dd></div>
    <div><dt>LAST VERIFIED</dt><dd>${e(dateLabel(structured?.last_verified_at))}</dd></div>
    <div><dt>APPLICATION LINK</dt><dd>${applicationLinkList(structured)}</dd></div>
  </dl>`;
}

function structuredSection(title, body) {
  return `<section class="profile-section"><h3>${e(title)}</h3>${body}</section>`;
}

function structuredAdmissions(structured) {
  if (!structured) {
    return '<p class="not-available">Structured records are not available for this university. Review the source evidence below or check the official admissions page.</p>';
  }
  const list = (rows, render) =>
    rows?.length
      ? `<ul class="structured-list">${rows.map(render).join("")}</ul>`
      : '<p class="not-available">Not available in the collected sources.</p>';

  const requirements = list(
    structured.admission_requirements,
    (row) =>
      `<li><p>${e(row.text)}</p><span class="tag">${e(row.category || "general")}</span>${row.academic_year ? ` <span class="meta-chip">${e(row.academic_year)}</span>` : ""}${sourceLink(row.source_url)}</li>`,
  );
  const deadlines = list(
    structured.application_deadlines,
    (row) =>
      `<li><p><strong>${e(row.label || "Application date")}</strong>${row.date_iso ? ` — ${e(dateLabel(row.date_iso))}` : " — date not stated"}</p>${row.raw_text ? `<p class="context">${e(row.raw_text)}</p>` : ""}${row.academic_year ? `<span class="meta-chip">${e(row.academic_year)}</span>` : ""}${sourceLink(row.source_url)}</li>`,
  );
  const examinations = list(
    structured.entrance_examinations,
    (row) =>
      `<li><p><strong>${e(row.exam_name || "Entrance examination")}</strong></p><p>${e(row.coverage)}</p>${row.academic_year ? `<span class="meta-chip">${e(row.academic_year)}</span>` : ""}${sourceLink(row.source_url)}</li>`,
  );
  const fees = list(structured.tuition_fees, (row) => {
    const amount =
      typeof row.amount_min === "number" && typeof row.amount_max === "number"
        ? `PHP ${Number(row.amount_min).toLocaleString("en-PH")}${
            row.amount_max === row.amount_min
              ? ""
              : `–${Number(row.amount_max).toLocaleString("en-PH")}`
          } per ${e(row.basis || "unspecified")}`
        : '<span class="muted">Published amount not available</span>';
    return `<li><p><strong>${amount}</strong></p>${row.raw_text ? `<p class="context">${e(row.raw_text)}</p>` : ""}${row.academic_year ? `<span class="meta-chip">${e(row.academic_year)}</span>` : ""}${sourceLink(row.source_url)}</li>`;
  });
  const links = list(
    structured.application_links,
    (row) =>
      `<li>${sourceLink(row.url, row.label || "Application page")}${row.source_url ? `<p class="context">Found on ${sourceLink(row.source_url)}</p>` : ""}</li>`,
  );
  const sources = (structured.source_urls || []).length
    ? `<ul class="source-list">${structured.source_urls.map((url) => `<li>${sourceLink(url, new URL(url).hostname + new URL(url).pathname)}</li>`).join("")}</ul>`
    : '<p class="not-available">No source links recorded.</p>';
  const conflicts = (state.detail?.declared_conflicts || []).length
    ? `<div class="evidence-note conflict-note"><strong>Conflicting source statements</strong>${state.detail.declared_conflicts.map((row) => `<p>${e(row.field)}: kept “${e(row.kept_value)}”; discarded “${e(row.discarded_value)}”. ${e(row.reason || "")}</p>`).join("")}</div>`
    : "";
  return `<div class="structured-profile">
    ${profileFacts(structured)}
    ${structuredSection("Admission requirements", requirements)}
    ${structuredSection("Application deadlines", deadlines)}
    ${structuredSection("Entrance examination information", examinations)}
    ${structuredSection("Tuition fees", fees)}
    ${structuredSection("Official application links", links)}
    ${conflicts}
    ${structuredSection("Recorded source pages", sources)}
  </div>`;
}

async function openDetails(id, tab = "overview") {
  const version = ++detailVersion;
  const dialog = $("#school-dialog");
  state.detail = null;
  state.tab = tab;
  $("#detail-body").innerHTML =
    '<div class="detail-panel"><h2 id="dialog-title">Loading university…</h2><p>Gathering the collected records and sources.</p></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const school = await api("/api/universities/" + encodeURIComponent(id));
    if (version !== detailVersion || !dialog.open) return;
    state.detail = school;
    renderDetails();
  } catch (error) {
    if (version !== detailVersion) return;
    $("#detail-body").innerHTML =
      `<div class="detail-panel"><h2 id="dialog-title">Unable to load university</h2><p>${e(error.message)}</p><button class="button secondary" data-action="details" data-school="${e(id)}">Try again</button></div>`;
  }
}

function renderDetails() {
  const school = state.detail;
  if (!school) return;
  const tabs = [
    ["overview", "Overview"],
    ["programs", `Programs (${school.program_count})`],
    ["admissions", "Admissions & fees"],
  ];
  const notes = school.evidence?.source_notes || [];
  let content = "";
  if (state.tab === "overview") {
    const sources = (school.sources || [])
      .map((source) => safeURL(source.final_url || source.requested_url))
      .filter(Boolean);
    content = `<h3>A starting point for ${e(school.short_name)}</h3><p>${school.collection_status === "pending" ? "This university is included in the Metro Manila directory. Its admissions and program information has not yet been collected for this prototype." : "These entries were collected from official public pages. They remain source evidence requiring review, including confirmation of the campus, academic year and current availability."}</p>${profileFacts(school.structured)}<dl class="detail-facts"><div><dt>UNIVERSITY TYPE</dt><dd>${e(school.sector)}</dd></div><div><dt>PROGRAM ENTRIES</dt><dd>${school.program_count || "Not indexed"}</dd></div><div><dt>LAST COLLECTED</dt><dd>${e(dateLabel(school.collected_at))}</dd></div></dl>${notes.length ? `<div class="evidence-note">${notes.map((note) => `<p>${e(note)}</p>`).join("")}</div>` : ""}<h3>Official sources</h3><ul class="source-list">${[...new Set(sources)].map((url) => `<li>${sourceLink(url, new URL(url).hostname + new URL(url).pathname)}</li>`).join("") || "<li>No source links recorded.</li>"}</ul><p>Missing data does not mean a fee is zero or a program is unavailable. Verify details directly with admissions.</p>`;
  } else if (state.tab === "programs") {
    content = `<h3>Collected program entries</h3><p>Program names are quoted from the source listing. Topic labels help you browse; strand eligibility and campus availability need confirmation.</p>${notes.length ? `<details class="program-review-notes"><summary>Read collection and title review notes</summary><div class="evidence-note">${notes.map((note) => `<p>${e(note)}</p>`).join("")}</div></details>` : ""}${school.program_count ? `<label><span class="sr-only">Search this university's programs</span><input class="detail-search" id="detail-program-search" type="search" placeholder="Search these programs…" maxlength="200"></label><div id="detail-program-results">${detailPrograms(school.programs)}</div>` : "<p>No program entries have been collected for this university yet.</p>"}`;
  } else {
    content =
      `<div class="evidence-note"><p>The organized profile below is extracted from approved sources and still requires human verification. Check the academic year and source before using it for an application.</p>${notes.map((note) => `<p>${e(note)}</p>`).join("")}</div>` +
      structuredAdmissions(school.structured) +
      `<details class="raw-evidence" open><summary>Source evidence (unreviewed text)</summary><p class="context">These are the original extracted statements. They are kept for transparency and may repeat or predate the organized profile above.</p>` +
      evidenceBlock(
        school,
        "admission_requirements",
        "Admission requirements — source text",
      ) +
      evidenceBlock(
        school,
        "entrance_exam_coverage",
        "Entrance exam coverage — source text",
      ) +
      evidenceBlock(
        school,
        "tuition_estimates",
        "Tuition and cost evidence — source text",
      ) +
      evidenceBlock(
        school,
        "application_deadlines",
        "Application dates — source text",
      ) +
      evidenceBlock(
        school,
        "application_status",
        "Published application notice — source text",
      ) +
      `</details>`;
  }
  $("#detail-body").innerHTML =
    `<header class="detail-head">${schoolMark(school)}<span class="eyebrow">YOUR NEXT CHAPTER, IN FOCUS</span><h2 id="dialog-title">${e(school.name)}</h2><p class="card-location">${icon("pin")}${e(school.campus_location)}</p>${statusTag(school)}</header><div class="detail-tabs" role="tablist" aria-label="University details">${tabs.map(([id, label]) => `<button id="tab-${id}" role="tab" data-action="tab" data-tab="${id}" aria-controls="detail-panel" aria-selected="${state.tab === id}" tabindex="${state.tab === id ? "0" : "-1"}">${e(label)}</button>`).join("")}</div><section class="detail-panel" id="detail-panel" role="tabpanel" aria-labelledby="tab-${state.tab}" tabindex="0">${content}<div class="dialog-actions"><button class="button secondary" data-action="save" data-school="${e(school.id)}" aria-pressed="${state.saved.includes(school.id)}">${icon("save")}${state.saved.includes(school.id) ? "Remove from saved" : "Save this school"}</button>${safeURL(school.official_url) ? `<a class="button primary" href="${e(safeURL(school.official_url))}" target="_blank" rel="noopener noreferrer">Official university page ${icon("external")}</a>` : ""}</div></section>`;
}

function detailPrograms(programs) {
  return programs.length
    ? `<ul class="detail-program-list">${programs.map((program) => `<li>${e(program.name)}<br><span class="tag">${e(program.topic)}</span>${program.strand_alignment ? `<p>${e(program.strand_alignment)}</p>` : ""}<br>${sourceLink(program.source_url)}</li>`).join("")}</ul>`
    : "<p>No collected program entries match your search.</p>";
}

function openNotes() {
  ++detailVersion;
  state.detail = null;
  $("#detail-body").innerHTML =
    `<header class="detail-head"><span class="eyebrow">A LITTLE CONTEXT</span><h2 id="dialog-title">Clearer choices start with honest data.</h2></header><div class="detail-panel"><h3>What you’re exploring</h3><p>UniMatch PH is an undergraduate research prototype for discovering Metro Manila universities and degree programs. The directory currently includes ${e(state.stats?.universities ?? state.schools.length)} institutions, with collected records from ${e(state.stats?.collected_universities ?? 0)} schools. Browse each profile for its source links and collection notes.</p><h3>Evidence, with room for review</h3><p>The latest recorded collection date is ${e(dateLabel(state.stats?.latest_collection))}. Source records can include older academic years, legacy pages, combined program titles or multiple campuses. All collected information needs verification; quoted notices should not be treated as current admissions decisions.</p><h3>A few things to keep in mind</h3><p>Missing tuition does not mean free tuition. Missing strand alignment does not establish eligibility. Program counts show collection coverage, not rankings or complete university offerings. Topics are simple browsing categories, not academic recommendations.</p><h3>Your shortlist</h3><p>Saved schools and comparison choices stay in this browser’s local storage and are kept separate for each account. They are not synced across devices or shared between accounts. Accounts are optional, and this prototype does not accept application submissions.</p><h3>Respectful collection</h3><p>The separate collector checks robots.txt, spaces requests and stops on access blocks. Exploring this website reads saved records; it does not scrape university websites on each visit.</p></div>`;
  if (!$("#school-dialog").open) $("#school-dialog").showModal();
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = button.dataset.school;
  switch (button.dataset.action) {
    case "details":
      openDetails(id, button.dataset.tab || "overview");
      break;
    case "save": {
      const index = state.saved.indexOf(id);
      if (index >= 0) state.saved.splice(index, 1);
      else state.saved.push(id);
      persist();
      toast(
        index >= 0
          ? "School removed from your shortlist."
          : "School saved to your shortlist.",
      );
      document.querySelectorAll('[data-action="save"]').forEach((item) => {
        if (item.dataset.school !== id) return;
        const saved = state.saved.includes(id);
        item.setAttribute("aria-pressed", String(saved));
        if (item.classList.contains("save-button"))
          item.setAttribute(
            "aria-label",
            `${saved ? "Unsave" : "Save"} ${state.schools.find((s) => s.id === id)?.short_name || "school"}`,
          );
        else
          item.innerHTML = `${icon("save")}${saved ? "Remove from saved" : "Save this school"}`;
      });
      if (state.view === "saved") render();
      break;
    }
    case "compare": {
      const index = state.compare.indexOf(id);
      if (index >= 0) state.compare.splice(index, 1);
      else if (state.compare.length >= 3) {
        toast(
          "You can compare three schools at a time. Remove one to add another.",
        );
        return;
      } else state.compare.push(id);
      persist();
      render();
      toast(
        index >= 0
          ? "School removed from comparison."
          : "Added to Compare schools in the sidebar.",
      );
      break;
    }
    case "tab":
      state.tab = button.dataset.tab;
      renderDetails();
      $("#tab-" + state.tab)?.focus();
      break;
    case "close-dialog":
      ++detailVersion;
      $("#school-dialog").close();
      break;
    case "notes":
      openNotes();
      break;
    case "browse":
      setView("universities");
      break;
    case "reset":
      setView(state.view);
      break;
    case "retry":
      render();
      break;
    case "next":
      state.page++;
      render();
      break;
    case "previous":
      if (state.page > 1) {
        state.page--;
        render();
      }
      break;
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "recommend-form") return;
  event.preventDefault();
  runRecommendation();
});

$("#search").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  state.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 220);
});
["city", "sector", "topic", "school", "sort"].forEach((id) =>
  $("#" + id).addEventListener("change", (event) => {
    state[id] = event.target.value;
    state.page = 1;
    render();
  }),
);
document.addEventListener("input", (event) => {
  if (event.target.id === "detail-program-search" && state.detail) {
    const query = event.target.value.trim().toLowerCase();
    $("#detail-program-results").innerHTML = detailPrograms(
      state.detail.programs.filter((p) => p.name.toLowerCase().includes(query)),
    );
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "k" &&
    !$("#school-dialog").open &&
    state.view !== "compare"
  ) {
    event.preventDefault();
    $("#search").focus();
  }
  if (event.key === "Escape") closeMenu();
  if (
    event.target.getAttribute("role") === "tab" &&
    ["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next].click();
  }
});
$("#school-dialog").addEventListener("click", (event) => {
  if (event.target === $("#school-dialog")) {
    ++detailVersion;
    $("#school-dialog").close();
  }
});
$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#sidebar-shade").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});
$("#sidebar-shade").addEventListener("click", closeMenu);

async function initialize() {
  try {
    const [stats, schools] = await Promise.all([
      api("/api/stats"),
      api("/api/universities"),
    ]);
    state.stats = stats;
    state.schools = schools.items;
    const ids = new Set(state.schools.map((s) => s.id));
    state.saved = state.saved.filter((id) => ids.has(id));
    state.compare = state.compare.filter((id) => ids.has(id));
    persist();
    $("#city").innerHTML += stats.cities
      .map((city) => `<option>${e(city)}</option>`)
      .join("");
    $("#topic").innerHTML += stats.topics
      .map((topic) => `<option>${e(topic)}</option>`)
      .join("");
    $("#school").innerHTML += state.schools
      .map((s) => `<option value="${e(s.id)}">${e(s.short_name)}</option>`)
      .join("");
    const params = new URLSearchParams(location.search);
    const requestedView = params.get("view") || location.hash.slice(1);
    if (viewTitles[requestedView]) state.view = requestedView;
    state.query = (params.get("search") || "").slice(0, 200);
    state.city = (params.get("city") || "").slice(0, 200);
    state.sector = (params.get("sector") || "").slice(0, 200);
    state.topic = (params.get("topic") || "").slice(0, 200);
    state.school = (params.get("school") || "").slice(0, 200);
    const requestedSort = params.get("sort");
    if (requestedSort === "name" || requestedSort === "featured") {
      state.sort = requestedSort;
    }
    ["search", "city", "sector", "topic", "school"].forEach((id) => {
      const value = id === "search" ? state.query : state[id];
      if (value) $("#" + id).value = value;
    });
    $("#sort").value = state.sort;
    controls();
    await render();

    if (state.school && state.view !== "programs") {
      await openDetails(
        state.school,
        params.get("tab") === "programs" ? "programs" : "overview",
      );
    }
    if (params.get("notes") === "1") openNotes();
  } catch (error) {
    $("#results").setAttribute("aria-busy", "false");
    $("#results-count").textContent = "Unable to load the dataset";
    $("#results").innerHTML =
      `<div class="error-state"><p>${e(error.message)}</p><p>Refresh this page after the server is available.</p></div>`;
  }
}
initialize();
