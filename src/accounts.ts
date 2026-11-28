/**
 * Account and student preference management with Neon PostgreSQL persistence
 * and cross-provider unique email enforcement (local email/password vs Google OAuth).
 */
import crypto from "node:crypto";
import { cleanText } from "./algorithms/extraction.js";
import { normalizeWeights, type Criterion } from "./algorithms/matching.js";
import {
  hydratePgUserIntoStore,
  persistAccountStore,
} from "./accountPersistence.js";
import {
  PostgresUniqueViolationError,
  dbFindUserByEmail,
  dbUpsertUser,
  dbUpsertUserPreferences,
  isPostgresSchemaReady,
} from "./db/postgres.js";
import {
  DecryptionError,
  consumeRecoveryCode,
  decryptPii,
  emailLookupHash,
  encryptPii,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCodes,
  normalizeEmail,
  totpUri,
  usernameLookupHash,
  verifyPassword,
  verifyTotp,
} from "./security.js";
import {
  isBootstrappedAdminEmail,
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
  type AuthProvider,
  type UserPreferencesRecord,
  type UserRecord,
} from "./store.js";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = hashPassword("unimatch-not-a-real-account");

export const GOOGLE_ACCOUNT_EXISTS_MSG =
  "An account with this email already exists via Google Sign-In. Please sign in with Google instead.";
export const LOCAL_ACCOUNT_EXISTS_MSG =
  "An account with this email already exists using email and password. Please log in with your email and password instead.";
export const GOOGLE_LOGIN_REQUIRED_MSG =
  "This email is registered with Google Sign-In. Please click 'Continue with Google' to log in.";

export class AccountError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AccountError";
    this.statusCode = statusCode;
  }
}

export class AccountConflictError extends AccountError {
  readonly existingProvider: AuthProvider;

  constructor(message: string, existingProvider: AuthProvider) {
    super(message, 409);
    this.name = "AccountConflictError";
    this.existingProvider = existingProvider;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decryptPii(value);
  } catch {
    return "";
  }
}

function syncUserToPostgresBackground(
  record: UserRecord,
  plainEmail?: string,
  plainUsername?: string | null,
): void {
  if (!isPostgresSchemaReady()) return;
  const email = (plainEmail || safeDecrypt(record.email_encrypted)).trim().toLowerCase();
  if (!email) return;
  const username =
    plainUsername !== undefined
      ? plainUsername
      : record.username_encrypted
        ? safeDecrypt(record.username_encrypted) || null
        : null;
  void dbUpsertUser(record, email, username).catch((err) => {
    console.error("[postgres] Failed to sync user update:", err);
  });
}

function syncPreferencesToPostgresBackground(pref: UserPreferencesRecord): void {
  if (!isPostgresSchemaReady()) return;
  void dbUpsertUserPreferences(pref).catch((err) => {
    console.error("[postgres] Failed to sync user preferences:", err);
  });
}

export function validateDisplayName(value: string): string {
  const name = cleanText(value);
  if (name.length < 1 || name.length > 80) {
    throw new AccountError("Display name must be between 1 and 80 characters");
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new AccountError("Display name contains unsupported control characters");
  }
  return name;
}

export function validatePassword(value: string): string {
  const password = String(value || "");
  if (password.length < 10) {
    throw new AccountError("Password must be at least 10 characters long");
  }
  if (password.length > 128) {
    throw new AccountError("Password must be at most 128 characters long");
  }
  if (password.trim() !== password) {
    throw new AccountError("Password must not begin or end with whitespace");
  }
  if (new Set(password).size < 4) {
    throw new AccountError("Choose a less predictable password");
  }
  return password;
}

export interface PreferencesData {
  program: string;
  city: string;
  sector: string;
  budget: number | null;
  budget_basis: string;
  weights: Record<Criterion, number>;
  updated_at: string | null;
}

function validatePreferencesInput(raw: Record<string, unknown>) {
  const program = cleanText(raw.program).slice(0, 200);
  const city = cleanText(raw.city).slice(0, 200);
  const sector = cleanText(raw.sector);
  if (sector && sector !== "Public" && sector !== "Private") {
    throw new AccountError("University type must be Public or Private");
  }

  let rawWeights: Record<string, unknown> = {};
  if (typeof raw.weights === "string" && raw.weights.trim()) {
    try {
      rawWeights = JSON.parse(raw.weights);
    } catch {
      throw new AccountError("Weights must be a JSON object");
    }
  } else if (raw.weights && typeof raw.weights === "object") {
    rawWeights = raw.weights as Record<string, unknown>;
  }

  let weights: Record<Criterion, number>;
  try {
    weights = normalizeWeights(rawWeights);
  } catch (err) {
    throw new AccountError((err as Error).message);
  }

  return {
    program,
    city,
    sector,
    budget: null as number | null,
    budget_basis: "semester",
    weights,
  };
}

