import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadPersistedAccounts,
  persistAccountStore,
  setAccountPersistenceDisabledForTests,
  setAccountStorePathForTests,
} from "./accountPersistence.js";
import { authenticate, createUser, getUser } from "./accounts.js";
import {
  AdminAccountError,
  SYSTEM_PRIMARY_ADMIN_ID,
  countActiveLocalAdmins,
  createAdminAccount,
  listAdminAccounts,
  registerSessionRevoker,
  removeAdminAccount,
  type AdminActor,
} from "./adminAccounts.js";
import { verifyPassword } from "./security.js";
import {
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
} from "./store.js";

function resetStore(): void {
  usersById.clear();
  userIdByEmailHash.clear();
  userIdByUsernameHash.clear();
  userPreferencesById.clear();
}

const primaryActor: AdminActor = {
  id: "firebase:primary-uid",
  email: "enricomigsduran@gmail.com",
  username: "enricomigsduran",
  displayName: "Primary Google Admin",
  source: "firebase",
};

test("createAdminAccount hashes password with bcrypt and supports login by username or email", () => {
  setAccountPersistenceDisabledForTests(true);
  resetStore();

  const created = createAdminAccount(
    {
      username: "Admissions_Lead",
      email: "Lead.Admin@UniMatch.edu.ph",
      displayName: "Maria Santos",
      password: "StrongAdminPassword!2026",
      passwordConfirm: "StrongAdminPassword!2026",
    },
    primaryActor,
  );

  assert.equal(created.account.username, "admissions_lead");
  assert.equal(created.account.email, "lead.admin@unimatch.edu.ph");
  assert.equal(created.account.role, "admin");
  assert.equal(created.summary.localAdminCount, 1);

  // Stored password must be bcrypt-hashed, never plaintext
  const stored = getUser(created.account.id);
  assert.ok(stored);
  assert.ok(stored.password_hash.startsWith("$2"));
  assert.notEqual(stored.password_hash, "StrongAdminPassword!2026");
  assert.equal(verifyPassword("StrongAdminPassword!2026", stored.password_hash), true);

  // Authenticate by username (case-insensitive)
  const loginByUsername = authenticate("ADMISSIONS_LEAD", "StrongAdminPassword!2026");
  assert.equal(loginByUsername.id, created.account.id);
  assert.equal(loginByUsername.role, "admin");

  // Authenticate by email (case-insensitive)
  const loginByEmail = authenticate("lead.admin@unimatch.edu.ph", "StrongAdminPassword!2026");
  assert.equal(loginByEmail.id, created.account.id);
  assert.equal(loginByEmail.role, "admin");
});

test("createAdminAccount rejects duplicate usernames and duplicate emails (including student emails)", () => {
  setAccountPersistenceDisabledForTests(true);
  resetStore();

  // Existing regular student account
  createUser("student@example.edu.ph", "StudentPass!2026", "Juan Dela Cruz");

  // First admin
  createAdminAccount(
    {
      username: "catalog_admin",
      email: "admin1@unimatch.edu.ph",
      password: "AdminPassword!2026",
      passwordConfirm: "AdminPassword!2026",
    },
    primaryActor,
  );

  // Duplicate username (case-insensitive)
  assert.throws(
    () =>
      createAdminAccount(
        {
          username: "CATALOG_ADMIN",
          email: "other@unimatch.edu.ph",
          password: "AdminPassword!2026",
          passwordConfirm: "AdminPassword!2026",
        },
        primaryActor,
      ),
    (err: unknown) =>
      err instanceof AdminAccountError &&
      err.statusCode === 409 &&
      /username is already taken/i.test(err.message),
  );

  // Duplicate admin email
  assert.throws(
    () =>
      createAdminAccount(
        {
          username: "another_admin",
          email: "ADMIN1@unimatch.edu.ph",
          password: "AdminPassword!2026",
          passwordConfirm: "AdminPassword!2026",
        },
        primaryActor,
      ),
    (err: unknown) =>
      err instanceof AdminAccountError &&
      err.statusCode === 409 &&
      /email address already exists/i.test(err.message),
  );

  // Duplicate against existing student email
  assert.throws(
    () =>
      createAdminAccount(
        {
          username: "student_dupe",
          email: "STUDENT@example.edu.ph",
          password: "AdminPassword!2026",
          passwordConfirm: "AdminPassword!2026",
        },
        primaryActor,
      ),
    (err: unknown) => err instanceof AdminAccountError && err.statusCode === 409,
  );

  // Duplicate against primary Google admin email
  assert.throws(
    () =>
      createAdminAccount(
        {
          username: "primary_dupe",
          email: "Enricomigsduran@gmail.com",
          password: "AdminPassword!2026",
          passwordConfirm: "AdminPassword!2026",
        },
        primaryActor,
      ),
    (err: unknown) => err instanceof AdminAccountError && err.statusCode === 409,
  );
});

