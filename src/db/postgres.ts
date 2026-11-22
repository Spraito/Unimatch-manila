/**
 * Neon PostgreSQL connection pool, automatic schema initialization, and
 * parameterized account/preference persistence helpers.
 *
 * Security design:
 * - Reads DATABASE_URL strictly from process.env (never hardcoded or logged).
 * - Uses parameterized SQL queries ($1, $2, ...) everywhere to prevent SQL injection.
 * - Enforces email uniqueness at the database level via UNIQUE constraint and
 *   case-insensitive functional unique index on LOWER(TRIM(email)).
 */
import "../env.js";
import { Pool, type PoolConfig } from "pg";
import type { AuthProvider, UserPreferencesRecord, UserRecord, UserRole } from "../store.js";
import type { Criterion } from "../algorithms/matching.js";

export interface PgUserRow {
  id: string;
  email: string;
  email_hash: string;
  email_encrypted: string;
  username: string | null;
  username_hash: string | null;
  username_encrypted: string | null;
  display_name_encrypted: string;
  password_hash: string;
  auth_provider: AuthProvider;
  firebase_uid: string | null;
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

export interface PgPreferenceRow {
  user_id: string;
  program: string;
  city: string;
  sector: string;
  budget: number | null;
  budget_basis: string;
  weights: Record<Criterion, number>;
  updated_at: string;
}

export class PostgresUniqueViolationError extends Error {
  readonly constraint: string;

