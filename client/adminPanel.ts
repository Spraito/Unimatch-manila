/**
 * UniMatch PH — Admin Catalog Manager, Polite Web Collector & JSON Importer UI.
 *
 * Strictly uses authenticated admin Firebase SDK writes (enforced by firestore.rules)
 * and verified Bearer ID tokens for backend collector/import endpoints.
 */
import type { Auth, User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import {
  deleteCatalogUniversity,
  getFreshIdToken,
  recordCollectionRun,
  saveCatalogUniversity,
  slugifyCatalogId,
  verifyAdminAccess,
  type CatalogDeadline,
  type CatalogExam,
  type CatalogFee,
  type CatalogLink,
  type CatalogProgram,
  type CatalogRequirement,
  type CatalogUniversityRecord,
  type CollectionRunRecord,
  type FirestoreErrorReporter,
} from "./catalogService.js";
import { buildCollectorUrlQueue } from "../src/algorithms/collectorUrlQueue.js";

interface CollectorTargetPage {
  label?: string;
  url: string;
  fields: string[];
}

interface CollectorTarget {
  universityId: string;
  name: string;
  approvedDomains: string[];
  pages: CollectorTargetPage[];
}

interface CollectorConfigSummary {
  userAgent: string;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  timeoutSeconds: number;
  maxPagesPerRun?: number;
  approvedDomains: string[];
  targets: CollectorTarget[];
}

interface CollectorAudit {
  universityId: string;
  universityName: string;
  mode: "polite-web" | "json-import";
  status: "completed" | "partial" | "blocked_by_robots" | "failed";
  fetchedUrlCount: number;
  programCount: number;
  conflictCount: number;
  robotsSummary: string;
  notes: string;
  urls: Array<{
    url: string;
    finalUrl: string;
    robotsAllowed: boolean;
    robotsReason: string;
    httpStatus: number | null;
    status: string;
    detail: string;
    discovered?: boolean;
    sourceKind?: "configured" | "pasted" | "discovered";
  }>;
}

function escapeHTML(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] || ch,
  );
}

function emptyDraft(): CatalogUniversityRecord {
  return {
    id: "",
    name: "",
    shortName: "",
    city: "Manila",
    campusLocation: "",
    sector: "Private",
    color: "green",
    officialUrl: "",
    collectionStatus: "partial",
    academicYear: "",
    academicYears: [],
    isPublished: true,
    programs: [],
    admissionRequirements: [],
    applicationDeadlines: [],
    entranceExaminations: [],
    tuitionFees: [],
    applicationLinks: [],
    declaredConflicts: [],
    sourceUrls: [],
    sourceNotes: [],
    collectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  };
}

export class AdminCatalogController {
  private readonly db: Firestore;
  private readonly auth: Auth;
  private readonly root: HTMLElement;
  private readonly reportError: FirestoreErrorReporter;
  private readonly isSessionAdmin: boolean;
  private readonly sessionDenied: boolean;
  private readonly csrfToken: string;
  private user: User | null = null;
  private isAdmin = false;
  private initialQueryApplied = false;
  private activeTab = "catalog";
  private universities: CatalogUniversityRecord[] = [];
  private runs: CollectionRunRecord[] = [];
  private collectorConfig: CollectorConfigSummary | null = null;
  private editing: CatalogUniversityRecord = emptyDraft();
  private editingIsExisting = false;
  private pendingCollectResult: {
    draft: CatalogUniversityRecord;
    audit: CollectorAudit;
  } | null = null;
  private pendingImportResult: {
    draft: CatalogUniversityRecord;
    audit: CollectorAudit;
  } | null = null;
  private searchTerm = "";

  constructor(
    db: Firestore,
    auth: Auth,
    root: HTMLElement,
    reportError: FirestoreErrorReporter,
  ) {
    this.db = db;
    this.auth = auth;
    this.root = root;
    this.reportError = reportError;
    this.isSessionAdmin = root.dataset.sessionAdmin === "true";
    this.sessionDenied = root.dataset.sessionDenied === "true";
    this.csrfToken = root.dataset.csrfToken || "";
    this.bindEvents();

    if (this.isSessionAdmin && !this.sessionDenied) {
      this.isAdmin = true;
      this.showWorkspace();
      void this.refreshWorkspace();
    }
  }

  private setFeedback(message: string, isError = false): void {
    const el = document.getElementById("admin-feedback");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.toggle("success", !isError);
    el.hidden = !message;
  }

  private showWorkspace(): void {
    const loading = document.getElementById("admin-loading");
    const gateSignedOut = document.getElementById("admin-gate-signed-out");
    const gateDenied = document.getElementById("admin-gate-denied");
    const workspace = document.getElementById("admin-workspace");
    if (loading) loading.hidden = true;
    if (gateSignedOut) gateSignedOut.hidden = true;
    if (gateDenied) gateDenied.hidden = true;
    if (workspace) workspace.hidden = false;
  }

