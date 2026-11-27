import assert from "node:assert/strict";
import test from "node:test";
import { setAccountPersistenceDisabledForTests } from "./accountPersistence.js";
import {
  AccountConflictError,
  AccountError,
  GOOGLE_ACCOUNT_EXISTS_MSG,
  GOOGLE_LOGIN_REQUIRED_MSG,
  LOCAL_ACCOUNT_EXISTS_MSG,
  authenticate,
  createUser,
  createUserAsync,
  registerOrVerifyGoogleAccount,
  updateProfile,
} from "./accounts.js";
import {
  AdminAccountError,
  createAdminAccount,
  type AdminActor,
} from "./adminAccounts.js";
import {
  POSTGRES_SCHEMA_STATEMENTS,
  checkPostgresConnection,
  setPostgresDisabledForTests,
} from "./db/postgres.js";
import {
  DEFAULT_BREVO_API_URL,
  STRICT_SENDER_EMAIL,
  STRICT_SENDER_NAME,
  getSenderEmail,
  sendBrevoEmail,
  sendGoogleSignInReminderEmail,
  sendPasswordResetEmail,
} from "./mailer.js";
import { normalizeEmail } from "./security.js";
import {
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
} from "./store.js";

function resetMemoryStore(): void {
  usersById.clear();
  userIdByEmailHash.clear();
  userIdByUsernameHash.clear();
  userPreferencesById.clear();
}

const adminActor: AdminActor = {
  id: "firebase:primary-uid",
  email: "enricomigsduran@gmail.com",
  username: "enricomigsduran",
  displayName: "Primary Google Admin",
  source: "firebase",
};

test("normalizeEmail trims whitespace and lowercases email addresses", () => {
  assert.equal(normalizeEmail("  Juan.DelaCruz@Example.EDU.PH  "), "juan.delacruz@example.edu.ph");
});

test("blocks manual registration when email already exists via Google OAuth", async () => {
  setAccountPersistenceDisabledForTests(true);
  setPostgresDisabledForTests(true);
  resetMemoryStore();

  try {
    const googleUser = await registerOrVerifyGoogleAccount({
      firebaseUid: "google-uid-101",
      email: "  Maria.Santos@Gmail.com ",
      displayName: "Maria Santos",
    });
    assert.equal(googleUser.email, "maria.santos@gmail.com");
    assert.equal(googleUser.auth_provider, "google");

    await assert.rejects(
      () =>
        createUserAsync(
          "MARIA.SANTOS@gmail.com",
          "SecurePassword!2026",
          "Maria Duplicate",
        ),
      (err: unknown) =>
        err instanceof AccountConflictError &&
        err.statusCode === 409 &&
        err.existingProvider === "google" &&
        err.message === GOOGLE_ACCOUNT_EXISTS_MSG,
    );

    // Password login against Google-only account directs user to Google Sign-In
    assert.throws(
      () => authenticate("maria.santos@gmail.com", "AnyPassword!2026"),
      (err: unknown) =>
        err instanceof AccountError && err.message === GOOGLE_LOGIN_REQUIRED_MSG,
    );

    // Admin creation also refuses duplicate Google OAuth email
    assert.throws(
      () =>
        createAdminAccount(
          {
            username: "maria_admin",
            email: "Maria.Santos@gmail.com",
            password: "AdminPassword!2026",
            passwordConfirm: "AdminPassword!2026",
          },
          adminActor,
        ),
      (err: unknown) =>
        err instanceof AdminAccountError &&
        err.statusCode === 409 &&
        err.message === GOOGLE_ACCOUNT_EXISTS_MSG,
    );
  } finally {
    setPostgresDisabledForTests(false);
  }
});

test("blocks Google OAuth signup when email already exists via manual email/password", async () => {
  setAccountPersistenceDisabledForTests(true);
  setPostgresDisabledForTests(true);
  resetMemoryStore();

  try {
    const localUser = createUser(
      "  Carlos.Reyes@UniMatch.ph ",
      "StrongPass!2026",
      "Carlos Reyes",
    );
    assert.equal(localUser.email, "carlos.reyes@unimatch.ph");

    await assert.rejects(
      () =>
        registerOrVerifyGoogleAccount({
          firebaseUid: "google-uid-202",
          email: "CARLOS.REYES@unimatch.ph",
          displayName: "Carlos Google",
        }),
      (err: unknown) =>
        err instanceof AccountConflictError &&
        err.statusCode === 409 &&
        err.existingProvider === "local" &&
        err.message === LOCAL_ACCOUNT_EXISTS_MSG,
    );

    // Only one account must exist in the store
    assert.equal(usersById.size, 1);
  } finally {
    setPostgresDisabledForTests(false);
  }
});

test("updateProfile prevents switching email to an address owned by a Google account", async () => {
  setAccountPersistenceDisabledForTests(true);
  setPostgresDisabledForTests(true);
  resetMemoryStore();

  try {
    await registerOrVerifyGoogleAccount({
      firebaseUid: "google-uid-303",
      email: "google.owner@gmail.com",
      displayName: "Google Owner",
    });
    const localUser = createUser(
      "local.student@example.edu.ph",
      "LocalStudent!2026",
      "Local Student",
    );

    assert.throws(
      () => updateProfile(localUser.id, "Local Student", "GOOGLE.OWNER@gmail.com"),
      (err: unknown) =>
        err instanceof AccountConflictError &&
        err.statusCode === 409 &&
        err.existingProvider === "google",
    );
  } finally {
    setPostgresDisabledForTests(false);
  }
});