  constructor(message: string, constraint = "") {
    super(message);
    this.name = "PostgresUniqueViolationError";
    this.constraint = constraint;
  }
}

export const POSTGRES_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    email_hash TEXT NOT NULL UNIQUE,
    email_encrypted TEXT NOT NULL,
    username TEXT UNIQUE,
    username_hash TEXT UNIQUE,
    username_encrypted TEXT,
    display_name_encrypted TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'google')),
    firebase_uid TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    totp_secret_encrypted TEXT,
    totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
    session_version INTEGER NOT NULL DEFAULT 0,
    password_changed_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  );`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local';`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS username_hash TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS username_encrypted TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(TRIM(email)));`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(TRIM(username))) WHERE username IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;`,
  `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    program TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    sector TEXT NOT NULL DEFAULT '',
    budget DOUBLE PRECISION,
    budget_basis TEXT NOT NULL DEFAULT 'semester',
    weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
];

let poolInstance: Pool | null = null;
let poolUrlSnapshot = "";
let schemaReady = false;
let postgresDisabledForTests = false;

export function setPostgresDisabledForTests(disabled: boolean): void {
  postgresDisabledForTests = disabled;
}

export function getDatabaseUrl(): string {
  if (postgresDisabledForTests) return "";
  return String(process.env.DATABASE_URL || "").trim();
}

export function isPostgresConfigured(): boolean {
  return Boolean(getDatabaseUrl());
}

export function isPostgresSchemaReady(): boolean {
  return schemaReady && isPostgresConfigured();
}

function buildPoolConfig(connectionString: string): PoolConfig {
  const config: PoolConfig = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  };
  const lower = connectionString.toLowerCase();
  if (lower.includes("neon.tech") && !lower.includes("sslmode=")) {
    config.ssl = { rejectUnauthorized: true };
  }
  return config;
}

export function getPool(): Pool | null {
  const url = getDatabaseUrl();
  if (!url) return null;

  if (poolInstance && poolUrlSnapshot === url) {
    return poolInstance;
  }

  if (poolInstance) {
    const oldPool = poolInstance;
    poolInstance = null;
    schemaReady = false;
    void oldPool.end().catch(() => {});
  }

  const nextPool = new Pool(buildPoolConfig(url));
  nextPool.on("error", (err) => {
    console.error("[postgres] Idle database client error:", err.message);
  });
  poolInstance = nextPool;
  poolUrlSnapshot = url;
  return poolInstance;
}

export async function closePostgresPool(): Promise<void> {
  schemaReady = false;
  if (!poolInstance) return;
  const active = poolInstance;
  poolInstance = null;
  poolUrlSnapshot = "";
  await active.end();
}

export async function initPostgresSchema(): Promise<boolean> {
  const pool = getPool();
  if (!pool) {
    schemaReady = false;
    return false;
  }

  const client = await pool.connect();
  try {
    for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
      await client.query(statement);
    }
    schemaReady = true;
    return true;
  } finally {
    client.release();
  }
}

export async function checkPostgresConnection(): Promise<{
  configured: boolean;
  ok: boolean;
  latencyMs?: number;
  tables?: string[];
  error?: string;
}> {
  if (!isPostgresConfigured()) {
    return {
      configured: false,
      ok: false,
      error: "DATABASE_URL is not set in the runtime environment.",
    };
  }

  const pool = getPool();
  if (!pool) {
    return {
      configured: false,
      ok: false,
      error: "PostgreSQL pool could not be initialized.",
    };
  }

  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1 AS ok");
    const tablesResult = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('users', 'user_preferences')
        ORDER BY table_name ASC`,
    );
    return {
      configured: true,
      ok: true,
      latencyMs: Date.now() - startedAt,
      tables: tablesResult.rows.map((r) => r.table_name),
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapUserRow(row: Record<string, unknown>): PgUserRow {
  const provider: AuthProvider =
    row.auth_provider === "google" ? "google" : "local";
  const role: UserRole = row.role === "admin" ? "admin" : "student";
  const recovery = Array.isArray(row.totp_recovery_hashes)
    ? row.totp_recovery_hashes.filter((v): v is string => typeof v === "string")
    : [];

  return {
    id: String(row.id),
    email: String(row.email).trim().toLowerCase(),
    email_hash: String(row.email_hash),
    email_encrypted: String(row.email_encrypted),
    username: typeof row.username === "string" ? row.username.trim().toLowerCase() : null,
    username_hash: typeof row.username_hash === "string" ? row.username_hash : null,
    username_encrypted:
      typeof row.username_encrypted === "string" ? row.username_encrypted : null,
    display_name_encrypted: String(row.display_name_encrypted),
    password_hash: typeof row.password_hash === "string" ? row.password_hash : "",
    auth_provider: provider,
    firebase_uid: typeof row.firebase_uid === "string" ? row.firebase_uid : null,
    role,
    is_active: row.is_active !== false,
    failed_logins: Number(row.failed_logins || 0),
    locked_until: toIsoOrNull(row.locked_until),
    totp_secret_encrypted:
      typeof row.totp_secret_encrypted === "string"
        ? row.totp_secret_encrypted
        : null,
    totp_enabled: Boolean(row.totp_enabled),
    totp_recovery_hashes: recovery,
    session_version: Number(row.session_version || 0),
    password_changed_at: toIsoOrNull(row.password_changed_at),
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    created_at: toIsoOrNull(row.created_at) || new Date().toISOString(),
    updated_at: toIsoOrNull(row.updated_at) || new Date().toISOString(),
    last_login_at: toIsoOrNull(row.last_login_at),
  };
}

export async function dbFindUserByEmail(
  normalizedEmail: string,
): Promise<PgUserRow | null> {
  const pool = getPool();
  if (!pool || !schemaReady) return null;
  const email = normalizedEmail.trim().toLowerCase();
  const result = await pool.query(
    "SELECT * FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1",
    [email],
  );
  if (!result.rows.length) return null;
  return mapUserRow(result.rows[0] as Record<string, unknown>);
}

export async function dbFindUserByUsername(
  normalizedUsername: string,
): Promise<PgUserRow | null> {
  const pool = getPool();
  if (!pool || !schemaReady) return null;
  const username = normalizedUsername.trim().toLowerCase();
  const result = await pool.query(
    "SELECT * FROM users WHERE LOWER(TRIM(username)) = $1 LIMIT 1",
    [username],
  );
  if (!result.rows.length) return null;
  return mapUserRow(result.rows[0] as Record<string, unknown>);
}

export async function dbUpsertUser(
  record: UserRecord,
  plainEmail: string,
  plainUsername: string | null = null,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;

  const normalizedEmail = plainEmail.trim().toLowerCase();
  const normalizedUsername = plainUsername
    ? plainUsername.trim().toLowerCase()
    : null;

  try {
    await pool.query(
      `INSERT INTO users (
        id,
        email,
        email_hash,
        email_encrypted,
        username,
        username_hash,
        username_encrypted,
        display_name_encrypted,
        password_hash,
        auth_provider,
        firebase_uid,
        role,
        is_active,
        failed_logins,
        locked_until,
        totp_secret_encrypted,
        totp_enabled,
        totp_recovery_hashes,
        session_version,
        password_changed_at,
        created_by,
        created_at,
        updated_at,
        last_login_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24
      )
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        email_hash = EXCLUDED.email_hash,
        email_encrypted = EXCLUDED.email_encrypted,
        username = EXCLUDED.username,
        username_hash = EXCLUDED.username_hash,
        username_encrypted = EXCLUDED.username_encrypted,
        display_name_encrypted = EXCLUDED.display_name_encrypted,
        password_hash = EXCLUDED.password_hash,
        auth_provider = EXCLUDED.auth_provider,
        firebase_uid = EXCLUDED.firebase_uid,
        role = EXCLUDED.role,
        is_active = EXCLUDED.is_active,
        failed_logins = EXCLUDED.failed_logins,
        locked_until = EXCLUDED.locked_until,
        totp_secret_encrypted = EXCLUDED.totp_secret_encrypted,
        totp_enabled = EXCLUDED.totp_enabled,
        totp_recovery_hashes = EXCLUDED.totp_recovery_hashes,
        session_version = EXCLUDED.session_version,
        password_changed_at = EXCLUDED.password_changed_at,
        created_by = EXCLUDED.created_by,
        updated_at = EXCLUDED.updated_at,
        last_login_at = EXCLUDED.last_login_at`,
      [
        record.id,
        normalizedEmail,
        record.email_hash,
        record.email_encrypted,
        normalizedUsername,
        record.username_hash,
        record.username_encrypted,
        record.display_name_encrypted,
        record.password_hash,
        record.auth_provider,
        record.firebase_uid,
        record.role,
        record.is_active,
        record.failed_logins,
        record.locked_until,
        record.totp_secret_encrypted,
        record.totp_enabled,
        JSON.stringify(record.totp_recovery_hashes ?? []),
        record.session_version,
        record.password_changed_at,
        record.created_by,
        record.created_at,
        record.updated_at,
        record.last_login_at,
      ],
    );
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr && pgErr.code === "23505") {
      throw new PostgresUniqueViolationError(
        "A record with this unique identifier already exists.",
        pgErr.constraint || "",
      );
    }
    throw err;
  }
}

