# UniMatch PH — Final Implementation Report

Date: 2026-10-29
Project: `Unimatch-data-aggregator-main`
Stack: Python 3.14, Flask, SQLite, vanilla HTML/CSS/JS

## 1. Summary

The existing UniMatch PH prototype was extended rather than replaced. The Flask
app, existing APIs, frontend workflows, SQLite data, and collector were preserved.
Three required algorithms were implemented as a shared `algorithms/` package and
integrated into the real collection, persistence, API, and recommendation flows.
A legal, CLI-driven collection pipeline and normalized admissions tables were added,
and the frontend now displays structured profiles and explainable weighted matches.
This phase also adds optional student registration, login/logout, profile editing,
saved preferences, personalised recommendations, CSRF protection, secure session
cookies, password hashing, authorization checks and AES-GCM encryption for profile
PII. Public browsing and the existing read APIs still work without an account.

The public entrance is now a simple server-rendered welcome page at `/` with the
forest-green, sage and cream visual identity, the existing campus illustration, and
clear **Sign up** / **Log in** actions. Successful authentication continues to the
full explorer at `/explore`; a quiet guest link keeps the directory available
without an account. The welcome page is intentionally limited to the welcome and
entry actions — the directory, statistics, filters, saved schools, comparison,
degree programs and recommendations remain in the existing application at
`/explore`.

Every page also has a light/dark switch. The theme follows the operating-system
preference on the first visit, stores an explicit choice in `localStorage`, and is
applied by a same-origin head script before the first paint, so there is no flash
of the wrong palette. The dark palette keeps the forest-green identity and covers
the welcome page, the explorer, dialogs, recommendations, comparison tables and
the account pages.

No data is fabricated. Missing values stay empty, are labelled unknown in matching,
and display as "Not available" in the interface. Scholarships remain out of scope.

The school directory now contains 15 Manila city-proper universities. The previous
UP Diliman placeholder was replaced by UP Manila; an idempotent startup sync adds
newly configured schools to existing databases and removes the unused placeholder
without deleting collected programs.

## 2. The three algorithms

| # | Requirement | Location | How it is used |
| --- | --- | --- | --- |
| 1 | Keyword NLP extraction / categorization | `algorithms/extraction.py` | Runs after collection and on import/backfill; builds structured profile rows |
| 2 | Rule-based weighted matching | `algorithms/matching.py` | Powers `GET /api/recommendations` and the "Find my match" screen |
| 3 | Hand-written stable merge sort | `algorithms/merge_sort.py` | Sorts every recommendation by descending score; no `sorted()`/`.sort()` |

### Algorithm 1 — extraction and normalization

- Keyword and regex classification of university, programs, requirements,
  deadlines, entrance examinations, tuition, application links, and academic year.
- Normalizes academic years (`AY 2026-27` → `2026-2027`), complete dates to ISO,
  PHP fee ranges, degree names, and requirement statements.
- Removes navigation/boilerplate; splits numbered and prose requirement lists.
- Deduplicates programs, fees, requirements, and links.
- Reconciles conflicts by approved-source priority, completeness, and text length;
  discarded values are stored in `data_conflicts`.
- Ambiguous data (for example conflicting academic years) is left unresolved instead
  of guessed.
- Application links are limited to approved domains.

Key entry points: `structure_record()`, `categorize_text()`,
`split_requirement_statements()`, `build_deadlines()`, `build_fees()`, `reconcile()`.

### Algorithm 2 — weighted matching

Only criteria supplied by the student are scored:

```text
score = 100 × Σ(weight[c] × points[c]) / Σ(weight[c])
```

- Default weights: program 45%, location 20%, budget 20%, university type 15%.
- Weights are configurable via UI or `weights=program:0.5,location:0.2,...` and
  normalized to sum to 1.
- Program matching: exact, all-keyword, partial-keyword, or none.
- Location matching avoids false positives such as "Manila" matching the
  "Metro Manila" region for a Quezon City campus.
- Budget uses only published numeric fees with the same basis (semester, trimester,
  year, unit).
- Every result includes per-criterion status (`matched`, `partial`, `not_matched`,
  `unknown`), points, and a human-readable reason.
- Missing source data scores 0 and is marked unknown — never treated as a match.

Key entry points: `normalize_weights()`, `validate_preferences()`,
`score_candidate()`, `recommend()`.

### Algorithm 3 — stable merge sort

- Recursive top-down merge sort with a temporary buffer.
- Stable: equal scores retain input order, so ties are deterministic.
- Does not call Python's `sorted()` or `list.sort()`.
- `merge_sort_by_score()` is used directly by recommendation ranking.

## 3. Collection and data pipeline