test("removeAdminAccount blocks self-removal, primary system admin removal, and last-admin lockout", () => {
  setAccountPersistenceDisabledForTests(true);
  resetStore();

  const first = createAdminAccount(
    {
      username: "admin_one",
      email: "admin1@unimatch.edu.ph",
      password: "AdminOnePass!2026",
      passwordConfirm: "AdminOnePass!2026",
    },
    primaryActor,
  );

  const firstActor: AdminActor = {
    id: first.account.id,
    email: first.account.email,
    username: first.account.username,
    displayName: first.account.displayName,
    source: "session",
  };

  // Self-removal must always fail
  assert.throws(
    () => removeAdminAccount(first.account.id, firstActor),
    (err: unknown) =>
      err instanceof AdminAccountError &&
      err.statusCode === 409 &&
      /cannot remove your own/i.test(err.message),
  );

  // Primary Google admin cannot be deleted via local removal API
  assert.throws(
    () => removeAdminAccount(SYSTEM_PRIMARY_ADMIN_ID, firstActor),
    (err: unknown) => err instanceof AdminAccountError && err.statusCode === 403,
  );

  // Last remaining admin protection (when no bootstrapped admin is included)
  const externalActor: AdminActor = {
    id: "adm-external",
    email: "other@unimatch.edu.ph",
    username: "other",
    displayName: "Other",
    source: "session",
  };
  assert.throws(
    () =>
      removeAdminAccount(first.account.id, externalActor, {
        includeBootstrappedAdmin: false,
      }),
    (err: unknown) =>
      err instanceof AdminAccountError &&
      err.statusCode === 409 &&
      /last remaining administrator/i.test(err.message),
  );
});

test("removeAdminAccount deletes account, triggers immediate session revocation, and blocks further sign-in", () => {
  setAccountPersistenceDisabledForTests(true);
  resetStore();

  const revokedIds: string[] = [];
  registerSessionRevoker((uid) => revokedIds.push(uid));

  const first = createAdminAccount(
    {
      username: "admin_alpha",
      email: "alpha@unimatch.edu.ph",
      password: "AlphaPassword!2026",
      passwordConfirm: "AlphaPassword!2026",
    },
    primaryActor,
  );
  const second = createAdminAccount(
    {
      username: "admin_beta",
      email: "beta@unimatch.edu.ph",
      password: "BetaPassword!2026",
      passwordConfirm: "BetaPassword!2026",
    },
    primaryActor,
  );

  const alphaActor: AdminActor = {
    id: first.account.id,
    email: first.account.email,
    username: first.account.username,
    displayName: first.account.displayName,
    source: "session",
  };

  const listed = listAdminAccounts(alphaActor);
  const alphaRow = listed.accounts.find((a) => a.id === first.account.id);
  const betaRow = listed.accounts.find((a) => a.id === second.account.id);
  assert.equal(alphaRow?.canRemove, false);
  assert.equal(alphaRow?.isCurrentUser, true);
  assert.equal(betaRow?.canRemove, true);

  const removed = removeAdminAccount(second.account.id, alphaActor);
  assert.equal(removed.removedId, second.account.id);
  assert.equal(removed.removedUsername, "admin_beta");
  assert.deepEqual(revokedIds, [second.account.id]);
  assert.equal(countActiveLocalAdmins(), 1);
  assert.equal(getUser(second.account.id), undefined);

  // Removed admin can no longer authenticate by username or email
  assert.throws(() => authenticate("admin_beta", "BetaPassword!2026"));
  assert.throws(() => authenticate("beta@unimatch.edu.ph", "BetaPassword!2026"));

  registerSessionRevoker(null);
});

test("atomic account persistence round-trips admin accounts without writing plaintext passwords", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unimatch-admins-"));
  const tempFile = path.join(tempDir, "accounts.json");
  try {
    setAccountStorePathForTests(tempFile);
    resetStore();

    const created = createAdminAccount(
      {
        username: "persisted_admin",
        email: "persist@unimatch.edu.ph",
        displayName: "Persisted Admin",
        password: "PersistPassword!2026",
        passwordConfirm: "PersistPassword!2026",
      },
      primaryActor,
    );
    persistAccountStore(tempFile);

    const rawDisk = fs.readFileSync(tempFile, "utf8");
    assert.equal(rawDisk.includes("PersistPassword!2026"), false);
    assert.ok(rawDisk.includes("$2"));

    // Wipe in-memory maps and reload from disk
    resetStore();
    const count = loadPersistedAccounts(tempFile);
    assert.equal(count, 1);

    const restored = getUser(created.account.id);
    assert.ok(restored);
    assert.equal(restored.role, "admin");

    const login = authenticate("persisted_admin", "PersistPassword!2026");
    assert.equal(login.id, created.account.id);
    assert.equal(login.role, "admin");
  } finally {
    setAccountStorePathForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
