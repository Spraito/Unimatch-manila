/**
 * UniMatch PH — Administrator Admission Schedule Management Controller.
 *
 * Supports dual administrator authentication:
 * - Local password-authenticated administrators via active Express session cookie + CSRF token
 * - Firebase Google administrators via verified `Authorization: Bearer <idToken>`
 */
import type { Auth, User } from "firebase/auth";

interface AdminEventRow {
  event_id: string;
  university_id: string;
  university_name: string;
  university_short_name: string;
  event_name: string;
  event_type: string;
  event_type_label: string;
  start_date: string | null;
  end_date: string | null;
  exam_time: string | null;
  venue: string | null;
  official_source_url: string | null;
  official_admissions_url: string | null;
  description: string;
  verification_status: "verified" | "unverified" | "tba";
  verification_label: string;
  is_confirmed: boolean;
  is_expired: boolean;
  is_upcoming: boolean;
  display_date: string;
  updated_by: string;
  last_updated_at: string;
}

interface UniversityOption {
  id: string;
  name: string;
  short_name: string;
  official_url: string | null;
}

interface AdminEventsResponse {
  actor: {
    email: string;
    displayName: string;
    source: "session" | "firebase";
  } | null;
  today: string;
  items: AdminEventRow[];
  total: number;
  summary: {
    total: number;
    verified_upcoming: number;
    unverified_or_tba: number;
    expired: number;
  };
  universities: UniversityOption[];
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

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export class AdminSchedulesController {
  private readonly auth: Auth;
  private readonly root: HTMLElement;
  private readonly isSessionAdmin: boolean;
  private readonly sessionDenied: boolean;
  private readonly csrfToken: string;
  private firebaseUser: User | null = null;
  private events: AdminEventRow[] = [];
  private universities: UniversityOption[] = [];
  private pendingDeleteId: string | null = null;

  constructor(auth: Auth, root: HTMLElement) {
    this.auth = auth;
    this.root = root;
    this.isSessionAdmin = root.dataset.sessionAdmin === "true";
    this.sessionDenied = root.dataset.sessionDenied === "true";
    this.csrfToken = root.dataset.csrfToken || "";
    this.bindEvents();

    if (this.isSessionAdmin && !this.sessionDenied) {
      this.showWorkspace();
      void this.loadEvents();
    }
  }

  private setFeedback(message: string, isError = false): void {
    const el = document.getElementById("admin-sched-feedback");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.toggle("success", !isError);
    el.hidden = !message;
  }

  private showWorkspace(): void {
    const loading = document.getElementById("admin-sched-loading");
    const signedOut = document.getElementById("admin-sched-signed-out");
    const denied = document.getElementById("admin-sched-denied");
    const workspace = document.getElementById("admin-sched-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = true;
    if (denied) denied.hidden = true;
    if (workspace) workspace.hidden = false;
  }

  private showSignedOut(): void {
    const loading = document.getElementById("admin-sched-loading");
    const signedOut = document.getElementById("admin-sched-signed-out");
    const denied = document.getElementById("admin-sched-denied");
    const workspace = document.getElementById("admin-sched-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = false;
    if (denied) denied.hidden = true;
    if (workspace) workspace.hidden = true;
  }

  private showDenied(): void {
    const loading = document.getElementById("admin-sched-loading");
    const signedOut = document.getElementById("admin-sched-signed-out");
    const denied = document.getElementById("admin-sched-denied");
    const workspace = document.getElementById("admin-sched-workspace");
    if (loading) loading.hidden = true;
    if (signedOut) signedOut.hidden = true;
    if (denied) denied.hidden = false;
    if (workspace) workspace.hidden = true;
  }

  async onAuthChanged(user: User | null): Promise<void> {
    this.firebaseUser = user;
    if (this.sessionDenied || this.isSessionAdmin) return;
    if (!user) {
      this.showSignedOut();
      return;
    }
    await this.loadEvents();
  }

  private async buildHeaders(isMutation = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (isMutation) {
      headers["Content-Type"] = "application/json";
    }
    if (this.isSessionAdmin) {
      if (isMutation && this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }
      return headers;
    }
    const activeUser = this.firebaseUser || this.auth.currentUser;
    if (activeUser) {
      const token = await activeUser.getIdToken();
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private syncVerificationDateState(): void {
    const verEl = document.getElementById("sched-verification") as HTMLSelectElement | null;
    const startEl = document.getElementById("sched-start-date") as HTMLInputElement | null;
    const endEl = document.getElementById("sched-end-date") as HTMLInputElement | null;
    if (!verEl || !startEl || !endEl) return;
    const isTba = verEl.value === "tba";
    startEl.disabled = isTba;
    endEl.disabled = isTba;
    if (isTba) {
      startEl.value = "";
      endEl.value = "";
    }
  }

  private bindEvents(): void {
    const form = document.getElementById("admin-sched-form") as HTMLFormElement | null;
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSaveEvent();
    });

    const verSelect = document.getElementById("sched-verification");
    verSelect?.addEventListener("change", () => this.syncVerificationDateState());

    const uniSelect = document.getElementById("sched-university") as HTMLSelectElement | null;
    uniSelect?.addEventListener("change", () => {
      const urlInput = document.getElementById("sched-source-url") as HTMLInputElement | null;
      const editId = (document.getElementById("sched-event-id") as HTMLInputElement | null)?.value;
      if (urlInput && !urlInput.value && !editId) {
        const match = this.universities.find((u) => u.id === uniSelect.value);
        if (match?.official_url) {
          urlInput.value = match.official_url;
        }
      }
    });

    document.getElementById("sched-cancel-edit")?.addEventListener("click", () => {
      this.resetForm();
    });

    document.getElementById("sched-refresh-btn")?.addEventListener("click", () => {
      void this.loadEvents();
    });

    ["sched-filter-university", "sched-filter-type", "sched-filter-verification"].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener("change", () => {
          this.renderTable();
        });
      },
    );
    document.getElementById("sched-filter-search")?.addEventListener("input", () => {
      this.renderTable();
    });

    const tableContainer = document.getElementById("admin-sched-table");
    tableContainer?.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        "[data-sched-action]",
      );
      if (!target) return;
      const action = target.dataset.schedAction;
      const eventId = target.dataset.eventId || "";
      if (!eventId) return;

      if (action === "edit") {
        this.populateFormForEdit(eventId);
      } else if (action === "delete-ask") {
        this.pendingDeleteId = eventId;
        this.renderTable();
      } else if (action === "delete-cancel") {
        this.pendingDeleteId = null;
        this.renderTable();
      } else if (action === "delete-confirm") {
        void this.handleDeleteEvent(eventId);
      }
    });
  }

  private populateUniversityDropdowns(): void {
    const formSelect = document.getElementById("sched-university") as HTMLSelectElement | null;
    const filterSelect = document.getElementById(
      "sched-filter-university",
    ) as HTMLSelectElement | null;
    if (!this.universities.length) return;

    if (formSelect && formSelect.options.length <= 1) {
      const current = formSelect.value;
      formSelect.innerHTML =
        '<option value="">Select university…</option>' +
        this.universities
          .map(
            (u) =>
              `<option value="${escapeHTML(u.id)}">${escapeHTML(u.name)} (${escapeHTML(u.short_name)})</option>`,
          )
          .join("");
      if (current) formSelect.value = current;
    }

    if (filterSelect && filterSelect.options.length <= 1) {
      const current = filterSelect.value;
      filterSelect.innerHTML =
        '<option value="">All universities</option>' +
        this.universities
          .map(
            (u) =>
              `<option value="${escapeHTML(u.id)}">${escapeHTML(u.short_name)} — ${escapeHTML(u.name)}</option>`,
          )
          .join("");
      if (current) filterSelect.value = current;
    }
  }

  private async loadEvents(): Promise<void> {
    try {
      const headers = await this.buildHeaders(false);
      const resp = await fetch("/api/admin/admission-events", { headers });
      if (resp.status === 401) {
        this.showSignedOut();
        return;
      }
      if (resp.status === 403) {
        this.showDenied();
        return;
      }
      if (!resp.ok) {
        throw new Error("Could not load admission schedules.");
      }
      const data = (await resp.json()) as AdminEventsResponse;
      this.showWorkspace();
      this.events = data.items || [];
      this.universities = data.universities || [];
      this.populateUniversityDropdowns();

      const actorEl = document.getElementById("admin-sched-actor");
      if (actorEl && data.actor) {
        const mode =
          data.actor.source === "firebase"
            ? "Google Admin session"
            : "Local admin session";
        actorEl.textContent = `${data.actor.email} · ${mode}`;
      }

      const setText = (id: string, value: number) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
      };
      setText("sched-kpi-total", data.summary?.total ?? this.events.length);
      setText("sched-kpi-verified", data.summary?.verified_upcoming ?? 0);
      setText("sched-kpi-pending", data.summary?.unverified_or_tba ?? 0);
      setText("sched-kpi-expired", data.summary?.expired ?? 0);

      this.renderTable();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not load admission schedules.",
        true,
      );
    }
  }

  private getFilteredEvents(): AdminEventRow[] {
    const uni =
      (document.getElementById("sched-filter-university") as HTMLSelectElement | null)
        ?.value || "";
    const type =
      (document.getElementById("sched-filter-type") as HTMLSelectElement | null)?.value ||
      "";
    const ver =
      (document.getElementById("sched-filter-verification") as HTMLSelectElement | null)
        ?.value || "";
    const search = (
      (document.getElementById("sched-filter-search") as HTMLInputElement | null)?.value ||
      ""
    )
      .trim()
      .toLowerCase();

    return this.events.filter((ev) => {
      if (uni && ev.university_id !== uni) return false;
      if (type && ev.event_type !== type) return false;
      if (ver && ev.verification_status !== ver) return false;
      if (search) {
        const hay = `${ev.event_name} ${ev.university_name} ${ev.university_short_name} ${ev.venue || ""} ${ev.description || ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  private renderTable(): void {
    const container = document.getElementById("admin-sched-table");
    const subtitle = document.getElementById("sched-list-subtitle");
    if (!container) return;

    const rows = this.getFilteredEvents();
    if (subtitle) {
      subtitle.textContent = `Showing ${rows.length} of ${this.events.length} centralized admission schedule record${this.events.length === 1 ? "" : "s"}.`;
    }

    if (!rows.length) {
      container.innerHTML =
        '<p class="account-empty">No admission schedule events match the active filters.</p>';
      return;
    }

    const htmlRows = rows
      .map((ev) => {
        const statusClass =
          ev.verification_status === "verified"
            ? ev.is_expired
              ? "is-muted"
              : "is-good"
            : ev.verification_status === "unverified"
              ? "is-warn"
              : "is-muted";
        const statusText =
          ev.is_expired && ev.is_confirmed
            ? "Verified · Expired"
            : ev.verification_label;
        const linkHref = safeHref(ev.official_source_url);
        const isDeleting = this.pendingDeleteId === ev.event_id;

        return `
        <tr>
          <td>
            <div class="admin-sched-cell-title">${escapeHTML(ev.event_name)}</div>
            <div class="admin-sched-cell-sub">
              <strong>${escapeHTML(ev.university_short_name)}</strong> · ${escapeHTML(ev.event_type_label)}
            </div>
            ${ev.venue ? `<div class="admin-sched-cell-sub">Venue: ${escapeHTML(ev.venue)}</div>` : ""}
          </td>
          <td class="admin-tabular">
            <div><strong>${escapeHTML(ev.display_date)}</strong></div>
            ${ev.exam_time ? `<div class="admin-sched-cell-sub">${escapeHTML(ev.exam_time)}</div>` : ""}
          </td>
          <td>
            <span class="admin-status-text ${statusClass}">${escapeHTML(statusText)}</span>
            ${
              linkHref
                ? `<div class="admin-sched-cell-sub"><a href="${escapeHTML(linkHref)}" target="_blank" rel="noopener noreferrer">Official link ↗</a></div>`
                : `<div class="admin-sched-cell-sub">No source URL</div>`
            }
          </td>
          <td class="admin-tabular">
            <div>${escapeHTML(formatDateTime(ev.last_updated_at))}</div>
            <div class="admin-sched-cell-sub">${escapeHTML(ev.updated_by)}</div>
          </td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="button secondary admin-btn-sm" data-sched-action="edit" data-event-id="${escapeHTML(ev.event_id)}">
                Edit
              </button>
              ${
                isDeleting
                  ? `<button type="button" class="button danger admin-btn-sm" data-sched-action="delete-confirm" data-event-id="${escapeHTML(ev.event_id)}">Confirm delete</button>
                     <button type="button" class="button secondary admin-btn-sm" data-sched-action="delete-cancel" data-event-id="${escapeHTML(ev.event_id)}">Cancel</button>`
                  : `<button type="button" class="button secondary admin-btn-sm" data-sched-action="delete-ask" data-event-id="${escapeHTML(ev.event_id)}">Delete</button>`
              }
            </div>
          </td>
        </tr>`;
      })
      .join("");

    container.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Event &amp; University</th>
              <th>Schedule</th>
              <th>Verification &amp; Source</th>
              <th>Last updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${htmlRows}</tbody>
        </table>
      </div>
    `;
  }

  private populateFormForEdit(eventId: string): void {
    const ev = this.events.find((item) => item.event_id === eventId);
    if (!ev) return;

    const setVal = (id: string, val: string) => {
      const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
      if (el) el.value = val;
    };

    setVal("sched-event-id", ev.event_id);
    setVal("sched-university", ev.university_id);
    setVal("sched-name", ev.event_name);
    setVal("sched-type", ev.event_type);
    setVal("sched-verification", ev.verification_status);
    setVal("sched-start-date", ev.start_date || "");
    setVal("sched-end-date", ev.end_date || "");
    setVal("sched-exam-time", ev.exam_time || "");
    setVal("sched-venue", ev.venue || "");
    setVal("sched-source-url", ev.official_source_url || "");
    setVal("sched-description", ev.description || "");
    this.syncVerificationDateState();

    const eyebrow = document.getElementById("sched-form-eyebrow");
    const title = document.getElementById("sched-form-title");
    const submitBtn = document.getElementById("sched-submit-btn");
    const cancelBtn = document.getElementById("sched-cancel-edit");
    if (eyebrow) eyebrow.textContent = "EDITING ADMISSION EVENT";
    if (title) title.textContent = `Edit: ${ev.university_short_name}`;
    if (submitBtn) submitBtn.textContent = "Update admission event";
    if (cancelBtn) cancelBtn.hidden = false;

    this.setFeedback("", false);
    document.getElementById("sched-name")?.focus();
  }

  private resetForm(): void {
    const form = document.getElementById("admin-sched-form") as HTMLFormElement | null;
    form?.reset();
    const idEl = document.getElementById("sched-event-id") as HTMLInputElement | null;
    if (idEl) idEl.value = "";
    this.syncVerificationDateState();

    const eyebrow = document.getElementById("sched-form-eyebrow");
    const title = document.getElementById("sched-form-title");
    const submitBtn = document.getElementById("sched-submit-btn");
    const cancelBtn = document.getElementById("sched-cancel-edit");
    if (eyebrow) eyebrow.textContent = "NEW ADMISSION EVENT";
    if (title) title.textContent = "Add admission event";
    if (submitBtn) submitBtn.textContent = "Save admission event";
    if (cancelBtn) cancelBtn.hidden = true;
  }

  private async handleSaveEvent(): Promise<void> {
    const getVal = (id: string) =>
      (
        document.getElementById(id) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | null
      )?.value.trim() || "";

    const eventId = getVal("sched-event-id");
    const payload = {
      university_id: getVal("sched-university"),
      event_name: getVal("sched-name"),
      event_type: getVal("sched-type"),
      verification_status: getVal("sched-verification"),
      start_date: getVal("sched-start-date") || null,
      end_date: getVal("sched-end-date") || null,
      exam_time: getVal("sched-exam-time") || null,
      venue: getVal("sched-venue") || null,
      official_source_url: getVal("sched-source-url") || null,
      description: getVal("sched-description"),
    };

    const submitBtn = document.getElementById(
      "sched-submit-btn",
    ) as HTMLButtonElement | null;
    if (submitBtn) submitBtn.disabled = true;

    try {
      const headers = await this.buildHeaders(true);
      const url = eventId
        ? `/api/admin/admission-events/${encodeURIComponent(eventId)}`
        : "/api/admin/admission-events";
      const method = eventId ? "PUT" : "POST";

      const resp = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        error?: string;
        event?: AdminEventRow;
      };
      if (!resp.ok) {
        throw new Error(data.error || "Could not save admission event.");
      }

      this.setFeedback(
        eventId
          ? `Updated "${data.event?.event_name || payload.event_name}". Student calendars now reflect this schedule.`
          : `Added "${data.event?.event_name || payload.event_name}". Students who saved this university can now view it.`,
        false,
      );
      this.resetForm();
      await this.loadEvents();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not save admission event.",
        true,
      );
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  private async handleDeleteEvent(eventId: string): Promise<void> {
    try {
      const headers = await this.buildHeaders(true);
      const resp = await fetch(
        `/api/admin/admission-events/${encodeURIComponent(eventId)}`,
        {
          method: "DELETE",
          headers,
        },
      );
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        throw new Error(data.error || "Could not delete admission event.");
      }
      this.pendingDeleteId = null;
      const editingId = (
        document.getElementById("sched-event-id") as HTMLInputElement | null
      )?.value;
      if (editingId === eventId) {
        this.resetForm();
      }
      this.setFeedback("Admission event deleted from centralized schedules.", false);
      await this.loadEvents();
    } catch (err) {
      this.setFeedback(
        err instanceof Error ? err.message : "Could not delete admission event.",
        true,
      );
    }
  }
}