Collection is CLI-only and never runs on page load:

```bash
# Live collection (requires a real research contact).
.venv/bin/python -m flask --app webapp collect-data \
  --contact "your-real-email@your-university.edu"

# Validate and summarize without writing.
.venv/bin/python -m flask --app webapp collect-data --dry-run \
  --contact "your-real-email@your-university.edu"

# Run only when the configured interval has elapsed (cron/systemd).
.venv/bin/python -m flask --app webapp collect-data --due \
  --contact "your-real-email@your-university.edu"

# Reproducible offline demo with saved synthetic HTML.
.venv/bin/python -m flask --app webapp collect-data \
  --config config/demo_sources.json --fixture-dir fixtures/demo
```

Pipeline:

1. Fetch an approved, allow-listed public page.
2. Clean text (remove scripts/navigation/boilerplate).
3. Apply Algorithm 1 keyword categorization.
4. Normalize and validate fields.
5. Deduplicate and reconcile conflicts by source priority.
6. Store related SQLite rows, source status, and run history.
7. Display the organized profile while retaining raw source evidence.

Compliance and failure behavior:

- `config/collection.json` holds contact, delay range, timeout, global approved
  domains, and schedule interval (default weekly).
- Each university has its own `approved_domains`; startup/collection fails closed
  for unapproved pages.
- Honors robots.txt (including same-origin redirects), randomized 2–5 s delays or
  crawl delay, TLS verification, and a 4 MiB download limit.
- Stops on 403/429 and never bypasses logins, CAPTCHA, paywalls, or access controls.
- Source rows record URL, domain, status, HTTP status, retrieval time, verification
  time, fields, and error.
- A failed refresh preserves the last-known status, timestamp, programs, and
  structured rows; it does not erase or rebuild them.
- Alternatives when automated collection is not permitted: official API/download,
  manual `import-data` JSON, or the offline fixture.

## 4. Database changes

Existing `universities`, `programs`, `evidence_json`, and `sources_json` remain for
backward compatibility. Additive migrations add:

- `admission_requirements`
- `application_deadlines`
- `entrance_examinations`
- `tuition_fees`
- `application_links`
- `collection_sources`
- `collection_runs`
- `data_conflicts`
- `users` (email HMAC + AES-GCM ciphertext, encrypted display name, password hash,
  role, active flag, failed-login count, lockout expiry, timestamps)
- `user_preferences` (program, city, sector, budget, budget basis, normalized
  weights JSON, update timestamp, foreign key to `users`)

Data is stored as related rows, not one large text field. Startup migrates and
backfills older databases. The real database was backed up to
`instance/unimatch.sqlite3.bak-20261029011155` before migration and was then
migrated in place. Account tables are additive and do not alter public university
data.

## 5. Student accounts and security

Registration, login, logout, profile editing, saved preferences and personalised
recommendations are implemented in the current phase:

| Route | Method | Behaviour |
| --- | --- | --- |
| `/register` | GET, POST | Validates input, creates the account, logs in |
| `/login` | GET, POST | Verifies credentials, rotates the session |
| `/logout` | POST | Requires CSRF, clears the session |
| `/profile` | GET, POST | Own profile, preferences and ranked matches only |

Public browsing and read APIs remain open. Authorization uses only the user ID in
the signed server-side session; profiles are not addressed by a user-controlled URL
parameter, so one student cannot read or edit another student's data.

Controls:

- **Password storage:** Werkzeug `generate_password_hash` / `check_password_hash`
  (scrypt). No plaintext or reversible password storage.
- **CSRF:** session-bound tokens on register, login, profile updates and logout;
  invalid/missing tokens return HTTP 400. Login rotates the token.