export async function dbDeleteUser(userId: string): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
}

export async function dbUpsertUserPreferences(
  pref: UserPreferencesRecord,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO user_preferences (
      user_id,
      program,
      city,
      sector,
      budget,
      budget_basis,
      weights,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    ON CONFLICT (user_id) DO UPDATE SET
      program = EXCLUDED.program,
      city = EXCLUDED.city,
      sector = EXCLUDED.sector,
      budget = EXCLUDED.budget,
      budget_basis = EXCLUDED.budget_basis,
      weights = EXCLUDED.weights,
      updated_at = EXCLUDED.updated_at`,
    [
      pref.user_id,
      pref.program,
      pref.city,
      pref.sector,
      pref.budget,
      pref.budget_basis,
      JSON.stringify(pref.weights),
      pref.updated_at,
    ],
  );
}

export async function dbLoadAllAccounts(): Promise<{
  users: PgUserRow[];
  preferences: PgPreferenceRow[];
}> {
  const pool = getPool();
  if (!pool || !schemaReady) {
    return { users: [], preferences: [] };
  }

  const [usersRes, prefsRes] = await Promise.all([
    pool.query("SELECT * FROM users ORDER BY created_at ASC"),
    pool.query("SELECT * FROM user_preferences"),
  ]);

  const users = usersRes.rows.map((row) =>
    mapUserRow(row as Record<string, unknown>),
  );
  const preferences: PgPreferenceRow[] = prefsRes.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      user_id: String(r.user_id),
      program: String(r.program ?? ""),
      city: String(r.city ?? ""),
      sector: String(r.sector ?? ""),
      budget:
        r.budget !== null && r.budget !== undefined ? Number(r.budget) : null,
      budget_basis: String(r.budget_basis || "semester"),
      weights:
        r.weights && typeof r.weights === "object"
          ? (r.weights as Record<Criterion, number>)
          : ({} as Record<Criterion, number>),
      updated_at: toIsoOrNull(r.updated_at) || new Date().toISOString(),
    };
  });

  return { users, preferences };
}
