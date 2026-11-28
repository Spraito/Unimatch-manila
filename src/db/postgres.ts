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
  `CREATE TABLE IF NOT EXISTS catalog_universities (
    id TEXT PRIMARY KEY,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_published BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    collection_status TEXT NOT NULL DEFAULT 'partial',
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `ALTER TABLE catalog_universities ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;`,
  `CREATE TABLE IF NOT EXISTS catalog_collection_runs (
    id TEXT PRIMARY KEY,
    university_id TEXT NOT NULL,
    university_name TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    fetched_url_count INTEGER NOT NULL DEFAULT 0,
    program_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    robots_summary TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_runs_created_at ON catalog_collection_runs (created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS admission_events (
    event_id TEXT PRIMARY KEY,
    university_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    academic_year TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    exam_time TEXT,
    venue TEXT,
    official_source_url TEXT,
    description TEXT NOT NULL DEFAULT '',
    verification_status TEXT NOT NULL DEFAULT 'tba' CHECK (verification_status IN ('verified', 'unverified', 'tba')),
    updated_by TEXT NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `ALTER TABLE admission_events ADD COLUMN IF NOT EXISTS academic_year TEXT NOT NULL DEFAULT '';`,
  `CREATE INDEX IF NOT EXISTS idx_admission_events_university ON admission_events (university_id);`,
  `CREATE INDEX IF NOT EXISTS idx_admission_events_status_date ON admission_events (verification_status, start_date);`,
  `CREATE TABLE IF NOT EXISTS user_application_tracking (
    user_id TEXT NOT NULL,
    university_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Interested',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, university_id)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_user_application_tracking_user ON user_application_tracking (user_id);`,
  `CREATE TABLE IF NOT EXISTS user_event_reminders (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    intervals_days JSONB NOT NULL DEFAULT '[7,3,1]'::jsonb,
    channels JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
    dismissed_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_user_event_reminders_user ON user_event_reminders (user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_user_event_reminders_event ON user_event_reminders (event_id);`,
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
          AND table_name IN (
            'users',
            'user_preferences',
            'catalog_universities',
            'catalog_collection_runs',
            'admission_events',
            'user_application_tracking',
            'user_event_reminders'
          )
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

export interface PgCatalogUniversityRow {
  id: string;
  payload: Record<string, unknown>;
  is_published: boolean;
  is_deleted: boolean;
  collection_status: string;
  updated_by: string | null;
  updated_at: string;
}

export interface PgCatalogRunRow {
  id: string;
  university_id: string;
  university_name: string;
  mode: string;
  status: string;
  fetched_url_count: number;
  program_count: number;
  conflict_count: number;
  robots_summary: string;
  notes: string;
  actor_email: string;
  created_at: string;
}

export async function dbLoadCatalogUniversities(): Promise<
  PgCatalogUniversityRow[]
> {
  const pool = getPool();
  if (!pool || !schemaReady) return [];
  const result = await pool.query(
    `SELECT id, payload, is_published, is_deleted, collection_status, updated_by, updated_at
       FROM catalog_universities
      ORDER BY id ASC`,
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      is_published: r.is_published !== false,
      is_deleted: Boolean(r.is_deleted),
      collection_status: String(r.collection_status || "partial"),
      updated_by: typeof r.updated_by === "string" ? r.updated_by : null,
      updated_at: toIsoOrNull(r.updated_at) || new Date().toISOString(),
    };
  });
}

export async function dbUpsertCatalogUniversity(
  id: string,
  payload: Record<string, unknown>,
  isPublished: boolean,
  collectionStatus: string,
  updatedBy: string,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO catalog_universities (
      id,
      payload,
      is_published,
      is_deleted,
      collection_status,
      updated_by,
      updated_at
    ) VALUES ($1, $2::jsonb, $3, FALSE, $4, $5, NOW())
    ON CONFLICT (id) DO UPDATE SET
      payload = EXCLUDED.payload,
      is_published = EXCLUDED.is_published,
      is_deleted = FALSE,
      collection_status = EXCLUDED.collection_status,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`,
    [id, JSON.stringify(payload), isPublished, collectionStatus, updatedBy],
  );
}

export async function dbMarkCatalogUniversityDeleted(
  id: string,
  updatedBy: string,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO catalog_universities (
      id,
      payload,
      is_published,
      is_deleted,
      collection_status,
      updated_by,
      updated_at
    ) VALUES ($1, '{}'::jsonb, FALSE, TRUE, 'pending', $2, NOW())
    ON CONFLICT (id) DO UPDATE SET
      is_published = FALSE,
      is_deleted = TRUE,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`,
    [id, updatedBy],
  );
}