- **Sessions:** signed cookies, `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  8-hour lifetime, session cleared on login and logout.
- **Brute force:** five failed logins trigger a 15-minute lockout; login errors do
  not reveal whether an email exists.
- **Validation:** normalized email, display-name limits, password length/variety,
  budget bounds, sector/basis allow-lists and normalized weights.
- **SQL:** parameterized statements for accounts and preferences.
- **XSS:** Jinja auto-escaping plus a CSP that disallows inline script.
- **Transport:** production HTTP→HTTPS redirect, HSTS, secure cookies and no-store
  caching for account/API responses.

### Hashing, encryption and HTTPS

| Data | Protection |
| --- | --- |
| Passwords | Werkzeug scrypt hash; not encrypted |
| Email | AES-GCM ciphertext + separate HMAC-SHA256 lookup hash |
| Display name | AES-GCM ciphertext |
| Preferences | Plaintext SQLite, access-controlled by authenticated `user_id` |
| Public university facts | Plaintext SQLite; intentionally not encrypted |
| Session | Signed Flask cookie; contains user ID and CSRF token only |
| Traffic | HTTPS in production; does not replace the controls above |

Encryption uses `cryptography`'s AES-GCM with a random nonce per value. A wrong key
or modified ciphertext raises `DecryptionError` instead of returning misleading
plaintext. Keys are loaded from `SECRET_KEY`, `UNIMATCH_DATA_KEY` and
`UNIMATCH_LOOKUP_KEY`; production startup refuses to run without them. Local
development may generate keys under `~/.config/unimatch`; tests use ephemeral keys.
No keys are hardcoded or stored with the database.

`flask --app webapp rotate-data-key` decrypts every account with the current data
key first, then re-encrypts all rows in one transaction with
`UNIMATCH_NEW_DATA_KEY`. A failure aborts before writing. The operator must retain
the old key until the new key and a backup are verified, then replace
`UNIMATCH_DATA_KEY` and restart. Rotating `UNIMATCH_LOOKUP_KEY` requires a separate
re-hash migration and is not automated.

This is not a claim of complete security. The app has no MFA, email verification,
password reset, audit log, per-IP throttling, administrator console or independent
security review.

## 6. Files changed or added

| File | Change |
| --- | --- |
| `algorithms/extraction.py` | Algorithm 1 |
| `algorithms/matching.py` | Algorithm 2 |
| `algorithms/merge_sort.py` | Algorithm 3 |
| `algorithms/__init__.py` | Package exports |
| `unimatch_ph.py` | Extraction integration, links, HTTP/timestamps, approved domains, browser engine |
| `webapp/database.py` | Migrations, structured tables, source registry, runs, conflicts, backfill, failure preservation, candidates, account tables |
| `webapp/collection.py` | Approved-domain validation, fixture fetcher, collection runner and CLI |
| `webapp/__init__.py` | Welcome `/` and explorer `/explore` routes, shared statistics/filter query, recommendation/config/collection APIs, structured detail/profile, CLI registration, security headers and HTTPS enforcement |
| `webapp/security.py` | Secret loading, cookie/session configuration, CSRF, AES-GCM PII encryption, safe redirects |
| `webapp/accounts.py` | Registration, authentication, lockout, profile/preferences persistence, key rotation CLI |
| `webapp/auth.py` | Login, register, logout, profile routes and authorization |
| `webapp/recommendations.py` | Shared recommendation orchestration for the API and profile |
| `webapp/templates/landing.html` | Welcome page with sign-up/log-in actions and guest directory link |
| `webapp/templates/_icons.html` | Shared SVG icon sprite, including the `#i-logo` brand mark |
| `webapp/templates/account_base.html`, `login.html`, `register.html`, `profile.html` | Account pages and personalised results |
| `webapp/static/logo.svg`, `favicon.svg` | Vector UniMatch mark and rounded favicon tile traced from `icons/Untitled.jpg` |
| `webapp/static/landing.css` | Welcome-page responsive visual system |
| `webapp/static/account.css` | Account-page styling |
| `webapp/static/theme.js` | Theme switch: saved/system preference, toggle state and theme-color |
| `webapp/static/theme-dark.css` | Dark palette for the explorer, welcome and account pages |
| `webapp/static/app.js` | Recommendation form/results, structured profile, comparison updates, `/explore` URL parameters |
| `webapp/static/style.css` | Recommendation, structured-profile and account-link styles |
| `webapp/templates/index.html` | Full explorer served at `/explore`, "Find my match" navigation and account links |
| `tests/test_landing.py` | Welcome page, authentication handoff and `/explore` route checks |
| `tests/test_theme.py` | Theme switch markup, asset delivery, persistence and page coverage |
| `tests/test_branding.py` | Shared logo symbol, favicon colours and removal of the old cap icon |
| `config/collection.json` | Collection contact/delays/domains/schedule |
| `config/demo_sources.json` | Synthetic offline source config |
| `fixtures/demo/` | Offline demo HTML and manifest (synthetic, labelled) |
| `tests/test_algorithms.py` | Algorithm tests |
| `tests/test_accounts.py` | Auth, authorization, CSRF, preferences, encryption, key rotation |
| `tests/test_collection.py` | Collection, persistence, API tests |
| `tests/test_web_browser.py` | Browser recommendation/profile workflows |
| `tests/test_browser.py` | Firefox fallback for rendering test |
| `README.md`, `webapp/README.md` | Updated documentation |
| `REPORT.md` | This report |

## 7. API additions