function assertEmailAvailableForLocalRegistration(
  normalizedEmail: string,
  lookupHash: string,
): void {
  if (isBootstrappedAdminEmail(normalizedEmail)) {
    throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
  }
  const existingId = userIdByEmailHash.get(lookupHash);
  if (existingId) {
    const existing = usersById.get(existingId);
    if (existing?.auth_provider === "google") {
      throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
    }
    throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
  }
}

function buildLocalStudentRecord(
  normalizedEmail: string,
  lookupHash: string,
  validName: string,
  validPassword: string,
): UserRecord {
  const now = nowIso();
  const userId = `usr-${crypto.randomBytes(12).toString("hex")}`;
  return {
    id: userId,
    username_hash: null,
    username_encrypted: null,
    email_hash: lookupHash,
    email_encrypted: encryptPii(normalizedEmail),
    display_name_encrypted: encryptPii(validName),
    password_hash: hashPassword(validPassword),
    auth_provider: "local",
    firebase_uid: null,
    role: "student",
    is_active: true,
    failed_logins: 0,
    locked_until: null,
    totp_secret_encrypted: null,
    totp_enabled: false,
    totp_recovery_hashes: [],
    session_version: 0,
    password_changed_at: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
}

export function createUser(
  email: string,
  password: string,
  displayName: string,
) {
  const normalizedEmail = normalizeEmail(email);
  const validName = validateDisplayName(displayName);
  const validPassword = validatePassword(password);
  const lookup = emailLookupHash(normalizedEmail);
  assertEmailAvailableForLocalRegistration(normalizedEmail, lookup);

  const record = buildLocalStudentRecord(
    normalizedEmail,
    lookup,
    validName,
    validPassword,
  );
  usersById.set(record.id, record);
  userIdByEmailHash.set(lookup, record.id);
  persistAccountStore();
  syncUserToPostgresBackground(record, normalizedEmail, null);
  return { id: record.id, email: normalizedEmail, display_name: validName };
}

export async function createUserAsync(
  email: string,
  password: string,
  displayName: string,
) {
  const normalizedEmail = normalizeEmail(email);
  const validName = validateDisplayName(displayName);
  const validPassword = validatePassword(password);
  const lookup = emailLookupHash(normalizedEmail);

  if (isPostgresSchemaReady()) {
    const existingPg = await dbFindUserByEmail(normalizedEmail);
    if (existingPg) {
      hydratePgUserIntoStore(existingPg);
      if (existingPg.auth_provider === "google") {
        throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
      }
      throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
    }
  }

  assertEmailAvailableForLocalRegistration(normalizedEmail, lookup);

  const record = buildLocalStudentRecord(
    normalizedEmail,
    lookup,
    validName,
    validPassword,
  );

  if (isPostgresSchemaReady()) {
    try {
      await dbUpsertUser(record, normalizedEmail, null);
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        const raced = await dbFindUserByEmail(normalizedEmail);
        if (raced?.auth_provider === "google") {
          throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
        }
        throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
      }
      throw err;
    }
  }

  usersById.set(record.id, record);
  userIdByEmailHash.set(lookup, record.id);
  persistAccountStore();
  return { id: record.id, email: normalizedEmail, display_name: validName };
}