test("PostgreSQL schema defines auto-created users and user_preferences tables with UNIQUE email enforcement", async () => {
  const joinedSql = POSTGRES_SCHEMA_STATEMENTS.join("\n");
  assert.match(joinedSql, /CREATE TABLE IF NOT EXISTS users/i);
  assert.match(joinedSql, /email TEXT NOT NULL UNIQUE/i);
  assert.match(joinedSql, /auth_provider TEXT NOT NULL DEFAULT 'local'/i);
  assert.match(joinedSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower/i);
  assert.match(joinedSql, /CREATE TABLE IF NOT EXISTS user_preferences/i);

  setPostgresDisabledForTests(true);
  try {
    const status = await checkPostgresConnection();
    assert.equal(status.configured, false);
    assert.equal(status.ok, false);
  } finally {
    setPostgresDisabledForTests(false);
  }
});

test("Brevo REST mailer sends HTTPS POST with api-key header strictly from spraitospraito@gmail.com and escapes HTML", async () => {
  assert.equal(getSenderEmail(), STRICT_SENDER_EMAIL);
  assert.equal(STRICT_SENDER_EMAIL, "spraitospraito@gmail.com");
  assert.equal(STRICT_SENDER_NAME, "UniMatch PH");

  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = String(init?.method || "");
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ messageId: "<msg-123@brevo>" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await sendPasswordResetEmail(
    {
      to: "  Student@Example.ph ",
      displayName: "Ana <script>alert(1)</script>",
      resetUrl: "https://unimatch.example/reset-password/abc.def",
    },
    {
      apiKey: "test-brevo-key",
      fetchImpl: mockFetch,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.status, 201);
  assert.equal(result.messageId, "<msg-123@brevo>");
  assert.deepEqual(result.responseBody, { messageId: "<msg-123@brevo>" });
  assert.equal(capturedUrl, DEFAULT_BREVO_API_URL);
  assert.equal(capturedMethod, "POST");
  assert.equal(capturedHeaders["api-key"], "test-brevo-key");
  assert.equal(capturedHeaders["Content-Type"], "application/json");
  assert.deepEqual(capturedBody.sender, {
    name: "UniMatch PH",
    email: "spraitospraito@gmail.com",
  });
  assert.deepEqual(capturedBody.to, [
    {
      email: "student@example.ph",
      name: "Ana <script>alert(1)</script>",
    },
  ]);
  assert.equal(String(capturedBody.htmlContent).includes("<script>"), false);
  assert.ok(String(capturedBody.htmlContent).includes("&lt;script&gt;"));
});

test("Brevo Google Sign-In reminder email sends strictly from spraitospraito@gmail.com with Google guidance", async () => {
  let capturedBody: Record<string, unknown> = {};
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ messageId: "<msg-google-456@brevo>" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await sendGoogleSignInReminderEmail(
    {
      to: "google.user@gmail.com",
      displayName: "Enrico <b>Admin</b>",
      loginUrl: "https://unimatch.example/login",
    },
    {
      apiKey: "test-brevo-key",
      fetchImpl: mockFetch,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.deepEqual(capturedBody.sender, {
    name: "UniMatch PH",
    email: "spraitospraito@gmail.com",
  });
  assert.match(String(capturedBody.subject), /Google/i);
  assert.match(String(capturedBody.htmlContent), /Continue with Google/i);
  assert.ok(String(capturedBody.htmlContent).includes("https://unimatch.example/login"));
  assert.equal(String(capturedBody.htmlContent).includes("<b>Admin</b>"), false);
});

test("Brevo REST mailer logs detailed HTTP error responses without leaking api-key", async () => {
  const logged: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    const failingFetch = (async () =>
      new Response(
        JSON.stringify({ code: "unauthorized", message: "Key not found" }),
        { status: 401, statusText: "Unauthorized" },
      )) as typeof fetch;

    const result = await sendBrevoEmail(
      {
        to: "student@example.ph",
        subject: "Test",
        htmlContent: "<p>Hello</p>",
      },
      {
        apiKey: "super-secret-brevo-key-do-not-log",
        fetchImpl: failingFetch,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.status, 401);
    assert.equal(result.error, "Key not found");
    assert.deepEqual(result.responseBody, {
      code: "unauthorized",
      message: "Key not found",
    });

    const serializedLogs = JSON.stringify(logged);
    assert.ok(serializedLogs.includes("401"));
    assert.ok(serializedLogs.includes("Key not found"));
    assert.equal(serializedLogs.includes("super-secret-brevo-key-do-not-log"), false);
  } finally {
    console.error = origError;
  }
});

test("Brevo REST mailer gracefully handles missing BREVO_API_KEY", async () => {
  const result = await sendBrevoEmail(
    {
      to: "student@example.ph",
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    },
    { apiKey: "" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
});
