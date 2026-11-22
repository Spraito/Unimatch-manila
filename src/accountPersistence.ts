/**
 * Persistence layer for server-side accounts & preferences.
 *
 * Primary datastore: Neon PostgreSQL (via DATABASE_URL) when configured.
 * Local fallback: Atomic JSON file persistence (data/accounts.json) so accounts
 * survive restarts even in offline/local environments without DATABASE_URL.
 *
 * Security design:
 * - Local passwords are ALWAYS stored exclusively as bcrypt hashes (never plaintext).
 * - Google OAuth accounts store auth_provider='google' with an empty password_hash.
 * - PII fields are encrypted (AES-256-GCM) alongside HMAC-SHA256 lookup hashes.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeWeights } from "./algorithms/matching.js";
import { dbLoadAllAccounts, type PgUserRow } from "./db/postgres.js";
import {
  HAS_PERSISTENT_PII_KEYS,
  decryptPii,
  emailLookupHash,
  encryptPii,
  normalizeEmail,
  normalizeUsername,
  usernameLookupHash,
} from "./security.js";
import {
  ROOT,
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
  type AuthProvider,
  type UserPreferencesRecord,
  type UserRecord,
  type UserRole,
} from "./store.js";

const DEFAULT_ACCOUNTS_PATH = path.join(ROOT, "data", "accounts.json");

interface EncryptedPersistedUser {
  id: string;
  username_hash: string | null;
  username_encrypted: string | null;
  email_hash: string;
  email_encrypted: string;
  display_name_encrypted: string;
  password_hash: string;
  auth_provider?: AuthProvider;
  firebase_uid?: string | null;
  role: UserRole;
  is_active: boolean;
  failed_logins: number;
  locked_until: string | null;
  totp_secret_encrypted: string | null;
  totp_enabled: boolean;
  totp_recovery_hashes: string[];
  session_version: number;
  password_changed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface DevLocalPersistedUser {
  id: string;
  username: string | null;
  email: string;
  display_name: string;
  password_hash: string;
  auth_provider?: AuthProvider;
  firebase_uid?: string | null;
  role: UserRole;
  is_active: boolean;
  failed_logins: number;
  locked_until: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_recovery_hashes: string[];
  session_version: number;
  password_changed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface PersistedAccountFile {
  version: 1;
  storage_mode: "encrypted" | "dev-local";
  saved_at: string;
  users: Array<EncryptedPersistedUser | DevLocalPersistedUser>;
  preferences: UserPreferencesRecord[];
}

let activeStorePath = DEFAULT_ACCOUNTS_PATH;
let persistenceDisabled = false;

export function setAccountStorePathForTests(filePath: string | null): void {
  if (filePath === null) {
    activeStorePath = DEFAULT_ACCOUNTS_PATH;
    persistenceDisabled = false;
    return;
  }
  activeStorePath = filePath;
  persistenceDisabled = false;
}

export function setAccountPersistenceDisabledForTests(disabled: boolean): void {
  persistenceDisabled = disabled;
}

function safeDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decryptPii(value);
  } catch {
    return "";
  }
}

export function hydratePgUserIntoStore(row: PgUserRow): UserRecord {
  const normEmail = normalizeEmail(row.email);
  const emailHash = emailLookupHash(normEmail);
  const decryptedEmail = safeDecrypt(row.email_encrypted);
  const emailEncrypted =
    decryptedEmail && decryptedEmail.toLowerCase() === normEmail
      ? row.email_encrypted
      : encryptPii(normEmail);

  let usernameHash: string | null = null;
  let usernameEncrypted: string | null = null;
  if (row.username) {
    try {
      const normUsername = normalizeUsername(row.username);
      usernameHash = usernameLookupHash(normUsername);
      const decUser = safeDecrypt(row.username_encrypted);
      usernameEncrypted =
        decUser && decUser.toLowerCase() === normUsername
          ? row.username_encrypted
          : encryptPii(normUsername);
    } catch {
      usernameHash = null;
      usernameEncrypted = null;
    }
  }

  const decDisplay = safeDecrypt(row.display_name_encrypted);
  const fallbackName = row.username || normEmail.split("@")[0] || "User";
  const displayNameEncrypted = decDisplay
    ? row.display_name_encrypted
    : encryptPii(fallbackName);

  const decTotp = safeDecrypt(row.totp_secret_encrypted);
  const totpSecretEncrypted = decTotp ? row.totp_secret_encrypted : null;

  const record: UserRecord = {
    id: row.id,
    username_hash: usernameHash,
    username_encrypted: usernameEncrypted,
    email_hash: emailHash,
    email_encrypted: emailEncrypted,
    display_name_encrypted: displayNameEncrypted,
    password_hash: row.password_hash,
    auth_provider: row.auth_provider === "google" ? "google" : "local",
    firebase_uid: row.firebase_uid ?? null,
    role: row.role === "admin" ? "admin" : "student",
    is_active: row.is_active !== false,
    failed_logins: Number(row.failed_logins || 0),
    locked_until: row.locked_until ?? null,
    totp_secret_encrypted: totpSecretEncrypted,
    totp_enabled: Boolean(row.totp_enabled && totpSecretEncrypted),
    totp_recovery_hashes: Array.isArray(row.totp_recovery_hashes)
      ? [...row.totp_recovery_hashes]
      : [],
    session_version: Number(row.session_version || 0),
    password_changed_at: row.password_changed_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at ?? null,
  };

  usersById.set(record.id, record);
  userIdByEmailHash.set(record.email_hash, record.id);
  if (record.username_hash) {
    userIdByUsernameHash.set(record.username_hash, record.id);
  }
  return record;
}

export async function loadAccountsFromPostgres(): Promise<{
  usersLoaded: number;
  preferencesLoaded: number;
}> {
  const { users, preferences } = await dbLoadAllAccounts();
  let usersLoaded = 0;
  for (const row of users) {
    try {
      hydratePgUserIntoStore(row);
      usersLoaded += 1;
    } catch {
      // Skip malformed row without crashing startup
    }
  }

  let preferencesLoaded = 0;
  for (const pref of preferences) {
    if (!usersById.has(pref.user_id)) continue;
    let weights = normalizeWeights();
    try {
      weights = normalizeWeights(pref.weights);
    } catch {
      weights = normalizeWeights();
    }
    userPreferencesById.set(pref.user_id, {
      user_id: pref.user_id,
      program: pref.program,
      city: pref.city,
      sector: pref.sector,
      budget: pref.budget,
      budget_basis: pref.budget_basis || "semester",
      weights,
      updated_at: pref.updated_at,
    });
    preferencesLoaded += 1;
  }

  return { usersLoaded, preferencesLoaded };
}

export function persistAccountStore(customPath?: string): void {
  if (persistenceDisabled && !customPath) return;
  const targetPath = customPath || activeStorePath;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const users: Array<EncryptedPersistedUser | DevLocalPersistedUser> = [];
  for (const record of usersById.values()) {
    if (HAS_PERSISTENT_PII_KEYS) {
      users.push({ ...record });
    } else {
      const email = safeDecrypt(record.email_encrypted);
      const username = record.username_encrypted
        ? safeDecrypt(record.username_encrypted)
        : null;
      const displayName = safeDecrypt(record.display_name_encrypted) || "User";
      const totpSecret = record.totp_secret_encrypted
        ? safeDecrypt(record.totp_secret_encrypted)
        : null;
      if (!email) continue;
      users.push({
        id: record.id,
        username: username || null,
        email,
        display_name: displayName,
        password_hash: record.password_hash,
        auth_provider: record.auth_provider === "google" ? "google" : "local",
        firebase_uid: record.firebase_uid ?? null,
        role: record.role === "admin" ? "admin" : "student",
        is_active: Boolean(record.is_active),
        failed_logins: Number(record.failed_logins || 0),
        locked_until: record.locked_until ?? null,
        totp_secret: totpSecret || null,
        totp_enabled: Boolean(record.totp_enabled),
        totp_recovery_hashes: Array.isArray(record.totp_recovery_hashes)
          ? [...record.totp_recovery_hashes]
          : [],
        session_version: Number(record.session_version || 0),
        password_changed_at: record.password_changed_at ?? null,
        created_by: record.created_by ?? null,
        created_at: record.created_at,
        updated_at: record.updated_at,
        last_login_at: record.last_login_at ?? null,
      });
    }
  }

  const payload: PersistedAccountFile = {
    version: 1,
    storage_mode: HAS_PERSISTENT_PII_KEYS ? "encrypted" : "dev-local",
    saved_at: new Date().toISOString(),
    users,
    preferences: Array.from(userPreferencesById.values()),
  };

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, targetPath);
}

export function loadPersistedAccounts(customPath?: string): number {
  const targetPath = customPath || activeStorePath;
  if (!fs.existsSync(targetPath)) return 0;

  let parsed: PersistedAccountFile;
  try {
    parsed = JSON.parse(fs.readFileSync(targetPath, "utf8")) as PersistedAccountFile;
  } catch (err) {
    console.error("Failed to read persisted accounts file:", err);
    return 0;
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) {
    return 0;
  }

  let loaded = 0;
  for (const raw of parsed.users) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) {
      continue;
    }
    const authProvider: AuthProvider =
      raw.auth_provider === "google" ? "google" : "local";
    if (
      authProvider === "local" &&
      (typeof raw.password_hash !== "string" || !raw.password_hash.startsWith("$2"))
    ) {
      continue;
    }
    const role: UserRole = raw.role === "admin" ? "admin" : "student";

    if (parsed.storage_mode === "encrypted" && "email_encrypted" in raw) {
      if (!HAS_PERSISTENT_PII_KEYS) {
        // Cannot safely decrypt encrypted records without the original env keys.
        continue;
      }
      const enc = raw as EncryptedPersistedUser;
      const record: UserRecord = {
        ...enc,
        auth_provider: authProvider,
        firebase_uid: enc.firebase_uid ?? null,
        password_hash: typeof enc.password_hash === "string" ? enc.password_hash : "",
        role,
        username_hash: enc.username_hash ?? null,
        username_encrypted: enc.username_encrypted ?? null,
        created_by: enc.created_by ?? null,
      };
      usersById.set(record.id, record);
      userIdByEmailHash.set(record.email_hash, record.id);
      if (record.username_hash) {
        userIdByUsernameHash.set(record.username_hash, record.id);
      }
      loaded += 1;
      continue;
    }

    if ("email" in raw && typeof raw.email === "string") {
      const dev = raw as DevLocalPersistedUser;
      try {
        const normEmail = normalizeEmail(dev.email);
        const emailHash = emailLookupHash(normEmail);
        let usernameHash: string | null = null;
        let usernameEnc: string | null = null;
        if (typeof dev.username === "string" && dev.username.trim()) {
          const normUsername = normalizeUsername(dev.username);
          usernameHash = usernameLookupHash(normUsername);
          usernameEnc = encryptPii(normUsername);
        }
        const record: UserRecord = {
          id: dev.id,
          username_hash: usernameHash,
          username_encrypted: usernameEnc,
          email_hash: emailHash,
          email_encrypted: encryptPii(normEmail),
          display_name_encrypted: encryptPii(String(dev.display_name || "User")),
          password_hash: typeof dev.password_hash === "string" ? dev.password_hash : "",
          auth_provider: authProvider,
          firebase_uid: dev.firebase_uid ?? null,
          role,
          is_active: dev.is_active !== false,
          failed_logins: Number(dev.failed_logins || 0),
          locked_until: dev.locked_until ?? null,
          totp_secret_encrypted: dev.totp_secret ? encryptPii(dev.totp_secret) : null,
          totp_enabled: Boolean(dev.totp_enabled),
          totp_recovery_hashes: Array.isArray(dev.totp_recovery_hashes)
            ? [...dev.totp_recovery_hashes]
            : [],
          session_version: Number(dev.session_version || 0),
          password_changed_at: dev.password_changed_at ?? null,
          created_by: dev.created_by ?? null,
          created_at: dev.created_at || new Date().toISOString(),
          updated_at: dev.updated_at || new Date().toISOString(),
          last_login_at: dev.last_login_at ?? null,
        };
        usersById.set(record.id, record);
        userIdByEmailHash.set(record.email_hash, record.id);
        if (record.username_hash) {
          userIdByUsernameHash.set(record.username_hash, record.id);
        }
        loaded += 1;
      } catch {
        // Skip malformed record without crashing boot
      }
    }
  }

  if (Array.isArray(parsed.preferences)) {
    for (const pref of parsed.preferences) {
      if (pref && typeof pref.user_id === "string" && usersById.has(pref.user_id)) {
        userPreferencesById.set(pref.user_id, pref);
      }
    }
  }

  return loaded;
}
