# UniMatch PH — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Global Default Deny**: Every unmatched path in Firestore is denied for both reads and writes (`match /{document=**} { allow read, write: if false; }`).
2. **Strict PII Isolation**: Email and display name live exclusively in `/users/{userId}/private/profile`. Only the owning verified user (`request.auth.uid == userId && request.auth.token.email_verified == true`) may `get`, `create`, `update`, or `delete` their own document. Blanket reads and `list` operations on PII are forbidden.
3. **Identity & Immutability**: Every document under `/users/{userId}/...` must embed `uid == request.auth.uid == userId`. On update, `uid` and `createdAt` are immutable (`incoming().uid == existing().uid`, `incoming().createdAt == existing().createdAt`).
4. **Temporal Integrity**: `createdAt` must equal `request.time` on create; `updatedAt` must equal `request.time` on create and update. Client-forged timestamps are rejected.
5. **Volumetric & Type Bounds**:
   - `userId` and `uid`: `^[a-zA-Z0-9_\-]+$`, length `1..128`.
   - `displayName`: string `1..80`.
   - `email`: string `3..254`, matches `request.auth.token.email`.
   - `program` / `city`: string `0..200`.
   - `sector`: enum `['', 'Public', 'Private']`.
   - `budget`: `null` or number `0 <= budget <= 10000000`.
   - `budgetBasis`: enum `['semester', 'trimester', 'year', 'unit']`.
   - `weights`: map with exact keys `['program', 'location', 'budget', 'sector']`, each finite number `0..1`.
   - `savedIds`: list size `<= 50`, first element string `<= 128` when non-empty.
   - `compareIds`: list size `<= 3`, first element string `<= 128` when non-empty.
6. **Zero Shadow Fields & Action-Based Updates**: `create` enforces `hasAll` + `hasOnly`; `update` enforces `isValid*(incoming())` first plus `affectedKeys().hasOnly(...)` for each allowed action.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unauthenticated Read of Profile PII**: `GET /users/uid1/private/profile` with `auth = null` → `PERMISSION_DENIED`.
2. **Cross-User PII Access**: `GET /users/uid1/private/profile` as `uid2` (verified) → `PERMISSION_DENIED`.
3. **Unverified Email Write**: `CREATE /users/uid1/private/profile` as `uid1` with `email_verified = false` → `PERMISSION_DENIED`.
4. **Shadow Field Injection (Role Escalation)**: `CREATE /users/uid1/private/profile` with extra `role: "admin"` or `isVerified: true` → `PERMISSION_DENIED`.
5. **Identity Spoofing on Create**: `CREATE /users/uid1/preferences/match` as `uid1` with `uid: "uid2"` → `PERMISSION_DENIED`.
6. **Immutable Field Tampering**: `UPDATE /users/uid1/private/profile` attempting to alter `createdAt` or `uid` → `PERMISSION_DENIED`.
7. **Client-Forged Timestamp**: `CREATE /users/uid1/preferences/match` with `updatedAt` set to a past timestamp instead of `request.time` → `PERMISSION_DENIED`.
8. **Path ID Poisoning**: `CREATE /users/../../admin/private/profile` or 500-char userId → `PERMISSION_DENIED`.
9. **Oversized String (Denial of Wallet)**: `UPDATE /users/uid1/preferences/match` with 5,000-character `program` string → `PERMISSION_DENIED`.
10. **Invalid Enum / Value Poisoning**: `UPDATE /users/uid1/preferences/match` with `sector: "Hacked"` or `budget: -500` or `budget: 999999999` → `PERMISSION_DENIED`.
11. **Unbounded Array Injection**: `UPDATE /users/uid1/shortlist/state` with `compareIds` of length 4 or `savedIds` of length 51 or non-string element `[123]` → `PERMISSION_DENIED`.
12. **Blanket Collection Listing**: `LIST /users/uid1/private` or `LIST /users` as any signed-in user → `PERMISSION_DENIED`.