| Endpoint | Purpose |
| --- | --- |
| `GET /api/recommendations` | Ranked, explained matches (`program`, `city`, `sector`, `budget`, `budget_basis`, `weights`, `limit`) |
| `GET /api/recommendation-config` | Default weights, labels, formula, budget bases |
| `GET /api/collection/status` | Recent runs and per-source status |
| `GET /api/universities/<id>` | Now includes structured profile, availability, and declared conflicts |
| `GET /api/compare` | Now includes structured rows |

At least one preference is required. Invalid budgets, bases, sectors, weights, or
limits return HTTP 400.

Authenticated HTML routes (not JSON APIs):

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Welcome page with sign-up/log-in actions and guest directory link |
| `/explore` | GET | Full explorer; accepts `view`, `search`, `city`, `sector`, `topic`, `school`, `sort`, `notes` |
| `/register` | GET, POST | Create account |
| `/login` | GET, POST | Authenticate |
| `/logout` | POST | End session |
| `/profile` | GET, POST | Own profile, preferences and matches |

## 8. Running the project

```bash
cd Unimatch-data-aggregator-main
python -m venv .venv
.venv/bin/python -m pip install -r requirements-web.txt
.venv/bin/python run_web.py
```

The app seeds a new database with 15 Manila universities and 312 program
entries, then applies structured backfill. Existing databases gain any newly
configured directory entries on startup; the unused `up-diliman` placeholder is
retired in favour of `up-manila` without deleting collected programs.

## 9. Test results

Command:

```bash
.venv/bin/python -m pytest -q
```

Result:

```text
158 passed in 51.05s
```

Coverage includes:

- Extraction categories, normalization, requirement splitting, deadline labels,
  duplicate fees, ambiguous academic years, conflicts, and approved links.
- SQLite structured persistence, fixture collection, and failed-refresh
  preservation.
- Weighted scores, custom weights, unknown-data handling, stable ranking, and proof
  that built-in `sorted()` is not used.
- Recommendation and structured-profile APIs, validation errors, and regressions.
- Registration, duplicate emails, password policy, login/logout, lockout, CSRF
  rejection, cookie flags/lifetime, profile isolation, input validation, saved
  preferences, personalised ranking, encrypted PII, wrong-key failure and data-key
  rotation.
- Real browser workflows (Playwright Firefox) for exploration, details, comparison,
  recommendations, and structured profiles.
- Welcome-page sign-up/log-in links, guest directory access, returning-student
  view, authentication handoff to `/explore`, footer links and asset delivery.
- Theme switch on every entry page, accessible toggle markup, non-deferred
  same-origin theme script, dark-stylesheet coverage and logged-in page support.

The real database was also checked after migration: 15 universities, 313 stored
program rows (312 seeded PUP/DLSU entries plus the known unverified UST headline
artifact), 5 requirement rows, 1 fee row, 18 tracked sources, empty
`users`/`user_preferences` tables, and working recommendations. The old
`up-diliman` placeholder is absent and `up-manila` is present.

## 10. Limitations

- Only PUP was collected live (October 21, 2026). UP Manila, UST and the other
  newly added Manila schools remain directory entries until a successful
  collection/import.
- The 12 newly added schools each have one verified official admissions URL.
  Program and fee pages were not added because they were not verified, so those
  fields correctly show “Not available” rather than fabricated data.
- Seeded PUP/DLSU records have no numeric semester fee, so budget fit is commonly
  `unknown` by design.
- PUP's page mixes AY 2026–2027 with eligibility text for AY 2024–2025; the conflict
  is preserved rather than resolved.
- DLSU data comes from a user-supplied export with older references and scraping
  artifacts; it remains unverified evidence.
- Keyword extraction is heuristic and may miss facts or retain stale text; raw
  evidence is retained for review.
- Recommendations measure fit against supplied preferences and collected records,
  not admission chances or institutional quality.
- Browser tests used Playwright Firefox locally because Chromium download failed;
  tests use whichever engine is installed and skip if none is available.
- No administrator console, MFA, email verification, password reset, audit log,
  per-IP throttling or write API exists. The server is a local prototype, not a
  public production deployment, and it has not had an independent security review.

## 11. Delivery

- Updated source: `/home/spraito/Downloads/Unimatch-data-aggregator-main`
- Delivery archive: `/home/spraito/Downloads/Unimatch-data-aggregator-main-updated.zip`
- New web dependency: `cryptography>=43,<47` in `requirements-web.txt`
- Database backup: `instance/unimatch.sqlite3.bak-20261029020229` (pre-expansion; earlier backup: `instance/unimatch.sqlite3.bak-20261029011155`)

The ZIP excludes `.venv`, `__pycache__`, pytest caches, generated `output/` files,
and the `instance/` database (which contains local account data). Production
secrets are not included; set them in the deployment environment.