export async function dbInsertCatalogRun(run: PgCatalogRunRow): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO catalog_collection_runs (
      id,
      university_id,
      university_name,
      mode,
      status,
      fetched_url_count,
      program_count,
      conflict_count,
      robots_summary,
      notes,
      actor_email,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO NOTHING`,
    [
      run.id,
      run.university_id,
      run.university_name,
      run.mode,
      run.status,
      run.fetched_url_count,
      run.program_count,
      run.conflict_count,
      run.robots_summary,
      run.notes,
      run.actor_email,
      run.created_at,
    ],
  );
}

export async function dbLoadCatalogRuns(limit = 30): Promise<PgCatalogRunRow[]> {
  const pool = getPool();
  if (!pool || !schemaReady) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await pool.query(
    `SELECT id, university_id, university_name, mode, status,
            fetched_url_count, program_count, conflict_count,
            robots_summary, notes, actor_email, created_at
       FROM catalog_collection_runs
      ORDER BY created_at DESC
      LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      university_id: String(r.university_id),
      university_name: String(r.university_name),
      mode: String(r.mode || "manual-edit"),
      status: String(r.status || "completed"),
      fetched_url_count: Number(r.fetched_url_count || 0),
      program_count: Number(r.program_count || 0),
      conflict_count: Number(r.conflict_count || 0),
      robots_summary: String(r.robots_summary || ""),
      notes: String(r.notes || ""),
      actor_email: String(r.actor_email || ""),
      created_at: toIsoOrNull(r.created_at) || new Date().toISOString(),
    };
  });
}

// --- Centralized Admission Schedules & Student Tracking persistence ---

export interface PgAdmissionEventRow {
  event_id: string;
  university_id: string;
  event_name: string;
  event_type: string;
  academic_year: string | null;
  start_date: string | null;
  end_date: string | null;
  exam_time: string | null;
  venue: string | null;
  official_source_url: string | null;
  description: string;
  verification_status: "verified" | "unverified" | "tba";
  updated_by: string;
  created_at: string;
  last_updated_at: string;
}

export interface PgUserApplicationStatusRow {
  user_id: string;
  university_id: string;
  status: string;
  updated_at: string;
}

export interface PgUserEventReminderRow {
  user_id: string;
  event_id: string;
  enabled: boolean;
  intervals_days: number[];
  channels: string[];
  dismissed_keys: string[];
  updated_at: string;
}

export async function dbLoadAdmissionEvents(): Promise<PgAdmissionEventRow[]> {
  const pool = getPool();
  if (!pool || !schemaReady) return [];
  const result = await pool.query(
    `SELECT event_id, university_id, event_name, event_type, academic_year,
            start_date, end_date, exam_time, venue,
            official_source_url, description, verification_status,
            updated_by, created_at, last_updated_at
       FROM admission_events
      ORDER BY start_date ASC NULLS LAST, university_id ASC, event_name ASC`,
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const rawVer = String(r.verification_status || "tba");
    const verification_status: "verified" | "unverified" | "tba" =
      rawVer === "verified" || rawVer === "unverified" ? rawVer : "tba";
    return {
      event_id: String(r.event_id),
      university_id: String(r.university_id),
      event_name: String(r.event_name),
      event_type: String(r.event_type),
      academic_year:
        typeof r.academic_year === "string" && r.academic_year.trim()
          ? r.academic_year.trim()
          : null,
      start_date: typeof r.start_date === "string" && r.start_date ? r.start_date : null,
      end_date: typeof r.end_date === "string" && r.end_date ? r.end_date : null,
      exam_time: typeof r.exam_time === "string" && r.exam_time ? r.exam_time : null,
      venue: typeof r.venue === "string" && r.venue ? r.venue : null,
      official_source_url:
        typeof r.official_source_url === "string" && r.official_source_url
          ? r.official_source_url
          : null,
      description: String(r.description || ""),
      verification_status,
      updated_by: String(r.updated_by || "system"),
      created_at: toIsoOrNull(r.created_at) || new Date().toISOString(),
      last_updated_at: toIsoOrNull(r.last_updated_at) || new Date().toISOString(),
    };
  });
}