export async function registerOrVerifyGoogleAccount(input: {
  firebaseUid: string;
  email: string;
  displayName?: string | null;
}) {
  const normalizedEmail = normalizeEmail(input.email);
  const uid = String(input.firebaseUid || "").trim();
  if (!uid) {
    throw new AccountError("Google account identifier is missing.");
  }
  const fallbackName = normalizedEmail.split("@")[0] || "Student";
  const safeDisplayName = validateDisplayName(
    String(input.displayName || "").trim() || fallbackName,
  );
  const lookup = emailLookupHash(normalizedEmail);

  // Authoritative check in Neon Postgres first when configured
  if (isPostgresSchemaReady()) {
    const existingPg = await dbFindUserByEmail(normalizedEmail);
    if (existingPg) {
      const hydrated = hydratePgUserIntoStore(existingPg);
      if (hydrated.auth_provider === "local") {
        throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
      }
      const now = nowIso();
      hydrated.firebase_uid = uid;
      hydrated.display_name_encrypted = encryptPii(safeDisplayName);
      hydrated.last_login_at = now;
      hydrated.updated_at = now;
      await dbUpsertUser(hydrated, normalizedEmail, null);
      persistAccountStore();
      return {
        id: hydrated.id,
        email: normalizedEmail,
        display_name: safeDisplayName,
        role: hydrated.role,
        auth_provider: hydrated.auth_provider,
      };
    }
  }

  // Check in-memory account store
  const existingId = userIdByEmailHash.get(lookup);
  if (existingId) {
    const existing = usersById.get(existingId);
    if (existing) {
      if (existing.auth_provider === "local") {
        throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
      }
      const now = nowIso();
      existing.firebase_uid = uid;
      existing.display_name_encrypted = encryptPii(safeDisplayName);
      existing.last_login_at = now;
      existing.updated_at = now;
      if (isPostgresSchemaReady()) {
        await dbUpsertUser(existing, normalizedEmail, null);
      }
      persistAccountStore();
      return {
        id: existing.id,
        email: normalizedEmail,
        display_name: safeDisplayName,
        role: existing.role,
        auth_provider: existing.auth_provider,
      };
    }
  }

  const now = nowIso();
  const userId = `gusr-${crypto.randomBytes(12).toString("hex")}`;
  const record: UserRecord = {
    id: userId,
    username_hash: null,
    username_encrypted: null,
    email_hash: lookup,
    email_encrypted: encryptPii(normalizedEmail),
    display_name_encrypted: encryptPii(safeDisplayName),
    password_hash: "",
    auth_provider: "google",
    firebase_uid: uid,
    role: isBootstrappedAdminEmail(normalizedEmail) ? "admin" : "student",
    is_active: true,
    failed_logins: 0,
    locked_until: null,
    totp_secret_encrypted: null,
    totp_enabled: false,
    totp_recovery_hashes: [],
    session_version: 0,
    password_changed_at: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    last_login_at: now,
  };

  if (isPostgresSchemaReady()) {
    try {
      await dbUpsertUser(record, normalizedEmail, null);
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        const raced = await dbFindUserByEmail(normalizedEmail);
        if (raced?.auth_provider === "local") {
          throw new AccountConflictError(LOCAL_ACCOUNT_EXISTS_MSG, "local");
        }
        if (raced) {
          const hydrated = hydratePgUserIntoStore(raced);
          return {
            id: hydrated.id,
            email: normalizedEmail,
            display_name: safeDisplayName,
            role: hydrated.role,
            auth_provider: hydrated.auth_provider,
          };
        }
      }
      throw err;
    }
  }

  usersById.set(record.id, record);
  userIdByEmailHash.set(lookup, record.id);
  persistAccountStore();
  return {
    id: record.id,
    email: normalizedEmail,
    display_name: safeDisplayName,
    role: record.role,
    auth_provider: record.auth_provider,
  };
}

export function authenticate(identifier: string, password: string) {
  const rawIdentifier = String(identifier || "").trim();
  let userId: string | undefined;
  try {
    if (rawIdentifier.includes("@")) {
      const lookup = emailLookupHash(rawIdentifier);
      userId = userIdByEmailHash.get(lookup);
    } else if (rawIdentifier) {
      const lookup = usernameLookupHash(rawIdentifier);
      userId = userIdByUsernameHash.get(lookup);
    }
  } catch {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    throw new AccountError("Invalid email, username, or password");
  }
  const user = userId ? usersById.get(userId) : undefined;
  if (!user) {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    if (rawIdentifier.includes("@") && isBootstrappedAdminEmail(rawIdentifier)) {
      throw new AccountError(GOOGLE_LOGIN_REQUIRED_MSG);
    }
    throw new AccountError("Invalid email, username, or password");
  }

  if (user.auth_provider === "google" || !user.password_hash) {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    throw new AccountError(GOOGLE_LOGIN_REQUIRED_MSG);
  }

  const now = Date.now();
  if (user.locked_until) {
    const lockedMs = Date.parse(user.locked_until);
    if (!Number.isNaN(lockedMs) && lockedMs > now) {
      throw new AccountError("Too many failed attempts. Try again later.");
    }
    user.failed_logins = 0;
    user.locked_until = null;
  }

  if (!user.is_active) {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    throw new AccountError("Invalid email, username, or password");
  }

  if (!verifyPassword(String(password || ""), user.password_hash)) {
    user.failed_logins += 1;
    if (user.failed_logins >= MAX_FAILED_LOGINS) {
      user.failed_logins = 0;
      user.locked_until = new Date(now + LOCKOUT_MS).toISOString();
    }
    persistAccountStore();
    syncUserToPostgresBackground(user);
    throw new AccountError("Invalid email, username, or password");
  }

  const iso = new Date(now).toISOString();
  user.failed_logins = 0;
  user.locked_until = null;
  user.last_login_at = iso;
  user.updated_at = iso;
  persistAccountStore();
  syncUserToPostgresBackground(user);

  return {
    id: user.id,
    role: user.role,
    totp_enabled: user.totp_enabled,
    session_version: user.session_version,
  };
}

