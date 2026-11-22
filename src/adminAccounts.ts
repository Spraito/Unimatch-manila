/**
 * Business logic layer for Administrator Account Management.
 *
 * Strictly separated from HTTP routes and storage internals:
 * - Validates username, email, display name, and password rules
 * - Prevents duplicate usernames and emails across all auth providers
 * - Hashes passwords with bcryptjs before saving
 * - Persists to Neon PostgreSQL (when configured) and atomic JSON fallback
 * - Blocks self-removal and last-administrator lockout
 * - Immediately revokes active sessions on account removal
 */
import crypto from "node:crypto";
import { persistAccountStore } from "./accountPersistence.js";
import {
  AccountError,
  GOOGLE_ACCOUNT_EXISTS_MSG,
  validateDisplayName,
  validatePassword,
} from "./accounts.js";
import {
  dbDeleteUser,
  dbUpsertUser,
  isPostgresSchemaReady,
} from "./db/postgres.js";
import {
  decryptPii,
  emailLookupHash,
  encryptPii,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  usernameLookupHash,
} from "./security.js";
import {
  BOOTSTRAPPED_ADMIN_EMAILS,
  isBootstrappedAdminEmail,
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
  type UserRecord,
} from "./store.js";

export { BOOTSTRAPPED_ADMIN_EMAILS, isBootstrappedAdminEmail };
export const SYSTEM_PRIMARY_ADMIN_ID = "system-primary-google-admin";

export class AdminAccountError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AdminAccountError";
    this.statusCode = statusCode;
  }
}

export interface AdminActor {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  source: "session" | "firebase";
}

export interface CreateAdminInput {
  username: string;
  email: string;
  displayName?: string;
  password: string;
  passwordConfirm?: string;
}

export interface PublicAdminAccount {
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

export interface AdminAccountsSummary {
  totalActiveAdmins: number;
  localAdminCount: number;
  hasBootstrappedAdmin: boolean;
}

export interface AdminPolicyOptions {
  includeBootstrappedAdmin?: boolean;
}

type SessionRevoker = (userId: string) => void;
let sessionRevoker: SessionRevoker | null = null;

export function registerSessionRevoker(revoker: SessionRevoker | null): void {
  sessionRevoker = revoker;
}

export function isActiveAdminUser(record: UserRecord | undefined | null): boolean {
  return Boolean(record && record.is_active && record.role === "admin");
}

export function findActiveAdminByEmail(email: string): UserRecord | undefined {
  try {
    const hash = emailLookupHash(email);
    const id = userIdByEmailHash.get(hash);
    if (!id) return undefined;
    const user = usersById.get(id);
    return isActiveAdminUser(user) ? user : undefined;
  } catch {
    return undefined;
  }
}

export function countActiveLocalAdmins(): number {
  let count = 0;
  for (const user of usersById.values()) {
    if (isActiveAdminUser(user) && user.auth_provider === "local") {
      count += 1;
    }
  }
  return count;
}

export function countTotalActiveAdmins(options?: AdminPolicyOptions): number {
  const includeBootstrapped = options?.includeBootstrappedAdmin !== false;
  const bootstrappedCount = includeBootstrapped ? BOOTSTRAPPED_ADMIN_EMAILS.size : 0;
  return countActiveLocalAdmins() + bootstrappedCount;
}

function getSummary(options?: AdminPolicyOptions): AdminAccountsSummary {
  const includeBootstrapped = options?.includeBootstrappedAdmin !== false;
  const localAdminCount = countActiveLocalAdmins();
  const hasBootstrappedAdmin = includeBootstrapped && BOOTSTRAPPED_ADMIN_EMAILS.size > 0;
  return {
    totalActiveAdmins: localAdminCount + (hasBootstrappedAdmin ? BOOTSTRAPPED_ADMIN_EMAILS.size : 0),
    localAdminCount,
    hasBootstrappedAdmin,
  };
}

function safeDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decryptPii(value);
  } catch {
    return "";
  }
}

