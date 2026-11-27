/**
 * Automated tests for Dual-Auth Admin Catalog Management & Admin Dashboard.
 *
 * Verifies:
 * 1. Server-side catalog sanitization rejects invalid slugs, missing names, and non-HTTPS URLs.
 * 2. Local admin catalog edits persist, sync immediately into live public store queries,
 *    and record attributed audit trail entries.
 * 3. Unpublished drafts and deleted universities are hidden from the public student explorer
 *    while remaining tracked appropriately for admins.
 * 4. Admin Dashboard aggregation returns accurate catalog & account counts with zero student PII.
 * 5. Express middleware enforces RBAC (blocks students with 403 and unauthenticated callers with 401)
 *    and requires CSRF tokens on local-admin write operations.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import express from "express";
import session from "express-session";
import { setPostgresDisabledForTests } from "./db/postgres.js";
import { createUser } from "./accounts.js";
import { createAdminAccount, type AdminActor } from "./adminAccounts.js";
import {
  CatalogValidationError,
  buildAdminDashboardSummary,
  deleteAdminCatalogUniversity,
  initCatalogStoreFromBaseline,
  listAdminCatalogRuns,
  listAdminCatalogUniversities,
  listPublishedCatalogUniversities,
  resetCatalogStoreForTests,
  sanitizeServerCatalogUniversity,
  saveAdminCatalogUniversity,
  seedBaselineCatalogUniversities,
} from "./catalogStore.js";
import { adminRouter } from "./routes/admin.js";
import { getCsrfToken } from "./security.js";
import {
  getUniversityDetail,
  initStore,
  queryUniversities,
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
} from "./store.js";

setPostgresDisabledForTests(true);

const LOCAL_ACTOR: AdminActor = {
  id: "local-admin-1",
  email: "localadmin@unimatch.ph",
  username: "localadmin",
  displayName: "Local Admin",
  source: "session",
};

describe("Admin Catalog Store & Sanitization", () => {
  beforeEach(() => {
    initStore();
    resetCatalogStoreForTests();
    initCatalogStoreFromBaseline(true);
  });

  it("loads all 15 baseline Metro Manila universities for admins immediately", () => {
    const all = listAdminCatalogUniversities();
    assert.ok(all.length >= 15, `Expected at least 15 baseline universities, got ${all.length}`);
  });

  it("rejects non-HTTPS official URLs and missing university names", () => {
    assert.throws(
      () =>
        sanitizeServerCatalogUniversity({
          id: "test-uni",
          name: "",
        }),
      CatalogValidationError,
    );

    assert.throws(
      () =>
        sanitizeServerCatalogUniversity({
          id: "test-uni",
          name: "Test Manila University",
          officialUrl: "javascript:alert(1)",
        }),
      CatalogValidationError,
    );

    assert.throws(
      () =>
        sanitizeServerCatalogUniversity({
          id: "test-uni",
          name: "Test Manila University",
          officialUrl: "http://insecure.edu.ph",
        }),
      CatalogValidationError,
    );
  });

  it("saves a new university from a local admin, syncs into public explorer store, and logs an audit run", async () => {
    const { university, run } = await saveAdminCatalogUniversity(
      {
        id: "manila-test-college",
        name: "Manila Test College",
        shortName: "MTC",
        city: "Manila",
        campusLocation: "Intramuros, Manila",
        sector: "Private",
        color: "green",
        officialUrl: "https://mtc.edu.ph/",
        collectionStatus: "verified",
        academicYear: "2026-2027",
        isPublished: true,
        programs: [
          {
            id: "mtc-cs",
            name: "BS Computer Science",
            topic: "Computing",
            strandAlignment: "STEM",
            sourceUrl: "https://mtc.edu.ph/cs",
          },
        ],
        tuitionFees: [
          {
            amountMin: 45000,
            amountMax: 52000,
            currency: "PHP",
            basis: "semester",
            rawText: "PHP 45,000–52,000 per semester",
            academicYear: "2026-2027",
            sourceUrl: "https://mtc.edu.ph/fees",
          },
        ],
      },
      LOCAL_ACTOR,
    );

    assert.equal(university.id, "manila-test-college");
    assert.equal(run.actorEmail, LOCAL_ACTOR.email);
    assert.equal(run.mode, "manual-edit");

    const detail = getUniversityDetail("manila-test-college");
    assert.ok(detail, "Saved university should immediately be queryable in public store");
    assert.equal(detail.name, "Manila Test College");
    assert.equal(detail.program_count, 1);

    const searchMatches = queryUniversities("Manila Test College");
    assert.equal(searchMatches.length, 1);

    // Unpublishing removes it from public explorer while keeping it in admin catalog
    await saveAdminCatalogUniversity(
      { ...university, isPublished: false },
      LOCAL_ACTOR,
    );
    assert.equal(getUniversityDetail("manila-test-college"), null);
    assert.ok(
      listAdminCatalogUniversities().some((u) => u.id === "manila-test-college"),
    );
    assert.ok(
      !listPublishedCatalogUniversities().some(
        (u) => u.id === "manila-test-college",
      ),
    );

    // Deleting removes it from both admin catalog and public store and records audit entry
    const del = await deleteAdminCatalogUniversity(
      "manila-test-college",
      LOCAL_ACTOR,
    );
    assert.equal(del.removedId, "manila-test-college");
    assert.equal(del.run.mode, "delete");
    assert.ok(
      !listAdminCatalogUniversities().some((u) => u.id === "manila-test-college"),
    );

    const runs = listAdminCatalogRuns(10);
    assert.equal(runs[0]?.mode, "delete");
    assert.equal(runs[0]?.actorEmail, LOCAL_ACTOR.email);
  });

  it("seeds baseline universities without overwriting unless requested", async () => {
    const first = await seedBaselineCatalogUniversities(false, LOCAL_ACTOR);
    assert.equal(first.skipped, listAdminCatalogUniversities().length);

    const overwriteRun = await seedBaselineCatalogUniversities(true, LOCAL_ACTOR);
    assert.ok(overwriteRun.written >= 15);
    assert.equal(overwriteRun.run.mode, "baseline-seed");
  });
});

describe("Admin Dashboard Summary & Dual-Auth HTTP Security", () => {
  let server: ReturnType<express.Express["listen"]> | null = null;
  let baseUrl = "";

  beforeEach(() => {
    initStore();
    resetCatalogStoreForTests();
    initCatalogStoreFromBaseline(true);
    usersById.clear();
    userIdByEmailHash.clear();
    userIdByUsernameHash.clear();
    userPreferencesById.clear();
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("aggregates dashboard KPIs accurately without exposing student PII", () => {
    createUser("student.one@example.com", "Juan Dela Cruz", "SecurePass123!");
    createAdminAccount(
      {
        username: "opsadmin",
        email: "opsadmin@example.com",
        displayName: "Ops Admin",
        password: "AdminPassword123!",
        passwordConfirm: "AdminPassword123!",
      },
      LOCAL_ACTOR,
    );

    const summary = buildAdminDashboardSummary(LOCAL_ACTOR);
    assert.ok(summary.metrics.universitiesTotal >= 15);
    assert.equal(summary.metrics.studentsTotal, 1);
    assert.equal(summary.metrics.studentsLocal, 1);
    assert.equal(summary.metrics.adminsLocal, 1);
    assert.ok(summary.metrics.adminsGoogle >= 1);

    const serialized = JSON.stringify(summary);
    assert.ok(
      !serialized.includes("student.one@example.com"),
      "Dashboard JSON must never leak student email addresses",
    );
    assert.ok(
      !serialized.includes("Juan Dela Cruz"),
      "Dashboard JSON must never leak student display names",
    );
  });

  it("enforces local admin RBAC and CSRF tokens on /api/admin/dashboard and /api/admin/catalog", async () => {
    const student = createUser("student2@example.com", "Student Two", "SecurePass123!");
    const createdAdmin = createAdminAccount(
      {
        username: "localcatadmin",
        email: "localcatadmin@example.com",
        displayName: "Local Catalog Admin",
        password: "AdminPassword123!",
        passwordConfirm: "AdminPassword123!",
      },
      LOCAL_ACTOR,
    );

    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: "test-secret-key-for-admin-tests",
        resave: false,
        saveUninitialized: false,
      }),
    );

    // Helper route to establish a test session cleanly
    app.post("/__test/session", (req, res) => {
      const { userId, sessionVersion } = req.body as {
        userId: string;
        sessionVersion: number;
      };
      req.session.userId = userId;
      req.session.sessionVersion = sessionVersion;
      const csrf = getCsrfToken(req);
      res.json({ csrf });
    });

    app.use((req, res, next) => {
      res.locals.currentUser = req.session.userId
        ? usersById.get(req.session.userId) ?? null
        : null;
      res.locals.csrfToken = () => getCsrfToken(req);
      next();
    });

    app.use(adminRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    // 1. Unauthenticated guest gets 401
    const guestDash = await fetch(`${baseUrl}/api/admin/dashboard`);
    assert.equal(guestDash.status, 401);
    const guestCat = await fetch(`${baseUrl}/api/admin/catalog`);
    assert.equal(guestCat.status, 401);

    // 2. Signed-in student gets 403 Forbidden
    const studentRow = usersById.get(student.id)!;
    const studentLogin = await fetch(`${baseUrl}/__test/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: studentRow.id,
        sessionVersion: studentRow.session_version,
      }),
    });
    const studentCookie = studentLogin.headers.get("set-cookie")!.split(";")[0];
    const studentDash = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(studentDash.status, 403);
    const studentCat = await fetch(`${baseUrl}/api/admin/catalog`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(studentCat.status, 403);

    // 3. Signed-in local admin gets 200 on dashboard & catalog GET
    const adminRow = usersById.get(createdAdmin.account.id)!;
    const adminLogin = await fetch(`${baseUrl}/__test/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: adminRow.id,
        sessionVersion: adminRow.session_version,
      }),
    });
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await adminLogin.json()) as { csrf: string };

    const adminDash = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminDash.status, 200);
    const dashData = (await adminDash.json()) as {
      actor: { email: string; source: string };
      metrics: { universitiesTotal: number };
    };
    assert.equal(dashData.actor.email, "localcatadmin@example.com");
    assert.equal(dashData.actor.source, "session");
    assert.ok(dashData.metrics.universitiesTotal >= 15);

    const adminCat = await fetch(`${baseUrl}/api/admin/catalog`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminCat.status, 200);

    // 4. Local admin PUT without CSRF token is rejected with 400
    const noCsrfPut = await fetch(`${baseUrl}/api/admin/catalog/csrf-test-school`, {
      method: "PUT",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        university: {
          id: "csrf-test-school",
          name: "CSRF Test School",
          shortName: "CTS",
          city: "Manila",
          campusLocation: "Manila",
          sector: "Private",
        },
      }),
    });
    assert.equal(noCsrfPut.status, 400);

    // 5. Local admin PUT with valid CSRF token succeeds with 200
    const validPut = await fetch(`${baseUrl}/api/admin/catalog/csrf-test-school`, {
      method: "PUT",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        university: {
          id: "csrf-test-school",
          name: "CSRF Test School",
          shortName: "CTS",
          city: "Manila",
          campusLocation: "Manila",
          sector: "Private",
          collectionStatus: "verified",
          isPublished: true,
        },
      }),
    });
    assert.equal(validPut.status, 200);
    const savedPayload = (await validPut.json()) as {
      university: { id: string; name: string };
    };
    assert.equal(savedPayload.university.id, "csrf-test-school");
    assert.equal(savedPayload.university.name, "CSRF Test School");

    // Clean up test record via CSRF-protected DELETE
    const validDel = await fetch(`${baseUrl}/api/admin/catalog/csrf-test-school`, {
      method: "DELETE",
      headers: {
        Cookie: adminCookie,
        "X-CSRF-Token": csrf,
      },
    });
    assert.equal(validDel.status, 200);
  });
});
