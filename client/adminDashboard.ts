/**
 * UniMatch PH — Admin Dashboard UI Controller.
 *
 * Supports dual administrator authentication:
 * - Local password-authenticated administrators via active Express session cookie
 * - Firebase Google administrators via verified `Authorization: Bearer <idToken>`
 */
import type { Auth, User } from "firebase/auth";

interface DashboardUniversityRow {
  id: string;
  name: string;
  shortName: string;
  city: string;
  sector: string;
  collectionStatus: "verified" | "partial" | "pending" | string;
  isPublished: boolean;
  programCount: number;
  feeCount: number;
  deadlineCount: number;
  examCount: number;
  conflictCount: number;
  academicYear: string;
  lastVerifiedAt: string;
}

interface DashboardRunRow {
  id: string;
  universityId: string;
  universityName: string;
  mode: string;
  status: string;
  fetchedUrlCount: number;
  programCount: number;
  conflictCount: number;
  robotsSummary: string;
  notes: string;
  actorEmail: string;
  createdAtMs: number;
  createdAt: string;
}

interface DashboardResponse {
  actor: {
    email: string;
    displayName: string;
    source: "session" | "firebase";
  };
  storage: {
    postgresPersistent: boolean;
  };
  metrics: {
    universitiesTotal: number;
    universitiesPublished: number;
    universitiesDraft: number;
    verifiedCount: number;
    partialCount: number;
    pendingCount: number;
    programsTotal: number;
    feesTotal: number;
    deadlinesTotal: number;
    examsTotal: number;
    conflictsTotal: number;
    withTuitionCount: number;
    withDeadlinesCount: number;
    withExamsCount: number;
    adminsTotal: number;
    adminsLocal: number;
    adminsGoogle: number;
    studentsTotal: number;
    studentsLocal: number;
    studentsGoogle: number;
    totpEnabledTotal: number;
    activeUsersTotal: number;
  };
  universities: DashboardUniversityRow[];
  recentRuns: DashboardRunRow[];
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

function formatDateTime(isoOrMs: string | number | null | undefined): string {
  if (!isoOrMs) return "—";
  const date = new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatModeLabel(mode: string): string {
  switch (mode) {
    case "manual-edit":
      return "Manual edit";
    case "polite-web":
      return "Polite collect";
    case "json-import":
      return "JSON import";
    case "baseline-seed":
      return "Baseline seed";
    case "delete":
      return "Removed";
    default:
      return mode;
  }
}

function formatStatusClass(status: string): string {
  if (status === "verified" || status === "completed") return "is-good";
  if (status === "partial") return "is-warn";
  return "is-muted";
}

export class AdminDashboardController {
  private readonly auth: Auth;
  private readonly root: HTMLElement;
  private readonly isSessionAdmin: boolean;
  private readonly sessionDenied: boolean;
  private firebaseUser: User | null = null;
  private data: DashboardResponse | null = null;
  private statusFilter = "all";
  private searchTerm = "";

  constructor(auth: Auth, root: HTMLElement) {
    this.auth = auth;
    this.root = root;
    this.isSessionAdmin = root.dataset.sessionAdmin === "true";
    this.sessionDenied = root.dataset.sessionDenied === "true";
    this.bindEvents();

    if (this.isSessionAdmin && !this.sessionDenied) {
      this.showWorkspace();
      void this.refreshDashboard();
    }
  }

  private setFeedback(message: string, isError = false): void {
    const el = document.getElementById("admin-dash-feedback");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.toggle("success", !isError);
    el.hidden = !message;
  }

  private showWorkspace(): void {
    const loading = document.getElementById("admin-dash-loading");
    const signedOut = document.getElementById("admin-dash-signed-out");
    const denied = document.getElementById("admin-dash-denied");
    const workspace = document.getElementById("admin-dash-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = true;
    if (denied) denied.hidden = true;
    if (workspace) workspace.hidden = false;
  }

  private showSignedOut(): void {
    const loading = document.getElementById("admin-dash-loading");
    const signedOut = document.getElementById("admin-dash-signed-out");
    const denied = document.getElementById("admin-dash-denied");
    const workspace = document.getElementById("admin-dash-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = false;
    if (denied) denied.hidden = true;
    if (workspace) workspace.hidden = true;
  }

  private showDenied(): void {
    const loading = document.getElementById("admin-dash-loading");
    const signedOut = document.getElementById("admin-dash-signed-out");
    const denied = document.getElementById("admin-dash-denied");
    const workspace = document.getElementById("admin-dash-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = true;
    if (denied) denied.hidden = false;
    if (workspace) workspace.hidden = true;
  }

  async onAuthChanged(user: User | null): Promise<void> {
    this.firebaseUser = user;
    if (this.sessionDenied) return;
    if (this.isSessionAdmin) return;

    if (!user) {
      this.showSignedOut();
      return;
    }

    await this.refreshDashboard();
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (!this.isSessionAdmin && this.firebaseUser) {
      const token = await this.firebaseUser.getIdToken();
      headers.Authorization = `Bearer ${token}`;
    } else if (!this.isSessionAdmin && this.auth.currentUser) {
      const token = await this.auth.currentUser.getIdToken();
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async refreshDashboard(): Promise<void> {
    try {
      const headers = await this.buildAuthHeaders();
      const resp = await fetch("/api/admin/dashboard", {
        method: "GET",
        credentials: "same-origin",
        headers,
      });

      if (resp.status === 401) {
        if (!this.isSessionAdmin) this.showSignedOut();
        else {
          this.setFeedback(
            "Your administrator session expired. Please sign in again.",
            true,
          );
        }
        return;
      }

      if (resp.status === 403) {
        this.showDenied();
        return;
      }

      const payload = (await resp.json()) as DashboardResponse & {
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(payload.error || "Could not load dashboard metrics.");
      }

      this.data = payload;
      this.showWorkspace();
      this.renderAll();
    } catch (err) {
      this.setFeedback(
        err instanceof Error
          ? err.message
          : "Could not load administrator dashboard.",
        true,
      );
    }
  }

  private renderAll(): void {
    if (!this.data) return;
    const { actor, metrics } = this.data;

    const actorEl = document.getElementById("admin-dash-actor");
    if (actorEl) {
      const modeText =
        actor.source === "firebase" ? "Google Admin session" : "Local admin session";
      actorEl.textContent = `${actor.email} · ${modeText}`;
    }

    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText(
      "dash-kpi-universities",
      `${metrics.universitiesPublished} / ${metrics.universitiesTotal}`,
    );
    setText(
      "dash-kpi-universities-sub",
      metrics.universitiesDraft > 0
        ? `${metrics.universitiesDraft} unpublished draft${metrics.universitiesDraft === 1 ? "" : "s"}`
        : "All directory entries live",
    );

    setText("dash-kpi-programs", metrics.programsTotal.toLocaleString("en-PH"));
    setText(
      "dash-kpi-programs-sub",
      `${metrics.feesTotal} tuition · ${metrics.deadlinesTotal} deadline records`,
    );

    const reviewQueue = metrics.partialCount + metrics.pendingCount;
    setText("dash-kpi-review", String(reviewQueue));
    setText(
      "dash-kpi-review-sub",
      `${metrics.verifiedCount} verified · ${metrics.partialCount} partial · ${metrics.pendingCount} pending`,
    );

    setText("dash-kpi-admins", String(metrics.adminsTotal));
    setText(
      "dash-kpi-admins-sub",
      `${metrics.adminsLocal} local · ${metrics.adminsGoogle} Google`,
    );

    setText("dash-kpi-students", String(metrics.studentsTotal));
    setText(
      "dash-kpi-students-sub",
      `${metrics.studentsLocal} local · ${metrics.studentsGoogle} Google`,
    );

    setText("dash-sec-local-admins", String(metrics.adminsLocal));
    setText("dash-sec-google-admins", String(metrics.adminsGoogle));
    setText(
      "dash-sec-students",
      `${metrics.studentsLocal} / ${metrics.studentsGoogle}`,
    );
    setText(
      "dash-sec-2fa",
      `${metrics.totpEnabledTotal} of ${metrics.activeUsersTotal}`,
    );

    this.renderMeters();
    this.renderUniversitiesTable();
    this.renderRecentActivity();
  }

  private renderMeters(): void {
    const container = document.getElementById("dash-coverage-meters");
    if (!container || !this.data) return;
    const m = this.data.metrics;
    const total = Math.max(1, m.universitiesTotal);

    const rows = [
      {
        label: "Verified universities",
        count: m.verifiedCount,
        total: m.universitiesTotal,
        pct: Math.round((m.verifiedCount / total) * 100),
      },
      {
        label: "Tuition records available",
        count: m.withTuitionCount,
        total: m.universitiesTotal,
        pct: Math.round((m.withTuitionCount / total) * 100),
      },
      {
        label: "Application deadlines listed",
        count: m.withDeadlinesCount,
        total: m.universitiesTotal,
        pct: Math.round((m.withDeadlinesCount / total) * 100),
      },
      {
        label: "Entrance exam notes listed",
        count: m.withExamsCount,
        total: m.universitiesTotal,
        pct: Math.round((m.withExamsCount / total) * 100),
      },
    ];

    container.innerHTML = rows
      .map(
        (r) => `<div class="admin-dash-meter-row">
        <div class="admin-dash-meter-head">
          <span>${escapeHTML(r.label)}</span>
          <span class="admin-tabular"><strong>${r.count}</strong> / ${r.total} (${r.pct}%)</span>
        </div>
        <progress class="admin-dash-progress" value="${r.pct}" max="100" aria-label="${escapeHTML(r.label)}"></progress>
      </div>`,
      )
      .join("");
  }

  private renderUniversitiesTable(): void {
    const container = document.getElementById("dash-university-table");
    const subtitle = document.getElementById("dash-catalog-subtitle");
    if (!container || !this.data) return;

    const q = this.searchTerm.toLowerCase();
    const filtered = this.data.universities.filter((u) => {
      if (this.statusFilter !== "all" && u.collectionStatus !== this.statusFilter) {
        return false;
      }
      if (q) {
        return `${u.name} ${u.shortName} ${u.city} ${u.id}`
          .toLowerCase()
          .includes(q);
      }
      return true;
    });

    if (subtitle) {
      subtitle.textContent = `Showing ${filtered.length} of ${this.data.universities.length} universities · ${this.data.metrics.conflictsTotal} flagged difference${this.data.metrics.conflictsTotal === 1 ? "" : "s"}`;
    }

    if (!filtered.length) {
      container.innerHTML =
        '<p class="account-empty">No universities match the selected filter.</p>';
      return;
    }

    container.innerHTML = `<div class="admin-table-wrap"><table class="admin-table">
      <thead>
        <tr>
          <th>University</th>
          <th>Programs</th>
          <th>Coverage</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${filtered
          .map((u) => {
            const visibility = u.isPublished ? "Published" : "Draft";
            const statusClass = formatStatusClass(u.collectionStatus);
            return `<tr>
              <td>
                <strong>${escapeHTML(u.name)}</strong>
                <div class="admin-cell-sub">${escapeHTML(u.shortName)} · ${escapeHTML(u.city)} · ${escapeHTML(u.sector)} · ${visibility}</div>
              </td>
              <td class="admin-tabular">${u.programCount}</td>
              <td class="admin-tabular">${u.feeCount} fee · ${u.deadlineCount} date · ${u.examCount} exam</td>
              <td>
                <span class="admin-dash-status ${statusClass}">${escapeHTML(u.collectionStatus)}</span>
                ${u.conflictCount > 0 ? `<div class="admin-cell-sub">${u.conflictCount} difference${u.conflictCount === 1 ? "" : "s"}</div>` : ""}
              </td>
              <td>
                <a class="button secondary admin-btn-sm" href="/admin?edit=${encodeURIComponent(u.id)}">Edit</a>
              </td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table></div>`;
  }

  private renderRecentActivity(): void {
    const container = document.getElementById("dash-recent-activity");
    if (!container || !this.data) return;

    const runs = this.data.recentRuns;
    if (!runs.length) {
      container.innerHTML =
        '<p class="account-empty">No catalog edits, seeds, or polite collections have been recorded yet. Open Manage Catalog to make your first update.</p>';
      return;
    }

    container.innerHTML = `<div class="admin-table-wrap"><table class="admin-table">
      <thead>
        <tr>
          <th>Target &amp; time</th>
          <th>Administrator</th>
          <th>Action</th>
          <th>Summary</th>
        </tr>
      </thead>
      <tbody>
        ${runs
          .map(
            (r) => `<tr>
              <td>
                <strong>${escapeHTML(r.universityName)}</strong>
                <div class="admin-cell-sub">${escapeHTML(formatDateTime(r.createdAt || r.createdAtMs))}</div>
              </td>
              <td>${escapeHTML(r.actorEmail || "Administrator")}</td>
              <td>
                <span class="admin-dash-status ${formatStatusClass(r.status)}">${escapeHTML(formatModeLabel(r.mode))}</span>
                <div class="admin-cell-sub">${escapeHTML(r.status)}</div>
              </td>
              <td>
                <div>${escapeHTML(r.notes)}</div>
                <div class="admin-cell-sub admin-tabular">${r.programCount} programs · ${r.fetchedUrlCount} URLs · ${r.conflictCount} conflicts</div>
              </td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table></div>`;
  }

  private bindEvents(): void {
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const filterBtn = target.closest<HTMLButtonElement>("[data-dash-status]");
      if (filterBtn?.dataset.dashStatus) {
        this.statusFilter = filterBtn.dataset.dashStatus;
        this.root
          .querySelectorAll<HTMLButtonElement>("[data-dash-status]")
          .forEach((btn) => {
            const active = btn.dataset.dashStatus === this.statusFilter;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-selected", String(active));
          });
        this.renderUniversitiesTable();
        return;
      }

      if (target.closest("#dash-refresh-btn")) {
        const btn = document.getElementById(
          "dash-refresh-btn",
        ) as HTMLButtonElement | null;
        if (btn) btn.disabled = true;
        this.setFeedback("");
        void this.refreshDashboard().finally(() => {
          if (btn) btn.disabled = false;
        });
      }
    });

    const searchInput = document.getElementById(
      "dash-university-search",
    ) as HTMLInputElement | null;
    searchInput?.addEventListener("input", () => {
      this.searchTerm = searchInput.value.trim();
      this.renderUniversitiesTable();
    });
  }
}