export function getUser(userId: string): UserRecord | undefined {
  return usersById.get(userId);
}

export function findUserByEmail(email: string): UserRecord | undefined {
  try {
    const lookup = emailLookupHash(email);
    const id = userIdByEmailHash.get(lookup);
    return id ? usersById.get(id) : undefined;
  } catch {
    return undefined;
  }
}

export async function findUserByEmailAsync(
  email: string,
): Promise<UserRecord | undefined> {
  const local = findUserByEmail(email);
  if (local) return local;
  if (!isPostgresSchemaReady()) return undefined;
  try {
    const normalized = normalizeEmail(email);
    const pgRow = await dbFindUserByEmail(normalized);
    if (!pgRow) return undefined;
    return hydratePgUserIntoStore(pgRow);
  } catch {
    return undefined;
  }
}

export function getProfile(userId: string) {
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  return {
    id: user.id,
    username: user.username_encrypted ? decryptPii(user.username_encrypted) : null,
    email: decryptPii(user.email_encrypted),
    display_name: decryptPii(user.display_name_encrypted),
    auth_provider: user.auth_provider,
    role: user.role,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
}

export function updateProfile(
  userId: string,
  displayName: string,
  email?: string,
) {
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  const validName = validateDisplayName(displayName);
  const cleanedEmail = email ? cleanText(email) : "";
  let updatedPlainEmail = safeDecrypt(user.email_encrypted);

  if (cleanedEmail) {
    const normalized = normalizeEmail(cleanedEmail);
    const newHash = emailLookupHash(normalized);
    if (
      isBootstrappedAdminEmail(normalized) &&
      user.email_hash !== newHash
    ) {
      throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
    }
    const owner = userIdByEmailHash.get(newHash);
    if (owner && owner !== userId) {
      const ownerRec = usersById.get(owner);
      if (ownerRec?.auth_provider === "google") {
        throw new AccountConflictError(GOOGLE_ACCOUNT_EXISTS_MSG, "google");
      }
      throw new AccountConflictError(
        "That email address is already in use",
        "local",
      );
    }
    userIdByEmailHash.delete(user.email_hash);
    user.email_hash = newHash;
    user.email_encrypted = encryptPii(normalized);
    userIdByEmailHash.set(newHash, userId);
    updatedPlainEmail = normalized;
  }
  user.display_name_encrypted = encryptPii(validName);
  user.updated_at = nowIso();
  persistAccountStore();
  syncUserToPostgresBackground(user, updatedPlainEmail);
  return getProfile(userId);
}

export function getPreferences(userId: string): PreferencesData {
  const prefs = userPreferencesById.get(userId);
  if (!prefs) {
    return {
      program: "",
      city: "",
      sector: "",
      budget: null,
      budget_basis: "semester",
      weights: normalizeWeights(),
      updated_at: null,
    };
  }
  return {
    program: prefs.program,
    city: prefs.city,
    sector: prefs.sector,
    budget: prefs.budget,
    budget_basis: prefs.budget_basis,
    weights: normalizeWeights(prefs.weights),
    updated_at: prefs.updated_at,
  };
}

export function savePreferences(
  userId: string,
  raw: Record<string, unknown>,
): PreferencesData {
  if (!getUser(userId)) throw new AccountError("Account not found");
  const values = validatePreferencesInput(raw);
  const now = nowIso();
  const prefRecord: UserPreferencesRecord = {
    user_id: userId,
    program: values.program,
    city: values.city,
    sector: values.sector,
    budget: values.budget,
    budget_basis: values.budget_basis,
    weights: values.weights,
    updated_at: now,
  };
  userPreferencesById.set(userId, prefRecord);
  persistAccountStore();
  syncPreferencesToPostgresBackground(prefRecord);
  return getPreferences(userId);
}

export function hasPreferences(preferences: PreferencesData): boolean {
  return Boolean(preferences.program || preferences.city || preferences.sector);
}

export function recommendationPreferences(preferences: PreferencesData) {
  return {
    program: preferences.program || "",
    city: preferences.city || "",
    sector: preferences.sector || "",
  };
}

function updatePasswordInternal(userId: string, newPassword: string): number {
  const password = validatePassword(newPassword);
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  if (user.auth_provider === "google") {
    throw new AccountError(GOOGLE_LOGIN_REQUIRED_MSG);
  }
  if (verifyPassword(password, user.password_hash)) {
    throw new AccountError("Choose a password you have not used before");
  }
  const now = nowIso();
  user.password_hash = hashPassword(password);
  user.session_version += 1;
  user.password_changed_at = now;
  user.failed_logins = 0;
  user.locked_until = null;
  user.updated_at = now;
  persistAccountStore();
  syncUserToPostgresBackground(user);
  return user.session_version;
}

export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): number {
  if (newPassword !== confirmation) {
    throw new AccountError("Passwords do not match.");
  }
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  if (user.auth_provider === "google") {
    throw new AccountError(GOOGLE_LOGIN_REQUIRED_MSG);
  }
  if (!verifyPassword(String(currentPassword || ""), user.password_hash)) {
    throw new AccountError("Your current password is incorrect");
  }
  return updatePasswordInternal(userId, newPassword);
}

