import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import session from "express-session";
import { setAccountPersistenceDisabledForTests } from "./accountPersistence.js";
import { createUser } from "./accounts.js";
import {
  APPLICATION_STATUSES,
  AdmissionScheduleValidationError,
  buildSavedUniversitiesDashboard,
  computeInAppNotifications,
  createAdmissionEvent,
  deleteAdmissionEvent,
  dismissUserNotification,
  getAdmissionEventById,
  getUserApplicationStatuses,
  listAdmissionEvents,
  resetAdmissionStoresForTests,
  seedBaselineAdmissionEvents,
  setAdmissionPersistenceForTests,
  setUserApplicationStatus,
  setUserEventReminder,
  todayManilaIso,
  updateAdmissionEvent,
} from "./admissionScheduleStore.js";
import { createAdminAccount, type AdminActor } from "./adminAccounts.js";
import { setPostgresDisabledForTests } from "./db/postgres.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { calendarRouter } from "./routes/calendar.js";
import { getCsrfToken } from "./security.js";
import {
  initStore,
  userIdByEmailHash,
  userIdByUsernameHash,
  userPreferencesById,
  usersById,
} from "./store.js";

function shiftIsoDate(baseIso: string, deltaDays: number): string {
  const [y, m, d] = baseIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function resetAll(): void {
  setPostgresDisabledForTests(true);
  setAccountPersistenceDisabledForTests(true);
  setAdmissionPersistenceForTests({ disabled: true });
  initStore();
  resetAdmissionStoresForTests();
  usersById.clear();
  userIdByEmailHash.clear();
  userIdByUsernameHash.clear();
  userPreferencesById.clear();
}

const primaryAdminActor: AdminActor = {
  id: "firebase:primary-uid",
  email: "enricomigsduran@gmail.com",
  username: "enricomigsduran",
  displayName: "Primary Google Admin",
  source: "firebase",
};

function createTestServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(
    session({
      name: "unimatch_test_sid",
      secret: "test-secret-only-not-production",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false },
    }),
  );
  app.use((req, res, next) => {
    res.locals.currentUser = null;
    res.locals.csrfToken = () => getCsrfToken(req);
    next();
  });
  app.get("/test-csrf", (req, res) => {
    res.json({ csrf: getCsrfToken(req) });
  });
  app.use(authRouter);
  app.use(adminRouter);
  app.use(calendarRouter);
  return app;
}

async function startHttpServer(app: express.Express): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function extractCookie(setCookie: string[] | string | null): string {
  if (!setCookie) return "";
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(";")[0]).join("; ");
}

