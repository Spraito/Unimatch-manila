# UniMatch PH — College Admissions Aggregator for Manila

> **Information Assurance and Security 1 (IAS 1) Technical & Security Documentation**  
> **Program / Section:** BS Computer Science — BCS35, De La Salle University–Dasmariñas (DLSU-D)  
> **Project Scope:** Secure full-stack web application matching prospective Philippine college students, parents, and guardians with Manila Higher Education Institutions (HEIs).

---

## Table of Contents

1. [Project Overview & Problem Statement](#1-project-overview--problem-statement)
2. [System Architecture & Tech Stack](#2-system-architecture--tech-stack)
3. [CIA Triad Mapping (Confidentiality, Integrity, Availability)](#3-cia-triad-mapping-confidentiality-integrity-availability)
4. [Detailed Security Architecture & Implemented Controls](#4-detailed-security-architecture--implemented-controls)
5. [Information Assets & Threat/Risk Mitigation Matrix](#5-information-assets--threatrisk-mitigation-matrix)
6. [Philippine Data Privacy Act of 2012 (RA 10173) Compliance](#6-philippine-data-privacy-act-of-2012-ra-10173-compliance)
7. [Setup & Environment Configuration Guide](#7-setup--environment-configuration-guide)
8. [Presentation Talking Points & Defense Q&A Guide](#8-presentation-talking-points--defense-qa-guide)

---

## 1. Project Overview & Problem Statement

### The Problem
Prospective Philippine Senior High School (SHS) graduates, parents, and guardians face fragmented, inconsistently formatted admissions information scattered across individual university portals, PDFs, and social media announcements. Checking entrance exams (such as UPCAT, USTET, DCAT, and PUPCET), tuition ranges, degree offerings, academic strand alignments, and deadlines across Manila universities is time-consuming and error-prone—especially during peak college application windows.

### The UniMatch PH Solution
**UniMatch PH** aggregates curated admissions evidence for **15 Manila city-proper Higher Education Institutions (HEIs)**—including **UP Manila, UST, DLSU, Adamson University, PUP Sta. Mesa, UE, FEU, San Beda University, Mapúa University, LPU Manila, CEU, TUP, PNU, PLM, and St. Paul University Manila**—into a single transparent, review-backed web platform.

### Core Functional Features
- **Public University & Program Directory (`/`, `/explore`)**: Searchable university catalog with official school seals (`public/static/logos/`), side-by-side comparison (up to 3 universities via `/api/compare`), topic filters, light/dark themes, and transparent source links. Public browsing requires **no account**.
- **Explainable Recommendation Engine (`/api/recommendations`, `/profile`, `/cloud-profile`)**:
  - **Algorithm 1 — Keyword-Based NLP Extraction & Reconciliation (`src/algorithms/extraction.ts`)**: Structures admission requirements, deadlines, entrance exams, tuition fee ranges, and official links while flagging conflicting source claims (`declared_conflicts`) without inventing missing data.
  - **Algorithm 2 — Rule-Based Weighted Matching (`src/algorithms/matching.ts`)**: Scores university/program candidates against student preferences—preferred degree/program (45% default), campus location (20%), tuition budget and billing basis (20%), and public/private sector (15%)—using published strand alignment and numeric fee evidence. Missing source values score `0` and are labeled `unknown`.
  - **Algorithm 3 — Hand-Written Stable Merge Sort (`src/algorithms/mergeSort.ts`)**: Deterministically ranks recommendations highest-first while preserving tie order.
- **Optional Student & Administrator Accounts**: Students can optionally sign up via email/password or Google Sign-In to save preferences and shortlists across sessions, while authorized administrators manage the admissions catalog (`/admin`) and administrator roster (`/admin/accounts`).

---

## 2. System Architecture & Tech Stack

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Browser Client (HTTPS / TLS)                          │
│  • Server-Rendered EJS Views (views/*.ejs) + Vanilla JS (public/static/)     │
│  • Bundled TypeScript Client (client/firebaseClient.ts → esbuild ESM)        │
│    - Google Sign-In (Firebase Auth Popup) + /api/auth/google-sync check      │
│    - Admin Catalog & Admin Account Management UI                             │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS (Strict CSP, Same-Origin, CSRF, Cookies)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                 Node.js + TypeScript + Express 5 Backend                     │
│  • Entry & Security Middleware (src/server.ts, src/env.ts)                   │
│  • Auth & Profile Routes (src/routes/auth.ts) + Admin RBAC (src/routes/admin)│
│  • Account & Admin Business Logic (src/accounts.ts, src/adminAccounts.ts)    │
│  • Crypto & Hardening (src/security.ts, src/securityHardening.ts)            │
│  • Matching & Polite Collector Engines (src/algorithms/*, src/collector.ts)  │
└───────┬──────────────────────────┬───────────────────────────┬───────────────┘
        │ Parameterized SQL (TLS)  │ Verify ID Token / Rules   │ HTTPS POST (api-key)
        ▼                          ▼                           ▼
┌───────────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐
│  Neon Serverless  │   │  Firebase Auth &      │   │  Brevo HTTPS REST API    │
│  PostgreSQL       │   │  Cloud Firestore      │   │  api.brevo.com/v3/smtp/  │
│  (DATABASE_URL)   │   │  (firebaseAdmin.ts,   │   │  email (BREVO_API_KEY)   │
│  • users (UNIQUE) │   │   firestore.rules)    │   │  • Password Reset Links  │
│  • user_preferences│  │  • Google OAuth 2.0   │   │  • Google-Only Reminders │
└───────────────────┘   └───────────────────────┘   └──────────────────────────┘
```

### Technology Stack (As Implemented)

| Layer | Technology / Library | Live Files |
| --- | --- | --- |
| **Frontend Views & UI** | EJS templates, custom CSS (light/dark themes), Vanilla JS, esbuild-bundled TypeScript | `views/*.ejs`, `public/static/app.js`, `client/*.ts` → `public/static/firebase-client.js` |
| **Backend Runtime** | Node.js (ESM), TypeScript, Express 5, `express-session` | `src/server.ts`, `src/routes/auth.ts`, `src/routes/admin.ts` |
| **Primary Relational DB** | Neon Serverless PostgreSQL via `pg` (`Pool`) with auto-created schema on startup | `src/db/postgres.ts`, `src/accountPersistence.ts` |
| **Cloud Auth & Secondary Store** | Firebase Auth (Google OAuth 2.0), `firebase-admin` (`verifyIdToken`), Cloud Firestore | `src/lib/firebaseAdmin.ts`, `client/firebaseClient.ts`, `firestore.rules` |
| **Cryptography & Auth Hardening** | Node `crypto` (AES-256-GCM, HMAC-SHA256, RFC 6238 TOTP), `bcryptjs` | `src/security.ts`, `src/securityHardening.ts` |
| **Transactional Email** | Brevo v3 HTTPS REST API (`POST https://api.brevo.com/v3/smtp/email`) | `src/mailer.ts` |
| **Environment & Config** | `dotenv` with production-safe defaults | `src/env.ts`, `.env.example`, `config/universities.json` |
| **Testing & Linting** | Node built-in test runner (`tsx --test`), `tsc --noEmit`, ESLint (`@firebase/eslint-plugin-security-rules`) | `src/*.test.ts`, `firestore.rules.test.ts` |

---

## 3. CIA Triad Mapping (Confidentiality, Integrity, Availability)

| CIA Pillar | Security Objective | Concrete Implementation in UniMatch PH |
| --- | --- | --- |
| **Confidentiality** | Protect student PII, passwords, 2FA secrets, sessions, and API credentials from unauthorized disclosure. | • **PII encryption at rest** using AES-256-GCM (`encryptPii`/`decryptPii` in `src/security.ts`) with a 32-byte `UNIMATCH_DATA_KEY`.<br>• **Blind-index lookup hashes** via HMAC-SHA256 (`UNIMATCH_LOOKUP_KEY`) so lookups avoid exposing plaintext keys in index maps.<br>• **One-way password hashing** using `bcryptjs` (`hashPassword`) and hashed TOTP recovery codes.<br>• **Strict owner-only Firestore rules** (`firestore.rules`: default-deny + `isVerifiedOwner(userId)` on `/users/{userId}/private/profile`).<br>• **Session cookie hardening** (`HttpOnly`, `SameSite`, `Secure`/`Partitioned` over HTTPS) and `Cache-Control: no-store` on auth/API routes.<br>• **Secret isolation**: `DATABASE_URL`, `BREVO_API_KEY`, and encryption keys loaded exclusively from `process.env` and gitignored. |
| **Integrity** | Prevent tampering with accounts, duplicate identities, SQL injection, XSS, CSRF, privilege escalation, and fabricated admissions data. | • **Database-level uniqueness**: `email TEXT NOT NULL UNIQUE` and `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(TRIM(email)))` in `src/db/postgres.ts`.<br>• **Cross-provider deduplication**: Blocks manual signup when a Google account owns an email and blocks Google Sign-In when a local account owns an email (HTTP `409`).<br>• **Parameterized SQL** (`$1, $2, ...`) in every PostgreSQL query.<br>• **Authenticated encryption (GCM auth tag + AAD)** detects tampered PII ciphertexts (`DecryptionError`).<br>• **CSRF tokens + Same-Origin checks** (`isCsrfValid`, `verifySameOriginMiddleware`) and **RBAC** (`requireAdmin`) on all admin mutations.<br>• **Firestore anti-tampering rules**: Strict `hasAll`/`hasOnly` schema checks, immutable `uid`/`createdAt`, server-timestamp checks (`request.time`), and admin-only catalog writes. |
| **Availability** | Keep admissions search, authentication, and password recovery reliable under traffic spikes, restarts, or external service hiccups. | • **Neon Serverless PostgreSQL persistence** (`pg.Pool` with `max: 10`, idle timeout, connection timeout, and non-fatal `pool.on("error")` handling) replaces volatile in-memory storage.<br>• **Startup resilience**: Automatic `CREATE TABLE IF NOT EXISTS` schema initialization and graceful fallback store (`src/accountPersistence.ts`) if `DATABASE_URL` is absent in offline environments.<br>• **Bounded in-memory rate limiting** (`SlidingFixedWindowLimiter` in `src/securityHardening.ts`) with automatic bucket eviction (`maxBuckets: 5000`) and `Retry-After` headers to mitigate brute-force and DoS floods.<br>• **Request body limits** (`256kb` default, `2mb` admin JSON import) and **HTTPS-based Brevo REST API** (`AbortSignal.timeout(15_000)`) avoiding blocked cloud SMTP ports (587/465). |

---

## 4. Detailed Security Architecture & Implemented Controls

### 4.1 Data Protection & PII Encryption

#### Protection in Transit
- **Reverse Proxy & HTTPS Detection (`src/server.ts`)**: `app.set("trust proxy", 1)` trusts cloud proxy headers (`X-Forwarded-Proto`, `X-Forwarded-Host`). `isSecureClientRequest()` detects HTTPS requests and upgrades session cookies via `upgradeCookieForIframe()` to `SameSite=None; Secure; Partitioned` for HTTPS cross-context previews while retaining `HttpOnly`.
- **Database & API Transport**: Neon PostgreSQL connections automatically enforce TLS (`sslmode=require` / `ssl: { rejectUnauthorized: true }` for `neon.tech` hosts in `src/db/postgres.ts`). Transactional emails travel strictly over HTTPS to Brevo's REST API (`src/mailer.ts`). All stored university URLs pass `safeUrl()` (`src/store.ts`), which accepts `https:` URLs only and rejects embedded credentials.

#### Protection at Rest (`src/security.ts`)
UniMatch PH separates cryptographic responsibilities across **three distinct environment secrets**:

1. **`UNIMATCH_DATA_KEY` (32-byte key — hex or base64 via `parse32ByteKey()`)**:
   - Encrypts sensitive user PII (`email_encrypted`, `username_encrypted`, `display_name_encrypted`, and `totp_secret_encrypted`) using **AES-256-GCM** (`encryptPii()` / `decryptPii()`).
   - Generates a fresh **12-byte (96-bit) cryptographically random nonce** per encryption, attaches Associated Authenticated Data (`ENCRYPTION_CONTEXT = "unimatch-profile-pii-v1"`), and appends the 16-byte GCM authentication tag. Any modification or wrong key triggers `DecryptionError`.
2. **`UNIMATCH_LOOKUP_KEY` (32-byte key — hex or base64)**:
   - Computes keyed **HMAC-SHA256 blind-index hashes** (`emailLookupHash()` with context `"unimatch-email-lookup-v1"` and `usernameLookupHash()` with context `"unimatch-username-lookup-v1"`).
   - Because AES-256-GCM uses random nonces (non-deterministic ciphertext), separating the blind-index key allows deterministic `O(1)` lookup by email/username without reusing the encryption key or storing raw secrets in lookup maps.
3. **`SECRET_KEY` (Session & Reset Token Signing Secret)**:
   - Signs `express-session` cookies (`unimatch_session`) and HMAC-SHA256 timed password-reset tokens (`makeResetToken()` / `loadResetToken()`, 30-minute `RESET_MAX_AGE_SECONDS = 1800`, compared with `crypto.timingSafeEqual`).

#### Password & Recovery Code Hashing (`src/security.ts`, `src/accounts.ts`)
- Local user and admin passwords are **never stored in plaintext**; they are hashed with **`bcryptjs` (`bcrypt.hashSync(password, 10)`)** and verified with `bcrypt.compareSync`.
- Login failures for unknown or Google-only users still execute `verifyPassword(..., DUMMY_PASSWORD_HASH)` to reduce timing side-channels.
- Optional 2FA (RFC 6238 TOTP) generates 10 single-use recovery codes stored exclusively as bcrypt hashes (`hashRecoveryCodes()` / `consumeRecoveryCode()`).

---

### 4.2 Authentication, Session Security & Account Deduplication

#### Unified Dual-Provider Account Model (`src/db/postgres.ts`, `src/accounts.ts`)
UniMatch PH supports both **manual email/password** (`auth_provider = 'local'`) and **Google OAuth 2.0 via Firebase Auth** (`auth_provider = 'google'`), persisted in the Neon PostgreSQL `users` table:
- `email TEXT NOT NULL UNIQUE` plus a case-insensitive functional unique index:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(TRIM(email)));
  ```
- `auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'google'))`
- `firebase_uid TEXT UNIQUE` and `user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)`

#### Email Normalization & Cross-Provider Deduplication
Every authentication flow normalizes emails via `normalizeEmail()` (`trim().toLowerCase()` + RFC-length/format validation):
1. **Manual Registration (`POST /register` → `createUserAsync()` in `src/accounts.ts`)**:
   - Queries Neon PostgreSQL (`dbFindUserByEmail(normalizedEmail)`) and the account store before insertion (and catches PostgreSQL unique-violation code `23505` on concurrent signups).
   - If the email already belongs to a Google OAuth account (or the bootstrapped Google admin), registration is rejected with **HTTP `409`** (`AccountConflictError`) and displays:  
     *"An account with this email already exists via Google Sign-In. Please sign in with Google instead."*
   - Attempting password login (`POST /login` → `authenticate()`) against a Google-only account returns explicit guidance to click **"Continue with Google"**.
2. **Google OAuth 2.0 Sign-In (`client/firebaseClient.ts` → `POST /api/auth/google-sync` → `registerOrVerifyGoogleAccount()`)**:
   - Immediately after `signInWithPopup(auth, provider)`, the client obtains a fresh Firebase ID token and calls `POST /api/auth/google-sync` with `Authorization: Bearer <idToken>`.
   - The backend verifies the signature/claims via `adminAuth.verifyIdToken(token)` (`src/lib/firebaseAdmin.ts`) and checks Neon PostgreSQL (`dbFindUserByEmail`).
   - If a `local` email/password account already owns that email, the server returns **HTTP `409`** (`code: "AUTH_PROVIDER_CONFLICT"`). The client immediately runs `await signOut(auth)` (preventing any duplicate Firestore profile or active session) and displays:  
     *"An account with this email already exists using email and password. Please log in with your email and password instead."*

#### Session Hardening & Account Lockout
- **Session Fixation Defense**: `regenerateAndRedirect()` in `src/routes/auth.ts` calls `req.session.regenerate()` and `refreshCsrfToken(req)` on every successful login, 2FA verification, and registration.
- **Session Invalidation**: Every `UserRecord` carries an integer `session_version`. Changing or resetting a password increments `session_version` (`updatePasswordInternal()`), automatically invalidating all older browser sessions on the next request (`src/server.ts`).
- **Brute-Force Lockout**: `authenticate()` locks local accounts for **15 minutes** after **5 consecutive failed password attempts** (`MAX_FAILED_LOGINS = 5`, `LOCKOUT_MS = 15 * 60 * 1000`).

#### Password Reset via Brevo HTTPS REST API (`src/mailer.ts`, `src/routes/auth.ts`)
- Replaced raw SMTP sockets (ports 587/465) with Brevo's v3 HTTPS REST API (`POST https://api.brevo.com/v3/smtp/email`), authenticated via `process.env.BREVO_API_KEY` in the `api-key` header and sending strictly from **`UniMatch PH <spraitospraito@gmail.com>`**.
- `POST /forgot-password` returns a neutral confirmation message to the browser (anti-enumeration) while logging every server-side step:
  1. Normalized email lookup in Neon PostgreSQL (`dbFindUserByEmail`) and local fallback store.
  2. Provider routing:
     - **Active local account**: generates a 30-minute HMAC-signed reset link (`makeResetToken`) and emails it via `sendPasswordResetEmail()`.
     - **Google-only account**: instead of silently failing, calls `sendGoogleSignInReminderEmail()` to guide the user to sign in with Google on `/login`.
  3. Exact Brevo HTTP status and response body logged on both success and failure (API key never logged).

---

### 4.3 Access Control & Environment Hygiene

#### Role-Based Access Control (RBAC)
- **Unified Server-Side Admin Guard (`requireAdmin` in `src/routes/admin.ts`)**: Protects every `/api/admin/*` endpoint (`GET/POST/DELETE /api/admin/accounts`, `GET /api/admin/baseline`, `POST /api/admin/collect`, `POST /api/admin/parse-import`). Accepts either:
  1. A verified Firebase Bearer ID token (`adminAuth.verifyIdToken`) belonging to an authorized admin (`isVerifiedAdminToken()`), or
  2. An active Express session whose live user record has `role === "admin"`, `is_active === true`, and a matching `session_version` (plus CSRF verification via `requireCsrfForSessionAdmin` on all mutations).
- **Protected Admin Views**: `GET /admin` and `GET /admin/accounts` block signed-in student accounts server-side with **HTTP `403 Forbidden`**.
- **Admin Account Safeguards (`src/adminAccounts.ts`)**:
  - Prevents duplicate usernames and emails across all roles and providers (`409`).
  - Blocks self-removal of the currently signed-in admin (`409`), protects the primary Google admin (`403`), and prevents deleting the last remaining administrator (`409`).
  - Immediately deletes the revoked admin from memory and Neon PostgreSQL (`dbDeleteUser`) and purges all active Express sessions via `registerSessionRevoker()` (`sessionStore.destroy()`).
- **Cloud Firestore Rules (`firestore.rules`)**: Global default-deny (`match /{document=**} { allow read, write: if false; }`), owner-only verified access (`isVerifiedOwner`) to private student PII/preferences/shortlists, and strict admin-only writes (`isAdmin()`) to `/catalogUniversities` and `/collectionRuns`.

#### Environment Bootstrap & Secret Hygiene
- **`src/env.ts` (imported first in `src/server.ts` and `src/security.ts`)**:
  - Runs `dotenv.config()` on startup so local `.env` values load automatically without overriding secrets injected by the hosting platform.
  - **`UNIMATCH_ENV` Safe Default**: `resolveUnimatchEnv()` defaults to **`"production"`** whenever `UNIMATCH_ENV` is unset or blank (`IS_PRODUCTION === true`). This ensures development-only shortcuts—such as rendering `dev_reset_link` directly in `/forgot-password`—are **never exposed in production**.
- **Repository Hygiene**: `.env.example` contains only safe empty placeholders (`DATABASE_URL=`, `SECRET_KEY=`, `UNIMATCH_DATA_KEY=`, `UNIMATCH_LOOKUP_KEY=`, `BREVO_API_KEY=`), and `.gitignore` excludes `.env`, `.env.*`, `*.key`, `secrets/`, `.neon`, and `data/accounts.json`.

---

### 4.4 Injection Defense, Input Validation & API Hardening

| Threat Vector | Implemented Defense | Code Reference |
| --- | --- | --- |
| **SQL Injection (SQLi)** | 100% parameterized queries (`$1, $2, ...`) via `pg.Pool`; zero string concatenation in SQL statements. | `src/db/postgres.ts` (`dbFindUserByEmail`, `dbUpsertUser`, `dbDeleteUser`, `dbUpsertUserPreferences`) |
| **Cross-Site Scripting (XSS)** | EJS escaped interpolation (`<%= ... %>`), explicit HTML entity escaping (`escapeHTML` in client, `escapeHtml` in email templates), and strict **Content-Security-Policy** (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, no `unsafe-inline`). | `views/*.ejs`, `client/firebaseClient.ts`, `src/mailer.ts`, `buildCspHeader()` in `src/securityHardening.ts` |
| **Cross-Site Request Forgery (CSRF)** | Per-session cryptographic CSRF tokens validated via `crypto.timingSafeEqual` (`isCsrfValid`), reinforced by `verifySameOriginMiddleware` checking `Origin`/`Referer` against `Host`/`X-Forwarded-Host`. | `src/security.ts`, `src/securityHardening.ts`, `src/server.ts` |
| **Open Redirects** | All `next` redirect targets validated by `isSafeNextUrl()` (server) and `isSafeRedirect()` (client) to permit only relative same-origin paths. | `src/security.ts`, `client/firebaseClient.ts` |
| **Brute-Force & Traffic Spikes (DoS)** | Bounded `SlidingFixedWindowLimiter` returning HTTP `429` + `Retry-After` / `X-RateLimit-*` headers:<br>• Public `/api/*`: 120 req / 1 min<br>• `/login`, `/login/2fa`, `/api/auth/google-sync`, `/register`: 10 req / 15 min<br>• `/forgot-password`, `/reset-password`: 5 req / 15 min<br>• `/api/admin/accounts` writes: 25 req / 15 min<br>• `/api/admin/collect`: 8 req / 5 min | `src/securityHardening.ts`, `src/server.ts`, `src/routes/auth.ts`, `src/routes/admin.ts` |
| **Input & Payload Bounds** | Strict length/regex/enum checks on IDs (`^[a-zA-Z0-9_-]{1,128}$`), query strings (`<= 200` chars), budgets (`0..10,000,000`), weights, display names (`1..80`), passwords (`10..128`, non-trivial), and Express JSON limits (`256kb` / `2mb`). | `src/accounts.ts`, `src/server.ts`, `src/routes/admin.ts`, `firestore.rules` |
| **Security Headers & Safe Errors** | `app.disable("x-powered-by")`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cache-Control: no-store` on sensitive/API routes, and generic `500` responses without stack traces. | `src/server.ts` |

---

## 5. Information Assets & Threat/Risk Mitigation Matrix

### Key Information Assets

| Asset Category | Examples | Sensitivity | Primary Storage & Protection |
| --- | --- | --- | --- |
| **Student & Admin PII** | Normalized email, username, display name | **High** (RA 10173 Personal Information) | Neon PostgreSQL (`email_encrypted`, `display_name_encrypted` via AES-256-GCM) & owner-only Firestore `/users/{uid}/private/profile` |
| **Authentication Secrets & Credentials** | Password hashes, TOTP secrets, recovery codes, session cookies, reset tokens | **Critical** | `bcryptjs` hashes, AES-256-GCM TOTP secrets, `HttpOnly` signed cookies, 30-min HMAC tokens |
| **Infrastructure & API Secrets** | `DATABASE_URL`, `BREVO_API_KEY`, `UNIMATCH_DATA_KEY`, `UNIMATCH_LOOKUP_KEY`, `SECRET_KEY` | **Critical** | Platform Secrets / gitignored `.env` only; never committed or logged |
| **Student Preferences & Shortlists** | Preferred program, city, budget, weights, saved/compared schools | **Medium** | Neon PostgreSQL (`user_preferences`) & owner-only Firestore documents |
| **University Admissions Directory** | 15 Manila HEIs, programs, tuition evidence, exam coverage, deadlines, official links | **Public / Integrity-Critical** | Curated JSON (`config/`, `data/`) & admin-write-only Firestore `/catalogUniversities` |

### Threat & Risk Mitigation Table

| Threat / Risk Scenario | Pre-Control Risk | Implemented Mitigations in Live Code | Residual Risk & Next-Step Control |
| --- | --- | --- | --- |
| **API Key / Secret Exposure in Git** | High | `.env.example` scrubbed to empty placeholders; `.gitignore` blocks `.env*`, `*.key`, `.neon`; `src/env.ts` loads from runtime env; `src/mailer.ts` never logs `BREVO_API_KEY`. | Low — add automated CI secret scanning (e.g., Gitleaks/TruffleHog). |
| **SQL Injection on Queries / Auth** | High | All Neon PostgreSQL queries use `$1, $2, ...` parameterization (`src/db/postgres.ts`); strict regex & length validation on all route params (`src/server.ts`, `src/routes/admin.ts`). | Low — maintain parameterized query discipline and add SAST in CI. |
| **Cross-Site Scripting (XSS)** | High | EJS auto-escaping, explicit `escapeHTML`/`escapeHtml` helpers, and strict CSP (`buildCspHeader()` without `unsafe-inline`). | Low — monitor CSP violations if adding third-party scripts. |
| **Duplicate / Conflicting Accounts Across Auth Providers** | Medium–High | `normalizeEmail()` (`trim().toLowerCase()`), Postgres `UNIQUE` email constraint + `idx_users_email_lower`, `POST /api/auth/google-sync` conflict check returning `409` + automatic client `signOut(auth)`. | Low — email verification for manual local signups can be added as a future enhancement. |
| **Unauthorized Admin / Cross-User Data Access** | High | Server-side `requireAdmin` middleware (`src/routes/admin.ts`), immediate session revocation (`registerSessionRevoker`), and default-deny owner-only `firestore.rules`. | Low — add centralized immutable audit logging for admin actions. |
| **DoS / Brute-Force During Peak Admissions** | High | Per-IP `SlidingFixedWindowLimiter` with bounded buckets + `Retry-After`, 5-attempt account lockout (`15 min`), and `256kb` payload caps. | Medium — in-memory limiters are per-instance; deploy an external Cloud WAF (e.g., Cloud Armor/Cloudflare) + Redis-backed rate limiting for multi-instance scale. |
| **Password-Reset Link Leakage in UI** | High | `UNIMATCH_ENV` defaults to `"production"` (`src/env.ts`), suppressing `dev_reset_link` in `POST /forgot-password`; real reset links are emailed via Brevo HTTPS REST API. | Low — ensure Brevo sender domain authentication (SPF/DKIM/DMARC) and authorized egress IPs for production. |

---

## 6. Philippine Data Privacy Act of 2012 (RA 10173) Compliance

UniMatch PH is designed to align with **Republic Act No. 10173 (Data Privacy Act of 2012)** and its Implementing Rules and Regulations (IRR) for processing student personal information:

1. **Transparency**:
   - Users are informed upfront what data is collected (email, display name, and optional college matching preferences) and why it is used (personalized university matching and account recovery).
   - Admissions facts display their official source URLs, retrieval timestamps, and review notices rather than opaque claims.
2. **Legitimate Purpose**:
   - Personal information is collected strictly for authenticating optional student/admin accounts, saving college-matching preferences, and sending requested password-reset or Google Sign-In guidance emails. UniMatch PH never sells, shares, or profiles student data for advertising.
3. **Proportionality (Data Minimization)**:
   - **Account creation is optional**: prospective students and parents can browse all 15 Manila universities, compare schools, and run recommendations without submitting any personal data.
   - When a student registers, only the minimum required fields (email, display name, password hash or Google UID) are stored—no government IDs, phone numbers, home addresses, grades, or financial statements are collected.
4. **User Consent & Data Subject Rights**:
   - Users voluntarily opt in via `/register` or **Continue with Google** (with Google OAuth consent prompt `prompt: "select_account"`).
   - Authenticated users can inspect and update their own profile, email, display name, preferences, password, and 2FA settings (`/profile`, `/cloud-profile`), and Firestore rules grant verified owners direct delete capability on their own `/users/{userId}` documents.
5. **Reasonable & Appropriate Security Measures (RA 10173, Section 20)**:
   - **Technical**: AES-256-GCM PII encryption at rest, separate HMAC-SHA256 blind-index keys, `bcryptjs` password hashing, TLS in transit, parameterized SQL, strict CSP/CSRF/RBAC controls, and rate limiting.
   - **Organizational / Operational**: Separation of student and admin privileges, protection against last-admin lockout, immediate session revocation upon admin removal, production-safe defaults (`UNIMATCH_ENV=production`), and zero hardcoded credentials.

---

## 7. Setup & Environment Configuration Guide

### Prerequisites
- **Node.js 20+** and **npm**
- A **Neon PostgreSQL** database connection string (`DATABASE_URL`)
- A **Brevo** API key (`BREVO_API_KEY`) with `spraitospraito@gmail.com` authorized as sender
- Firebase project configuration (`firebase-applet-config.json`) for Google Sign-In & Firestore features

### Environment Variables
Copy `.env.example` to a local, gitignored `.env` file (or configure under your hosting platform's **Secrets** manager). **Never commit real values to Git.**

```env
# Server configuration
PORT=3000
UNIMATCH_ENV=production
TRUST_PROXY=1

# Neon PostgreSQL connection string (pooled URL with sslmode=require)
DATABASE_URL=

# Session & PII encryption keys (generate 32-byte keys with: openssl rand -hex 32)
SECRET_KEY=
UNIMATCH_DATA_KEY=
UNIMATCH_LOOKUP_KEY=

# Brevo HTTPS REST API key for transactional emails
# Endpoint: POST https://api.brevo.com/v3/smtp/email | Sender: UniMatch PH <spraitospraito@gmail.com>
BREVO_API_KEY=
```

Generate cryptographically strong 32-byte keys locally:
```bash
openssl rand -hex 32   # Use separate outputs for SECRET_KEY, UNIMATCH_DATA_KEY, UNIMATCH_LOOKUP_KEY
```

### Run Locally & Verify

```bash
# 1. Install dependencies
npm install

# 2. Build server TypeScript (dist/) and bundle client Firebase module (public/static/firebase-client.js)
npm run build

# 3. Run typecheck + Firestore security rules linter
npm run lint

# 4. Run automated security, admin, collector, and Postgres/Brevo test suites
npx tsx --test src/postgresAndBrevo.test.ts src/adminAccounts.test.ts src/securityHardening.test.ts src/collector.test.ts

# 5. Start development server (auto-creates Neon Postgres tables on boot when DATABASE_URL is set)
npm run dev

# Or run the compiled production build
npm start
```

The server listens on `http://0.0.0.0:3000` (configurable via `PORT`).

---

## 8. Presentation Talking Points & Defense Q&A Guide

### Key Real-World Engineering Highlights (For Live Demo)

1. **Migration from Volatile Storage to Neon Serverless PostgreSQL (`src/db/postgres.ts`, `src/server.ts`)**:
   - Earlier prototypes relied on volatile in-memory maps/local files. We wired `pg.Pool` to `process.env.DATABASE_URL` with automatic startup schema creation (`CREATE TABLE IF NOT EXISTS users` and `user_preferences`) and startup hydration (`loadAccountsFromPostgres()`), while keeping a safe offline fallback if `DATABASE_URL` is absent during local testing.
2. **Preventing Duplicate & Conflicting Accounts Across Auth Providers (`src/accounts.ts`, `src/routes/auth.ts`, `client/firebaseClient.ts`)**:
   - A common real-world security and UX flaw is letting one user accidentally create two accounts with the same email—one via Google OAuth and one via email/password.
   - We solved this at **both** the database layer (`email TEXT NOT NULL UNIQUE` + `idx_users_email_lower` on `LOWER(TRIM(email))`) and the application layer (`normalizeEmail()`, `createUserAsync()`, and `POST /api/auth/google-sync`). Attempting cross-provider signup returns HTTP `409`, signs out conflicting Google sessions immediately, and tells the user which sign-in method to use.
3. **Cryptographic Separation with 32-Byte Keys (`src/security.ts`)**:
   - Student PII is encrypted at rest using **AES-256-GCM** (`UNIMATCH_DATA_KEY`), while deterministic lookups use a separate **HMAC-SHA256** blind-index key (`UNIMATCH_LOOKUP_KEY`), and passwords use **`bcryptjs`**. Even if a database dump were exposed, plaintext passwords and encrypted PII fields cannot be recovered without the runtime environment keys.
4. **Fail-Safe `UNIMATCH_ENV=production` Default & Brevo HTTPS REST Email (`src/env.ts`, `src/mailer.ts`, `src/routes/auth.ts`)**:
   - `src/env.ts` loads `.env` at startup and defaults `UNIMATCH_ENV` to `"production"` whenever unset, guaranteeing development-only `dev_reset_link` tokens never appear in the browser UI.
   - Instead of raw SMTP (ports 587/465, often blocked in cloud containers), password resets and Google-only sign-in reminders are sent via **Brevo's HTTPS REST API** (`POST https://api.brevo.com/v3/smtp/email`) strictly from `UniMatch PH <spraitospraito@gmail.com>`, with step-by-step server diagnostics logging PostgreSQL lookups and exact Brevo HTTP responses.

---

### Expected Instructor Q&A (Code-Grounded Answers)

#### Q1: How does UniMatch PH comply with the Philippine Data Privacy Act of 2012 (RA 10173)?
> **Answer:** We enforce RA 10173 across four pillars directly in code:
> 1. **Data Minimization (Proportionality):** Browsing all 15 Manila universities and running recommendations requires zero personal data; accounts are optional and collect only email, display name, and academic matching preferences.
> 2. **Consent & Control:** Users explicitly opt in to register or sign in with Google, can edit their own profile/preferences at `/profile` or `/cloud-profile`, and can delete their own Firestore documents.
> 3. **Access Isolation:** `firestore.rules` starts with global default-deny and restricts `/users/{userId}/private/profile` to `request.auth.uid == userId && email_verified == true`.
> 4. **Reasonable Technical Safeguards (Sec. 20):** PII is encrypted at rest with AES-256-GCM (`src/security.ts`), passwords are hashed with `bcryptjs`, transport uses HTTPS/TLS, and admin routes enforce server-side RBAC (`src/routes/admin.ts`).

#### Q2: How are encryption keys and API secrets (`BREVO_API_KEY`, `DATABASE_URL`, etc.) protected from Git leakage?
> **Answer:** Zero secrets are hardcoded in `src/` or committed to Git. `.env.example` contains empty placeholders only; `.gitignore` explicitly blocks `.env`, `.env.*`, `*.key`, `secrets/`, `.neon`, and `data/accounts.json`. At runtime, `src/env.ts` invokes `dotenv.config()` without overriding platform-injected Secrets (`process.env`). In `src/mailer.ts`, error logs capture HTTP status and response bodies for debugging while strictly omitting `BREVO_API_KEY`—verified by our automated unit test in `src/postgresAndBrevo.test.ts`.

#### Q3: Why do you separate `UNIMATCH_DATA_KEY` and `UNIMATCH_LOOKUP_KEY` instead of using one key?
> **Answer:** AES-256-GCM (`encryptPii` in `src/security.ts`) intentionally uses a fresh random 12-byte nonce every time so encrypting the same email twice produces different ciphertexts—preventing pattern analysis. Because randomized ciphertext cannot be queried directly, we use a separate 32-byte `UNIMATCH_LOOKUP_KEY` to compute a domain-separated HMAC-SHA256 blind index (`emailLookupHash`, `usernameLookupHash`). Keeping these keys independent follows cryptographic key-separation best practices: compromising one key does not expose the other function, and `UNIMATCH_DATA_KEY` can be rotated without invalidating lookup hashes (and vice versa).

#### Q4: How does your backend prevent SQL Injection and Cross-Site Scripting (XSS)?
> **Answer:**
> - **SQL Injection:** Every query in `src/db/postgres.ts` uses `pg` parameterized placeholders (`$1, $2, ...`)—never string interpolation—so user input is always treated as data, never executable SQL. Additionally, route parameters and query inputs undergo strict regex, type, and length validation (`src/server.ts`, `src/accounts.ts`).
> - **XSS:** All server templates (`views/*.ejs`) use escaped output (`<%= ... %>`), dynamic client DOM rendering escapes strings via `escapeHTML()` (`client/firebaseClient.ts`), transactional emails escape names/URLs via `escapeHtml()` (`src/mailer.ts`), and `src/server.ts` sends a strict `Content-Security-Policy` header (`buildCspHeader()` in `src/securityHardening.ts`) with `default-src 'self'`, `object-src 'none'`, and no `unsafe-inline`.

#### Q5: What remaining vulnerabilities or limitations exist, and what are your planned future improvements?
> **Answer:** Being transparent about residual risks is a core IAS principle. While we implemented strong application-level controls, five production upgrades are planned next:
> 1. **External Cloud WAF & Distributed Rate Limiting:** Our `SlidingFixedWindowLimiter` (`src/securityHardening.ts`) is currently in-memory per Node process; scaling across multiple instances requires Redis-backed rate limiting behind a Cloud WAF (e.g., Cloudflare or Google Cloud Armor).
> 2. **Persistent Session Store:** `express-session` currently uses `MemoryStore`; moving sessions to PostgreSQL (`connect-pg-simple`) or Redis will preserve sessions across multi-instance deployments and restarts.
> 3. **Automated Key Rotation & Managed KMS:** Moving `UNIMATCH_DATA_KEY` / `UNIMATCH_LOOKUP_KEY` into a managed Secret Manager / KMS with scheduled rotation and PII re-encryption scripts.
> 4. **Email Verification for Local Signups & Custom Sending Domain:** Adding verification emails on manual registration and configuring a dedicated domain with SPF, DKIM, and DMARC records (plus authorized egress IPs in Brevo).
> 5. **Automated CI/CD Security Scanning & Audit Trails:** Integrating SAST, `npm audit` dependency scanning, secret scanning (Gitleaks), and an immutable PostgreSQL audit log table for all admin and authentication events.
