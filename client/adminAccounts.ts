/**
 * UniMatch PH — Admin Account Management UI Controller.
 *
 * Works seamlessly for both authentication paths:
 * - Express session admins (cookie + X-CSRF-Token)
 * - Firebase Google Admin (Authorization: Bearer <idToken>)
 *
 * All authorization checks, password hashing, duplicate validation,
 * self-removal protection, last-admin protection, and session revocation
 * are enforced strictly on the Express backend.
 */
import type { Auth, User } from "firebase/auth";
import { getFreshIdToken } from "./catalogService.js";

interface PublicAdminAccount {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: "admin";
  authType: "primary-google" | "local-password";
  createdBy: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  isCurrentUser: boolean;
  canRemove: boolean;
  protectionReason: string | null;
}

interface AdminAccountsSummary {
  totalActiveAdmins: number;
  localAdminCount: number;
  hasBootstrappedAdmin: boolean;
}

interface AdminActor {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  source: "session" | "firebase";
}

interface AdminAccountsPayload {
  currentActor: AdminActor;
  summary: AdminAccountsSummary;
  accounts: PublicAdminAccount[];
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

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export class AdminAccountsController {
  private readonly auth: Auth;
  private readonly root: HTMLElement;
  private readonly isSessionAdmin: boolean;
  private readonly sessionDenied: boolean;
  private readonly csrfToken: string;
  private firebaseUser: User | null = null;
  private accounts: PublicAdminAccount[] = [];
  private summary: AdminAccountsSummary | null = null;
  private currentActor: AdminActor | null = null;
  private pendingRemoveTarget: PublicAdminAccount | null = null;
  private isSubmittingCreate = false;
  private isSubmittingRemove = false;

  constructor(auth: Auth, root: HTMLElement) {
    this.auth = auth;
    this.root = root;
    this.isSessionAdmin = root.dataset.sessionAdmin === "true";
    this.sessionDenied = root.dataset.sessionDenied === "true";
    this.csrfToken = root.dataset.csrfToken || "";
    this.bindEvents();

    if (this.isSessionAdmin && !this.sessionDenied) {
      this.showWorkspace();
      void this.loadAccounts();
    }
  }

  private setFeedback(message: string, isError = false): void {
    const el = document.getElementById("admin-accounts-feedback");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.toggle("success", !isError);
    el.hidden = !message;
  }

  private setFormError(message: string): void {
    const el = document.getElementById("admin-create-error");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  private showGate(mode: "loading" | "signed-out" | "denied" | "workspace"): void {
    const loading = document.getElementById("admin-accounts-loading");
    const signedOut = document.getElementById("admin-accounts-signed-out");
    const denied = document.getElementById("admin-accounts-denied");
    const workspace = document.getElementById("admin-accounts-workspace");

    if (loading) loading.hidden = mode !== "loading";
    if (signedOut) signedOut.hidden = mode !== "signed-out";
    if (denied) denied.hidden = mode !== "denied";
    if (workspace) workspace.hidden = mode !== "workspace";
  }

  private showWorkspace(): void {
    this.showGate("workspace");
  }

  async onAuthChanged(user: User | null): Promise<void> {
    this.firebaseUser = user;
    if (this.sessionDenied) {
      this.showGate("denied");
      return;
    }
    if (this.isSessionAdmin) {
      // Session-authenticated admin is already authorized by the server
      return;
    }
    if (!user) {
      this.showGate("signed-out");
      return;
    }
    this.showGate("loading");
    await this.loadAccounts();
  }

  private async buildAuthHeaders(includeJson = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (includeJson) {
      headers["Content-Type"] = "application/json";
    }
    if (this.isSessionAdmin) {
      if (this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }
      return headers;
    }
    if (this.firebaseUser) {
      const token = await getFreshIdToken(this.auth);
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async loadAccounts(): Promise<void> {
    try {
      const headers = await this.buildAuthHeaders(false);
      const resp = await fetch("/api/admin/accounts", {
        method: "GET",
        headers,
        credentials: "same-origin",
      });
      if (resp.status === 401) {
        this.showGate("signed-out");
        return;
      }
      if (resp.status === 403) {
        this.showGate("denied");
        return;
      }
      const data = (await resp.json().catch(() => null)) as
        | (AdminAccountsPayload & { error?: string })
        | null;
      if (!resp.ok || !data || !Array.isArray(data.accounts)) {
        throw new Error(data?.error || "Could not load administrator accounts.");
      }

      this.accounts = data.accounts;
      this.summary = data.summary;
      this.currentActor = data.currentActor;
      this.showWorkspace();
      this.render();
    } catch (err) {
      if (!this.isSessionAdmin && !this.firebaseUser) {
        this.showGate("signed-out");
        return;
      }
      this.showWorkspace();
      this.setFeedback(
        err instanceof Error ? err.message : "Could not load administrator accounts.",
        true,
      );
    }
  }

  private render(): void {
    const totalEl = document.getElementById("admin-stat-total");
    const localEl = document.getElementById("admin-stat-local");
    const actorEl = document.getElementById("admin-stat-actor");
    const listEl = document.getElementById("admin-accounts-list");

    if (totalEl && this.summary) {
      totalEl.textContent = String(this.summary.totalActiveAdmins);
    }
    if (localEl && this.summary) {
      localEl.textContent = String(this.summary.localAdminCount);
    }
    if (actorEl && this.currentActor) {
      const modeLabel =
        this.currentActor.source === "firebase" ? "Google sign-in" : "Local admin session";
      actorEl.textContent = `${this.currentActor.email || this.currentActor.displayName} · ${modeLabel}`;
    }

    if (!listEl) return;

    if (!this.accounts.length) {
      listEl.innerHTML =
        '<p class="account-empty">No administrator accounts are currently configured.</p>';
      return;
    }

    const rows = this.accounts
      .map((acct) => {
        const authLabel =
          acct.authType === "primary-google"
            ? "Primary Google"
            : "Local password";
        const addedLabel = acct.createdAt
          ? `Added ${formatShortDate(acct.createdAt)}`
          : "System owner";
        const lastLoginLine = acct.lastLoginAt
          ? `<div class="admin-cell-sub">Last login ${escapeHTML(
              formatShortDate(acct.lastLoginAt),
            )}</div>`
          : "";
        const createdByLine = acct.createdBy
          ? `<div class="admin-cell-sub">Added by ${escapeHTML(acct.createdBy)}</div>`
          : "";

        const actionCell = acct.canRemove
          ? `<button
               type="button"
               class="button secondary admin-btn-sm admin-btn-danger"
               data-action="open-remove-admin"
               data-admin-id="${escapeHTML(acct.id)}"
             >Remove</button>`
          : `<span class="admin-protected-note">${escapeHTML(
              acct.protectionReason || "Protected",
            )}</span>`;

        return `<tr>
          <td>
            <strong>${escapeHTML(acct.displayName)}</strong>
            <div class="admin-cell-sub">@${escapeHTML(acct.username)}${
              acct.isCurrentUser ? " · You" : ""
            }</div>
          </td>
          <td>
            <span>${escapeHTML(acct.email)}</span>
            ${createdByLine}
          </td>
          <td>
            <span class="admin-status-text">${escapeHTML(authLabel)}</span>
          </td>
          <td class="admin-tabular">
            <span>${escapeHTML(addedLabel)}</span>
            ${lastLoginLine}
          </td>
          <td class="admin-actions-col">
            ${actionCell}
          </td>
        </tr>`;
      })
      .join("");

    listEl.innerHTML = `<div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Administrator</th>
            <th>Email</th>
            <th>Access type</th>
            <th>Activity</th>
            <th class="admin-actions-col">Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private openRemoveModal(accountId: string): void {
    const target = this.accounts.find((a) => a.id === accountId && a.canRemove);
    if (!target) return;
    this.pendingRemoveTarget = target;

    const modal = document.getElementById("admin-remove-modal");
    const targetLabel = document.getElementById("admin-remove-target-label");
    const targetEmail = document.getElementById("admin-remove-target-email");
    const modalError = document.getElementById("admin-remove-error");
    const confirmBtn = document.getElementById(
      "admin-remove-confirm",
    ) as HTMLButtonElement | null;

    if (targetLabel) {
      targetLabel.textContent = `${target.displayName} (@${target.username})`;
    }
    if (targetEmail) {
      targetEmail.textContent = target.email;
    }
    if (modalError) {
      modalError.textContent = "";
      modalError.hidden = true;
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Remove administrator";
    }
    if (modal) {
      modal.hidden = false;
      confirmBtn?.focus();
    }
  }

  private closeRemoveModal(): void {
    const modal = document.getElementById("admin-remove-modal");
    if (modal) modal.hidden = true;
    this.pendingRemoveTarget = null;
  }

  private async handleCreateSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.isSubmittingCreate) return;

    const form = event.currentTarget as HTMLFormElement;
    const usernameInput = document.getElementById(
      "new-admin-username",
    ) as HTMLInputElement | null;
    const emailInput = document.getElementById(
      "new-admin-email",
    ) as HTMLInputElement | null;
    const displayInput = document.getElementById(
      "new-admin-display-name",
    ) as HTMLInputElement | null;
    const passwordInput = document.getElementById(
      "new-admin-password",
    ) as HTMLInputElement | null;
    const confirmInput = document.getElementById(
      "new-admin-password-confirm",
    ) as HTMLInputElement | null;
    const submitBtn = document.getElementById(
      "admin-create-submit",
    ) as HTMLButtonElement | null;

    const username = (usernameInput?.value || "").trim();
    const email = (emailInput?.value || "").trim();
    const displayName = (displayInput?.value || "").trim();
    const password = passwordInput?.value || "";
    const passwordConfirm = confirmInput?.value || "";

    this.setFormError("");
    this.setFeedback("");

    if (!username || !email || !password) {
      this.setFormError("Username, email address, and password are required.");
      return;
    }
    if (password !== passwordConfirm) {
      this.setFormError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      this.setFormError("Password must be at least 10 characters long.");
      return;
    }

    this.isSubmittingCreate = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating account…";
    }

    try {
      const headers = await this.buildAuthHeaders(true);
      const resp = await fetch("/api/admin/accounts", {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({
          username,
          email,
          displayName: displayName || undefined,
          password,
          passwordConfirm,
        }),
      });

      const data = (await resp.json().catch(() => null)) as {
        account?: PublicAdminAccount;
        error?: string;
      } | null;

      if (resp.status === 401) {
        this.showGate("signed-out");
        return;
      }
      if (resp.status === 403) {
        this.showGate("denied");
        return;
      }
      if (!resp.ok) {
        throw new Error(data?.error || "Could not create administrator account.");
      }

      form.reset();
      await this.loadAccounts();
      const created = data?.account;
      this.setFeedback(
        created
          ? `Administrator account @${created.username} (${created.email}) created. They can now sign in at /login.`
          : "Administrator account created.",
        false,
      );
    } catch (err) {
      this.setFormError(
        err instanceof Error ? err.message : "Could not create administrator account.",
      );
    } finally {
      this.isSubmittingCreate = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create administrator";
      }
    }
  }

  private async handleConfirmRemove(): Promise<void> {
    if (!this.pendingRemoveTarget || this.isSubmittingRemove) return;
    const target = this.pendingRemoveTarget;
    const confirmBtn = document.getElementById(
      "admin-remove-confirm",
    ) as HTMLButtonElement | null;
    const modalError = document.getElementById("admin-remove-error");

    this.isSubmittingRemove = true;
    if (modalError) {
      modalError.textContent = "";
      modalError.hidden = true;
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Removing…";
    }

    try {
      const headers = await this.buildAuthHeaders(false);
      const resp = await fetch(
        `/api/admin/accounts/${encodeURIComponent(target.id)}`,
        {
          method: "DELETE",
          headers,
          credentials: "same-origin",
        },
      );
      const data = (await resp.json().catch(() => null)) as {
        removedUsername?: string;
        removedEmail?: string;
        error?: string;
      } | null;

      if (resp.status === 401) {
        this.closeRemoveModal();
        this.showGate("signed-out");
        return;
      }
      if (resp.status === 403) {
        this.closeRemoveModal();
        this.showGate("denied");
        return;
      }
      if (!resp.ok) {
        throw new Error(data?.error || "Could not remove administrator account.");
      }

      this.closeRemoveModal();
      this.setFormError("");
      await this.loadAccounts();
      this.setFeedback(
        `Removed administrator @${data?.removedUsername || target.username} (${data?.removedEmail || target.email}). Their admin access and active sessions have been revoked.`,
        false,
      );
    } catch (err) {
      if (modalError) {
        modalError.textContent =
          err instanceof Error
            ? err.message
            : "Could not remove administrator account.";
        modalError.hidden = false;
      }
    } finally {
      this.isSubmittingRemove = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Remove administrator";
      }
    }
  }

  private bindEvents(): void {
    const form = document.getElementById("admin-create-form");
    form?.addEventListener("submit", (event) => {
      void this.handleCreateSubmit(event);
    });
    form?.addEventListener("input", () => {
      this.setFormError("");
    });

    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const openBtn = target.closest<HTMLButtonElement>(
        '[data-action="open-remove-admin"]',
      );
      if (openBtn?.dataset.adminId) {
        this.openRemoveModal(openBtn.dataset.adminId);
        return;
      }

      if (target.closest('[data-action="close-remove-modal"]')) {
        this.closeRemoveModal();
        return;
      }

      if (target.id === "admin-remove-modal") {
        this.closeRemoveModal();
        return;
      }

      if (target.closest("#admin-remove-confirm")) {
        void this.handleConfirmRemove();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const modal = document.getElementById("admin-remove-modal");
        if (modal && !modal.hidden) {
          this.closeRemoveModal();
        }
      }
    });
  }
}
