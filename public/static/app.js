import { createCalendarManager } from "/static/calendar.js";

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
  calendar: "Application calendar",
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
  compareItems: [],
  compareOptions: {
    showThird: false,
    onlyDifferences: false,
    programQuery: "",
  },
  schools: [],
  stats: null,
  detail: null,
  tab: "overview",
  detailTopic: "",
  recommend: {
    program: "",
    city: "",
    sector: "",
    budget: "",
    budgetBasis: "semester",
    limit: 20,
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

const calendarManager = createCalendarManager({
  getSavedIds: () => state.saved,
  getCompareIds: () => state.compare,
  getSchoolById: (id) => state.schools.find((s) => s.id === id) || null,
  schoolMark: (school) => schoolMark(school),
  toast: (msg) => toast(msg),
  setView: (view) => setView(view),
  rerenderIfView: (view) => {
    if (state.view === view) {
      const results = $("#results");
      if (results && view === "calendar") {
        calendarManager.renderCalendarView(results);
      } else {
        render();
      }
    }
  },
});

function liveCatalogApi(path, params = {}) {
  const live = window.__unimatchLiveCatalog;
  if (!live || !Array.isArray(live.records) || live.records.length === 0) {
    return null;
  }
  const allDetails = [...live.detailsById.values()];

  if (path === "/api/stats") {
    const cities = [...new Set(allDetails.map((u) => u.city).filter(Boolean))].sort();
    const topics = [
      ...new Set(
        allDetails.flatMap((u) => (u.programs || []).map((p) => p.topic).filter(Boolean)),
      ),
    ].sort();
    const collected = allDetails.filter((u) => u.collection_status !== "pending").length;
    const latest = allDetails
      .map((u) => u.collected_at || u.last_verified_at)
      .filter(Boolean)
      .sort()
      .pop() || null;
    return {
      universities: allDetails.length,
      collected_universities: collected,
      cities,
      topics,
      latest_collection: latest,
    };
  }

  if (path === "/api/universities") {
    const q = String(params.search || "").trim().toLowerCase();
    const city = String(params.city || "").trim();
    const sector = String(params.sector || "").trim();
    const sort = String(params.sort || "featured").trim();
    const matched = allDetails.filter((u) => {
      if (city && u.city !== city) return false;
      if (sector && u.sector !== sector) return false;
      if (q) {
        const hay = `${u.name} ${u.short_name} ${u.campus_location}`.toLowerCase();
        if (
          !hay.includes(q) &&
          !(u.programs || []).some((p) => p.name.toLowerCase().includes(q))
        ) {
          return false;
        }
      }
      return true;
    });
    matched.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (b.program_count !== a.program_count) return b.program_count - a.program_count;
      return a.name.localeCompare(b.name);
    });
    return { items: matched, total: matched.length };
  }

  if (path.startsWith("/api/universities/")) {
    const schoolId = decodeURIComponent(path.slice("/api/universities/".length));
    const found = live.detailsById.get(schoolId);
    if (found) return found;
    return null;
  }

  if (path === "/api/programs") {
    const q = String(params.search || "").trim().toLowerCase();
    const schoolId = String(params.university_id || "").trim();
    const topic = String(params.topic || "").trim();
    const page = Math.max(1, Number(params.page || 1));
    const limit = Math.max(1, Math.min(100, Number(params.limit || 12)));
    const joined = [];
    for (const u of allDetails) {
      if (schoolId && u.id !== schoolId) continue;
      for (const p of u.programs || []) {
        if (topic && p.topic !== topic) continue;
        if (q) {
          const hay = `${p.name} ${u.name} ${u.short_name}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        joined.push(p);
      }
    }
    joined.sort(
      (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)),
    );
    const start = (page - 1) * limit;
    return {
      items: joined.slice(start, start + limit),
      total: joined.length,
      page,
      limit,
    };
  }

  if (path === "/api/compare") {
    const ids = String(params.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const items = ids.map((id) => live.detailsById.get(id)).filter(Boolean);
    return items.length ? { items } : null;
  }

  if (path === "/api/recommendations") {
    const budget =
      params.budget !== undefined && params.budget !== "" && params.budget !== null
        ? Number(params.budget)
        : null;
    const validBudget = budget !== null && Number.isFinite(budget) ? budget : null;
    return live.scoreRecommendations(
      live.records,
      {
        program: String(params.program || ""),
        city: String(params.city || ""),
        sector: String(params.sector || ""),
        budget: validBudget,
        budget_basis: validBudget !== null ? String(params.budget_basis || "semester") : null,
      },
      params.weights ? String(params.weights) : null,
      Number(params.limit || 20),
    );
  }

  return null;
}

async function api(path, params = {}) {
  const liveResult = liveCatalogApi(path, params);
  if (liveResult !== null) {
    return liveResult;
  }
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

function persist(syncCloud = true) {
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
  if (syncCloud) {
    window.dispatchEvent(
      new CustomEvent("unimatch:shortlist-changed", {
        detail: { saved: [...state.saved], compare: [...state.compare] },
      }),
    );
  }
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

function shortLocation(campusLocation, city) {
  const raw = String(campusLocation || city || "Manila").trim();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^metro manila$/i.test(p));
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
  }
  return parts[0] || city || "Manila";
}

const UNIVERSITY_LOGOS = {
  "dlsu-manila": "/static/logos/dlsu-manila.png",
  "pup-sta-mesa": "/static/logos/pup-sta-mesa.png",
  "ust-manila": "/static/logos/ust-manila.png",
  "adamson-manila": "/static/logos/adamson-manila.png",
  "plm-manila": "/static/logos/plm-manila.png",
  "ue-manila": "/static/logos/ue-manila.png",
  "ceu-manila": "/static/logos/ceu-manila.png",
  "tup-manila": "/static/logos/tup-manila.png",
  "pnu-manila": "/static/logos/pnu-manila.png",
  "sanbeda-manila": "/static/logos/sanbeda-manila.png",
  "up-manila": "/static/logos/up-manila.png",
  spumanila: "/static/logos/spumanila.png",
  "feu-manila": "/static/logos/feu-manila.png",
  "lpu-manila": "/static/logos/lpu-manila.png",
  "mapua-manila": "/static/logos/mapua-manila.png",
};

function resolveSchoolLogo(school) {
  const id = String(school?.university_id || school?.id || "")
    .trim()
    .toLowerCase();
  if (id && UNIVERSITY_LOGOS[id]) return UNIVERSITY_LOGOS[id];
  return "";
}

function schoolMark(school, small = false) {
  const raw = String(school?.short_name || "").trim();
  const mark = raw.startsWith("UP") ? "UP" : raw || "UNI";
  const wide = mark.length > 4 ? "wide" : "";
  const color = school?.color || "";
  const logoUrl = resolveSchoolLogo(school);
  const label = school?.name || school?.university_name || raw || "University";
  if (logoUrl) {
    return `<span class="school-mark has-logo ${e(color)} ${small ? "small" : ""}" title="${e(label)}"><img class="school-logo-img" src="${e(logoUrl)}" alt="${e(label)} logo" loading="lazy" decoding="async" referrerpolicy="no-referrer" /><span class="school-mark-fallback" aria-hidden="true">${e(mark)}</span></span>`;
  }
  return `<span class="school-mark ${e(color)} ${small ? "small" : ""} ${wide}" aria-hidden="true">${e(mark)}</span>`;
}

function statusTag(school) {
  return school.collection_status === "pending"
    ? '<span class="meta-status">Pending</span>'
    : "";
}

function shortExamLabel(raw) {
  if (!raw) return "Check portal";
  return String(raw)
    .replace(/College Entrance Examination/i, "Entrance Exam")
    .trim();
}

function schoolCard(school) {
  const saved = state.saved.includes(school.id),
    compared = state.compare.includes(school.id);
  const examLabel = shortExamLabel(school.exam_summary);
  const tuitionLabel = school.free_tuition
    ? "Free (RA 10931)"
    : school.tuition_amount_count
      ? "See fee guide"
      : "Check portal";
  const tuitionClass = school.free_tuition ? "metric-value is-free" : "metric-value";
  return `<article class="school-card ${e(school.color)}" data-school-card="${e(school.id)}">
    <div class="card-top">
      ${schoolMark(school)}
      <button class="icon-button save-button" data-action="save" data-school="${e(school.id)}" aria-pressed="${saved}" aria-label="${saved ? "Unsave" : "Save"} ${e(school.short_name)}">${icon("save")}</button>
    </div>
    <h3><button class="card-title-btn" data-action="details" data-school="${e(school.id)}">${e(school.name)}</button></h3>
    <p class="card-meta"><span>${e(school.sector)}</span><span aria-hidden="true">·</span><span>${e(shortLocation(school.campus_location, school.city))}</span></p>
    <div class="card-stats">
      <div>
        <span class="metric-label">Programs</span>
        <span class="metric-value"><strong>${school.program_count || 0}</strong> degrees</span>
      </div>
      <div>
        <span class="metric-label">Entrance exam</span>
        <span class="metric-value">${e(examLabel)}</span>
      </div>
      <div>
        <span class="metric-label">Tuition</span>
        <span class="${tuitionClass}">${e(tuitionLabel)}</span>
      </div>
    </div>
    <div class="card-footer">
      <button class="text-button" data-action="details" data-school="${e(school.id)}">Explore school ${icon("arrow")}</button>
      <button class="compare-button" data-action="compare" data-school="${e(school.id)}" aria-pressed="${compared}" aria-label="${compared ? "Remove" : "Add"} ${e(school.short_name)} ${compared ? "from" : "to"} comparison"><span class="compare-check">${icon("check")}</span>Compare</button>
    </div>
  </article>`;
}

function programCard(program) {
  return `<article class="program-card">
    <div class="program-school">${schoolMark(program, true)}<span>${e(program.short_name)}</span><span aria-hidden="true">·</span><span>${e(program.topic)}</span></div>
    <h3>${e(program.name)}</h3>
    ${program.strand_alignment ? `<p class="program-strand">Strand note: ${e(program.strand_alignment)}</p>` : ""}
    <button class="text-button" data-action="details" data-school="${e(program.university_id)}" data-tab="programs">View university ${icon("arrow")}</button>
  </article>`;
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

function renderQuickFilters() {
  const container = $("#quick-filters");
  if (!container) return;
  if (state.view === "universities") {
    const total = state.schools.length || 15;
    const pub = state.schools.filter((s) => s.sector === "Public").length || 5;
    const priv = state.schools.filter((s) => s.sector === "Private").length || 10;
    const buttons = [
      ["", `All (${total})`],
      ["Public", `Public · Free tuition (${pub})`],
      ["Private", `Private (${priv})`],
    ];
    container.hidden = false;
    container.innerHTML = buttons
      .map(
        ([val, label]) =>
          `<button type="button" class="filter-chip" data-action="quick-sector" data-value="${e(val)}" aria-pressed="${state.sector === val}">${e(label)}</button>`,
      )
      .join("");
    return;
  }
  if (state.view === "programs") {
    const topics = state.stats?.topics || [];
    const buttons = [["", "All topics"], ...topics.map((t) => [t, t])];
    container.hidden = false;
    container.innerHTML = buttons
      .map(
        ([val, label]) =>
          `<button type="button" class="filter-chip" data-action="quick-topic" data-value="${e(val)}" aria-pressed="${state.topic === val}">${e(label)}</button>`,
      )
      .join("");
    return;
  }
  container.hidden = true;
  container.innerHTML = "";
}

function controls() {
  const universitiesView = state.view === "universities",
    programs = state.view === "programs",
    compare = state.view === "compare",
    recommend = state.view === "recommend",
    calendar = state.view === "calendar";
  $("#hero").hidden = !universitiesView;
  $("#section-heading").hidden = universitiesView;
  $("#filter-bar").hidden = compare || recommend || calendar;
  $("#results-meta").hidden = compare || recommend || calendar;
  const multiCity = (state.stats?.cities?.length || 0) > 1;
  $("#city-wrap").hidden = !multiCity || programs || recommend || calendar;
  $("#sector-wrap").hidden = universitiesView || programs || recommend || calendar;
  $("#school-wrap").hidden = !programs;
  $("#topic-wrap").hidden = true;
  $("#sort-wrap").hidden = programs || recommend || calendar;
  $("#search").placeholder = programs
    ? "Search a degree or subject (e.g. Nursing, Computer Science)…"
    : "Search a university, degree, or exam (e.g. USTET, Nursing)…";
  const descriptions = {
    universities: [
      "Explore universities",
      "Browse 15 Metro Manila universities with verified programs and admissions info.",
    ],
    programs: [
      "Degree programs",
      "Search undergraduate degrees across all 15 Metro Manila universities.",
    ],
    saved: [
      "Saved schools",
      "Track your application status, upcoming entrance exams, deadlines, and official portals for every university you saved.",
    ],
    calendar: [
      "Application calendar",
      "View confirmed entrance examination dates, application openings, and deadlines from all your saved universities in one calendar.",
    ],
    compare: [
      "Compare schools",
      "Select two universities (or up to three) to compare tuition, entrance exams, programs, and admissions side by side.",
    ],
    recommend: [
      "Find my match",
      "Tell us your preferred program, campus area, budget, or school type to see ranked matches.",
    ],
  };
  $("#section-title").textContent = descriptions[state.view][0];
  $("#section-description").textContent = descriptions[state.view][1];
  $("#breadcrumb-view").textContent = viewTitles[state.view];
  document.querySelectorAll(".nav-item").forEach((button) => {
    const selected = button.dataset.view === state.view;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  renderQuickFilters();
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
    if (state.view === "calendar") {
      await calendarManager.refreshData();
      if (version !== renderVersion) return;
      calendarManager.renderCalendarView(results);
      return;
    }
    if (state.view === "recommend") {
      renderRecommend();
      return;
    }
    if (state.view === "compare") {
      if (!state.compare.length) {
        state.compareItems = [];
        renderComparison([]);
      } else {
        const data = await api("/api/compare", {
          ids: state.compare.join(","),
        });
        if (version !== renderVersion) return;
        state.compareItems = data.items || [];
        renderComparison(state.compareItems);
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
    } else if (state.view === "saved") {
      const [data] = await Promise.all([
        api("/api/universities", {
          search: state.query,
          city: state.city,
          sector: state.sector,
          sort: state.sort,
        }),
        calendarManager.refreshData(),
      ]);
      if (version !== renderVersion) return;
      const schools = data.items.filter((s) => state.saved.includes(s.id));
      $("#results-count").innerHTML =
        `<strong>${schools.length}</strong> ${schools.length === 1 ? "university" : "universities"} on your shortlist`;
      calendarManager.renderSavedDashboardView(results, schools);
    } else {
      const data = await api("/api/universities", {
        search: state.query,
        city: state.city,
        sector: state.sector,
        sort: state.sort,
      });
      if (version !== renderVersion) return;
      const schools = data.items;
      $("#results-count").innerHTML =
        `<strong>${schools.length}</strong> ${schools.length === 1 ? "university" : "universities"} to explore`;
      results.innerHTML = schools.length
        ? `<div class="school-grid">${schools.map(schoolCard).join("")}</div>`
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

function extractCampusArea(campusLocation, city) {
  const parts = String(campusLocation || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^metro manila$/i.test(p));
  if (parts.length >= 2) {
    const cityPart = parts[parts.length - 1];
    const districtPart = parts[parts.length - 2];
    if (cityPart.toLowerCase() === String(city || "Manila").toLowerCase()) {
      return districtPart;
    }
    return `${districtPart}, ${cityPart}`;
  }
  return parts[0] || city || "";
}

function getMatchLocations() {
  const cities = state.stats?.cities || [];
  const areas = new Set();
  for (const s of state.schools) {
    const area = extractCampusArea(s.campus_location, s.city);
    if (area) areas.add(area);
  }
  const items = [];
  if (cities.length > 1) {
    cities.forEach((c) => items.push({ value: c, label: `${c} (all campuses)` }));
  }
  [...areas]
    .sort((a, b) => a.localeCompare(b))
    .forEach((area) => items.push({ value: area, label: area }));
  return items;
}

const QUICK_COMPARE_PAIRS = [
  ["up-manila", "dlsu-manila", "UP Manila vs. DLSU"],
  ["ust-manila", "feu-manila", "UST vs. FEU"],
  ["pup-sta-mesa", "plm-manila", "PUP vs. PLM"],
  ["mapua-manila", "tup-manila", "Mapúa vs. TUP"],
];

function renderCompareSelectorBar() {
  const sortedSchools = [...state.schools].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const showThird =
    state.compare.length >= 3 || state.compareOptions.showThird;
  const slotCount = showThird ? 3 : 2;
  const slotSelect = (slotIdx) => {
    const currentId = state.compare[slotIdx] || "";
    const otherIds = new Set(
      state.compare.filter((id, idx) => idx !== slotIdx && id),
    );
    const options = sortedSchools
      .map((s) => {
        const disabled = otherIds.has(s.id) ? "disabled" : "";
        const selected = s.id === currentId ? "selected" : "";
        return `<option value="${e(s.id)}" ${selected} ${disabled}>${e(s.name)} (${e(s.sector)})</option>`;
      })
      .join("");
    return `<label class="compare-slot-field">
      <span>University ${slotIdx + 1}</span>
      <select class="compare-slot-select" id="compare-slot-${slotIdx}" data-compare-slot="${slotIdx}" aria-label="Select university ${slotIdx + 1}">
        <option value="">Choose a university…</option>
        ${options}
      </select>
    </label>`;
  };

  const canSwap = state.compare.length >= 2;
  const hasAny = state.compare.length > 0;

  return `<section class="compare-picker" aria-label="Select universities to compare">
    <div class="compare-picker-slots ${showThird ? "has-three" : ""}">
      ${slotSelect(0)}
      <button type="button" class="compare-swap-btn" data-action="compare-swap" ${canSwap ? "" : "disabled"} title="Swap University 1 and University 2" aria-label="Swap University 1 and University 2">
        ${icon("compare")}<span>Swap</span>
      </button>
      ${slotSelect(1)}
      ${showThird ? slotSelect(2) : ""}
    </div>
    <div class="compare-picker-actions">
      ${
        !showThird && state.schools.length >= 3
          ? `<button type="button" class="text-button" data-action="compare-add-third">+ Add 3rd university</button>`
          : ""
      }
      ${
        hasAny
          ? `<button type="button" class="compare-clear-btn" data-action="compare-clear">Clear selection</button>`
          : ""
      }
    </div>
  </section>`;
}

function buildCompareInsights(schools) {
  if (schools.length < 2) return "";
  const highlights = [];

  const freeSchools = schools.filter((s) => s.free_tuition);
  const paidSchools = schools.filter((s) => !s.free_tuition);
  if (freeSchools.length > 0 && paidSchools.length > 0) {
    highlights.push(
      `Tuition: Free under RA 10931 at ${freeSchools.map((s) => s.short_name).join(" & ")}`,
    );
  } else if (freeSchools.length === schools.length) {
    highlights.push("Tuition: All selected schools offer free tuition (RA 10931)");
  }

  const byProgs = [...schools].sort(
    (a, b) => (b.program_count || 0) - (a.program_count || 0),
  );
  const diffProgs = (byProgs[0].program_count || 0) - (byProgs[byProgs.length - 1].program_count || 0);
  if (diffProgs > 0) {
    highlights.push(
      `Programs: ${byProgs[0].short_name} lists ${diffProgs} more ${diffProgs === 1 ? "degree" : "degrees"}`,
    );
  }

  const topicSets = schools.map(
    (s) => new Set((s.programs || []).map((p) => p.topic).filter(Boolean)),
  );
  if (topicSets.every((set) => set.size > 0)) {
    const shared = [...topicSets[0]].filter((t) =>
      topicSets.every((set) => set.has(t)),
    );
    const union = new Set(topicSets.flatMap((set) => [...set]));
    highlights.push(`Shared fields: ${shared.length} of ${union.size} subject areas`);
  }

  const sectors = new Set(schools.map((s) => s.sector).filter(Boolean));
  if (sectors.size > 1) {
    highlights.push("Mix: Public vs. Private");
  }

  if (!highlights.length) return "";
  return `<div class="compare-insights" aria-label="Comparison highlights">
    ${highlights
      .map((item) => `<span>${e(item)}</span>`)
      .join('<span class="compare-insight-sep" aria-hidden="true">·</span>')}
  </div>`;
}

function renderCompareTableHtml(schools) {
  const query = state.compareOptions.programQuery.trim().toLowerCase();
  const onlyDiffs = Boolean(state.compareOptions.onlyDifferences);

  const structuredField = (
    school,
    key,
    renderFn,
    emptyText = "Check official portal",
  ) => {
    const rows = school.structured?.[key] || [];
    return rows.length
      ? rows.map(renderFn).join("")
      : `<span class="muted">${e(emptyText)}</span>`;
  };

  const feeText = (fee) => {
    if (fee.amount_min === 0 && fee.amount_max === 0) {
      return '<p class="is-free-text"><strong>Free tuition (RA 10931)</strong></p>';
    }
    if (
      typeof fee.amount_min === "number" &&
      typeof fee.amount_max === "number"
    ) {
      return `<p class="compare-num">PHP ${Number(fee.amount_min).toLocaleString("en-PH")}${
        fee.amount_max === fee.amount_min
          ? ""
          : `–${Number(fee.amount_max).toLocaleString("en-PH")}`
      } per ${e(fee.basis || "term")}</p>`;
    }
    return '<p class="muted">Not published yet</p>';
  };

  const allTopicSets = schools.map(
    (s) => new Set((s.programs || []).map((p) => p.topic).filter(Boolean)),
  );
  const sharedTopics =
    schools.length >= 2 && allTopicSets.every((set) => set.size > 0)
      ? new Set(
          [...allTopicSets[0]].filter((t) =>
            allTopicSets.every((set) => set.has(t)),
          ),
        )
      : new Set();

  const programCell = (school) => {
    const progs = school.programs || [];
    const count = school.program_count || progs.length || 0;
    const topics = [...new Set(progs.map((p) => p.topic).filter(Boolean))].sort();

    if (query) {
      const matched = progs.filter((p) =>
        `${p.name} ${p.topic || ""}`.toLowerCase().includes(query),
      );
      if (matched.length === 0) {
        return `<p class="compare-prog-status is-none">No listed degrees matching “${e(state.compareOptions.programQuery.trim())}”</p>
          <p class="muted compare-num">${count} total listed degrees</p>`;
      }
      const preview = matched.slice(0, 6);
      const extra = matched.length - preview.length;
      return `<p class="compare-prog-status is-found"><strong>${matched.length}</strong> matching ${matched.length === 1 ? "degree" : "degrees"}</p>
        <ul class="compare-list compare-prog-matches">${preview.map((p) => `<li>${e(p.name)}</li>`).join("")}</ul>
        ${extra > 0 ? `<p class="muted">+ ${extra} more matching degrees · <button type="button" class="compare-inline-link" data-action="details" data-school="${e(school.id)}" data-tab="programs">View all</button></p>` : ""}`;
    }

    const topicText = topics.length
      ? `<p class="compare-topics">${topics
          .map((t) =>
            sharedTopics.has(t)
              ? `<span>${e(t)}</span>`
              : `<strong>${e(t)}</strong>`,
          )
          .join('<span aria-hidden="true"> · </span>')}</p>`
      : "";
    return count
      ? `<p class="compare-num"><strong>${count}</strong> listed degrees</p>${topicText}`
      : '<span class="muted">Not listed yet</span>';
  };

  const requirementsCell = (school) => {
    const reqs = school.structured?.admission_requirements || [];
    if (!reqs.length) return '<span class="muted">Check official portal</span>';
    const visible = reqs.slice(0, 4);
    const hidden = reqs.slice(4);
    return `<ul class="compare-list">${visible.map((r) => `<li>${e(r.text)}</li>`).join("")}</ul>${
      hidden.length
        ? `<details class="compare-more"><summary>Show ${hidden.length} more requirement${hidden.length === 1 ? "" : "s"}</summary><ul class="compare-list">${hidden.map((r) => `<li>${e(r.text)}</li>`).join("")}</ul></details>`
        : ""
    }`;
  };

  const deadlinesCell = (school) => {
    const deadlines = school.structured?.application_deadlines || [];
    if (!deadlines.length) {
      return '<span class="muted">Confirm dates on official portal</span>';
    }
    return `<ul class="compare-list">${deadlines
      .slice(0, 4)
      .map(
        (d) =>
          `<li><strong>${e(d.label || "Application date")}</strong>${d.date_iso ? ` — <span class="compare-num">${e(dateLabel(d.date_iso))}</span>` : d.raw_text ? `: ${e(d.raw_text)}` : ""}</li>`,
      )
      .join("")}</ul>`;
  };

  const rows = [
    {
      label: "Campus & district",
      key: (s) => String(s.campus_location || s.city || "").toLowerCase(),
      render: (s) => e(s.campus_location || s.city || "Not specified"),
    },
    {
      label: "University type",
      key: (s) => String(s.sector || "").toLowerCase(),
      render: (s) => `<strong>${e(s.sector)}</strong> university`,
    },
    {
      label: "Tuition & cost",
      key: (s) => {
        if (s.free_tuition) return "free";
        const fees = s.structured?.tuition_fees || [];
        return fees.map((f) => `${f.amount_min}-${f.amount_max}-${f.basis}`).join("|") || "unknown";
      },
      render: (s) => {
        if (s.free_tuition) {
          return '<p class="is-free-text"><strong>Free tuition (RA 10931)</strong></p><p class="muted">Eligible Filipino undergraduates</p>';
        }
        return structuredField(s, "tuition_fees", feeText, "Not published yet — check portal");
      },
    },
    {
      label: "Entrance exam",
      key: (s) =>
        (s.structured?.entrance_examinations || [])
          .map((r) => `${r.exam_name || ""}|${r.coverage || ""}`)
          .join(";")
          .toLowerCase() || (s.exam_summary || "").toLowerCase(),
      render: (s) =>
        structuredField(
          s,
          "entrance_examinations",
          (row) =>
            `<p><strong>${e(row.exam_name || "Entrance exam")}</strong>${row.coverage ? `<br><span class="muted">${e(row.coverage)}</span>` : ""}</p>`,
        ),
    },
    {
      label: query ? "Matching programs" : "Degree programs",
      key: (s) =>
        query
          ? String(
              (s.programs || []).filter((p) =>
                `${p.name} ${p.topic || ""}`.toLowerCase().includes(query),
              ).length,
            )
          : `${s.program_count || 0}|${[...new Set((s.programs || []).map((p) => p.topic))].sort().join(",")}`,
      render: programCell,
    },
    {
      label: "Application dates",
      key: (s) =>
        (s.structured?.application_deadlines || [])
          .map((d) => `${d.label}|${d.date_iso || d.raw_text}`)
          .join(";")
          .toLowerCase(),
      render: deadlinesCell,
    },
    {
      label: "Freshman requirements",
      key: (s) =>
        (s.structured?.admission_requirements || [])
          .map((r) => r.text)
          .join(";")
          .toLowerCase(),
      render: requirementsCell,
    },
    {
      label: "Academic year",
      key: (s) => `${structuredYear(s.structured)}|${dateLabel(s.structured?.last_verified_at || s.collected_at)}`,
      render: (s) =>
        `<p class="compare-num"><strong>${e(structuredYear(s.structured))}</strong></p><p class="muted compare-num">Checked ${e(dateLabel(s.structured?.last_verified_at || s.collected_at))}</p>`,
    },
    {
      label: "Official links",
      key: (s) =>
        (s.structured?.application_links || []).map((l) => l.url).join("|"),
      render: (s) => applicationLinkList(s.structured),
    },
  ];

  const evaluatedRows = rows.map((row) => {
    const keys = new Set(schools.map((s) => row.key(s)));
    return { ...row, differs: schools.length >= 2 && keys.size > 1 };
  });

  const visibleRows = onlyDiffs
    ? evaluatedRows.filter((row) => row.differs)
    : evaluatedRows;

  if (onlyDiffs && visibleRows.length === 0) {
    return `<div class="empty-state compare-no-diffs">
      <h3>All compared fields match</h3>
      <p>Switch back to All criteria to review the complete details side by side.</p>
      <button type="button" class="button secondary" data-action="compare-diff-mode" data-value="all">Show all criteria</button>
    </div>`;
  }

  return `<div class="compare-scroll" role="region" aria-label="University comparison table" tabindex="0">
    <table class="compare-table">
      <thead>
        <tr>
          <th scope="col" class="compare-sticky-col">Criteria</th>
          ${schools
            .map(
              (school) => `<th scope="col" class="compare-school">
                <div class="compare-school-top">
                  ${schoolMark(school)}
                  <div class="compare-school-titles">
                    <h3>${e(school.name)}</h3>
                    <p class="compare-school-sub">${e(school.sector)} <span aria-hidden="true">·</span> ${e(shortLocation(school.campus_location, school.city))}</p>
                  </div>
                </div>
                <div class="compare-head-actions">
                  <button type="button" class="text-button" data-action="details" data-school="${e(school.id)}">View details ${icon("arrow")}</button>
                  <button type="button" class="compare-remove" data-action="compare" data-school="${e(school.id)}" aria-label="Remove ${e(school.short_name)} from comparison">Remove</button>
                </div>
              </th>`,
            )
            .join("")}
        </tr>
      </thead>
      <tbody>
        ${visibleRows
          .map(
            (row) => `<tr class="${row.differs ? "is-diff" : ""}">
              <th scope="row" class="compare-sticky-col">
                <span>${e(row.label)}</span>
                ${row.differs && schools.length >= 2 ? '<span class="compare-diff-note">Differs</span>' : ""}
              </th>
              ${schools.map((school) => `<td>${row.render(school)}</td>`).join("")}
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function updateCompareTableOnly() {
  const host = $("#compare-table-host");
  if (!host || !state.compareItems.length) return;
  host.innerHTML = renderCompareTableHtml(state.compareItems);
}

function renderComparison(schools) {
  const pickerHtml = renderCompareSelectorBar();

  if (!schools.length) {
    const validPairs = QUICK_COMPARE_PAIRS.filter(
      ([a, b]) =>
        state.schools.some((s) => s.id === a) &&
        state.schools.some((s) => s.id === b),
    );
    $("#results").innerHTML = `${pickerHtml}
      <div class="empty-state compare-empty">
        <div class="empty-icon">${icon("compare")}</div>
        <h3>Pick two universities above to compare side by side</h3>
        <p>Select any two Metro Manila universities from the dropdowns above, or start with a popular comparison below.</p>
        ${
          validPairs.length
            ? `<div class="compare-quick-pairs">
                ${validPairs
                  .map(
                    ([a, b, label]) =>
                      `<button type="button" class="filter-chip" data-action="compare-pair" data-pair="${e(`${a},${b}`)}">${e(label)}</button>`,
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>`;
    return;
  }

  const singleSchoolHint =
    schools.length === 1
      ? (() => {
          const picked = schools[0];
          const counterCandidates = state.schools
            .filter((s) => s.id !== picked.id && s.sector !== picked.sector)
            .slice(0, 3);
          return `<div class="compare-single-banner">
            <div>
              <strong>Add a second university</strong>
              <p>Choose University 2 in the selector above to compare ${e(picked.short_name)} side by side.</p>
            </div>
            ${
              counterCandidates.length
                ? `<div class="compare-quick-pairs">
                    ${counterCandidates
                      .map(
                        (other) =>
                          `<button type="button" class="filter-chip" data-action="compare-pair" data-pair="${e(`${picked.id},${other.id}`)}">Compare with ${e(other.short_name)}</button>`,
                      )
                      .join("")}
                  </div>`
                : ""
            }
          </div>`;
        })()
      : "";

  const toolbarHtml =
    schools.length >= 2
      ? `<div class="compare-toolbar">
          <label class="compare-program-search">
            ${icon("search")}
            <span class="sr-only">Check a degree program across compared universities</span>
            <input
              id="compare-program-search"
              type="search"
              maxlength="120"
              autocomplete="off"
              placeholder="Check a degree across these schools (e.g. Computer Science, Nursing)…"
              value="${e(state.compareOptions.programQuery)}"
            />
          </label>
          <div class="compare-segmented" role="group" aria-label="Filter comparison rows">
            <button type="button" data-action="compare-diff-mode" data-value="all" aria-pressed="${!state.compareOptions.onlyDifferences}">All criteria</button>
            <button type="button" data-action="compare-diff-mode" data-value="diff" aria-pressed="${state.compareOptions.onlyDifferences}">Only differences</button>
          </div>
        </div>`
      : "";

  const insightsHtml = buildCompareInsights(schools);

  $("#results").innerHTML = `${pickerHtml}${singleSchoolHint}${insightsHtml}${toolbarHtml}<div id="compare-table-host">${renderCompareTableHtml(schools)}</div>`;
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
          <p class="match-program"><span>${e(item.topic || "University-wide match")}</span>${item.unknown ? '<span aria-hidden="true">·</span><span class="match-unknown-note">Some source data unknown</span>' : ""}</p>
        </div>
        <div class="match-score" aria-label="Match score ${e(item.score)} out of 100">
          <strong>${e(item.score)}</strong><span>match score</span>
        </div>
      </div>
      <progress class="score-track" max="100" value="${Math.max(0, Math.min(100, Number(item.score) || 0))}" aria-hidden="true"></progress>
      <ul class="explain-list">${explanations}</ul>
      <div class="match-actions">
        <button type="button" class="text-button" data-action="details" data-school="${e(item.university_id)}">View university ${icon("arrow")}</button>
        <button type="button" class="compare-button" data-action="compare" data-school="${e(item.university_id)}" aria-pressed="${compared}" aria-label="${compared ? "Remove" : "Add"} ${e(item.short_name || item.university_name)} ${compared ? "from" : "to"} comparison"><span class="compare-check">${icon("check")}</span>Compare</button>
      </div>
    </div>
  </article>`;
}

function recommendationGroup(group) {
  const best = group.items.reduce(
    (highest, item) => Math.max(highest, Number(item.score) || 0),
    0,
  );
  const matchedSchool = state.schools.find((s) => s.id === group.university_id);
  const markSource = matchedSchool || {
    id: group.university_id,
    name: group.university_name,
    short_name: group.short_name,
    color: "green",
  };
  const programCountLabel =
    group.items.length === 1 && !group.items[0].program_name
      ? "University match"
      : `${group.items.length} matching ${group.items.length === 1 ? "program" : "programs"}`;
  return `<section class="match-group">
    <header class="match-group-head">
      <div class="match-group-title-row">
        ${schoolMark(markSource)}
        <div>
          <h3>${e(group.university_name)}</h3>
          <p class="card-location">${icon("pin")}${e(group.campus_location || "Campus not available")}</p>
        </div>
      </div>
      <div class="match-group-meta">
        <strong>${e(best)}<span>/100 best</span></strong>
        <span class="match-group-count">${e(programCountLabel)}</span>
      </div>
    </header>
    <div class="match-group-list">${group.items.map((item) => recommendationRow(item, item.rank)).join("")}</div>
  </section>`;
}

function recommendationOutput(result, error, loading) {
  if (loading) {
    return '<div class="loading-state recommend-loading">Finding your best university matches…</div>';
  }
  if (error) {
    return `<div class="error-state"><p>${e(error)}</p><p>Adjust a preference or try again.</p></div>`;
  }
  if (!result) {
    const picks = [
      "Computer Science",
      "Nursing",
      "Accountancy",
      "Architecture",
      "Psychology",
      "Engineering",
    ];
    return `<div class="empty-state recommend-placeholder">
      <div class="empty-icon">${icon("spark")}</div>
      <h3>See which universities fit you best</h3>
      <p>Enter a degree, campus area, budget, or school type — or try a popular program below.</p>
      <div class="match-quick-picks">
        ${picks.map((p) => `<button type="button" class="filter-chip" data-action="quick-match" data-value="${e(p)}">${e(p)}</button>`).join("")}
      </div>
    </div>`;
  }
  if (!result.items?.length) {
    return emptyState(
      "No matches found",
      "Try a broader degree keyword (e.g. Engineering, Nursing, Computer Science) or adjust one of your filters.",
      "recommend-reset",
      "Reset preferences",
      "spark",
    );
  }
  const groups = groupRecommendations(result.items);
  const topTwoIds = groups.slice(0, 2).map((g) => g.university_id).filter(Boolean);
  const showingAll = result.items.length >= result.total;
  const headingText = showingAll
    ? `${result.items.length} ${result.items.length === 1 ? "match" : "matches"} across ${groups.length} universit${groups.length === 1 ? "y" : "ies"}`
    : `Showing top ${result.items.length} of ${result.total} matches across ${groups.length} universit${groups.length === 1 ? "y" : "ies"}`;
  const canShowMore = result.total > result.items.length && result.limit < 60;

  return `<div class="recommend-summary">
      <div>
        <h3>${e(headingText)}</h3>
        <details class="score-info-toggle">
          <summary>How scores work</summary>
          <p>${e(result.formula || "")} ${e(result.unknown_policy || "Missing source data scores 0 and is labeled unknown.")}</p>
        </details>
      </div>
      ${
        topTwoIds.length === 2
          ? `<button type="button" class="button secondary compare-top-btn" data-action="compare-pair" data-pair="${e(topTwoIds.join(","))}">${icon("compare")}Compare top 2</button>`
          : ""
      }
    </div>
    <div class="match-list">${groups.map(recommendationGroup).join("")}</div>
    ${
      canShowMore
        ? `<div class="recommend-more-wrap"><button type="button" class="button secondary" data-action="recommend-more">Show more matches (${Math.min(60, result.total)} max)</button></div>`
        : ""
    }`;
}

function updateWeightSumLabel() {
  const el = $("#rec-weight-sum");
  if (!el) return;
  let sum = 0;
  for (const name of ["program", "location", "budget", "sector"]) {
    const val = Number($("#rec-weight-" + name)?.value || 0);
    if (Number.isFinite(val) && val > 0) sum += val;
  }
  if (sum <= 0) {
    el.textContent = "Total: 0% — set at least one weight above 0";
    el.classList.add("is-invalid");
  } else if (Math.round(sum) === 100) {
    el.textContent = "Total: 100%";
    el.classList.remove("is-invalid");
  } else {
    el.textContent = `Total: ${Math.round(sum)}% (auto-normalized to 100%)`;
    el.classList.remove("is-invalid");
  }
}

function updateRecommendOutput() {
  const out = $(".recommend-output");
  if (!out) {
    renderRecommend();
    return;
  }
  out.innerHTML = recommendationOutput(
    state.recommend.result,
    state.recommend.error,
    state.recommend.loading,
  );
  const submit = $(".recommend-submit");
  if (submit) submit.disabled = Boolean(state.recommend.loading);
}

function renderRecommend() {
  const rec = state.recommend;
  const locations = getMatchLocations();
  const weightInput = (name, label) => `<label class="weight-field"><span>${e(label)}</span><input id="rec-weight-${e(name)}" type="number" min="0" max="100" step="5" value="${Math.round(Number(rec.weights[name] || 0) * 100)}" aria-label="${e(label)} weight in percent"><span class="weight-unit">%</span></label>`;
  $("#results").innerHTML = `<div class="recommend-layout">
    <form class="recommend-form" id="recommend-form" novalidate>
      <div class="recommend-form-head">
        <h3>Your preferences</h3>
        <p>Fill in at least one field. Leave anything blank if it doesn’t matter.</p>
      </div>
      <label class="recommend-field"><span>Preferred degree or field</span><input id="rec-program" type="search" maxlength="200" autocomplete="off" placeholder="e.g. Computer Science, Nursing, BS Accountancy, IT" value="${e(rec.program)}"></label>
      <label class="recommend-field"><span>Campus area</span><select id="rec-city"><option value="">Any Manila campus</option>${locations.map((loc) => `<option value="${e(loc.value)}" ${loc.value === rec.city ? "selected" : ""}>${e(loc.label)}</option>`).join("")}</select></label>
      <label class="recommend-field"><span>University type</span><select id="rec-sector"><option value="">Public or Private</option><option value="Public" ${rec.sector === "Public" ? "selected" : ""}>Public (Free tuition via RA 10931)</option><option value="Private" ${rec.sector === "Private" ? "selected" : ""}>Private</option></select></label>
      <div class="recommend-budget">
        <label class="recommend-field"><span>Budget (PHP)</span><input id="rec-budget" type="number" min="0" max="10000000" step="1000" inputmode="numeric" placeholder="Optional" value="${e(rec.budget)}"></label>
        <label class="recommend-field"><span>Per</span><select id="rec-basis">${["semester", "trimester", "year", "unit"].map((basis) => `<option value="${basis}" ${basis === rec.budgetBasis ? "selected" : ""}>${basis}</option>`).join("")}</select></label>
      </div>
      <details class="weight-panel">
        <summary>Customize priority weights</summary>
        <p>Adjust how much each factor counts toward your match score.</p>
        <div class="weight-grid">
          ${weightInput("program", "Program")}
          ${weightInput("location", "Location")}
          ${weightInput("budget", "Budget")}
          ${weightInput("sector", "School type")}
        </div>
        <p class="weight-sum" id="rec-weight-sum">Total: 100%</p>
      </details>
      <div class="recommend-form-actions">
        <button class="button primary recommend-submit" type="submit" ${rec.loading ? "disabled" : ""}>${icon("spark")}Find my matches</button>
        <button class="button secondary recommend-reset-btn" type="button" data-action="recommend-reset">Clear</button>
      </div>
    </form>
    <div class="recommend-output" aria-live="polite">${recommendationOutput(rec.result, rec.error, rec.loading)}</div>
  </div>`;
  updateWeightSumLabel();
  $("#results").setAttribute("aria-busy", "false");
}

async function runRecommendation(resetLimit = true) {
  const rec = state.recommend;
  const read = (id) => ($("#" + id)?.value || "").trim();
  if ($("#recommend-form")) {
    rec.program = read("rec-program");
    rec.city = read("rec-city");
    rec.sector = read("rec-sector");
    rec.budget = read("rec-budget");
    rec.budgetBasis = read("rec-basis") || "semester";
    const weights = {};
    let weightTotal = 0;
    for (const name of ["program", "location", "budget", "sector"]) {
      const raw = Number(read("rec-weight-" + name));
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        rec.error = "Each criterion weight must be a number from 0 to 100.";
        rec.result = null;
        updateRecommendOutput();
        return;
      }
      weights[name] = raw / 100;
      weightTotal += raw;
    }
    if (weightTotal <= 0) {
      rec.error = "At least one criterion weight must be greater than 0%.";
      rec.result = null;
      updateRecommendOutput();
      return;
    }
    rec.weights = weights;
  }
  if (resetLimit) rec.limit = 20;
  if (!rec.program && !rec.city && !rec.sector && rec.budget === "") {
    rec.error =
      "Add at least one preference: a program, campus area, budget, or university type.";
    rec.result = null;
    updateRecommendOutput();
    return;
  }
  if (
    rec.budget !== "" &&
    (!Number.isFinite(Number(rec.budget)) || Number(rec.budget) < 0)
  ) {
    rec.error = "Budget must be a non-negative number.";
    rec.result = null;
    updateRecommendOutput();
    return;
  }
  rec.loading = true;
  rec.error = "";
  rec.result = null;
  updateRecommendOutput();
  const params = {
    program: rec.program,
    city: rec.city,
    sector: rec.sector,
    limit: rec.limit || 20,
    weights: Object.entries(rec.weights)
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
    updateRecommendOutput();
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

function formatFeeRow(row) {
  if (row.amount_min === 0 && row.amount_max === 0) {
    return "Free Tuition (RA 10931)";
  }
  if (typeof row.amount_min === "number" && typeof row.amount_max === "number") {
    return `PHP ${Number(row.amount_min).toLocaleString("en-PH")}${
      row.amount_max === row.amount_min
        ? ""
        : `–${Number(row.amount_max).toLocaleString("en-PH")}`
    } per ${e(row.basis || "term")}`;
  }
  return "See official fee schedule";
}

function structuredAdmissions(structured) {
  if (!structured) {
    return '<p class="not-available">Admissions details are not available yet. Visit the university’s official website for current guidelines.</p>';
  }

  const exams = structured.entrance_examinations || [];
  const examSection = exams.length
    ? `<section class="profile-section">
        <h3>Entrance exam</h3>
        <ul class="structured-list">${exams
          .map(
            (row) =>
              `<li><p><strong>${e(row.exam_name || "Entrance examination")}</strong></p>${row.coverage ? `<p>${e(row.coverage)}</p>` : ""}${sourceLink(row.source_url, "Official exam info")}</li>`,
          )
          .join("")}</ul>
      </section>`
    : "";

  const allFees = structured.tuition_fees || [];
  const verifiedFees = allFees.filter(
    (row) => typeof row.amount_min === "number" || typeof row.amount_max === "number",
  );
  const feeFallbackUrl = allFees.map((r) => safeURL(r.source_url)).find(Boolean) || null;
  const feeSection = `<section class="profile-section">
    <h3>Tuition &amp; fees</h3>
    ${
      verifiedFees.length
        ? `<ul class="structured-list">${verifiedFees
            .map(
              (row) =>
                `<li><p><strong>${formatFeeRow(row)}</strong></p>${row.raw_text ? `<p>${e(row.raw_text)}</p>` : ""}${sourceLink(row.source_url, "Official fee page")}</li>`,
            )
            .join("")}</ul>`
        : `<p class="muted-note">Tuition rates aren’t listed here yet so we don’t guess — check the official fee guide directly on the university’s site.${feeFallbackUrl ? ` ${sourceLink(feeFallbackUrl, "Official fee page")}` : ""}</p>`
    }
  </section>`;

  const reqs = structured.admission_requirements || [];
  const reqSection = reqs.length
    ? `<section class="profile-section">
        <h3>Freshman requirements</h3>
        <ul class="req-checklist">${reqs
          .map(
            (row) =>
              `<li><span>${e(row.text)}</span>${sourceLink(row.source_url, "Source")}</li>`,
          )
          .join("")}</ul>
      </section>`
    : "";

  const deadlines = structured.application_deadlines || [];
  const deadlineSection = deadlines.length
    ? `<section class="profile-section">
        <h3>Application dates</h3>
        <ul class="structured-list">${deadlines
          .map(
            (row) =>
              `<li><p><strong>${e(row.label || "Application date")}</strong>${row.date_iso ? ` — ${e(dateLabel(row.date_iso))}` : ""}</p>${row.raw_text ? `<p>${e(row.raw_text)}</p>` : ""}${sourceLink(row.source_url, "Official schedule")}</li>`,
          )
          .join("")}</ul>
      </section>`
    : "";

  const links = (structured.application_links || []).filter((l) => safeURL(l.url));
  const linkSection = links.length
    ? `<section class="profile-section">
        <h3>Official portals</h3>
        <div class="portal-links">${links
          .map(
            (row) =>
              `<a class="portal-link-card" href="${e(safeURL(row.url))}" target="_blank" rel="noopener noreferrer">${e(row.label || "Official admissions portal")} <span aria-hidden="true">↗</span></a>`,
          )
          .join("")}</div>
      </section>`
    : "";

  const conflicts = (state.detail?.declared_conflicts || []).length
    ? `<div class="evidence-note conflict-note"><strong>Source differences to verify</strong>${state.detail.declared_conflicts.map((row) => `<p>${e(row.field)}: kept “${e(row.kept_value)}” over “${e(row.discarded_value)}”.</p>`).join("")}</div>`
    : "";

  return `<div class="structured-profile">
    ${examSection}
    ${feeSection}
    ${reqSection}
    ${deadlineSection}
    ${linkSection}
    ${conflicts}
    <p class="muted-note">Application windows change each year — confirm exact dates directly on the official portal above.</p>
  </div>`;
}

async function openDetails(id, tab = "overview") {
  const version = ++detailVersion;
  const dialog = $("#school-dialog");
  state.detail = null;
  state.tab = tab;
  state.detailTopic = "";
  $("#detail-body").innerHTML =
    '<div class="detail-panel"><h2 id="dialog-title">Loading university…</h2><p>Fetching official programs and admissions details.</p></div>';
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
  const examLabel =
    school.exam_summary ||
    school.structured?.entrance_examinations?.[0]?.exam_name ||
    "Check official portal";
  const tuitionLabel = school.free_tuition
    ? "Free (RA 10931)"
    : school.tuition_amount_count
      ? "See Admissions & fees"
      : "Check official portal";

  let content = "";
  if (state.tab === "overview") {
    const links = (school.structured?.application_links || []).filter((l) => safeURL(l.url));
    content = `
      <dl class="detail-facts">
        <div><dt>Degree programs</dt><dd>${school.program_count || 0} listed</dd></div>
        <div><dt>Entrance exam</dt><dd>${e(examLabel)}</dd></div>
        <div><dt>Tuition</dt><dd class="${school.free_tuition ? "is-free-text" : ""}">${e(tuitionLabel)}</dd></div>
      </dl>
      ${
        links.length
          ? `<section class="profile-section">
              <h3>Official links</h3>
              <div class="portal-links">${links
                .map(
                  (l) =>
                    `<a class="portal-link-card" href="${e(safeURL(l.url))}" target="_blank" rel="noopener noreferrer">${e(l.label || "Official page")} <span aria-hidden="true">↗</span></a>`,
                )
                .join("")}</div>
            </section>`
          : ""
      }
      ${
        notes.length
          ? `<section class="profile-section"><h3>About this record</h3><p class="overview-note">${e(notes[0])}</p></section>`
          : ""
      }
      <p class="muted-note">Last checked ${e(dateLabel(school.structured?.last_verified_at || school.collected_at))}. Confirm current intake details directly with admissions.</p>`;
  } else if (state.tab === "programs") {
    const topics = [
      ...new Set((school.programs || []).map((p) => p.topic).filter(Boolean)),
    ].sort();
    const topicBar =
      topics.length > 1
        ? `<div class="modal-topic-filters">${[["", "All"], ...topics.map((t) => [t, t])]
            .map(
              ([val, label]) =>
                `<button type="button" class="filter-chip" data-action="detail-topic" data-value="${e(val)}" aria-pressed="${state.detailTopic === val}">${e(label)}</button>`,
            )
            .join("")}</div>`
        : "";
    const filtered = state.detailTopic
      ? school.programs.filter((p) => p.topic === state.detailTopic)
      : school.programs;
    content = school.program_count
      ? `<label><span class="sr-only">Search this university's programs</span><input class="detail-search" id="detail-program-search" type="search" placeholder="Filter ${school.program_count} programs…" maxlength="200"></label>${topicBar}<div id="detail-program-results">${detailPrograms(filtered)}</div>`
      : "<p class=\"muted-note\">No programs are listed for this university yet.</p>";
  } else {
    content =
      structuredAdmissions(school.structured) +
      `<details class="raw-evidence"><summary>View raw source excerpts</summary>` +
      evidenceBlock(school, "admission_requirements", "Requirements excerpts") +
      evidenceBlock(school, "entrance_exam_coverage", "Exam excerpts") +
      evidenceBlock(school, "tuition_estimates", "Tuition excerpts") +
      `</details>`;
  }

  $("#detail-body").innerHTML =
    `<header class="detail-head">
      <div class="detail-head-row">
        ${schoolMark(school)}
        <div>
          <h2 id="dialog-title">${e(school.name)}</h2>
          <p class="detail-meta">${e(school.sector)} university <span aria-hidden="true">·</span> ${e(school.campus_location)}</p>
        </div>
      </div>
    </header>
    <div class="detail-tabs" role="tablist" aria-label="University details">${tabs.map(([id, label]) => `<button id="tab-${id}" role="tab" data-action="tab" data-tab="${id}" aria-controls="detail-panel" aria-selected="${state.tab === id}" tabindex="${state.tab === id ? "0" : "-1"}">${e(label)}</button>`).join("")}</div>
    <section class="detail-panel" id="detail-panel" role="tabpanel" aria-labelledby="tab-${state.tab}" tabindex="0">
      ${content}
      <div class="dialog-actions">
        <button class="button secondary" data-action="save" data-school="${e(school.id)}" aria-pressed="${state.saved.includes(school.id)}">${icon("save")}${state.saved.includes(school.id) ? "Saved" : "Save school"}</button>
        <button class="button secondary" data-action="compare" data-school="${e(school.id)}" aria-pressed="${state.compare.includes(school.id)}">${state.compare.includes(school.id) ? "In comparison" : "Compare"}</button>
        ${safeURL(school.official_url) ? `<a class="button primary" href="${e(safeURL(school.official_url))}" target="_blank" rel="noopener noreferrer">Official website ${icon("external")}</a>` : ""}
      </div>
    </section>`;
}

function detailPrograms(programs) {
  return programs.length
    ? `<ul class="detail-program-list">${programs
        .map(
          (program) =>
            `<li class="program-row">
              <div class="program-row-main">
                <strong>${e(program.name)}</strong>
                <span class="program-row-meta">${e(program.topic)}${program.strand_alignment ? ` · ${e(program.strand_alignment)}` : ""}</span>
              </div>
              ${sourceLink(program.source_url, "Source")}
            </li>`,
        )
        .join("")}</ul>`
    : '<p class="muted-note">No programs match that filter.</p>';
}

function openNotes() {
  ++detailVersion;
  state.detail = null;
  $("#detail-body").innerHTML =
    `<header class="detail-head"><h2 id="dialog-title">About this data</h2><p class="detail-meta">Sourced from official Metro Manila university portals</p></header>
    <div class="detail-panel">
      <h3>What’s included</h3>
      <p>UniMatch PH covers ${e(state.stats?.universities ?? state.schools.length)} Metro Manila universities with undergraduate programs, entrance exam policies, freshman requirements, and official portal links.</p>
      <h3>Tuition honesty</h3>
      <p>Public universities covered by Republic Act 10931 (Free Higher Education) are marked free for eligible Filipino undergraduates. Private university tuition is left blank unless verified on an official fee schedule.</p>
      <h3>Always double-check dates</h3>
      <p>Application periods and entrance exam schedules change every academic year. Use the official links on each university’s profile to confirm current deadlines.</p>
    </div>`;
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
          item.innerHTML = `${icon("save")}${saved ? "Saved" : "Save school"}`;
      });
      if (state.view === "saved" || state.view === "calendar") {
        render();
      } else {
        void calendarManager.refreshData();
      }
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
      if (state.compare.length < 3) state.compareOptions.showThird = false;
      persist();
      if (state.view === "compare") {
        render();
      } else {
        document.querySelectorAll('[data-action="compare"]').forEach((item) => {
          if (item.dataset.school !== id) return;
          const compared = state.compare.includes(id);
          item.setAttribute("aria-pressed", String(compared));
          if (item.closest("#school-dialog")) {
            item.textContent = compared ? "In comparison" : "Compare";
          }
        });
      }
      toast(
        index >= 0
          ? "School removed from comparison."
          : "Added to Compare schools in the sidebar.",
      );
      break;
    }
    case "compare-swap": {
      if (state.compare.length >= 2) {
        [state.compare[0], state.compare[1]] = [
          state.compare[1],
          state.compare[0],
        ];
        persist();
        render();
      }
      break;
    }
    case "compare-add-third": {
      state.compareOptions.showThird = true;
      renderComparison(state.compareItems);
      $("#compare-slot-2")?.focus();
      break;
    }
    case "compare-clear": {
      state.compare = [];
      state.compareItems = [];
      state.compareOptions = {
        showThird: false,
        onlyDifferences: false,
        programQuery: "",
      };
      persist();
      renderComparison([]);
      toast("Comparison cleared.");
      break;
    }
    case "compare-pair": {
      const pairIds = String(button.dataset.pair || "")
        .split(",")
        .map((s) => s.trim())
        .filter((sid) => state.schools.some((s) => s.id === sid))
        .slice(0, 3);
      if (pairIds.length) {
        state.compare = pairIds;
        state.compareOptions.showThird = pairIds.length >= 3;
        state.compareOptions.onlyDifferences = false;
        persist();
        if (state.view !== "compare") {
          setView("compare");
        } else {
          render();
        }
      }
      break;
    }
    case "compare-diff-mode": {
      state.compareOptions.onlyDifferences = button.dataset.value === "diff";
      document
        .querySelectorAll('[data-action="compare-diff-mode"]')
        .forEach((btn) => {
          const active =
            (btn.dataset.value === "diff") ===
            state.compareOptions.onlyDifferences;
          btn.setAttribute("aria-pressed", String(active));
        });
      updateCompareTableOnly();
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
    case "quick-sector":
      state.sector = button.dataset.value || "";
      $("#sector").value = state.sector;
      state.page = 1;
      renderQuickFilters();
      render();
      break;
    case "quick-topic":
      state.topic = button.dataset.value || "";
      $("#topic").value = state.topic;
      state.page = 1;
      renderQuickFilters();
      render();
      break;
    case "quick-match": {
      const val = button.dataset.value || "";
      const input = $("#rec-program");
      if (input) input.value = val;
      state.recommend.program = val;
      runRecommendation(true);
      break;
    }
    case "recommend-reset": {
      state.recommend = {
        program: "",
        city: "",
        sector: "",
        budget: "",
        budgetBasis: "semester",
        limit: 20,
        weights: {
          program: 0.45,
          location: 0.2,
          budget: 0.2,
          sector: 0.15,
        },
        result: null,
        error: "",
        loading: false,
      };
      renderRecommend();
      break;
    }
    case "recommend-more": {
      state.recommend.limit = Math.min(60, (state.recommend.limit || 20) + 20);
      runRecommendation(false);
      break;
    }
    case "detail-topic": {
      state.detailTopic = button.dataset.value || "";
      renderDetails();
      break;
    }
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
    default:
      calendarManager.handleAction(button.dataset.action, button);
      break;
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (calendarManager.handleChange(target)) return;
  if (
    target instanceof HTMLSelectElement &&
    target.dataset.compareSlot !== undefined
  ) {
    const slotIdx = Number(target.dataset.compareSlot);
    const chosenId = target.value.trim();
    const next = [...state.compare];
    if (chosenId) {
      // Remove if already present at another slot
      const existing = next.indexOf(chosenId);
      if (existing >= 0 && existing !== slotIdx) {
        next.splice(existing, 1);
      }
      if (slotIdx < next.length) next[slotIdx] = chosenId;
      else next.push(chosenId);
    } else if (slotIdx < next.length) {
      next.splice(slotIdx, 1);
    }
    state.compare = [...new Set(next.filter(Boolean))].slice(0, 3);
    if (state.compare.length < 3 && slotIdx === 2 && !chosenId) {
      state.compareOptions.showThird = false;
    }
    persist();
    render();
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "recommend-form") return;
  event.preventDefault();
  runRecommendation(true);
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
    renderQuickFilters();
    render();
  }),
);
document.addEventListener("input", (event) => {
  if (event.target.id === "detail-program-search" && state.detail) {
    const query = event.target.value.trim().toLowerCase();
    const base = state.detailTopic
      ? state.detail.programs.filter((p) => p.topic === state.detailTopic)
      : state.detail.programs;
    $("#detail-program-results").innerHTML = detailPrograms(
      base.filter((p) => p.name.toLowerCase().includes(query)),
    );
  }
  if (event.target.id === "compare-program-search") {
    state.compareOptions.programQuery = event.target.value;
    updateCompareTableOnly();
  }
  if (
    typeof event.target.id === "string" &&
    event.target.id.startsWith("rec-weight-")
  ) {
    updateWeightSumLabel();
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
    persist(false);
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
    const bodyInitialView = document.body.dataset.initialView || "";
    const requestedView =
      params.get("view") || location.hash.slice(1) || bodyInitialView;
    if (viewTitles[requestedView]) state.view = requestedView;
    const requestedCompareIds = (params.get("ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter((sid) => ids.has(sid))
      .slice(0, 3);
    if (requestedCompareIds.length) {
      state.compare = [...new Set(requestedCompareIds)];
      state.compareOptions.showThird = state.compare.length >= 3;
      persist(false);
    }
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
    if (state.view !== "calendar" && state.view !== "saved") {
      void calendarManager.refreshData();
    }

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

window.addEventListener("unimatch:cloud-hydrate", (event) => {
  const detail = event.detail || {};
  const validIds = new Set(state.schools.map((s) => s.id));
  const filterValid = (list, cap) =>
    [...new Set((Array.isArray(list) ? list : []).filter((id) => validIds.size === 0 || validIds.has(id)))].slice(0, cap);

  const cloudSaved = filterValid(detail.savedIds, 50);
  const cloudCompare = filterValid(detail.compareIds, 3);
  const mergedSaved = filterValid([...cloudSaved, ...state.saved], 50);
  const mergedCompare = filterValid([...cloudCompare, ...state.compare], 3);
  const changedFromCloud =
    mergedSaved.length !== cloudSaved.length ||
    mergedCompare.length !== cloudCompare.length;

  state.saved = mergedSaved;
  state.compare = mergedCompare;
  persist(changedFromCloud);

  if (detail.preferences && typeof detail.preferences === "object") {
    const p = detail.preferences;
    if (!state.recommend.program && p.program) state.recommend.program = String(p.program);
    if (!state.recommend.city && p.city) state.recommend.city = String(p.city);
    if (!state.recommend.sector && p.sector) state.recommend.sector = String(p.sector);
    if (state.recommend.budget === "" && p.budget != null) {
      state.recommend.budget = String(p.budget);
    }
    if (p.budgetBasis) state.recommend.budgetBasis = String(p.budgetBasis);
    if (p.weights && typeof p.weights === "object") {
      state.recommend.weights = { ...state.recommend.weights, ...p.weights };
    }
  }
  render();
  if (state.view !== "calendar" && state.view !== "saved") {
    void calendarManager.refreshData();
  }
});

window.addEventListener("unimatch:catalog-updated", async (event) => {
  const count = Number(event.detail?.count || 0);
  if (count <= 0) return;
  try {
    const [stats, schools] = await Promise.all([
      api("/api/stats"),
      api("/api/universities"),
    ]);
    state.stats = stats;
    state.schools = schools.items;
    const resetSelect = (selector, defaultLabel, values) => {
      const el = $(selector);
      if (!el) return;
      const prev = el.value;
      el.innerHTML =
        `<option value="">${e(defaultLabel)}</option>` +
        values.map((v) => `<option value="${e(v.value)}">${e(v.label)}</option>`).join("");
      el.value = prev;
    };
    resetSelect(
      "#city",
      "All locations",
      stats.cities.map((c) => ({ value: c, label: c })),
    );
    resetSelect(
      "#topic",
      "All topics",
      stats.topics.map((t) => ({ value: t, label: t })),
    );
    resetSelect(
      "#school",
      "All universities",
      state.schools.map((s) => ({ value: s.id, label: s.short_name })),
    );
    renderQuickFilters();
    render();
  } catch {
    // Keep existing rendered view on transient refresh issue
  }
});

document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (
      img instanceof HTMLImageElement &&
      img.classList.contains("school-logo-img")
    ) {
      const wrap = img.closest(".school-mark");
      if (wrap) {
        wrap.classList.remove("has-logo");
        wrap.setAttribute("aria-hidden", "true");
      }
      img.remove();
    }
  },
  true,
);

initialize();