function toPublicLocalAdmin(
  record: UserRecord,
  actor: AdminActor,
  totalActiveAdmins: number,
): PublicAdminAccount {
  const email = safeDecrypt(record.email_encrypted);
  const username = safeDecrypt(record.username_encrypted) || email.split("@")[0] || "admin";
  const displayName = safeDecrypt(record.display_name_encrypted) || username;

  const isCurrentUser =
    (actor.source === "session" && actor.id === record.id) ||
    (Boolean(actor.email) &&
      Boolean(email) &&
      actor.email.trim().toLowerCase() === email.trim().toLowerCase());

  let canRemove = true;
  let protectionReason: string | null = null;
  if (isCurrentUser) {
    canRemove = false;
    protectionReason = "Current signed-in account";
  } else if (totalActiveAdmins <= 1) {
    canRemove = false;
    protectionReason = "Last remaining administrator";
  }

  return {
    id: record.id,
    username,
    email,
    displayName,
    role: "admin",
    authType: "local-password",
    createdBy: record.created_by ?? null,
    createdAt: record.created_at,
    lastLoginAt: record.last_login_at,
    isCurrentUser,
    canRemove,
    protectionReason,
  };
}

export function listAdminAccounts(
  actor: AdminActor,
  options?: AdminPolicyOptions,
): {
  currentActor: AdminActor;
  summary: AdminAccountsSummary;
  accounts: PublicAdminAccount[];
} {
  const summary = getSummary(options);
  const accounts: PublicAdminAccount[] = [];

  if (summary.hasBootstrappedAdmin) {
    for (const primaryEmail of BOOTSTRAPPED_ADMIN_EMAILS) {
      const isCurrentUser =
        actor.source === "firebase" &&
        actor.email.trim().toLowerCase() === primaryEmail;
      accounts.push({
        id: SYSTEM_PRIMARY_ADMIN_ID,
        username: primaryEmail.split("@")[0] || "primary-admin",
        email: primaryEmail,
        displayName: "Primary Google Admin",
        role: "admin",
        authType: "primary-google",
        createdBy: "System owner",
        createdAt: null,
        lastLoginAt: null,
        isCurrentUser,
        canRemove: false,
        protectionReason: isCurrentUser
          ? "Primary Google admin · current session"
          : "Primary Google administrator",
      });
    }
  }

  const localAdmins = Array.from(usersById.values())
    .filter((u) => isActiveAdminUser(u) && u.auth_provider === "local")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const record of localAdmins) {
    accounts.push(toPublicLocalAdmin(record, actor, summary.totalActiveAdmins));
  }

  return {
    currentActor: actor,
    summary,
    accounts,
  };
}

export function createAdminAccount(
  input: CreateAdminInput,
  actor: AdminActor,
  options?: AdminPolicyOptions,
): {
  account: PublicAdminAccount;
  summary: AdminAccountsSummary;
} {
  let normalizedUsername: string;
  let normalizedEmail: string;
  let validDisplayName: string;
  let validPassword: string;

  try {
    normalizedUsername = normalizeUsername(input.username);
  } catch (err) {
    throw new AdminAccountError((err as Error).message, 400);
  }

  try {
    normalizedEmail = normalizeEmail(input.email);
  } catch (err) {
    throw new AdminAccountError((err as Error).message, 400);
  }

  const rawDisplayName = String(input.displayName ?? "").trim() || normalizedUsername;
  try {
    validDisplayName = validateDisplayName(rawDisplayName);
  } catch (err) {
    throw new AdminAccountError(
      err instanceof AccountError ? err.message : (err as Error).message,
      400,
    );
  }

  if (
    input.passwordConfirm !== undefined &&
    String(input.password || "") !== String(input.passwordConfirm || "")
  ) {
    throw new AdminAccountError("Passwords do not match.", 400);
  }

  try {
    validPassword = validatePassword(input.password);
  } catch (err) {
    throw new AdminAccountError(
      err instanceof AccountError ? err.message : (err as Error).message,
      400,
    );
  }

  if (
    options?.includeBootstrappedAdmin !== false &&
    isBootstrappedAdminEmail(normalizedEmail)
  ) {
    throw new AdminAccountError(
      "That email is already assigned to the primary Google administrator account.",
      409,
    );
  }

  const usernameHash = usernameLookupHash(normalizedUsername);
  if (userIdByUsernameHash.has(usernameHash)) {
    throw new AdminAccountError(
      "That username is already taken. Choose a different username.",
      409,
    );
  }

  const emailHash = emailLookupHash(normalizedEmail);
  const existingEmailId = userIdByEmailHash.get(emailHash);
  if (existingEmailId) {
    const existing = usersById.get(existingEmailId);
    if (existing?.auth_provider === "google") {
      throw new AdminAccountError(GOOGLE_ACCOUNT_EXISTS_MSG, 409);
    }
    throw new AdminAccountError(
      "An account with this email address already exists.",
      409,
    );
  }

  const now = new Date().toISOString();
  const userId = `adm-${crypto.randomBytes(12).toString("hex")}`;
  const createdBy = actor.email || actor.username || actor.id;

  const record: UserRecord = {
    id: userId,
    username_hash: usernameHash,
    username_encrypted: encryptPii(normalizedUsername),
    email_hash: emailHash,
    email_encrypted: encryptPii(normalizedEmail),
    display_name_encrypted: encryptPii(validDisplayName),
    password_hash: hashPassword(validPassword),
    auth_provider: "local",
    firebase_uid: null,
    role: "admin",
    is_active: true,
    failed_logins: 0,
    locked_until: null,
    totp_secret_encrypted: null,
    totp_enabled: false,
    totp_recovery_hashes: [],
    session_version: 0,
    password_changed_at: null,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };

  usersById.set(userId, record);
  userIdByEmailHash.set(emailHash, userId);
  userIdByUsernameHash.set(usernameHash, userId);
  persistAccountStore();

  if (isPostgresSchemaReady()) {
    void dbUpsertUser(record, normalizedEmail, normalizedUsername).catch((err) => {
      console.error("[postgres] Failed to persist admin account:", err);
    });
  }

  const summary = getSummary(options);
  return {
    account: toPublicLocalAdmin(record, actor, summary.totalActiveAdmins),
    summary,
  };
}