export function resetPassword(
  userId: string,
  newPassword: string,
  confirmation: string,
): number {
  if (newPassword !== confirmation) {
    throw new AccountError("Passwords do not match.");
  }
  return updatePasswordInternal(userId, newPassword);
}

export function getTotpState(userId: string) {
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  let secret = "";
  if (user.totp_secret_encrypted) {
    try {
      secret = decryptPii(user.totp_secret_encrypted);
    } catch (err) {
      if (err instanceof DecryptionError) secret = "";
    }
  }
  return {
    enabled: user.totp_enabled,
    recovery_remaining: user.totp_recovery_hashes.length,
    secret_available: Boolean(secret),
  };
}

export function beginTotpSetup(userId: string) {
  const profile = getProfile(userId);
  const secret = generateTotpSecret();
  return {
    secret,
    uri: totpUri(secret, profile.email),
    account: profile.email,
  };
}

export function enableTotp(
  userId: string,
  secret: string,
  code: string,
): string[] {
  if (!verifyTotp(secret, code)) {
    throw new AccountError(
      "That authentication code is not valid. Try the current code.",
    );
  }
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  const codes = generateRecoveryCodes();
  user.totp_secret_encrypted = encryptPii(secret);
  user.totp_enabled = true;
  user.totp_recovery_hashes = hashRecoveryCodes(codes);
  user.updated_at = nowIso();
  persistAccountStore();
  syncUserToPostgresBackground(user);
  return codes;
}

export function verifySecondFactor(userId: string, code: string): boolean {
  const user = getUser(userId);
  if (!user || !user.totp_enabled) return false;
  let secret = "";
  if (user.totp_secret_encrypted) {
    try {
      secret = decryptPii(user.totp_secret_encrypted);
    } catch {
      return false;
    }
  }
  if (secret && verifyTotp(secret, code)) return true;
  const { matched, remaining } = consumeRecoveryCode(
    user.totp_recovery_hashes,
    code,
  );
  if (matched) {
    user.totp_recovery_hashes = remaining;
    user.updated_at = nowIso();
    persistAccountStore();
    syncUserToPostgresBackground(user);
    return true;
  }
  return false;
}

export function disableTotp(
  userId: string,
  password: string,
  code: string,
): void {
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  if (!user.totp_enabled) {
    throw new AccountError("Two-factor authentication is not enabled.");
  }
  if (!verifyPassword(String(password || ""), user.password_hash)) {
    throw new AccountError("Your password is incorrect");
  }
  if (!verifySecondFactor(userId, code)) {
    throw new AccountError("Enter a valid authenticator or recovery code.");
  }
  user.totp_secret_encrypted = null;
  user.totp_enabled = false;
  user.totp_recovery_hashes = [];
  user.updated_at = nowIso();
  persistAccountStore();
  syncUserToPostgresBackground(user);
}
