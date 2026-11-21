/**
 * In-memory account and student preference management.
 */
import crypto from "node:crypto";
import { cleanText } from "./algorithms/extraction.js";
import {
  BUDGET_BASES,
  normalizeWeights,
  type Criterion,
} from "./algorithms/matching.js";
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
  verifyPassword,
  verifyTotp,
} from "./security.js";
import {
  userIdByEmailHash,
  userPreferencesById,
  usersById,
  type UserRecord,
} from "./store.js";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = hashPassword("unimatch-not-a-real-account");

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
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

  let budget: number | null = null;
  if (raw.budget !== undefined && raw.budget !== null && raw.budget !== "") {
    if (typeof raw.budget === "boolean") {
      throw new AccountError("Budget must be a number");
    }
    const num = Number(raw.budget);
    if (!Number.isFinite(num)) {
      throw new AccountError("Budget must be a number");
    }
    if (num < 0 || num > 10_000_000) {
      throw new AccountError("Budget must be between 0 and 10,000,000 PHP");
    }
    budget = num;
  }

  const rawBasis = cleanText(raw.budget_basis);
  const basis = rawBasis || "semester";
  if (!(BUDGET_BASES as readonly string[]).includes(basis)) {
    throw new AccountError(
      "Budget basis must be semester, trimester, year or unit",
    );
  }
  if (budget === null && rawBasis) {
    throw new AccountError("Provide a budget when choosing a budget basis");
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
    budget,
    budget_basis: budget !== null ? basis : "semester",
    weights,
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
  if (userIdByEmailHash.has(lookup)) {
    throw new AccountError("An account with this email already exists");
  }
  const now = nowIso();
  const userId = `usr-${crypto.randomBytes(12).toString("hex")}`;
  const record: UserRecord = {
    id: userId,
    email_hash: lookup,
    email_encrypted: encryptPii(normalizedEmail),
    display_name_encrypted: encryptPii(validName),
    password_hash: hashPassword(validPassword),
    role: "student",
    is_active: true,
    failed_logins: 0,
    locked_until: null,
    totp_secret_encrypted: null,
    totp_enabled: false,
    totp_recovery_hashes: [],
    session_version: 0,
    password_changed_at: null,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  usersById.set(userId, record);
  userIdByEmailHash.set(lookup, userId);
  return { id: userId, email: normalizedEmail, display_name: validName };
}

export function authenticate(email: string, password: string) {
  let lookup: string;
  try {
    lookup = emailLookupHash(email);
  } catch {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    throw new AccountError("Invalid email or password");
  }
  const userId = userIdByEmailHash.get(lookup);
  const user = userId ? usersById.get(userId) : undefined;
  if (!user) {
    verifyPassword(String(password || ""), DUMMY_PASSWORD_HASH);
    throw new AccountError("Invalid email or password");
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
    throw new AccountError("Invalid email or password");
  }

  if (!verifyPassword(String(password || ""), user.password_hash)) {
    user.failed_logins += 1;
    if (user.failed_logins >= MAX_FAILED_LOGINS) {
      user.failed_logins = 0;
      user.locked_until = new Date(now + LOCKOUT_MS).toISOString();
    }
    throw new AccountError("Invalid email or password");
  }

  const iso = new Date(now).toISOString();
  user.failed_logins = 0;
  user.locked_until = null;
  user.last_login_at = iso;
  user.updated_at = iso;

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

export function getProfile(userId: string) {
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
  return {
    id: user.id,
    email: decryptPii(user.email_encrypted),
    display_name: decryptPii(user.display_name_encrypted),
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
  if (cleanedEmail) {
    const normalized = normalizeEmail(cleanedEmail);
    const newHash = emailLookupHash(normalized);
    const owner = userIdByEmailHash.get(newHash);
    if (owner && owner !== userId) {
      throw new AccountError("That email address is already in use");
    }
    userIdByEmailHash.delete(user.email_hash);
    user.email_hash = newHash;
    user.email_encrypted = encryptPii(normalized);
    userIdByEmailHash.set(newHash, userId);
  }
  user.display_name_encrypted = encryptPii(validName);
  user.updated_at = nowIso();
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
  userPreferencesById.set(userId, {
    user_id: userId,
    program: values.program,
    city: values.city,
    sector: values.sector,
    budget: values.budget,
    budget_basis: values.budget_basis,
    weights: values.weights,
    updated_at: now,
  });
  return getPreferences(userId);
}

export function hasPreferences(preferences: PreferencesData): boolean {
  return Boolean(
    preferences.program ||
      preferences.city ||
      preferences.sector ||
      preferences.budget !== null,
  );
}

export function recommendationPreferences(preferences: PreferencesData) {
  return {
    program: preferences.program || "",
    city: preferences.city || "",
    sector: preferences.sector || "",
    budget: preferences.budget,
    budget_basis: preferences.budget !== null ? preferences.budget_basis : "",
  };
}

function updatePasswordInternal(userId: string, newPassword: string): number {
  const password = validatePassword(newPassword);
  const user = getUser(userId);
  if (!user) throw new AccountError("Account not found");
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
}