export function removeAdminAccount(
  targetId: string,
  actor: AdminActor,
  options?: AdminPolicyOptions,
): {
  removedId: string;
  removedUsername: string;
  removedEmail: string;
  summary: AdminAccountsSummary;
} {
  const cleanedId = String(targetId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cleanedId)) {
    throw new AdminAccountError("Invalid administrator account identifier.", 400);
  }

  if (cleanedId === SYSTEM_PRIMARY_ADMIN_ID) {
    throw new AdminAccountError(
      "The primary Google administrator account cannot be removed here.",
      403,
    );
  }

  const target = usersById.get(cleanedId);
  if (!target || target.role !== "admin" || !target.is_active) {
    throw new AdminAccountError("Administrator account not found.", 404);
  }

  const targetEmail = safeDecrypt(target.email_encrypted);
  const targetUsername =
    safeDecrypt(target.username_encrypted) || targetEmail.split("@")[0] || "admin";

  const isSameSessionAccount =
    actor.source === "session" && actor.id === target.id;
  const isSameEmailAccount =
    Boolean(actor.email) &&
    Boolean(targetEmail) &&
    actor.email.trim().toLowerCase() === targetEmail.trim().toLowerCase();

  if (isSameSessionAccount || isSameEmailAccount) {
    throw new AdminAccountError(
      "You cannot remove your own currently signed-in administrator account.",
      409,
    );
  }

  const totalBefore = countTotalActiveAdmins(options);
  if (totalBefore <= 1) {
    throw new AdminAccountError(
      "Cannot remove the last remaining administrator account. Create another administrator first to avoid losing access.",
      409,
    );
  }

  // Immediately revoke account status, lookup indexes, and active sessions
  target.is_active = false;
  target.session_version += 1;
  usersById.delete(target.id);
  userIdByEmailHash.delete(target.email_hash);
  if (target.username_hash) {
    userIdByUsernameHash.delete(target.username_hash);
  }
  userPreferencesById.delete(target.id);
  persistAccountStore();

  if (isPostgresSchemaReady()) {
    void dbDeleteUser(target.id).catch((err) => {
      console.error("[postgres] Failed to delete admin account:", err);
    });
  }

  if (sessionRevoker) {
    try {
      sessionRevoker(target.id);
    } catch (err) {
      console.error("Failed to purge revoked admin sessions:", err);
    }
  }

  return {
    removedId: target.id,
    removedUsername: targetUsername,
    removedEmail: targetEmail,
    summary: getSummary(options),
  };
}