test("Scenario 1, 2, 3: Saving universities dynamically populates calendar; saving multiple combines them; unsaving removes from personal calendar without deleting central DB records", async () => {
  resetAll();
  const today = todayManilaIso();
  const upExamDate = shiftIsoDate(today, 20);
  const ustExamDate = shiftIsoDate(today, 25);

  const upEvent = await createAdmissionEvent(
    {
      university_id: "up-manila",
      event_name: "UPCAT 2027 Entrance Examination",
      event_type: "entrance_exam",
      start_date: upExamDate,
      exam_time: "7:00 AM – 12:00 PM",
      venue: "UP Manila Testing Center",
      official_source_url: "https://upcat.up.edu.ph/",
      description: "Bring test permit and valid school ID.",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  const ustEvent = await createAdmissionEvent(
    {
      university_id: "ust-manila",
      event_name: "USTET Freshman Entrance Examination",
      event_type: "entrance_exam",
      start_date: ustExamDate,
      exam_time: "8:00 AM – 12:00 PM",
      venue: "UST Main Campus, España Blvd",
      official_source_url: "https://ofad.ust.edu.ph/",
      description: "Check testing room assignment on OFAD portal.",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  // Scenario 1: Student saves UP Manila -> UP Manila events appear
  const singleSaved = listAdmissionEvents({
    universityIds: ["up-manila"],
    todayIso: today,
  });
  assert.equal(singleSaved.length, 1);
  assert.equal(singleSaved[0].event_id, upEvent.event_id);
  assert.equal(singleSaved[0].is_confirmed, true);

  // Scenario 2: Student saves multiple universities -> combined view includes both
  const multiSaved = listAdmissionEvents({
    universityIds: ["up-manila", "ust-manila"],
    todayIso: today,
  });
  assert.equal(multiSaved.length, 2);
  assert.deepEqual(
    multiSaved.map((e) => e.university_id),
    ["up-manila", "ust-manila"],
  );

  // Scenario 3: Student unsaves UP Manila -> disappears from personal calendar,
  // while central DB record remains completely intact!
  const afterUnsave = listAdmissionEvents({
    universityIds: ["ust-manila"],
    todayIso: today,
  });
  assert.equal(afterUnsave.length, 1);
  assert.equal(afterUnsave[0].event_id, ustEvent.event_id);

  // Verify central record for UP Manila still exists untouched
  const centralUp = getAdmissionEventById(upEvent.event_id, today);
  assert.ok(centralUp);
  assert.equal(centralUp.start_date, upExamDate);
});

test("Scenario 4 & 5: Admin updates an exam date and adds a new event -> student calendar and saved dashboard reflect changes immediately", async () => {
  resetAll();
  const today = todayManilaIso();
  const initialDate = shiftIsoDate(today, 30);
  const rescheduledDate = shiftIsoDate(today, 45);
  const deadlineDate = shiftIsoDate(today, 14);

  const exam = await createAdmissionEvent(
    {
      university_id: "dlsu-manila",
      event_name: "DCAT Freshman Examination",
      event_type: "entrance_exam",
      start_date: initialDate,
      official_source_url: "https://www.dlsu.edu.ph/admissions/undergraduate/",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  // Admin updates exam date
  const updated = await updateAdmissionEvent(
    exam.event_id,
    {
      university_id: "dlsu-manila",
      event_name: "DCAT Freshman Examination (Rescheduled)",
      event_type: "entrance_exam",
      start_date: rescheduledDate,
      exam_time: "9:00 AM",
      venue: "DLSU Taft Campus",
      official_source_url: "https://www.dlsu.edu.ph/admissions/undergraduate/",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );
  assert.equal(updated.start_date, rescheduledDate);

  // Admin adds a new application deadline event
  const deadline = await createAdmissionEvent(
    {
      university_id: "dlsu-manila",
      event_name: "DLSU Online Application Deadline",
      event_type: "application_deadline",
      start_date: deadlineDate,
      official_source_url: "https://www.dlsu.edu.ph/admissions/undergraduate/",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  // Student who saved DLSU immediately sees both the rescheduled exam and new deadline
  const studentCalendar = listAdmissionEvents({
    universityIds: ["dlsu-manila"],
    todayIso: today,
  });
  assert.equal(studentCalendar.length, 2);
  assert.equal(studentCalendar[0].event_id, deadline.event_id);
  assert.equal(studentCalendar[1].event_id, exam.event_id);
  assert.equal(studentCalendar[1].start_date, rescheduledDate);

  const dashboard = buildSavedUniversitiesDashboard(["dlsu-manila"], {}, today);
  assert.equal(dashboard.length, 1);
  assert.equal(dashboard[0].next_upcoming_event?.event_id, deadline.event_id);
  assert.equal(dashboard[0].entrance_exam.start_date, rescheduledDate);
  assert.equal(dashboard[0].application_deadline?.start_date, deadlineDate);
});

test("Scenario 6: Student updates application status independently without affecting central schedules", async () => {
  resetAll();
  const today = todayManilaIso();
  const examDate = shiftIsoDate(today, 18);

  const exam = await createAdmissionEvent(
    {
      university_id: "pup-sta-mesa",
      event_name: "PUPCET Batch 1",
      event_type: "entrance_exam",
      start_date: examDate,
      official_source_url: "https://www.pup.edu.ph/iapply/pupcet",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  for (const status of APPLICATION_STATUSES) {
    const saved = await setUserApplicationStatus("student-1", "pup-sta-mesa", status);
    assert.equal(saved.status, status);
  }

  // Invalid status is rejected
  await assert.rejects(
    () => setUserApplicationStatus("student-1", "pup-sta-mesa", "Accepted Instantly"),
    AdmissionScheduleValidationError,
  );

  // Separate user still defaults to Interested
  const otherDash = buildSavedUniversitiesDashboard(
    ["pup-sta-mesa"],
    getUserApplicationStatuses("student-2"),
    today,
  );
  assert.equal(otherDash[0].application_status, "Interested");

  // Student 1 sees their updated status alongside untouched central exam schedule
  const student1Dash = buildSavedUniversitiesDashboard(
    ["pup-sta-mesa"],
    getUserApplicationStatuses("student-1"),
    today,
  );
  assert.equal(student1Dash[0].application_status, "Application Completed");
  assert.equal(student1Dash[0].entrance_exam.event_id, exam.event_id);
  assert.equal(student1Dash[0].entrance_exam.start_date, examDate);
});

test("Scenario 7: Student enables, configures (7/3/1d), dismisses, and disables reminders; in-app notifications trigger accurately", async () => {
  resetAll();
  const today = todayManilaIso();
  const inThreeDays = shiftIsoDate(today, 3);
  const inTwentyDays = shiftIsoDate(today, 20);

  const soonExam = await createAdmissionEvent(
    {
      university_id: "ust-manila",
      event_name: "USTET Examination Day",
      event_type: "entrance_exam",
      start_date: inThreeDays,
      exam_time: "7:30 AM",
      official_source_url: "https://ofad.ust.edu.ph/",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  const farExam = await createAdmissionEvent(
    {
      university_id: "up-manila",
      event_name: "UPCAT Future Batch",
      event_type: "entrance_exam",
      start_date: inTwentyDays,
      official_source_url: "https://upcat.up.edu.ph/",
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );

  // Enable reminders for both events
  await setUserEventReminder("student-1", soonExam.event_id, {
    enabled: true,
    intervals_days: [7, 3, 1],
    channels: ["in_app"],
  });
  await setUserEventReminder("student-1", farExam.event_id, {
    enabled: true,
    intervals_days: [7, 3, 1],
    channels: ["in_app"],
  });

  // Only the event 3 days away should trigger an active in-app notification now
  const active = computeInAppNotifications(
    "student-1",
    ["ust-manila", "up-manila"],
    today,
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].event_id, soonExam.event_id);
  assert.equal(active[0].days_until, 3);
  assert.equal(active[0].threshold_days, 3);
  assert.equal(active[0].channel, "in_app");

  // Unsaving UST immediately silences UST's notification
  const afterUnsave = computeInAppNotifications("student-1", ["up-manila"], today);
  assert.equal(afterUnsave.length, 0);

  // Dismissing the notification hides it for the current threshold & date
  await dismissUserNotification(
    "student-1",
    soonExam.event_id,
    active[0].notification_key,
  );
  const afterDismiss = computeInAppNotifications("student-1", ["ust-manila"], today);
  assert.equal(afterDismiss.length, 0);

  // Disabling the reminder suppresses all future alerts
  await setUserEventReminder("student-1", soonExam.event_id, {
    enabled: false,
    intervals_days: [7, 3, 1],
  });
  const afterDisable = computeInAppNotifications("student-1", ["ust-manila"], today);
  assert.equal(afterDisable.length, 0);
});

test("Scenario 8: Unverified, TBA, and expired dates are NEVER presented as confirmed upcoming events or reminders", async () => {
  resetAll();
  const today = todayManilaIso();
  const yesterday = shiftIsoDate(today, -2);
  const inTwoDays = shiftIsoDate(today, 2);

  // Baseline seeding creates honest TBA records with zero fabricated dates
  const seededCount = seedBaselineAdmissionEvents();
  assert.ok(seededCount >= 15);

  const baselineUp = listAdmissionEvents({
    universityId: "up-manila",
    todayIso: today,
  });
  assert.ok(baselineUp.length >= 1);
  assert.equal(baselineUp[0].verification_status, "tba");
  assert.equal(baselineUp[0].start_date, null);
  assert.equal(baselineUp[0].display_date, "To Be Announced");
  assert.equal(baselineUp[0].is_confirmed, false);
  assert.equal(baselineUp[0].is_upcoming, false);

  // Verified event without a date MUST be rejected by validation
  await assert.rejects(
    () =>
      createAdmissionEvent(
        {
          university_id: "up-manila",
          event_name: "Missing Date Verified Exam",
          event_type: "entrance_exam",
          start_date: null,
          verification_status: "verified",
        },
        "admin@unimatch.edu.ph",
      ),
    AdmissionScheduleValidationError,
  );

  // Invalid URL protocol rejected
  await assert.rejects(
    () =>
      createAdmissionEvent(
        {
          university_id: "up-manila",
          event_name: "Bad URL Event",
          event_type: "entrance_exam",
          start_date: inTwoDays,
          official_source_url: "javascript:alert(1)",
          verification_status: "verified",
        },
        "admin@unimatch.edu.ph",
      ),
    AdmissionScheduleValidationError,
  );

  // Unverified event with tentative date is NOT marked confirmed and does NOT trigger reminders
  const unverifiedEv = await createAdmissionEvent(
    {
      university_id: "feu-manila",
      event_name: "Tentative FEU-CAT Window",
      event_type: "entrance_exam",
      start_date: inTwoDays,
      verification_status: "unverified",
    },
    "admin@unimatch.edu.ph",
  );
  assert.equal(unverifiedEv.is_confirmed, false);
  assert.equal(unverifiedEv.is_upcoming, false);

  // Expired verified event is NOT upcoming and does NOT appear as next upcoming event
  const expiredEv = await createAdmissionEvent(
    {
      university_id: "feu-manila",
      event_name: "Past FEU Application Deadline",
      event_type: "application_deadline",
      start_date: yesterday,
      verification_status: "verified",
    },
    "admin@unimatch.edu.ph",
  );
  assert.equal(expiredEv.is_expired, true);
  assert.equal(expiredEv.is_upcoming, false);

  await setUserEventReminder("student-1", unverifiedEv.event_id, {
    enabled: true,
    intervals_days: [7, 3, 1],
  });
  await setUserEventReminder("student-1", expiredEv.event_id, {
    enabled: true,
    intervals_days: [7, 3, 1],
  });
  const alerts = computeInAppNotifications("student-1", ["feu-manila"], today);
  assert.equal(alerts.length, 0);

  const dash = buildSavedUniversitiesDashboard(["feu-manila"], {}, today);
  assert.equal(dash[0].next_upcoming_event, null);
  assert.equal(dash[0].application_deadline, null);
});

test("Scenario 9 (HTTP end-to-end): Students get 403 on admin schedule APIs; authenticated admin can CRUD with CSRF and student endpoints reflect immediately", async () => {
  resetAll();
  createUser("student@example.edu.ph", "StudentPass!2026", "Student User");
  createAdminAccount(
    {
      username: "sched_admin",
      email: "sched.admin@unimatch.edu.ph",
      displayName: "Schedule Admin",
      password: "AdminStrongPassword!2026",
      passwordConfirm: "AdminStrongPassword!2026",
    },
    primaryAdminActor,
  );

  const app = createTestServer();
  const { server, baseUrl } = await startHttpServer(app);

  try {
    // 1. Unauthenticated request to admin schedule API -> 401
    const unauthResp = await fetch(`${baseUrl}/api/admin/admission-events`);
    assert.equal(unauthResp.status, 401);

    // 2. Log in as student
    const studentCsrfRes = await fetch(`${baseUrl}/test-csrf`);
    const studentCookie = extractCookie(studentCsrfRes.headers.getSetCookie());
    const { csrf: studentCsrf } = (await studentCsrfRes.json()) as {
      csrf: string;
    };

    const studentLogin = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: studentCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf_token: studentCsrf,
        identifier: "student@example.edu.ph",
        password: "StudentPass!2026",
      }),
    });
    const studentSessionCookie =
      extractCookie(studentLogin.headers.getSetCookie()) || studentCookie;

    // Fetch fresh CSRF token after login session regeneration
    const postLoginStudentCsrfRes = await fetch(`${baseUrl}/test-csrf`, {
      headers: { Cookie: studentSessionCookie },
    });
    const { csrf: studentAuthCsrf } = (await postLoginStudentCsrfRes.json()) as {
      csrf: string;
    };

    // Student CANNOT access admin schedule read or write endpoints -> 403
    const studentAdminGet = await fetch(`${baseUrl}/api/admin/admission-events`, {
      headers: { Cookie: studentSessionCookie },
    });
    assert.equal(studentAdminGet.status, 403);

    const studentAdminPost = await fetch(`${baseUrl}/api/admin/admission-events`, {
      method: "POST",
      headers: {
        Cookie: studentSessionCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": studentAuthCsrf,
      },
      body: JSON.stringify({
        university_id: "up-manila",
        event_name: "Unauthorized Student Edit",
        event_type: "entrance_exam",
        start_date: shiftIsoDate(todayManilaIso(), 10),
        verification_status: "verified",
      }),
    });
    assert.equal(studentAdminPost.status, 403);

    // 3. Log in as local Admin
    const adminCsrfRes = await fetch(`${baseUrl}/test-csrf`);
    const adminPreCookie = extractCookie(adminCsrfRes.headers.getSetCookie());
    const { csrf: adminPreCsrf } = (await adminCsrfRes.json()) as {
      csrf: string;
    };

    const adminLogin = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: adminPreCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf_token: adminPreCsrf,
        identifier: "sched_admin",
        password: "AdminStrongPassword!2026",
      }),
    });
    const adminCookie =
      extractCookie(adminLogin.headers.getSetCookie()) || adminPreCookie;

    const adminPostCsrfRes = await fetch(`${baseUrl}/test-csrf`, {
      headers: { Cookie: adminCookie },
    });
    const { csrf: adminCsrf } = (await adminPostCsrfRes.json()) as {
      csrf: string;
    };

    // Admin POST without CSRF is rejected with 400
    const adminNoCsrf = await fetch(`${baseUrl}/api/admin/admission-events`, {
      method: "POST",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        university_id: "up-manila",
        event_name: "Missing CSRF Test",
        event_type: "entrance_exam",
        start_date: shiftIsoDate(todayManilaIso(), 5),
        verification_status: "verified",
      }),
    });
    assert.equal(adminNoCsrf.status, 400);

    // Admin creates verified event -> 201
    const targetDate = shiftIsoDate(todayManilaIso(), 5);
    const adminCreate = await fetch(`${baseUrl}/api/admin/admission-events`, {
      method: "POST",
      headers: {
        Cookie: adminCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": adminCsrf,
      },
      body: JSON.stringify({
        university_id: "up-manila",
        event_name: "UPCAT Confirmed Testing Date",
        event_type: "entrance_exam",
        start_date: targetDate,
        exam_time: "7:00 AM",
        venue: "UP Manila Campus",
        official_source_url: "https://upcat.up.edu.ph/",
        verification_status: "verified",
      }),
    });
    assert.equal(adminCreate.status, 201);
    const createdPayload = (await adminCreate.json()) as {
      event: { event_id: string; start_date: string };
    };
    const eventId = createdPayload.event.event_id;

    // Student updates application status & enables reminder via authenticated HTTP API
    const statusPut = await fetch(`${baseUrl}/api/tracking/status/up-manila`, {
      method: "PUT",
      headers: {
        Cookie: studentSessionCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": studentAuthCsrf,
      },
      body: JSON.stringify({ status: "Examination Scheduled" }),
    });
    assert.equal(statusPut.status, 200);

    const reminderPut = await fetch(
      `${baseUrl}/api/tracking/reminders/${encodeURIComponent(eventId)}`,
      {
        method: "PUT",
        headers: {
          Cookie: studentSessionCookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": studentAuthCsrf,
        },
        body: JSON.stringify({
          enabled: true,
          intervals_days: [7, 3, 1],
          saved_ids: ["up-manila"],
        }),
      },
    );
    assert.equal(reminderPut.status, 200);
    const remPayload = (await reminderPut.json()) as {
      notifications: Array<{ event_id: string; days_until: number }>;
    };
    assert.equal(remPayload.notifications.length, 1);
    assert.equal(remPayload.notifications[0].event_id, eventId);
    assert.equal(remPayload.notifications[0].days_until, 5);

    // Student fetches /api/saved-dashboard and sees status + verified exam + notification
    const dashRes = await fetch(
      `${baseUrl}/api/saved-dashboard?university_ids=up-manila`,
      {
        headers: { Cookie: studentSessionCookie },
      },
    );
    assert.equal(dashRes.status, 200);
    const dashData = (await dashRes.json()) as {
      items: Array<{
        university_id: string;
        application_status: string;
        entrance_exam: { start_date: string };
      }>;
      notifications: Array<{ event_id: string }>;
    };
    assert.equal(dashData.items.length, 1);
    assert.equal(dashData.items[0].application_status, "Examination Scheduled");
    assert.equal(dashData.items[0].entrance_exam.start_date, targetDate);
    assert.equal(dashData.notifications.length, 1);

    // Admin deletes event -> 200 and cleans up central store
    const adminDel = await fetch(
      `${baseUrl}/api/admin/admission-events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers: {
          Cookie: adminCookie,
          "X-CSRF-Token": adminCsrf,
        },
      },
    );
    assert.equal(adminDel.status, 200);
    assert.equal(await deleteAdmissionEvent(eventId), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