  private setTab(tab: string): void {
    this.activeTab = tab;
    document.querySelectorAll<HTMLButtonElement>("[data-admin-tab]").forEach((btn) => {
      const selected = btn.dataset.adminTab === tab;
      btn.classList.toggle("active", selected);
      btn.setAttribute("aria-selected", String(selected));
    });
    document.querySelectorAll<HTMLElement>("[data-admin-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== tab;
    });
  }

  private async buildAuthHeaders(
    includeJson = false,
    includeCsrf = false,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (includeJson) {
      headers["Content-Type"] = "application/json";
    }
    if (this.isSessionAdmin) {
      if (includeCsrf && this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }
      return headers;
    }
    const token = await getFreshIdToken(this.auth);
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async onAuthChanged(user: User | null): Promise<void> {
    this.user = user;
    if (this.sessionDenied) return;
    if (this.isSessionAdmin) {
      // Local session admin already has full access without requiring Google sign-in
      this.isAdmin = true;
      return;
    }

    const loading = document.getElementById("admin-loading");
    const gateSignedOut = document.getElementById("admin-gate-signed-out");
    const gateDenied = document.getElementById("admin-gate-denied");
    const workspace = document.getElementById("admin-workspace");
    if (!workspace) return;

    if (loading) loading.hidden = false;
    if (!user) {
      this.isAdmin = false;
      if (loading) loading.hidden = true;
      if (gateSignedOut) gateSignedOut.hidden = false;
      if (gateDenied) gateDenied.hidden = true;
      workspace.hidden = true;
      return;
    }

    this.isAdmin = await verifyAdminAccess(this.db, user);
    if (loading) loading.hidden = true;
    if (!this.isAdmin) {
      if (gateSignedOut) gateSignedOut.hidden = true;
      if (gateDenied) gateDenied.hidden = false;
      workspace.hidden = true;
      return;
    }

    this.showWorkspace();
    const adminEmailEl = document.getElementById("admin-account-email");
    if (adminEmailEl) adminEmailEl.textContent = user.email || "";

    await this.refreshWorkspace();
  }

  private applyInitialDeepLink(): void {
    if (this.initialQueryApplied) return;
    this.initialQueryApplied = true;
    const params = new URLSearchParams(window.location.search);
    const editSlug = (params.get("edit") || "").trim().toLowerCase();
    const tabParam = (params.get("tab") || "").trim().toLowerCase();

    if (editSlug) {
      const found = this.universities.find((u) => u.id === editSlug);
      if (found) {
        this.editing = structuredClone(found);
        this.editingIsExisting = true;
        this.populateEditorForm();
        this.setTab("editor");
        return;
      }
    }

    if (["catalog", "editor", "collector", "import"].includes(tabParam)) {
      if (tabParam === "editor") {
        this.editing = emptyDraft();
        this.editingIsExisting = false;
        this.populateEditorForm();
      }
      this.setTab(tabParam);
    }
  }

  private async refreshWorkspace(): Promise<void> {
    if (!this.isAdmin) return;
    try {
      const headers = await this.buildAuthHeaders(false, false);
      const resp = await fetch("/api/admin/catalog", {
        method: "GET",
        credentials: "same-origin",
        headers,
      });

      if (resp.status === 401 || resp.status === 403) {
        const problem = (await resp.json().catch(() => ({}))) as { error?: string };
        this.setFeedback(
          problem.error || "Administrator sign-in is required to manage the catalog.",
          true,
        );
        return;
      }

      const data = (await resp.json()) as {
        error?: string;
        universities?: CatalogUniversityRecord[];
        runs?: CollectionRunRecord[];
        collector?: CollectorConfigSummary;
        actor?: { email: string; displayName: string; source: string };
      };
      if (!resp.ok) {
        throw new Error(data.error || "Could not load the catalog manager.");
      }

      this.universities = Array.isArray(data.universities) ? data.universities : [];
      this.runs = Array.isArray(data.runs) ? data.runs : [];
      if (data.collector) {
        this.collectorConfig = data.collector;
      }
      if (data.actor?.email) {
        const adminEmailEl = document.getElementById("admin-account-email");
        if (adminEmailEl) adminEmailEl.textContent = data.actor.email;
      }

      this.renderCatalogList();
      this.renderCollectorControls();
      this.renderRunHistory();
      this.populateEditorForm();
      this.applyInitialDeepLink();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not load the catalog manager.",
        true,
      );
    }
  }

  private async persistUniversityViaApi(
    record: CatalogUniversityRecord,
    audit?: {
      mode?: "manual-edit" | "polite-web" | "json-import";
      status?: "completed" | "partial" | "blocked_by_robots" | "failed";
      fetchedUrlCount?: number;
      robotsSummary?: string;
      notes?: string;
    },
  ): Promise<CatalogUniversityRecord> {
    const cleanId = slugifyCatalogId(record.id || record.name);
    if (!cleanId) {
      throw new Error("Enter a valid university slug ID or full name first.");
    }
    const headers = await this.buildAuthHeaders(true, true);
    const resp = await fetch(`/api/admin/catalog/${encodeURIComponent(cleanId)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        university: { ...record, id: cleanId },
        audit,
      }),
    });
    const data = (await resp.json()) as {
      error?: string;
      university?: CatalogUniversityRecord;
    };
    if (!resp.ok || !data.university) {
      throw new Error(data.error || "Could not save university to the catalog.");
    }

    // Best-effort Firestore mirror when signed in as a Firebase Google Admin
    if (this.user && !this.isSessionAdmin) {
      void saveCatalogUniversity(
        this.db,
        this.user,
        data.university,
        this.reportError,
      ).catch(() => {});
      if (audit) {
        void recordCollectionRun(
          this.db,
          this.user,
          {
            universityId: data.university.id,
            universityName: data.university.name,
            mode: audit.mode || "manual-edit",
            status: audit.status || "completed",
            fetchedUrlCount: audit.fetchedUrlCount ?? data.university.sourceUrls.length,
            programCount: data.university.programs.length,
            conflictCount: data.university.declaredConflicts.length,
            robotsSummary: audit.robotsSummary || "Direct verified admin catalog update.",
            notes: audit.notes || `Saved ${data.university.name}.`,
          },
          this.reportError,
        ).catch(() => {});
      }
    }

    return data.university;
  }

  private renderCatalogList(): void {
    const listEl = document.getElementById("admin-university-list");
    const statsEl = document.getElementById("admin-catalog-summary");
    if (!listEl) return;

    const totalPrograms = this.universities.reduce(
      (sum, u) => sum + (u.programs?.length || 0),
      0,
    );
    if (statsEl) {
      statsEl.textContent = `${this.universities.length} universities · ${totalPrograms} degree programs in catalog`;
    }

    const q = this.searchTerm.toLowerCase();
    const filtered = this.universities.filter((u) => {
      if (!q) return true;
      return `${u.name} ${u.shortName} ${u.city} ${u.id}`.toLowerCase().includes(q);
    });

    if (!filtered.length) {
      listEl.innerHTML = this.universities.length
        ? '<p class="account-empty">No universities match that search filter.</p>'
        : '<p class="account-empty">Your cloud catalog is empty. Click <strong>Seed baseline (15 schools)</strong> above to populate the Metro Manila directory, or add a university manually.</p>';
      return;
    }

    listEl.innerHTML = `<div class="admin-table-wrap"><table class="admin-table">
      <thead>
        <tr>
          <th>University</th>
          <th>City &amp; type</th>
          <th>Programs</th>
          <th>Fees / dates</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${filtered
          .map(
            (u) => `<tr>
          <td>
            <strong>${escapeHTML(u.name)}</strong>
            <div class="admin-cell-sub">${escapeHTML(u.shortName)} · <code>${escapeHTML(u.id)}</code></div>
          </td>
          <td>${escapeHTML(u.city)} · ${escapeHTML(u.sector)}</td>
          <td>${u.programs.length}</td>
          <td>${u.tuitionFees.length} fee · ${u.applicationDeadlines.length} date</td>
          <td><span class="account-pill">${escapeHTML(u.collectionStatus)}</span></td>
          <td class="admin-row-actions">
            <button type="button" class="button secondary admin-btn-sm" data-admin-edit="${escapeHTML(u.id)}">Edit</button>
            <button type="button" class="button secondary admin-btn-sm admin-btn-danger" data-admin-delete="${escapeHTML(u.id)}">Delete</button>
          </td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table></div>`;
  }

  private getSelectedCollectorTarget(): CollectorTarget | null {
    if (!this.collectorConfig) return null;
    const select = document.getElementById(
      "collector-university-select",
    ) as HTMLSelectElement | null;
    const selectedId = select?.value || this.collectorConfig.targets[0]?.universityId || "";
    return (
      this.collectorConfig.targets.find((t) => t.universityId === selectedId) ||
      this.collectorConfig.targets[0] ||
      null
    );
  }

  private getCollectorQueueState() {
    const target = this.getSelectedCollectorTarget();
    const maxPages = this.collectorConfig?.maxPagesPerRun || 12;
    const checkedBoxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '#collector-pages-checklist input[type="checkbox"][data-collector-page-url]:checked',
      ),
    );
    const checkedUrls = checkedBoxes
      .map((box) => box.dataset.collectorPageUrl || "")
      .filter(Boolean);
    const extraEl = document.getElementById(
      "collector-extra-urls",
    ) as HTMLTextAreaElement | null;
    const pastedText = extraEl?.value || "";
    const approvedDomains =
      target?.approvedDomains || this.collectorConfig?.approvedDomains || [];
    return {
      target,
      queue: buildCollectorUrlQueue(checkedUrls, pastedText, approvedDomains, maxPages),
    };
  }

  private renderSelectedUniversityPages(): void {
    const checklistEl = document.getElementById("collector-pages-checklist");
    const subEl = document.getElementById("collector-pages-sub");
    const target = this.getSelectedCollectorTarget();
    if (!checklistEl) return;

    if (!target) {
      checklistEl.innerHTML =
        '<p class="account-help">Select a configured university to view its official pages.</p>';
      this.updateCollectorUrlStatus();
      return;
    }

    if (subEl) {
      subEl.textContent = `Allowed official domains for ${target.name}: ${target.approvedDomains.join(", ")}`;
    }

    if (!target.pages.length) {
      checklistEl.innerHTML =
        '<p class="account-help">No pre-filled pages configured yet. Paste official URLs below.</p>';
      this.updateCollectorUrlStatus();
      return;
    }

    checklistEl.innerHTML = target.pages
      .map((page, index) => {
        const fieldSummary = (page.fields || [])
          .map((f) => f.replace(/_/g, " "))
          .join(" · ");
        const labelText = page.label || `Official page ${index + 1}`;
        return `<label class="admin-page-item">
          <input
            type="checkbox"
            checked
            data-collector-page-url="${escapeHTML(page.url)}"
          />
          <span class="admin-page-meta">
            <span class="admin-page-title">
              <strong>${escapeHTML(labelText)}</strong>${fieldSummary ? `<span class="admin-page-fields"> · ${escapeHTML(fieldSummary)}</span>` : ""}
            </span>
            <code class="admin-page-url">${escapeHTML(page.url)}</code>
          </span>
        </label>`;
      })
      .join("");

    this.updateCollectorUrlStatus();
  }

  private updateCollectorUrlStatus(): void {
    const statusEl = document.getElementById("collector-url-status");
    const runBtn = document.getElementById(
      "collector-run-btn",
    ) as HTMLButtonElement | null;
    if (!statusEl) return;

    const { target, queue } = this.getCollectorQueueState();
    if (!target) {
      statusEl.textContent = "";
      statusEl.classList.remove("has-error");
      if (runBtn) runBtn.disabled = true;
      return;
    }

    const parts: string[] = [
      `${queue.queuedUrls.length} / ${queue.maxPages} official pages queued`,
    ];
    if (queue.checkedCount > 0 || queue.pastedValidCount > 0) {
      parts.push(
        `${queue.checkedCount} pre-filled · ${queue.pastedValidCount} pasted`,
      );
    }
    if (queue.duplicateCount > 0) {
      parts.push(`${queue.duplicateCount} duplicate skipped`);
    }

    const errors: string[] = [];
    if (queue.queuedUrls.length === 0 && queue.invalidLines.length === 0) {
      errors.push("Select at least one pre-filled page or paste an official .edu.ph URL.");
    }
    if (queue.exceedsMax) {
      errors.push(
        `Limit is ${queue.maxPages} official pages per run. Uncheck or remove ${queue.queuedUrls.length - queue.maxPages} URL(s).`,
      );
    }
    for (const issue of queue.invalidLines.slice(0, 3)) {
      errors.push(`Line ${issue.lineNumber}: ${issue.reason}`);
    }
    if (queue.invalidLines.length > 3) {
      errors.push(`…and ${queue.invalidLines.length - 3} more invalid line(s).`);
    }

    const hasError = errors.length > 0;
    statusEl.classList.toggle("has-error", hasError);
    statusEl.innerHTML = `<div class="admin-url-counter">${escapeHTML(parts.join(" · "))}</div>${
      hasError
        ? `<ul class="admin-url-errors">${errors
            .map((msg) => `<li>${escapeHTML(msg)}</li>`)
            .join("")}</ul>`
        : ""
    }`;

    if (runBtn && !runBtn.dataset.busy) {
      runBtn.disabled = !queue.canRun;
    }
  }

  private renderCollectorControls(): void {
    const select = document.getElementById(
      "collector-university-select",
    ) as HTMLSelectElement | null;
    const domainsEl = document.getElementById("collector-approved-domains");
    const policyEl = document.getElementById("collector-policy-summary");
    if (!this.collectorConfig) return;

    if (select && select.options.length <= 1) {
      select.innerHTML = this.collectorConfig.targets
        .map(
          (t) =>
            `<option value="${escapeHTML(t.universityId)}">${escapeHTML(t.name)} (${t.pages.length} official page${t.pages.length === 1 ? "" : "s"})</option>`,
        )
        .join("");
    }
    if (domainsEl) {
      domainsEl.innerHTML = this.collectorConfig.approvedDomains
        .map((d) => `<span class="admin-domain-chip">${escapeHTML(d)}</span>`)
        .join("");
    }
    if (policyEl) {
      const maxPages = this.collectorConfig.maxPagesPerRun || 12;
      policyEl.textContent = `Checks robots.txt first · up to ${maxPages} official pages per run · ${this.collectorConfig.minDelaySeconds}–${this.collectorConfig.maxDelaySeconds}s polite delay between requests · ${this.collectorConfig.timeoutSeconds}s timeout · stops immediately on 403/429 blocks.`;
    }
    this.renderSelectedUniversityPages();
  }

  private renderRunHistory(): void {
    const container = document.getElementById("admin-run-history");
    if (!container) return;
    if (!this.runs.length) {
      container.innerHTML =
        '<p class="account-empty">No catalog seeds, polite collections, or JSON imports have been logged yet.</p>';
      return;
    }
    container.innerHTML = `<div class="admin-table-wrap"><table class="admin-table">
      <thead>
        <tr>
          <th>Target</th>
          <th>Mode</th>
          <th>Status</th>
          <th>Counts</th>
          <th>Audit notes</th>
        </tr>
      </thead>
      <tbody>
        ${this.runs
          .map(
            (r) => `<tr>
          <td><strong>${escapeHTML(r.universityName)}</strong><div class="admin-cell-sub">${r.createdAtMs ? escapeHTML(new Date(r.createdAtMs).toLocaleString("en-PH")) : "Just now"}</div></td>
          <td><span class="account-status">${escapeHTML(r.mode)}</span></td>
          <td><span class="account-pill">${escapeHTML(r.status)}</span></td>
          <td>${r.fetchedUrlCount} URLs · ${r.programCount} programs · ${r.conflictCount} conflicts</td>
          <td><div>${escapeHTML(r.notes)}</div>${r.robotsSummary ? `<div class="admin-cell-sub">${escapeHTML(r.robotsSummary)}</div>` : ""}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table></div>`;
  }

  private populateEditorForm(): void {
    const u = this.editing;
    const setVal = (id: string, val: string) => {
      const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
      if (el) el.value = val;
    };
    const idInput = document.getElementById("ed-id") as HTMLInputElement | null;
    if (idInput) {
      idInput.value = u.id;
      idInput.readOnly = this.editingIsExisting;
    }
    setVal("ed-name", u.name);
    setVal("ed-short-name", u.shortName);
    setVal("ed-city", u.city);
    setVal("ed-campus", u.campusLocation);
    setVal("ed-sector", u.sector);
    setVal("ed-color", u.color);
    setVal("ed-official-url", u.officialUrl);
    setVal("ed-academic-year", u.academicYear);
    setVal("ed-status", u.collectionStatus);
    const pubBox = document.getElementById("ed-published") as HTMLInputElement | null;
    if (pubBox) pubBox.checked = u.isPublished !== false;
    setVal("ed-source-notes", (u.sourceNotes || []).join("\n"));

    const titleEl = document.getElementById("admin-editor-heading");
    if (titleEl) {
      titleEl.textContent = this.editingIsExisting
        ? `Editing ${u.shortName || u.name}`
        : "Add a new university";
    }

    this.renderEditorLists();
  }

  private renderEditorLists(): void {
    const u = this.editing;

    const progEl = document.getElementById("ed-programs-list");
    if (progEl) {
      progEl.innerHTML = u.programs.length
        ? `<ul class="admin-item-list">${u.programs
            .map(
              (p, idx) => `<li>
            <div><strong>${escapeHTML(p.name)}</strong> <span class="account-status">${escapeHTML(p.topic)}</span>${p.strandAlignment ? `<div class="admin-cell-sub">Strand: ${escapeHTML(p.strandAlignment)}</div>` : ""}</div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-program="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No degree programs added yet.</p>';
    }

    const feeEl = document.getElementById("ed-fees-list");
    if (feeEl) {
      feeEl.innerHTML = u.tuitionFees.length
        ? `<ul class="admin-item-list">${u.tuitionFees
            .map(
              (f, idx) => `<li>
            <div><strong>${f.amountMin !== null ? `PHP ${f.amountMin.toLocaleString("en-PH")}${f.amountMax && f.amountMax !== f.amountMin ? `–${f.amountMax.toLocaleString("en-PH")}` : ""}` : "Note only"}</strong> (${escapeHTML(f.basis)})${f.rawText ? `<div class="admin-cell-sub">${escapeHTML(f.rawText)}</div>` : ""}</div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-fee="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No tuition records added yet.</p>';
    }

    const deadlineEl = document.getElementById("ed-deadlines-list");
    if (deadlineEl) {
      deadlineEl.innerHTML = u.applicationDeadlines.length
        ? `<ul class="admin-item-list">${u.applicationDeadlines
            .map(
              (d, idx) => `<li>
            <div><strong>${escapeHTML(d.label)}</strong>${d.dateIso ? ` — ${escapeHTML(d.dateIso)}` : ""}${d.rawText ? `<div class="admin-cell-sub">${escapeHTML(d.rawText)}</div>` : ""}</div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-deadline="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No deadlines added yet.</p>';
    }

    const reqEl = document.getElementById("ed-reqs-list");
    if (reqEl) {
      reqEl.innerHTML = u.admissionRequirements.length
        ? `<ul class="admin-item-list">${u.admissionRequirements
            .map(
              (r, idx) => `<li>
            <div><span class="account-status">${escapeHTML(r.category)}</span> ${escapeHTML(r.text)}</div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-req="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No admission requirements added yet.</p>';
    }

    const examEl = document.getElementById("ed-exams-list");
    if (examEl) {
      examEl.innerHTML = u.entranceExaminations.length
        ? `<ul class="admin-item-list">${u.entranceExaminations
            .map(
              (e, idx) => `<li>
            <div><strong>${escapeHTML(e.examName)}</strong><div class="admin-cell-sub">${escapeHTML(e.coverage)}</div></div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-exam="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No entrance exam notes added yet.</p>';
    }

    const linkEl = document.getElementById("ed-links-list");
    if (linkEl) {
      linkEl.innerHTML = u.applicationLinks.length
        ? `<ul class="admin-item-list">${u.applicationLinks
            .map(
              (l, idx) => `<li>
            <div><strong>${escapeHTML(l.label)}</strong><div class="admin-cell-sub">${escapeHTML(l.url)}</div></div>
            <button type="button" class="button secondary admin-btn-sm" data-remove-link="${idx}">Remove</button>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="account-help">No official application links added yet.</p>';
    }
  }

  private renderAuditPreview(
    containerId: string,
    result: { draft: CatalogUniversityRecord; audit: CollectorAudit } | null,
    publishAction: string,
    loadAction: string,
  ): void {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!result) {
      el.innerHTML = "";
      return;
    }
    const { draft, audit } = result;
    const formatSourceKind = (u: CollectorAudit["urls"][number]): string => {
      if (u.sourceKind === "pasted") return "pasted URL";
      if (u.sourceKind === "discovered" || u.discovered) return "linked subpage";
      return "pre-filled page";
    };

    const urlRows = audit.urls.length
      ? `<ul class="admin-audit-urls">${audit.urls
          .map(
            (u) => `<li>
          <div class="admin-audit-url-head">
            <code class="admin-page-url">${escapeHTML(u.url)}</code>
            <span class="admin-cell-sub">${escapeHTML(formatSourceKind(u))} · ${escapeHTML(u.status)}${u.httpStatus ? ` · HTTP ${u.httpStatus}` : ""}</span>
          </div>
          <div class="admin-cell-sub">${escapeHTML(u.robotsReason)} · ${escapeHTML(u.detail)}</div>
        </li>`,
          )
          .join("")}</ul>`
      : "";

    const conflictsSection = draft.declaredConflicts.length
      ? `<section class="admin-conflicts-box" aria-label="Flagged differences across official pages">
          <div class="admin-conflicts-head">
            <strong>Flagged differences across official pages (${draft.declaredConflicts.length})</strong>
            <p class="account-help">
              Higher-priority configured official pages were kept automatically. Review any discrepancy below before publishing.
            </p>
          </div>
          <ul class="admin-conflicts-list">
            ${draft.declaredConflicts
              .map(
                (c) => `<li class="admin-conflict-item">
                  <div class="admin-conflict-field"><strong>${escapeHTML(c.field.replace(/_/g, " "))}</strong></div>
                  <div class="admin-conflict-grid">
                    <div>
                      <span class="admin-conflict-label">Kept (official priority)</span>
                      <div>${escapeHTML(c.keptValue)}</div>
                    </div>
                    <div>
                      <span class="admin-conflict-label">Other official page</span>
                      <div>${escapeHTML(c.discardedValue)}</div>
                    </div>
                  </div>
                  <div class="admin-cell-sub">${escapeHTML(c.reason)}</div>
                </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : "";

    const renderSectionDetails = (title: string, itemsHtml: string, count: number) =>
      count > 0
        ? `<details class="admin-preview-details">
            <summary>${escapeHTML(title)} (${count})</summary>
            <ul class="admin-preview-list">${itemsHtml}</ul>
          </details>`
        : "";

    const programsPreview = renderSectionDetails(
      "Extracted degree programs",
      draft.programs
        .slice(0, 40)
        .map(
          (p) =>
            `<li><strong>${escapeHTML(p.name)}</strong> <span class="admin-cell-sub">· ${escapeHTML(p.topic)}${p.strandAlignment ? ` · Strand: ${escapeHTML(p.strandAlignment)}` : ""}</span></li>`,
        )
        .join("") +
        (draft.programs.length > 40
          ? `<li class="admin-cell-sub">…and ${draft.programs.length - 40} more programs (all viewable in Editor)</li>`
          : ""),
      draft.programs.length,
    );

    const reqsPreview = renderSectionDetails(
      "Extracted admission requirements",
      draft.admissionRequirements
        .slice(0, 20)
        .map(
          (r) =>
            `<li><span class="admin-cell-sub">${escapeHTML(r.category)} ·</span> ${escapeHTML(r.text)}</li>`,
        )
        .join(""),
      draft.admissionRequirements.length,
    );

    const feesPreview = renderSectionDetails(
      "Extracted tuition & fee notes",
      draft.tuitionFees
        .slice(0, 15)
        .map((f) => {
          const amt =
            f.amountMin !== null
              ? f.amountMin === 0 && f.amountMax === 0
                ? "Free Tuition (RA 10931)"
                : `PHP ${f.amountMin.toLocaleString()}${f.amountMax && f.amountMax !== f.amountMin ? ` – ${f.amountMax.toLocaleString()}` : ""} (${escapeHTML(f.basis)})`
              : escapeHTML(f.basis);
          return `<li><strong>${amt}</strong> — ${escapeHTML(f.rawText)}</li>`;
        })
        .join(""),
      draft.tuitionFees.length,
    );

    const deadlinesPreview = renderSectionDetails(
      "Extracted dates & deadlines",
      draft.applicationDeadlines
        .slice(0, 15)
        .map(
          (d) =>
            `<li><strong>${escapeHTML(d.label)}</strong>${d.dateIso ? ` (${escapeHTML(d.dateIso)})` : ""} — ${escapeHTML(d.rawText)}</li>`,
        )
        .join(""),
      draft.applicationDeadlines.length,
    );

    const examsPreview = renderSectionDetails(
      "Extracted entrance examinations",
      draft.entranceExaminations
        .slice(0, 10)
        .map(
          (e) =>
            `<li><strong>${escapeHTML(e.examName)}</strong> — ${escapeHTML(e.coverage)}</li>`,
        )
        .join(""),
      draft.entranceExaminations.length,
    );

    const linksPreview = renderSectionDetails(
      "Official portals & PDF guides",
      draft.applicationLinks
        .slice(0, 12)
        .map(
          (l) =>
            `<li><strong>${escapeHTML(l.label)}</strong> — <span class="admin-cell-sub">${escapeHTML(l.url)}</span></li>`,
        )
        .join(""),
      draft.applicationLinks.length,
    );

    el.innerHTML = `<div class="admin-preview-card">
      <div class="admin-preview-head">
        <div>
          <h3>${escapeHTML(draft.name)}</h3>
          <p class="account-help">${escapeHTML(audit.notes)}</p>
        </div>
        <span class="account-pill">${escapeHTML(audit.status)}</span>
      </div>
      <p class="admin-cell-sub">${escapeHTML(audit.robotsSummary)}</p>
      <div class="admin-preview-metrics">
        <span><strong>${draft.programs.length}</strong> programs</span>
        <span><strong>${draft.tuitionFees.length}</strong> tuition notes</span>
        <span><strong>${draft.applicationDeadlines.length}</strong> deadlines</span>
        <span><strong>${draft.admissionRequirements.length}</strong> requirements</span>
        <span><strong>${draft.entranceExaminations.length}</strong> exams</span>
        <span><strong>${draft.applicationLinks.length}</strong> links/PDFs</span>
        <span><strong>${draft.declaredConflicts.length}</strong> differences</span>
      </div>
      ${conflictsSection}
      ${programsPreview}
      ${reqsPreview}
      ${feesPreview}
      ${deadlinesPreview}
      ${examsPreview}
      ${linksPreview}
      ${urlRows}
      <div class="admin-preview-actions">
        <button type="button" class="button primary" data-admin-action="${publishAction}">Merge &amp; publish to catalog</button>
        <button type="button" class="button secondary" data-admin-action="${loadAction}">Review in editor first</button>
      </div>
    </div>`;
  }

  private readEditorMetadataIntoEditing(): void {
    const val = (id: string) =>
      (
        document.getElementById(id) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | null
      )?.value.trim() || "";
    const pubBox = document.getElementById("ed-published") as HTMLInputElement | null;
    const name = val("ed-name");
    const rawId = val("ed-id") || slugifyCatalogId(name);
    this.editing = {
      ...this.editing,
      id: rawId,
      name,
      shortName: val("ed-short-name") || name.slice(0, 30),
      city: val("ed-city") || "Manila",
      campusLocation: val("ed-campus") || val("ed-city") || "Metro Manila",
      sector: val("ed-sector") === "Public" ? "Public" : "Private",
      color: (val("ed-color") || "green") as CatalogUniversityRecord["color"],
      officialUrl: val("ed-official-url"),
      academicYear: val("ed-academic-year"),
      collectionStatus: (val("ed-status") ||
        "partial") as CatalogUniversityRecord["collectionStatus"],
      isPublished: pubBox ? pubBox.checked : true,
      sourceNotes: val("ed-source-notes")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      lastVerifiedAt: new Date().toISOString(),
    };
  }

  private async handleSeedBaseline(button: HTMLButtonElement): Promise<void> {
    if (!this.isAdmin) return;
    const overwriteBox = document.getElementById(
      "admin-seed-overwrite",
    ) as HTMLInputElement | null;
    const overwrite = Boolean(overwriteBox?.checked);

    button.disabled = true;
    const original = button.textContent || "Seed baseline";
    button.textContent = "Seeding catalog…";
    this.setFeedback("");
    try {
      const headers = await this.buildAuthHeaders(true, true);
      const resp = await fetch("/api/admin/catalog/seed", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ overwrite }),
      });
      const data = (await resp.json()) as {
        error?: string;
        written?: number;
        skipped?: number;
      };
      if (!resp.ok) {
        throw new Error(data.error || "Could not seed baseline universities.");
      }
      const written = Number(data.written || 0);
      const skipped = Number(data.skipped || 0);
      this.setFeedback(
        `Baseline sync complete: saved ${written} universities (${skipped} existing entries preserved).`,
        false,
      );
      await this.refreshWorkspace();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not seed baseline universities.",
        true,
      );
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  private async handleRunPoliteCollect(button: HTMLButtonElement): Promise<void> {
    if (!this.isAdmin) return;
    const discoverBox = document.getElementById(
      "collector-discover-subpages",
    ) as HTMLInputElement | null;
    const { target, queue } = this.getCollectorQueueState();
    const discoverSubpages = discoverBox ? discoverBox.checked : true;

    if (!target) {
      this.setFeedback("Select a configured university first.", true);
      return;
    }
    if (!queue.canRun) {
      this.updateCollectorUrlStatus();
      this.setFeedback(
        queue.invalidLines.length
          ? "Fix the invalid official URL line(s) before running collection."
          : queue.exceedsMax
            ? `Reduce the selection to ${queue.maxPages} official pages or fewer.`
            : "Select at least one pre-filled page or paste an official .edu.ph URL.",
        true,
      );
      return;
    }

    button.dataset.busy = "1";
    button.disabled = true;
    const original = button.textContent || "Run polite collection";
    button.textContent = `Checking robots.txt & collecting ${queue.queuedUrls.length} official page${queue.queuedUrls.length === 1 ? "" : "s"}…`;
    this.setFeedback("");
    try {
      const headers = await this.buildAuthHeaders(true, true);
      const resp = await fetch("/api/admin/collect", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          universityId: target.universityId,
          urls: queue.queuedUrls,
          discoverSubpages,
        }),
      });
      const data = (await resp.json()) as {
        error?: string;
        draft?: CatalogUniversityRecord;
        audit?: CollectorAudit;
      };
      if (!resp.ok || !data.draft || !data.audit) {
        throw new Error(data.error || "Polite collection could not be completed.");
      }
      this.pendingCollectResult = { draft: data.draft, audit: data.audit };
      this.renderAuditPreview(
        "collector-preview-box",
        this.pendingCollectResult,
        "publish-collect",
        "load-collect-editor",
      );
      this.setFeedback(data.audit.notes, data.audit.status === "failed");
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Polite collection failed.",
        true,
      );
    } finally {
      delete button.dataset.busy;
      button.textContent = original;
      this.updateCollectorUrlStatus();
    }
  }

  private async handleParseJsonImport(button: HTMLButtonElement): Promise<void> {
    if (!this.isAdmin) return;
    const textarea = document.getElementById(
      "import-json-text",
    ) as HTMLTextAreaElement | null;
    const rawText = textarea?.value.trim() || "";
    if (!rawText) {
      this.setFeedback("Paste or upload a collector JSON file first.", true);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.setFeedback("The provided text is not valid JSON.", true);
      return;
    }

    button.disabled = true;
    const original = button.textContent || "Parse & validate snapshot";
    button.textContent = "Structuring with Algorithm 1…";
    this.setFeedback("");
    try {
      const headers = await this.buildAuthHeaders(true, true);
      const resp = await fetch("/api/admin/parse-import", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ snapshot: parsed }),
      });
      const data = (await resp.json()) as {
        error?: string;
        draft?: CatalogUniversityRecord;
        audit?: CollectorAudit;
      };
      if (!resp.ok || !data.draft || !data.audit) {
        throw new Error(data.error || "Could not validate JSON snapshot.");
      }
      this.pendingImportResult = { draft: data.draft, audit: data.audit };
      this.renderAuditPreview(
        "import-preview-box",
        this.pendingImportResult,
        "publish-import",
        "load-import-editor",
      );
      this.setFeedback(data.audit.notes, false);
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not parse JSON snapshot.",
        true,
      );
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  private async publishCollectedOrImported(
    source: { draft: CatalogUniversityRecord; audit: CollectorAudit } | null,
    clearTarget: "collect" | "import",
  ): Promise<void> {
    if (!this.isAdmin || !source) return;
    try {
      // Smart non-destructive merge: keep newly collected items and preserve existing verified details
      const existing = this.universities.find((u) => u.id === source.draft.id);
      const dedupeMerge = <T>(
        fresh: T[],
        prior: T[],
        keyFn: (item: T) => string,
        maxLen: number,
      ): T[] => {
        const out: T[] = [];
        const seen = new Set<string>();
        for (const item of [...fresh, ...prior]) {
          const k = keyFn(item).trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          out.push(item);
          if (out.length >= maxLen) break;
        }
        return out;
      };

      const merged: CatalogUniversityRecord = {
        ...source.draft,
        programs: dedupeMerge(
          source.draft.programs,
          existing?.programs || [],
          (p) => p.name,
          400,
        ),
        tuitionFees: dedupeMerge(
          source.draft.tuitionFees,
          existing?.tuitionFees || [],
          (f) => `${f.amountMin ?? ""}|${f.amountMax ?? ""}|${f.basis}|${f.rawText.slice(0, 80)}`,
          50,
        ),
        applicationDeadlines: dedupeMerge(
          source.draft.applicationDeadlines,
          existing?.applicationDeadlines || [],
          (d) => `${d.label}|${d.dateIso}|${d.rawText.slice(0, 80)}`,
          50,
        ),
        admissionRequirements: dedupeMerge(
          source.draft.admissionRequirements,
          existing?.admissionRequirements || [],
          (r) => r.text.slice(0, 120),
          100,
        ),
        entranceExaminations: dedupeMerge(
          source.draft.entranceExaminations,
          existing?.entranceExaminations || [],
          (e) => `${e.examName}|${e.coverage.slice(0, 80)}`,
          30,
        ),
        applicationLinks: dedupeMerge(
          source.draft.applicationLinks,
          existing?.applicationLinks || [],
          (l) => l.url,
          50,
        ),
      };
      await this.persistUniversityViaApi(merged, {
        mode: source.audit.mode,
        status: source.audit.status,
        fetchedUrlCount: source.audit.fetchedUrlCount,
        robotsSummary: source.audit.robotsSummary,
        notes: source.audit.notes,
      });
      if (clearTarget === "collect") {
        this.pendingCollectResult = null;
        this.renderAuditPreview("collector-preview-box", null, "", "");
      } else {
        this.pendingImportResult = null;
        this.renderAuditPreview("import-preview-box", null, "", "");
      }
      this.setFeedback(`Published ${merged.name} to the live catalog.`, false);
      await this.refreshWorkspace();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not publish catalog update.",
        true,
      );
    }
  }

  private bindEvents(): void {
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const tabBtn = target.closest<HTMLButtonElement>("[data-admin-tab]");
      if (tabBtn?.dataset.adminTab) {
        this.setTab(tabBtn.dataset.adminTab);
        return;
      }

      const editBtn = target.closest<HTMLButtonElement>("[data-admin-edit]");
      if (editBtn?.dataset.adminEdit) {
        const found = this.universities.find((u) => u.id === editBtn.dataset.adminEdit);
        if (found) {
          this.editing = structuredClone(found);
          this.editingIsExisting = true;
          this.populateEditorForm();
          this.setTab("editor");
        }
        return;
      }

      const delBtn = target.closest<HTMLButtonElement>("[data-admin-delete]");
      if (delBtn?.dataset.adminDelete) {
        const id = delBtn.dataset.adminDelete;
        if (!this.isAdmin) return;
        delBtn.disabled = true;
        void this.buildAuthHeaders(false, true)
          .then((headers) =>
            fetch(`/api/admin/catalog/${encodeURIComponent(id)}`, {
              method: "DELETE",
              credentials: "same-origin",
              headers,
            }),
          )
          .then(async (resp) => {
            const payload = (await resp.json().catch(() => ({}))) as {
              error?: string;
            };
            if (!resp.ok) {
              throw new Error(payload.error || "Could not delete university.");
            }
            if (this.user && !this.isSessionAdmin) {
              void deleteCatalogUniversity(this.db, id, this.reportError).catch(
                () => {},
              );
            }
            this.setFeedback(`Removed "${id}" from the catalog.`, false);
            return this.refreshWorkspace();
          })
          .catch((err) => {
            this.setFeedback(
              err instanceof Error ? err.message : "Could not delete university.",
              true,
            );
            delBtn.disabled = false;
          });
        return;
      }

      // Dynamic list removals inside the editor
      const rmProg = target.closest<HTMLButtonElement>("[data-remove-program]");
      if (rmProg) {
        this.editing.programs.splice(Number(rmProg.dataset.removeProgram), 1);
        this.renderEditorLists();
        return;
      }
      const rmFee = target.closest<HTMLButtonElement>("[data-remove-fee]");
      if (rmFee) {
        this.editing.tuitionFees.splice(Number(rmFee.dataset.removeFee), 1);
        this.renderEditorLists();
        return;
      }
      const rmDead = target.closest<HTMLButtonElement>("[data-remove-deadline]");
      if (rmDead) {
        this.editing.applicationDeadlines.splice(Number(rmDead.dataset.removeDeadline), 1);
        this.renderEditorLists();
        return;
      }
      const rmReq = target.closest<HTMLButtonElement>("[data-remove-req]");
      if (rmReq) {
        this.editing.admissionRequirements.splice(Number(rmReq.dataset.removeReq), 1);
        this.renderEditorLists();
        return;
      }
      const rmExam = target.closest<HTMLButtonElement>("[data-remove-exam]");
      if (rmExam) {
        this.editing.entranceExaminations.splice(Number(rmExam.dataset.removeExam), 1);
        this.renderEditorLists();
        return;
      }
      const rmLink = target.closest<HTMLButtonElement>("[data-remove-link]");
      if (rmLink) {
        this.editing.applicationLinks.splice(Number(rmLink.dataset.removeLink), 1);
        this.renderEditorLists();
        return;
      }

      const actionBtn = target.closest<HTMLButtonElement>("[data-admin-action]");
      if (!actionBtn?.dataset.adminAction) return;
      switch (actionBtn.dataset.adminAction) {
        case "seed-baseline":
          void this.handleSeedBaseline(actionBtn);
          break;
        case "new-university":
          this.editing = emptyDraft();
          this.editingIsExisting = false;
          this.populateEditorForm();
          this.setTab("editor");
          break;
        case "add-program": {
          const name = (document.getElementById("add-prog-name") as HTMLInputElement | null)?.value.trim() || "";
          const topic = (document.getElementById("add-prog-topic") as HTMLSelectElement | null)?.value || "Computing";
          const strand = (document.getElementById("add-prog-strand") as HTMLInputElement | null)?.value.trim() || "";
          const url = (document.getElementById("add-prog-url") as HTMLInputElement | null)?.value.trim() || "";
          if (!name) return;
          const item: CatalogProgram = {
            id: `${slugifyCatalogId(this.editing.id || "school")}-prog-${Date.now().toString(36)}`,
            name,
            topic,
            strandAlignment: strand,
            sourceUrl: url,
          };
          this.editing.programs.push(item);
          (document.getElementById("add-prog-name") as HTMLInputElement).value = "";
          (document.getElementById("add-prog-strand") as HTMLInputElement).value = "";
          (document.getElementById("add-prog-url") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "add-fee": {
          const minRaw = (document.getElementById("add-fee-min") as HTMLInputElement | null)?.value.trim() || "";
          const maxRaw = (document.getElementById("add-fee-max") as HTMLInputElement | null)?.value.trim() || "";
          const basis = (document.getElementById("add-fee-basis") as HTMLSelectElement | null)?.value || "semester";
          const note = (document.getElementById("add-fee-note") as HTMLInputElement | null)?.value.trim() || "";
          if (!minRaw && !note) return;
          const fee: CatalogFee = {
            amountMin: minRaw ? Number(minRaw) : null,
            amountMax: maxRaw ? Number(maxRaw) : minRaw ? Number(minRaw) : null,
            currency: "PHP",
            basis,
            rawText: note,
            academicYear: this.editing.academicYear,
            sourceUrl: this.editing.officialUrl,
          };
          this.editing.tuitionFees.push(fee);
          (document.getElementById("add-fee-min") as HTMLInputElement).value = "";
          (document.getElementById("add-fee-max") as HTMLInputElement).value = "";
          (document.getElementById("add-fee-note") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "add-deadline": {
          const label = (document.getElementById("add-dead-label") as HTMLInputElement | null)?.value.trim() || "";
          const dateIso = (document.getElementById("add-dead-date") as HTMLInputElement | null)?.value.trim() || "";
          const rawText = (document.getElementById("add-dead-note") as HTMLInputElement | null)?.value.trim() || "";
          if (!label && !rawText) return;
          const row: CatalogDeadline = {
            label: label || "Application deadline",
            dateIso,
            rawText,
            academicYear: this.editing.academicYear,
            sourceUrl: this.editing.officialUrl,
          };
          this.editing.applicationDeadlines.push(row);
          (document.getElementById("add-dead-label") as HTMLInputElement).value = "";
          (document.getElementById("add-dead-date") as HTMLInputElement).value = "";
          (document.getElementById("add-dead-note") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "add-req": {
          const category = (document.getElementById("add-req-cat") as HTMLSelectElement | null)?.value || "document";
          const text = (document.getElementById("add-req-text") as HTMLInputElement | null)?.value.trim() || "";
          if (!text) return;
          const row: CatalogRequirement = {
            category,
            text,
            academicYear: this.editing.academicYear,
            sourceUrl: this.editing.officialUrl,
          };
          this.editing.admissionRequirements.push(row);
          (document.getElementById("add-req-text") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "add-exam": {
          const examName = (document.getElementById("add-exam-name") as HTMLInputElement | null)?.value.trim() || "";
          const coverage = (document.getElementById("add-exam-coverage") as HTMLInputElement | null)?.value.trim() || "";
          if (!examName && !coverage) return;
          const row: CatalogExam = {
            examName: examName || "Entrance examination",
            coverage,
            academicYear: this.editing.academicYear,
            sourceUrl: this.editing.officialUrl,
          };
          this.editing.entranceExaminations.push(row);
          (document.getElementById("add-exam-name") as HTMLInputElement).value = "";
          (document.getElementById("add-exam-coverage") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "add-link": {
          const label = (document.getElementById("add-link-label") as HTMLInputElement | null)?.value.trim() || "";
          const url = (document.getElementById("add-link-url") as HTMLInputElement | null)?.value.trim() || "";
          if (!url.startsWith("https://")) {
            this.setFeedback("Official application links must start with https://", true);
            return;
          }
          const row: CatalogLink = {
            label: label || "Application portal",
            url,
            sourceUrl: this.editing.officialUrl,
          };
          this.editing.applicationLinks.push(row);
          (document.getElementById("add-link-label") as HTMLInputElement).value = "";
          (document.getElementById("add-link-url") as HTMLInputElement).value = "";
          this.renderEditorLists();
          break;
        }
        case "collector-select-all":
          document
            .querySelectorAll<HTMLInputElement>(
              '#collector-pages-checklist input[type="checkbox"][data-collector-page-url]',
            )
            .forEach((box) => {
              box.checked = true;
            });
          this.updateCollectorUrlStatus();
          break;
        case "collector-clear-pages":
          document
            .querySelectorAll<HTMLInputElement>(
              '#collector-pages-checklist input[type="checkbox"][data-collector-page-url]',
            )
            .forEach((box) => {
              box.checked = false;
            });
          this.updateCollectorUrlStatus();
          break;
        case "run-collect":
          void this.handleRunPoliteCollect(actionBtn);
          break;
        case "publish-collect":
          void this.publishCollectedOrImported(this.pendingCollectResult, "collect");
          break;
        case "load-collect-editor":
          if (this.pendingCollectResult) {
            const existing = this.universities.find(
              (u) => u.id === this.pendingCollectResult!.draft.id,
            );
            this.editing = structuredClone(this.pendingCollectResult.draft);
            if (!this.editing.programs.length && existing?.programs.length) {
              this.editing.programs = structuredClone(existing.programs);
            }
            this.editingIsExisting = Boolean(existing);
            this.populateEditorForm();
            this.setTab("editor");
          }
          break;
        case "parse-import":
          void this.handleParseJsonImport(actionBtn);
          break;
        case "publish-import":
          void this.publishCollectedOrImported(this.pendingImportResult, "import");
          break;
        case "load-import-editor":
          if (this.pendingImportResult) {
            const existing = this.universities.find(
              (u) => u.id === this.pendingImportResult!.draft.id,
            );
            this.editing = structuredClone(this.pendingImportResult.draft);
            this.editingIsExisting = Boolean(existing);
            this.populateEditorForm();
            this.setTab("editor");
          }
          break;
      }
    });

    const collectorSelect = document.getElementById(
      "collector-university-select",
    ) as HTMLSelectElement | null;
    collectorSelect?.addEventListener("change", () => {
      this.renderSelectedUniversityPages();
    });

    const collectorChecklist = document.getElementById(
      "collector-pages-checklist",
    );
    collectorChecklist?.addEventListener("change", () => {
      this.updateCollectorUrlStatus();
    });

    const collectorExtraUrls = document.getElementById(
      "collector-extra-urls",
    ) as HTMLTextAreaElement | null;
    collectorExtraUrls?.addEventListener("input", () => {
      this.updateCollectorUrlStatus();
    });

    const searchInput = document.getElementById(
      "admin-catalog-search",
    ) as HTMLInputElement | null;
    searchInput?.addEventListener("input", () => {
      this.searchTerm = searchInput.value.trim();
      this.renderCatalogList();
    });

    const fileInput = document.getElementById(
      "import-json-file",
    ) as HTMLInputElement | null;
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        this.setFeedback("JSON file must be under 2 MB.", true);
        return;
      }
      const text = await file.text();
      const textarea = document.getElementById(
        "import-json-text",
      ) as HTMLTextAreaElement | null;
      if (textarea) textarea.value = text;
      this.setFeedback(`Loaded "${file.name}". Click Parse & validate snapshot.`, false);
    });

    const editorForm = document.getElementById(
      "admin-editor-form",
    ) as HTMLFormElement | null;
    editorForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!this.isAdmin) return;
      const submitBtn = editorForm.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      if (submitBtn) submitBtn.disabled = true;
      this.setFeedback("");
      try {
        this.readEditorMetadataIntoEditing();
        const saved = await this.persistUniversityViaApi(this.editing, {
          mode: "manual-edit",
          status: "completed",
          fetchedUrlCount: this.editing.sourceUrls.length,
          robotsSummary: "Direct verified admin catalog update.",
          notes: `Saved ${this.editing.name} (${this.editing.programs.length} programs, ${this.editing.tuitionFees.length} tuition records).`,
        });
        this.editingIsExisting = true;
        this.setFeedback(`Saved ${saved.name} to the live catalog.`, false);
        await this.refreshWorkspace();
        this.setTab("catalog");
      } catch (err) {
        this.setFeedback(
          err instanceof Error ? err.message : "Could not save university.",
          true,
        );
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}