export async function dbUpsertAdmissionEvent(
  event: PgAdmissionEventRow,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO admission_events (
      event_id, university_id, event_name, event_type, academic_year,
      start_date, end_date, exam_time, venue,
      official_source_url, description, verification_status,
      updated_by, created_at, last_updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15
    )
    ON CONFLICT (event_id) DO UPDATE SET
      university_id = EXCLUDED.university_id,
      event_name = EXCLUDED.event_name,
      event_type = EXCLUDED.event_type,
      academic_year = EXCLUDED.academic_year,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      exam_time = EXCLUDED.exam_time,
      venue = EXCLUDED.venue,
      official_source_url = EXCLUDED.official_source_url,
      description = EXCLUDED.description,
      verification_status = EXCLUDED.verification_status,
      updated_by = EXCLUDED.updated_by,
      last_updated_at = EXCLUDED.last_updated_at`,
    [
      event.event_id,
      event.university_id,
      event.event_name,
      event.event_type,
      event.academic_year || "",
      event.start_date,
      event.end_date,
      event.exam_time,
      event.venue,
      event.official_source_url,
      event.description,
      event.verification_status,
      event.updated_by,
      event.created_at,
      event.last_updated_at,
    ],
  );
}

export async function dbDeleteAdmissionEvent(eventId: string): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(`DELETE FROM user_event_reminders WHERE event_id = $1`, [
    eventId,
  ]);
  await pool.query(`DELETE FROM admission_events WHERE event_id = $1`, [
    eventId,
  ]);
}

export async function dbLoadAllUserApplicationTracking(): Promise<
  PgUserApplicationStatusRow[]
> {
  const pool = getPool();
  if (!pool || !schemaReady) return [];
  const result = await pool.query(
    `SELECT user_id, university_id, status, updated_at
       FROM user_application_tracking`,
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      user_id: String(r.user_id),
      university_id: String(r.university_id),
      status: String(r.status || "Interested"),
      updated_at: toIsoOrNull(r.updated_at) || new Date().toISOString(),
    };
  });
}

export async function dbUpsertUserApplicationStatus(
  userId: string,
  universityId: string,
  status: string,
  updatedAt: string,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO user_application_tracking (user_id, university_id, status, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, university_id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [userId, universityId, status, updatedAt],
  );
}

export async function dbLoadAllUserEventReminders(): Promise<
  PgUserEventReminderRow[]
> {
  const pool = getPool();
  if (!pool || !schemaReady) return [];
  const result = await pool.query(
    `SELECT user_id, event_id, enabled, intervals_days, channels, dismissed_keys, updated_at
       FROM user_event_reminders`,
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      user_id: String(r.user_id),
      event_id: String(r.event_id),
      enabled: Boolean(r.enabled),
      intervals_days: Array.isArray(r.intervals_days)
        ? r.intervals_days.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : [7, 3, 1],
      channels: Array.isArray(r.channels)
        ? r.channels.map((v) => String(v))
        : ["in_app"],
      dismissed_keys: Array.isArray(r.dismissed_keys)
        ? r.dismissed_keys.map((v) => String(v))
        : [],
      updated_at: toIsoOrNull(r.updated_at) || new Date().toISOString(),
    };
  });
}

export async function dbUpsertUserEventReminder(
  reminder: PgUserEventReminderRow,
): Promise<void> {
  const pool = getPool();
  if (!pool || !schemaReady) return;
  await pool.query(
    `INSERT INTO user_event_reminders (
      user_id, event_id, enabled, intervals_days, channels, dismissed_keys, updated_at
    ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
    ON CONFLICT (user_id, event_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      intervals_days = EXCLUDED.intervals_days,
      channels = EXCLUDED.channels,
      dismissed_keys = EXCLUDED.dismissed_keys,
      updated_at = EXCLUDED.updated_at`,
    [
      reminder.user_id,
      reminder.event_id,
      reminder.enabled,
      JSON.stringify(reminder.intervals_days),
      JSON.stringify(reminder.channels),
      JSON.stringify(reminder.dismissed_keys),
      reminder.updated_at,
    ],
  );
}


