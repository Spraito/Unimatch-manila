/**
 * UniMatch PH — University Application Calendar, Event Details,
 * Application Status Tracking, Reminder Notifications, and Enhanced
 * Saved Universities Dashboard module.
 *
 * Integrates directly with the existing saved universities list (`state.saved`)
 * without duplicating or replacing the bookmark system.
 */

export const APPLICATION_STATUSES = [
  "Interested",
  "Application Ongoing",
  "Application Submitted",
  "Examination Scheduled",
  "Examination Completed",
  "Application Completed",
];

export const REMINDER_INTERVALS = [7, 3, 1];

const EVENT_TYPE_LABELS = {
  entrance_exam: "Entrance Exam",
  application_open: "Application Opens",
  application_deadline: "Deadline",
  results_release: "Results Release",
  enrollment: "Enrollment",
  other: "Admission Event",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const e = escapeHTML;
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function safeURL(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function getTodayManilaIso() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function daysBetweenIso(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

function formatDateReadable(iso) {
  if (!iso) return "To Be Announced";
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return iso;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.toLocaleDateString("en-PH", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTimeReadable(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusClassFor(status) {
  switch (status) {
    case "Application Completed":
      return "app-status-complete";
    case "Examination Completed":
    case "Examination Scheduled":
      return "app-status-exam";
    case "Application Submitted":
      return "app-status-submitted";
    case "Application Ongoing":
      return "app-status-ongoing";
    default:
      return "app-status-interested";
  }
}

function accentIndexFor(universityId, savedIds) {
  const idx = savedIds.indexOf(universityId);
  if (idx >= 0) return idx % 8;
  let hash = 0;
  for (let i = 0; i < universityId.length; i++) {
    hash = (hash * 31 + universityId.charCodeAt(i)) >>> 0;
  }
  return hash % 8;
}

export function createCalendarManager(ctx) {
  const ACCOUNT_ID = document.body.dataset.account || "guest";
  const CSRF_TOKEN = document.body.dataset.csrfToken || "";
  const isSessionUser = ACCOUNT_ID !== "guest";

  const todayInitial = getTodayManilaIso();
  const [initYear, initMonth] = todayInitial.split("-").map(Number);

  const calState = {
    today: todayInitial,
    year: initYear,
    month: initMonth - 1, // 0-indexed
    filterUniversity: "",
    filterType: "",
    showExpiredOnGrid: false,
    authenticated: isSessionUser,
    loading: false,
    error: "",
    dashboardItems: [],
    events: [],
    statuses: loadGuestMap("appStatuses"),
    reminders: loadGuestMap("eventReminders"),
    notifications: [],
    hasAutoFocusedMonth: false,
  };

  function guestStorageKey(suffix) {
    return `unimatch.v2.${ACCOUNT_ID}.${suffix}`;
  }

  function loadGuestMap(suffix) {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(guestStorageKey(suffix)) || "{}",
      );
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveGuestMap(suffix, obj) {
    try {
      localStorage.setItem(guestStorageKey(suffix), JSON.stringify(obj));
    } catch {
      // Ignore storage quota errors
    }
  }

  async function buildAuthHeaders(isMutation = false) {
    const headers = { Accept: "application/json" };
    if (isMutation) {
      headers["Content-Type"] = "application/json";
    }
    if (isSessionUser) {
      if (isMutation && CSRF_TOKEN) {
        headers["X-CSRF-Token"] = CSRF_TOKEN;
      }
      return headers;
    }
    const token = await window.__unimatchAuth?.getIdToken?.().catch(() => null);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async function isSignedInNow() {
    if (isSessionUser) return true;
    const token = await window.__unimatchAuth?.getIdToken?.().catch(() => null);
    return Boolean(token);
  }

  function computeLocalNotifications(events, savedIds) {
    const savedSet = new Set(savedIds);
    const out = [];
    for (const rem of Object.values(calState.reminders || {})) {
      if (!rem || !rem.enabled) continue;
      const ev = events.find((item) => item.event_id === rem.event_id);
      if (!ev || !savedSet.has(ev.university_id)) continue;
      if (!ev.is_confirmed || !ev.start_date) continue;
      const daysUntil = daysBetweenIso(calState.today, ev.start_date);
      if (daysUntil < 0) continue;

      const intervals = (
        Array.isArray(rem.intervals_days) ? rem.intervals_days : [7, 3, 1]
      )
        .map(Number)
        .filter((n) => n === 7 || n === 3 || n === 1)
        .sort((a, b) => a - b);
      const matched = intervals.find((d) => daysUntil <= d);
      if (!matched) continue;

      const notifKey = `${ev.event_id}:${matched}d:${ev.start_date}`;
      const dismissed = Array.isArray(rem.dismissed_keys)
        ? rem.dismissed_keys
        : [];
      if (dismissed.includes(notifKey)) continue;

      const timingPhrase =
        daysUntil === 0
          ? "is today"
          : daysUntil === 1
            ? "is tomorrow (1 day away)"
            : `is in ${daysUntil} days`;

      out.push({
        notification_key: notifKey,
        channel: "in_app",
        event_id: ev.event_id,
        university_id: ev.university_id,
        university_name: ev.university_name,
        university_short_name: ev.university_short_name,
        event_name: ev.event_name,
        event_type: ev.event_type,
        event_type_label: ev.event_type_label,
        start_date: ev.start_date,
        exam_time: ev.exam_time,
        venue: ev.venue,
        official_source_url:
          ev.official_source_url || ev.official_admissions_url,
        days_until: daysUntil,
        threshold_days: matched,
        title: `${ev.university_short_name}: ${ev.event_name}`,
        message: `${ev.event_name} at ${ev.university_name} ${timingPhrase} (${ev.display_date}).`,
      });
    }
    out.sort(
      (a, b) =>
        a.days_until - b.days_until || a.start_date.localeCompare(b.start_date),
    );
    return out;
  }

  function updateNavBadges() {
    const calBadge = document.getElementById("calendar-count");
    if (calBadge) {
      const upcomingCount = calState.events.filter((ev) => ev.is_upcoming).length;
      calBadge.textContent = String(upcomingCount);
    }
    const notifBadge = document.getElementById("notif-count");
    const notifBtn = document.getElementById("topbar-notif-btn");
    const count = calState.notifications.length;
    if (notifBadge) {
      notifBadge.textContent = String(count);
      notifBadge.hidden = count === 0;
    }
    if (notifBtn) {
      notifBtn.classList.toggle("has-alerts", count > 0);
      notifBtn.setAttribute(
        "aria-label",
        count > 0
          ? `Open admission reminders (${count} active alert${count === 1 ? "" : "s"})`
          : "Open admission reminder notifications",
      );
    }
  }

  async function refreshData() {
    const savedIds = ctx.getSavedIds();
    if (!savedIds.length) {
      calState.dashboardItems = [];
      calState.events = [];
      calState.notifications = [];
      calState.error = "";
      calState.loading = false;
      updateNavBadges();
      return;
    }

    calState.loading = true;
    calState.error = "";
    try {
      const headers = await buildAuthHeaders(false);
      const url = `/api/saved-dashboard?university_ids=${encodeURIComponent(savedIds.join(","))}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || "Could not load admission schedules.");
      }

      calState.today = data.today || getTodayManilaIso();
      calState.authenticated = Boolean(data.authenticated);
      calState.events = Array.isArray(data.events) ? data.events : [];

      if (calState.authenticated) {
        calState.statuses = data.statuses || {};
        calState.reminders = data.reminders || {};
        calState.notifications = Array.isArray(data.notifications)
          ? data.notifications
          : [];
        calState.dashboardItems = Array.isArray(data.items) ? data.items : [];
      } else {
        // Guest mode: merge local statuses & compute in-app notifications locally
        const localStatuses = loadGuestMap("appStatuses");
        calState.statuses = localStatuses;
        calState.reminders = loadGuestMap("eventReminders");
        calState.dashboardItems = (Array.isArray(data.items) ? data.items : []).map(
          (item) => {
            const localStatus = localStatuses[item.university_id];
            return {
              ...item,
              application_status:
                localStatus && APPLICATION_STATUSES.includes(localStatus.status)
                  ? localStatus.status
                  : item.application_status || "Interested",
              application_status_updated_at: localStatus?.updated_at || null,
            };
          },
        );
        calState.notifications = computeLocalNotifications(
          calState.events,
          savedIds,
        );
      }

      // If no events in current month on initial open, auto-focus month of earliest upcoming verified event
      if (!calState.hasAutoFocusedMonth) {
        const firstUpcoming = calState.events.find(
          (ev) => ev.is_upcoming && ev.start_date,
        );
        if (firstUpcoming) {
          const [y, m] = firstUpcoming.start_date.split("-").map(Number);
          if (y && m) {
            calState.year = y;
            calState.month = m - 1;
          }
        }
        calState.hasAutoFocusedMonth = true;
      }
    } catch (err) {
      calState.error =
        err instanceof Error
          ? err.message
          : "Could not load admission schedules.";
    } finally {
      calState.loading = false;
      updateNavBadges();
    }
  }

  // --- Application Status Update ---

  async function updateApplicationStatus(universityId, status) {
    if (!APPLICATION_STATUSES.includes(status)) return;
    const nowIso = new Date().toISOString();
    const signedIn = await isSignedInNow();

    if (signedIn) {
      try {
        const headers = await buildAuthHeaders(true);
        const resp = await fetch(
          `/api/tracking/status/${encodeURIComponent(universityId)}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ status }),
          },
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(data.error || "Could not save application status.");
        }
        calState.statuses[universityId] = {
          status: data.status || status,
          updated_at: data.updated_at || nowIso,
        };
      } catch (err) {
        ctx.toast(
          err instanceof Error
            ? err.message
            : "Could not update application status.",
        );
        return;
      }
    } else {
      calState.statuses[universityId] = { status, updated_at: nowIso };
      saveGuestMap("appStatuses", calState.statuses);
    }

    const item = calState.dashboardItems.find(
      (u) => u.university_id === universityId,
    );
    if (item) {
      item.application_status = status;
      item.application_status_updated_at = nowIso;
    }

    // Update badge styling cleanly without wiping focus
    const card = document.querySelector(
      `[data-saved-card="${CSS.escape(universityId)}"]`,
    );
    if (card) {
      const badge = card.querySelector("[data-status-label]");
      if (badge) {
        badge.textContent = status;
        badge.className = `saved-status-indicator ${statusClassFor(status)}`;
      }
    }
    ctx.toast(`Status updated to “${status}”.`);
  }

  // --- Event Reminder Update & Notification Dismissal ---

  async function saveEventReminder(eventId, enabled, intervalsDays) {
    const cleanIntervals = (intervalsDays || [])
      .map(Number)
      .filter((n) => n === 7 || n === 3 || n === 1)
      .sort((a, b) => b - a);
    const effectiveIntervals = cleanIntervals.length ? cleanIntervals : [7, 3, 1];
    const savedIds = ctx.getSavedIds();
    const signedIn = await isSignedInNow();

    if (signedIn) {
      try {
        const headers = await buildAuthHeaders(true);
        const resp = await fetch(
          `/api/tracking/reminders/${encodeURIComponent(eventId)}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({
              enabled: Boolean(enabled),
              intervals_days: effectiveIntervals,
              channels: ["in_app"],
              saved_ids: savedIds,
            }),
          },
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(data.error || "Could not update reminder.");
        }
        if (data.reminder) {
          calState.reminders[eventId] = data.reminder;
        }
        if (Array.isArray(data.notifications)) {
          calState.notifications = data.notifications;
        }
      } catch (err) {
        ctx.toast(
          err instanceof Error ? err.message : "Could not save reminder.",
        );
        return;
      }
    } else {
      const existing = calState.reminders[eventId] || {};
      calState.reminders[eventId] = {
        user_id: "guest",
        event_id: eventId,
        enabled: Boolean(enabled),
        intervals_days: effectiveIntervals,
        channels: ["in_app"],
        dismissed_keys: Array.isArray(existing.dismissed_keys)
          ? existing.dismissed_keys
          : [],
        updated_at: new Date().toISOString(),
      };
      saveGuestMap("eventReminders", calState.reminders);
      calState.notifications = computeLocalNotifications(
        calState.events,
        savedIds,
      );
    }

    updateNavBadges();
    ctx.toast(
      enabled
        ? `In-app reminder enabled (${effectiveIntervals.map((d) => `${d}d`).join(", ")} before event).`
        : "Reminder disabled for this event.",
    );
  }

  async function dismissNotification(eventId, notificationKey) {
    const savedIds = ctx.getSavedIds();
    const signedIn = await isSignedInNow();

    if (signedIn) {
      try {
        const headers = await buildAuthHeaders(true);
        const resp = await fetch("/api/tracking/notifications/dismiss", {
          method: "POST",
          headers,
          body: JSON.stringify({
            event_id: eventId,
            notification_key: notificationKey,
            saved_ids: savedIds,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) {
          if (data.reminder) calState.reminders[eventId] = data.reminder;
          if (Array.isArray(data.notifications)) {
            calState.notifications = data.notifications;
          }
        }
      } catch {
        // Keep UI responsive
      }
    } else {
      const rem = calState.reminders[eventId];
      if (rem) {
        const set = new Set(rem.dismissed_keys || []);
        set.add(notificationKey);
        rem.dismissed_keys = [...set];
        saveGuestMap("eventReminders", calState.reminders);
      }
      calState.notifications = computeLocalNotifications(
        calState.events,
        savedIds,
      );
    }

    updateNavBadges();
    openNotificationsModal();
  }

  // --- Calendar Month Grid Rendering ---

  function getFilteredCalendarEvents() {
    return calState.events.filter((ev) => {
      if (
        calState.filterUniversity &&
        ev.university_id !== calState.filterUniversity
      ) {
        return false;
      }
      if (calState.filterType && ev.event_type !== calState.filterType) {
        return false;
      }
      return true;
    });
  }

  function renderCalendarView(resultsEl) {
    const savedIds = ctx.getSavedIds();
    if (!savedIds.length) {
      resultsEl.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${icon("calendar")}</div>
        <h3>Save universities to build your admission calendar</h3>
        <p>Your personal application calendar automatically combines verified entrance examination dates, application openings, and deadlines from every university you save.</p>
        <button type="button" class="button primary" data-action="browse">Explore colleges</button>
      </div>`;
      return;
    }

    if (calState.error) {
      resultsEl.innerHTML = `<div class="error-state"><p>${e(calState.error)}</p><button type="button" class="button secondary" data-action="retry">Try again</button></div>`;
      return;
    }

    const filteredEvents = getFilteredCalendarEvents();
    const confirmedEvents = filteredEvents.filter(
      (ev) => ev.is_confirmed && (calState.showExpiredOnGrid || !ev.is_expired),
    );
    const unverifiedOrTba = filteredEvents.filter(
      (ev) => !ev.is_confirmed && !ev.is_expired,
    );
    const expiredEvents = filteredEvents.filter((ev) => ev.is_expired);

    const upcomingConfirmedTotal = calState.events.filter(
      (ev) => ev.is_upcoming,
    ).length;
    const unverifiedTotal = calState.events.filter(
      (ev) => !ev.is_confirmed && !ev.is_expired,
    ).length;
    const activeAlerts = calState.notifications.length;

    // Build month calendar matrix
    const year = calState.year;
    const month = calState.month;
    const firstOfMonth = new Date(Date.UTC(year, month, 1));
    const startWeekday = firstOfMonth.getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    const gridStart = new Date(Date.UTC(year, month, 1 - startWeekday));
    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

    const toIso = (dt) =>
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;

    const eventsOnDate = (iso) =>
      confirmedEvents.filter((ev) => {
        if (!ev.start_date) return false;
        const end = ev.end_date || ev.start_date;
        return ev.start_date <= iso && iso <= end;
      });

    const cellsHtml = [];
    const monthAgendaDays = [];

    for (let i = 0; i < totalCells; i++) {
      const dt = new Date(gridStart.getTime() + i * 86_400_000);
      const iso = toIso(dt);
      const isCurrentMonth = dt.getUTCMonth() === month;
      const isToday = iso === calState.today;
      const dayEvents = eventsOnDate(iso);

      if (isCurrentMonth && dayEvents.length > 0) {
        monthAgendaDays.push({ iso, dayNum: dt.getUTCDate(), events: dayEvents });
      }

      const maxVisible = dayEvents.length > 3 ? 2 : 3;
      const visibleEvents = dayEvents.slice(0, maxVisible);
      const overflowCount = dayEvents.length - visibleEvents.length;

      const chipsHtml = visibleEvents
        .map((ev) => {
          const accent = accentIndexFor(ev.university_id, savedIds);
          const remEnabled = Boolean(calState.reminders[ev.event_id]?.enabled);
          return `<button
            type="button"
            class="cal-event-chip uni-accent-${accent}${ev.is_expired ? " is-expired" : ""}"
            data-action="cal-event-detail"
            data-event-id="${e(ev.event_id)}"
            title="${e(`${ev.university_name} — ${ev.event_name} (${ev.display_date})`)}"
          >
            <span class="cal-event-dot" aria-hidden="true"></span>
            <span class="cal-event-text"><strong>${e(ev.university_short_name)}</strong> ${e(ev.event_name)}</span>
            ${remEnabled ? '<span class="cal-event-bell" aria-label="Reminder enabled">●</span>' : ""}
          </button>`;
        })
        .join("");

      const overflowHtml =
        overflowCount > 0
          ? `<button type="button" class="cal-more-btn" data-action="cal-day-overflow" data-date="${e(iso)}">+${overflowCount} more</button>`
          : "";

      cellsHtml.push(`<div class="cal-cell${isCurrentMonth ? "" : " is-outside"}${isToday ? " is-today" : ""}" data-date="${e(iso)}">
        <div class="cal-cell-head">
          <span class="cal-day-num">${dt.getUTCDate()}</span>
          ${isToday ? '<span class="cal-today-tag">Today</span>' : ""}
        </div>
        <div class="cal-cell-events">${chipsHtml}${overflowHtml}</div>
      </div>`);
    }

    // Legend for saved universities
    const legendHtml = calState.dashboardItems
      .map((uni) => {
        const accent = accentIndexFor(uni.university_id, savedIds);
        const active = calState.filterUniversity === uni.university_id;
        return `<button
          type="button"
          class="cal-legend-item uni-accent-${accent}${active ? " is-selected" : ""}"
          data-action="cal-filter-uni"
          data-school="${e(uni.university_id)}"
          aria-pressed="${active}"
        >
          <span class="cal-legend-swatch" aria-hidden="true"></span>
          <span>${e(uni.short_name)}</span>
        </button>`;
      })
      .join("");

    // Active due reminders banner inside calendar if any are triggered
    const alertsBannerHtml =
      activeAlerts > 0
        ? `<div class="cal-alerts-banner" role="region" aria-label="Active admission reminders">
            <div class="cal-alerts-banner-main">
              ${icon("bell")}
              <div>
                <strong>${activeAlerts} upcoming admission reminder${activeAlerts === 1 ? "" : "s"} due now</strong>
                <p>${e(calState.notifications[0].message)}${activeAlerts > 1 ? ` (+${activeAlerts - 1} more)` : ""}</p>
              </div>
            </div>
            <button type="button" class="button primary cal-btn-sm" data-action="open-notifications">Review reminders</button>
          </div>`
        : "";

    // Mobile chronological agenda list for this month
    const mobileAgendaHtml = monthAgendaDays.length
      ? `<div class="cal-mobile-agenda">
          ${monthAgendaDays
            .map(
              (day) => `<div class="cal-agenda-day">
                <div class="cal-agenda-date${day.iso === calState.today ? " is-today" : ""}">${e(formatDateReadable(day.iso))}</div>
                <div class="cal-agenda-items">
                  ${day.events
                    .map((ev) => {
                      const accent = accentIndexFor(ev.university_id, savedIds);
                      return `<button type="button" class="cal-agenda-card uni-accent-${accent}" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">
                        <span class="cal-agenda-stripe" aria-hidden="true"></span>
                        <div class="cal-agenda-body">
                          <strong>${e(ev.university_short_name)} · ${e(ev.event_name)}</strong>
                          <span>${e(ev.event_type_label)}${ev.exam_time ? ` · ${e(ev.exam_time)}` : ""}</span>
                        </div>
                      </button>`;
                    })
                    .join("")}
                </div>
              </div>`,
            )
            .join("")}
        </div>`
      : `<p class="cal-mobile-empty">No confirmed admission events scheduled in ${e(MONTH_NAMES[month])} ${year} for your saved universities.</p>`;

    // Unverified & To Be Announced section (explicitly separated from confirmed calendar events)
    const unverifiedHtml = unverifiedOrTba.length
      ? `<section class="cal-notice-section" aria-labelledby="cal-tba-heading">
          <div class="cal-notice-head">
            <div>
              <h3 id="cal-tba-heading">To Be Announced &amp; Unverified Schedules</h3>
              <p>These entries are kept separate from confirmed calendar dates until officially announced and verified.</p>
            </div>
            <span class="cal-notice-count">${unverifiedOrTba.length} ${unverifiedOrTba.length === 1 ? "notice" : "notices"}</span>
          </div>
          <div class="cal-notice-list">
            ${unverifiedOrTba
              .map((ev) => {
                const accent = accentIndexFor(ev.university_id, savedIds);
                const link = safeURL(
                  ev.official_source_url || ev.official_admissions_url,
                );
                const verClass =
                  ev.verification_status === "unverified"
                    ? "ver-unverified"
                    : "ver-tba";
                return `<article class="cal-notice-card uni-accent-${accent}">
                  <div class="cal-notice-top">
                    <div>
                      <span class="cal-notice-uni"><span class="cal-legend-swatch" aria-hidden="true"></span>${e(ev.university_name)}</span>
                      <h4>${e(ev.event_name)}</h4>
                    </div>
                    <span class="cal-ver-tag ${verClass}">${e(ev.verification_label)}</span>
                  </div>
                  <p class="cal-notice-meta">
                    <span>${e(ev.event_type_label)}</span>
                    <span aria-hidden="true">·</span>
                    <strong>${ev.verification_status === "unverified" && ev.start_date ? `${e(ev.display_date)} (Unverified)` : "To Be Announced"}</strong>
                  </p>
                  ${ev.description ? `<p class="cal-notice-desc">${e(ev.description)}</p>` : ""}
                  <div class="cal-notice-actions">
                    <button type="button" class="text-button" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">Event details ${icon("arrow")}</button>
                    ${link ? `<a class="cal-official-link" href="${e(link)}" target="_blank" rel="noopener noreferrer">Verify on official site ${icon("external")}</a>` : ""}
                  </div>
                </article>`;
              })
              .join("")}
          </div>
        </section>`
      : "";

    // Expired schedules archive (never presented as upcoming)
    const expiredHtml = expiredEvents.length
      ? `<details class="cal-expired-details">
          <summary>Past / expired admission schedules (${expiredEvents.length})</summary>
          <ul class="cal-expired-list">
            ${expiredEvents
              .map(
                (ev) => `<li>
                  <button type="button" class="cal-expired-btn" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">
                    <strong>${e(ev.university_short_name)}</strong> — ${e(ev.event_name)}
                    <span>${e(ev.display_date)} · ${e(ev.event_type_label)}</span>
                  </button>
                </li>`,
              )
              .join("")}
          </ul>
        </details>`
      : "";

    const monthEmptyNote =
      !monthAgendaDays.length && upcomingConfirmedTotal > 0
        ? `<div class="cal-month-hint">
            <span>No confirmed events in ${e(MONTH_NAMES[month])} ${year}.</span>
            <button type="button" class="text-button" data-action="cal-jump-next">Jump to next confirmed event ${icon("arrow")}</button>
          </div>`
        : !upcomingConfirmedTotal
          ? `<div class="cal-month-hint">
              <span>No confirmed upcoming examination or deadline dates have been published yet for your saved universities. Check the To Be Announced notices and official portal links below.</span>
            </div>`
          : "";

    resultsEl.innerHTML = `<div class="calendar-workspace">
      ${alertsBannerHtml}

      <div class="cal-kpi-strip" aria-label="Calendar summary">
        <div class="cal-kpi">
          <span>Saved universities</span>
          <strong>${savedIds.length}</strong>
        </div>
        <div class="cal-kpi">
          <span>Confirmed upcoming</span>
          <strong>${upcomingConfirmedTotal}</strong>
        </div>
        <div class="cal-kpi">
          <span>TBA / Unverified</span>
          <strong>${unverifiedTotal}</strong>
        </div>
        <div class="cal-kpi">
          <span>Due reminders</span>
          <strong>${activeAlerts}</strong>
        </div>
      </div>

      <section class="cal-card" aria-label="Monthly university admission calendar">
        <header class="cal-toolbar">
          <div class="cal-month-nav">
            <button type="button" class="icon-button cal-nav-btn" data-action="cal-prev" aria-label="Previous month">
              <span aria-hidden="true">←</span>
            </button>
            <h3 class="cal-month-title">${e(MONTH_NAMES[month])} ${year}</h3>
            <button type="button" class="icon-button cal-nav-btn" data-action="cal-next" aria-label="Next month">
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" class="button secondary cal-btn-sm" data-action="cal-today">Today</button>
          </div>
          <div class="cal-controls-right">
            <select id="cal-filter-type" class="cal-select" aria-label="Filter by event type">
              <option value="">All event types</option>
              ${Object.entries(EVENT_TYPE_LABELS)
                .map(
                  ([val, lbl]) =>
                    `<option value="${e(val)}" ${calState.filterType === val ? "selected" : ""}>${e(lbl)}</option>`,
                )
                .join("")}
            </select>
            <label class="cal-toggle-expired">
              <input type="checkbox" id="cal-show-expired" ${calState.showExpiredOnGrid ? "checked" : ""} />
              <span>Show past</span>
            </label>
            <button type="button" class="button secondary cal-btn-sm" data-action="open-notifications">
              ${icon("bell")}Reminders${activeAlerts ? ` (${activeAlerts})` : ""}
            </button>
          </div>
        </header>

        <div class="cal-legend-bar" role="group" aria-label="Filter calendar by saved university">
          <button
            type="button"
            class="cal-legend-item cal-legend-all${!calState.filterUniversity ? " is-selected" : ""}"
            data-action="cal-filter-uni"
            data-school=""
            aria-pressed="${!calState.filterUniversity}"
          >All saved (${savedIds.length})</button>
          ${legendHtml}
        </div>

        ${monthEmptyNote}

        <div class="cal-grid-wrap">
          <div class="cal-weekdays" aria-hidden="true">
            ${WEEKDAYS.map((d) => `<div class="cal-weekday">${d}</div>`).join("")}
          </div>
          <div class="cal-grid">${cellsHtml.join("")}</div>
        </div>

        ${mobileAgendaHtml}
      </section>

      ${unverifiedHtml}
      ${expiredHtml}
    </div>`;
  }

  // --- Enhanced Saved Universities Dashboard ---

  function renderSavedDashboardView(resultsEl, filteredSchools) {
    const savedIds = ctx.getSavedIds();
    if (!savedIds.length) {
      resultsEl.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${icon("save")}</div>
        <h3>Keep a few possibilities close</h3>
        <p>Bookmark universities while browsing to track your application status, view entrance examination dates, and build your personal admission calendar.</p>
        <button type="button" class="button primary" data-action="browse">Explore colleges</button>
      </div>`;
      return;
    }

    const visibleIds = new Set(filteredSchools.map((s) => s.id));
    const dashboardById = new Map(
      calState.dashboardItems.map((item) => [item.university_id, item]),
    );

    const cardsHtml = filteredSchools
      .map((school) => {
        const dash = dashboardById.get(school.id);
        const appStatus =
          dash?.application_status ||
          calState.statuses[school.id]?.status ||
          "Interested";
        const nextEv = dash?.next_upcoming_event || null;
        const exam = dash?.entrance_exam || null;
        const deadline = dash?.application_deadline || null;
        const officialUrl = safeURL(
          dash?.official_admissions_url || school.official_url,
        );
        const compared = ctx.getCompareIds().includes(school.id);
        const accent = accentIndexFor(school.id, savedIds);

        const examDisplay = exam
          ? exam.status === "verified"
            ? `${exam.display_date}${exam.event_name ? ` · ${exam.event_name}` : ""}`
            : exam.display_date
          : "To Be Announced";

        const deadlineDisplay = deadline
          ? deadline.display_date
          : "Not announced yet";

        const nextEventDisplay = nextEv
          ? `${nextEv.display_date} — ${nextEv.event_name}`
          : "No confirmed upcoming event";

        return `<article class="saved-dash-card uni-accent-${accent}" data-saved-card="${e(school.id)}">
          <div class="saved-dash-head">
            <div class="saved-dash-identity">
              ${ctx.schoolMark(school)}
              <div class="saved-dash-titles">
                <h3>${e(school.name)}</h3>
                <p class="card-location">
                  <span>${e(school.sector)}</span>
                  <span aria-hidden="true">·</span>
                  <span>${e(school.city || "Manila")}</span>
                  <span aria-hidden="true">·</span>
                  <span class="saved-status-indicator ${statusClassFor(appStatus)}" data-status-label>${e(appStatus)}</span>
                </p>
              </div>
            </div>
            <div class="saved-dash-status-wrap">
              <label class="saved-status-field">
                <span>Application status</span>
                <select
                  class="saved-status-select"
                  data-app-status-school="${e(school.id)}"
                  aria-label="Application status for ${e(school.name)}"
                >
                  ${APPLICATION_STATUSES.map(
                    (st) =>
                      `<option value="${e(st)}" ${st === appStatus ? "selected" : ""}>${e(st)}</option>`,
                  ).join("")}
                </select>
              </label>
            </div>
          </div>

          <dl class="saved-dash-facts">
            <div>
              <dt>Next upcoming event</dt>
              <dd class="${nextEv ? "is-confirmed-val" : "is-muted-val"}">${e(nextEventDisplay)}</dd>
            </div>
            <div>
              <dt>Entrance examination</dt>
              <dd class="${exam?.status === "verified" ? "is-confirmed-val" : "is-tba-val"}">${e(examDisplay)}</dd>
            </div>
            <div>
              <dt>Application deadline</dt>
              <dd class="${deadline?.status === "verified" ? "is-confirmed-val" : "is-muted-val"}">${e(deadlineDisplay)}</dd>
            </div>
          </dl>

          <footer class="saved-dash-footer">
            <div class="saved-dash-links">
              <button type="button" class="button primary saved-btn-sm" data-action="uni-full-schedule" data-school="${e(school.id)}">
                ${icon("calendar")}Admission schedule (${dash?.total_events_count ?? 0})
              </button>
              ${
                officialUrl
                  ? `<a class="button secondary saved-btn-sm" href="${e(officialUrl)}" target="_blank" rel="noopener noreferrer">Official admissions ${icon("external")}</a>`
                  : ""
              }
              <button type="button" class="text-button" data-action="details" data-school="${e(school.id)}">
                School profile ${icon("arrow")}
              </button>
            </div>
            <div class="saved-dash-secondary-actions">
              <button
                type="button"
                class="compare-button"
                data-action="compare"
                data-school="${e(school.id)}"
                aria-pressed="${compared}"
              ><span class="compare-check">${icon("check")}</span>Compare</button>
              <button
                type="button"
                class="saved-remove-btn"
                data-action="save"
                data-school="${e(school.id)}"
                aria-pressed="true"
                aria-label="Remove ${e(school.short_name)} from saved universities"
              >Remove</button>
            </div>
          </footer>
        </article>`;
      })
      .join("");

    const activeAlerts = calState.notifications.length;
    const summaryBanner = `<div class="saved-dash-banner">
      <div class="saved-dash-banner-copy">
        <strong>Track your applications &amp; admission timeline</strong>
        <p>Application progress statuses are personal to your shortlist and separate from official university schedule dates.</p>
      </div>
      <div class="saved-dash-banner-actions">
        <button type="button" class="button primary" data-view="calendar">${icon("calendar")}Open application calendar</button>
        <button type="button" class="button secondary" data-action="open-notifications">${icon("bell")}Reminders${activeAlerts ? ` (${activeAlerts})` : ""}</button>
      </div>
    </div>`;

    resultsEl.innerHTML = visibleIds.size
      ? `${summaryBanner}<div class="saved-dash-list">${cardsHtml}</div>`
      : `<div class="empty-state">
          <div class="empty-icon">${icon("search")}</div>
          <h3>No saved schools match that filter</h3>
          <p>Clear your search filter to view all ${savedIds.length} saved universities.</p>
          <button type="button" class="button secondary" data-action="reset">Reset search</button>
        </div>`;
  }

  // --- Event Detail Modal ---

  function openEventDetailModal(eventId) {
    const ev = calState.events.find((item) => item.event_id === eventId);
    if (!ev) {
      ctx.toast("Event details are not available.");
      return;
    }

    const dialog = document.getElementById("school-dialog");
    const body = document.getElementById("detail-body");
    if (!dialog || !body) return;

    const school = ctx.getSchoolById(ev.university_id) || {
      id: ev.university_id,
      name: ev.university_name,
      short_name: ev.university_short_name,
      color: ev.university_color,
    };

    const sourceHref = safeURL(ev.official_source_url);
    const admissionsHref = safeURL(ev.official_admissions_url);
    const rem = calState.reminders[ev.event_id] || {
      enabled: false,
      intervals_days: [7, 3, 1],
    };
    const activeIntervals = new Set(
      Array.isArray(rem.intervals_days) ? rem.intervals_days.map(Number) : [7, 3, 1],
    );

    const verClass =
      ev.verification_status === "verified"
        ? ev.is_expired
          ? "ver-expired"
          : "ver-verified"
        : ev.verification_status === "unverified"
          ? "ver-unverified"
          : "ver-tba";

    const verLabel =
      ev.is_expired && ev.is_confirmed
        ? "Verified · Expired"
        : ev.verification_label;

    const reminderSectionHtml = ev.is_upcoming
      ? `<section class="event-reminder-box" data-reminder-event="${e(ev.event_id)}">
          <div class="event-reminder-head">
            <div>
              <h3>${icon("bell")}Examination &amp; deadline reminders</h3>
              <p>Receive in-app alerts before this confirmed date. Email &amp; browser notification channels are structured for future release.</p>
            </div>
            <label class="reminder-switch">
              <input
                type="checkbox"
                id="event-reminder-toggle"
                data-reminder-toggle="${e(ev.event_id)}"
                ${rem.enabled ? "checked" : ""}
              />
              <span>${rem.enabled ? "Enabled" : "Off"}</span>
            </label>
          </div>
          <div class="reminder-intervals" id="reminder-intervals-wrap">
            ${REMINDER_INTERVALS.map(
              (days) => `<label class="reminder-interval-opt">
                <input
                  type="checkbox"
                  data-reminder-interval="${days}"
                  data-event-id="${e(ev.event_id)}"
                  ${activeIntervals.has(days) ? "checked" : ""}
                  ${rem.enabled ? "" : "disabled"}
                />
                <span>${days} ${days === 1 ? "day" : "days"} before</span>
              </label>`,
            ).join("")}
          </div>
        </section>`
      : `<div class="event-reminder-note">
          ${
            ev.is_expired
              ? "Reminders are disabled because this event date has already passed."
              : "Reminders can be enabled once an administrator verifies an official date for this event."
          }
        </div>`;

    body.innerHTML = `<header class="detail-head">
      <div class="detail-head-row">
        ${ctx.schoolMark(school)}
        <div>
          <p class="event-modal-kicker">
            <span>${e(ev.event_type_label)}</span>
            <span aria-hidden="true">·</span>
            <span class="cal-ver-tag ${verClass}">${e(verLabel)}</span>
          </p>
          <h2 id="dialog-title">${e(ev.event_name)}</h2>
          <p class="detail-meta">${e(ev.university_name)}</p>
        </div>
      </div>
    </header>
    <div class="detail-panel event-detail-panel">
      <dl class="detail-facts event-detail-facts">
        <div>
          <dt>Date</dt>
          <dd>${e(ev.display_date)}${ev.verification_status === "unverified" && ev.start_date ? " (Unverified)" : ""}</dd>
        </div>
        <div>
          <dt>Examination time</dt>
          <dd>${e(ev.exam_time || "Not specified")}</dd>
        </div>
        <div>
          <dt>Venue / location</dt>
          <dd>${e(ev.venue || "Check official announcement")}</dd>
        </div>
        ${
          ev.application_period?.label
            ? `<div><dt>Application period</dt><dd>${e(ev.application_period.label)}</dd></div>`
            : ""
        }
        <div>
          <dt>Verification status</dt>
          <dd>${e(verLabel)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>${e(formatDateTimeReadable(ev.last_updated_at))}</dd>
        </div>
      </dl>

      ${
        ev.description
          ? `<section class="profile-section">
              <h3>Notes &amp; instructions</h3>
              <p class="overview-note">${e(ev.description)}</p>
            </section>`
          : ""
      }

      ${reminderSectionHtml}

      <div class="dialog-actions">
        ${
          sourceHref
            ? `<a class="button primary" href="${e(sourceHref)}" target="_blank" rel="noopener noreferrer">Official announcement ${icon("external")}</a>`
            : ""
        }
        ${
          admissionsHref && admissionsHref !== sourceHref
            ? `<a class="button secondary" href="${e(admissionsHref)}" target="_blank" rel="noopener noreferrer">Official admissions page ${icon("external")}</a>`
            : admissionsHref && !sourceHref
              ? `<a class="button primary" href="${e(admissionsHref)}" target="_blank" rel="noopener noreferrer">Official admissions page ${icon("external")}</a>`
              : ""
        }
        <button type="button" class="button secondary" data-action="details" data-school="${e(ev.university_id)}">University profile</button>
      </div>
    </div>`;

    if (!dialog.open) dialog.showModal();
  }

  // --- Day Overflow Modal (when >3 universities overlap on the same date) ---

  function openDayOverflowModal(isoDate) {
    const savedIds = ctx.getSavedIds();
    const events = getFilteredCalendarEvents().filter((ev) => {
      if (!ev.is_confirmed || !ev.start_date) return false;
      const end = ev.end_date || ev.start_date;
      return ev.start_date <= isoDate && isoDate <= end;
    });
    const dialog = document.getElementById("school-dialog");
    const body = document.getElementById("detail-body");
    if (!dialog || !body) return;

    body.innerHTML = `<header class="detail-head">
      <h2 id="dialog-title">${e(formatDateReadable(isoDate))}</h2>
      <p class="detail-meta">${events.length} overlapping admission event${events.length === 1 ? "" : "s"} across your saved universities</p>
    </header>
    <div class="detail-panel">
      <div class="cal-overflow-list">
        ${events
          .map((ev) => {
            const accent = accentIndexFor(ev.university_id, savedIds);
            return `<button type="button" class="cal-agenda-card uni-accent-${accent}" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">
              <span class="cal-agenda-stripe" aria-hidden="true"></span>
              <div class="cal-agenda-body">
                <strong>${e(ev.university_name)} — ${e(ev.event_name)}</strong>
                <span>${e(ev.event_type_label)}${ev.exam_time ? ` · ${e(ev.exam_time)}` : ""}${ev.venue ? ` · ${e(ev.venue)}` : ""}</span>
              </div>
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  // --- Complete University Admission Schedule Modal (from Saved Dashboard) ---

  function openUniversityScheduleModal(universityId) {
    const dash = calState.dashboardItems.find(
      (u) => u.university_id === universityId,
    );
    const school = ctx.getSchoolById(universityId);
    if (!school && !dash) return;

    const events = dash?.events || calState.events.filter((ev) => ev.university_id === universityId);
    const officialUrl = safeURL(
      dash?.official_admissions_url || school?.official_url,
    );
    const dialog = document.getElementById("school-dialog");
    const body = document.getElementById("detail-body");
    if (!dialog || !body) return;

    const upcoming = events.filter((ev) => ev.is_upcoming);
    const unverified = events.filter((ev) => !ev.is_confirmed && !ev.is_expired);
    const past = events.filter((ev) => ev.is_expired);

    const renderGroup = (title, list) =>
      list.length
        ? `<section class="profile-section">
            <h3>${e(title)} (${list.length})</h3>
            <ul class="uni-sched-modal-list">
              ${list
                .map((ev) => {
                  const verClass =
                    ev.verification_status === "verified"
                      ? ev.is_expired
                        ? "ver-expired"
                        : "ver-verified"
                      : ev.verification_status === "unverified"
                        ? "ver-unverified"
                        : "ver-tba";
                  return `<li>
                    <button type="button" class="uni-sched-row" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">
                      <div>
                        <strong>${e(ev.event_name)}</strong>
                        <span>${e(ev.event_type_label)} · ${e(ev.display_date)}${ev.exam_time ? ` · ${e(ev.exam_time)}` : ""}</span>
                      </div>
                      <span class="cal-ver-tag ${verClass}">${e(ev.is_expired && ev.is_confirmed ? "Expired" : ev.verification_label)}</span>
                    </button>
                  </li>`;
                })
                .join("")}
            </ul>
          </section>`
        : "";

    body.innerHTML = `<header class="detail-head">
      <div class="detail-head-row">
        ${ctx.schoolMark(school || dash)}
        <div>
          <h2 id="dialog-title">${e(dash?.name || school?.name)}</h2>
          <p class="detail-meta">Complete admission schedule · Status: ${e(dash?.application_status || "Interested")}</p>
        </div>
      </div>
    </header>
    <div class="detail-panel">
      ${
        events.length
          ? renderGroup("Confirmed upcoming events", upcoming) +
            renderGroup("To Be Announced & unverified notices", unverified) +
            renderGroup("Past / expired schedules", past)
          : '<p class="muted-note">No admission events recorded yet. Check the official university admissions portal below.</p>'
      }
      <div class="dialog-actions">
        <button type="button" class="button primary" data-action="cal-open-for-uni" data-school="${e(universityId)}">${icon("calendar")}Filter in calendar</button>
        ${
          officialUrl
            ? `<a class="button secondary" href="${e(officialUrl)}" target="_blank" rel="noopener noreferrer">Official admissions page ${icon("external")}</a>`
            : ""
        }
      </div>
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  // --- In-App Notification Center Modal ---

  function openNotificationsModal() {
    const dialog = document.getElementById("school-dialog");
    const body = document.getElementById("detail-body");
    if (!dialog || !body) return;

    const savedSet = new Set(ctx.getSavedIds());
    const enabledReminders = Object.values(calState.reminders || {})
      .filter((r) => r && r.enabled)
      .map((r) => ({
        rem: r,
        ev: calState.events.find(
          (item) =>
            item.event_id === r.event_id && savedSet.has(item.university_id),
        ),
      }))
      .filter((pair) => Boolean(pair.ev));

    const activeHtml = calState.notifications.length
      ? `<ul class="notif-list">
          ${calState.notifications
            .map(
              (n) => `<li class="notif-item">
                <div class="notif-item-main">
                  <span class="notif-countdown">${
                    n.days_until === 0
                      ? "Today"
                      : n.days_until === 1
                        ? "Tomorrow"
                        : `In ${n.days_until} days`
                  }</span>
                  <strong>${e(n.title)}</strong>
                  <p>${e(n.message)}</p>
                  ${n.venue || n.exam_time ? `<p class="notif-meta">${e([n.exam_time, n.venue].filter(Boolean).join(" · "))}</p>` : ""}
                </div>
                <div class="notif-item-actions">
                  <button type="button" class="button secondary saved-btn-sm" data-action="cal-event-detail" data-event-id="${e(n.event_id)}">Details</button>
                  <button type="button" class="text-button" data-action="notif-dismiss" data-event-id="${e(n.event_id)}" data-notif-key="${e(n.notification_key)}">Dismiss</button>
                </div>
              </li>`,
            )
            .join("")}
        </ul>`
      : `<p class="muted-note">No reminders are currently due within your 7-day, 3-day, or 1-day alert windows.</p>`;

    const configuredHtml = enabledReminders.length
      ? `<ul class="notif-configured-list">
          ${enabledReminders
            .map(
              ({ rem, ev }) => `<li>
                <div>
                  <strong>${e(ev.university_short_name)} — ${e(ev.event_name)}</strong>
                  <span>${e(ev.display_date)} · Alerts: ${(rem.intervals_days || [7, 3, 1]).map((d) => `${d}d`).join(", ")} before</span>
                </div>
                <div class="notif-item-actions">
                  <button type="button" class="text-button" data-action="cal-event-detail" data-event-id="${e(ev.event_id)}">Edit</button>
                  <button type="button" class="text-button" data-action="notif-disable" data-event-id="${e(ev.event_id)}">Disable</button>
                </div>
              </li>`,
            )
            .join("")}
        </ul>`
      : `<p class="muted-note">You haven’t enabled any event reminders yet. Click any confirmed date on your Application Calendar to turn on 7-day, 3-day, or 1-day alerts.</p>`;

    body.innerHTML = `<header class="detail-head">
      <h2 id="dialog-title">Admission Reminders &amp; Alerts</h2>
      <p class="detail-meta">In-app notifications for your saved universities’ verified upcoming schedules</p>
    </header>
    <div class="detail-panel">
      <section class="profile-section">
        <h3>Due alerts (${calState.notifications.length})</h3>
        ${activeHtml}
      </section>
      <section class="profile-section">
        <h3>Enabled event reminders (${enabledReminders.length})</h3>
        ${configuredHtml}
      </section>
      <p class="muted-note">Reminders trigger automatically for verified upcoming dates only. Unsaving a university immediately silences its alerts without modifying central schedules.</p>
    </div>`;

    if (!dialog.open) dialog.showModal();
  }

  // --- Interaction Handlers ---

  function handleAction(action, button) {
    switch (action) {
      case "cal-prev": {
        if (calState.month === 0) {
          calState.month = 11;
          calState.year -= 1;
        } else {
          calState.month -= 1;
        }
        ctx.rerenderIfView("calendar");
        return true;
      }
      case "cal-next": {
        if (calState.month === 11) {
          calState.month = 0;
          calState.year += 1;
        } else {
          calState.month += 1;
        }
        ctx.rerenderIfView("calendar");
        return true;
      }
      case "cal-today": {
        const [y, m] = calState.today.split("-").map(Number);
        calState.year = y;
        calState.month = m - 1;
        ctx.rerenderIfView("calendar");
        return true;
      }
      case "cal-jump-next": {
        const nextEv = getFilteredCalendarEvents().find(
          (ev) => ev.is_upcoming && ev.start_date,
        );
        if (nextEv) {
          const [y, m] = nextEv.start_date.split("-").map(Number);
          calState.year = y;
          calState.month = m - 1;
          ctx.rerenderIfView("calendar");
        }
        return true;
      }
      case "cal-filter-uni": {
        const sid = button.dataset.school || "";
        calState.filterUniversity =
          calState.filterUniversity === sid ? "" : sid;
        ctx.rerenderIfView("calendar");
        return true;
      }
      case "cal-event-detail": {
        const eventId = button.dataset.eventId || "";
        if (eventId) openEventDetailModal(eventId);
        return true;
      }
      case "cal-day-overflow": {
        const date = button.dataset.date || "";
        if (date) openDayOverflowModal(date);
        return true;
      }
      case "uni-full-schedule": {
        const sid = button.dataset.school || "";
        if (sid) openUniversityScheduleModal(sid);
        return true;
      }
      case "cal-open-for-uni": {
        const sid = button.dataset.school || "";
        calState.filterUniversity = sid;
        const dialog = document.getElementById("school-dialog");
        if (dialog?.open) dialog.close();
        ctx.setView("calendar");
        return true;
      }
      case "open-notifications": {
        openNotificationsModal();
        return true;
      }
      case "notif-dismiss": {
        const eventId = button.dataset.eventId || "";
        const key = button.dataset.notifKey || "";
        if (eventId && key) void dismissNotification(eventId, key);
        return true;
      }
      case "notif-disable": {
        const eventId = button.dataset.eventId || "";
        if (eventId) {
          void saveEventReminder(eventId, false, [7, 3, 1]).then(() => {
            openNotificationsModal();
            ctx.rerenderIfView("calendar");
          });
        }
        return true;
      }
      default:
        return false;
    }
  }

  function handleChange(target) {
    if (
      target instanceof HTMLSelectElement &&
      target.dataset.appStatusSchool
    ) {
      void updateApplicationStatus(target.dataset.appStatusSchool, target.value);
      return true;
    }
    if (target.id === "cal-filter-type") {
      calState.filterType = target.value;
      ctx.rerenderIfView("calendar");
      return true;
    }
    if (target.id === "cal-show-expired") {
      calState.showExpiredOnGrid = Boolean(target.checked);
      ctx.rerenderIfView("calendar");
      return true;
    }
    if (
      target instanceof HTMLInputElement &&
      target.dataset.reminderToggle
    ) {
      const eventId = target.dataset.reminderToggle;
      const enabled = target.checked;
      const box = target.closest("[data-reminder-event]");
      const labelSpan = target.nextElementSibling;
      if (labelSpan) labelSpan.textContent = enabled ? "Enabled" : "Off";
      const intervalInputs = box
        ? [...box.querySelectorAll("[data-reminder-interval]")]
        : [];
      intervalInputs.forEach((inp) => {
        inp.disabled = !enabled;
      });
      const checkedDays = intervalInputs
        .filter((inp) => inp.checked)
        .map((inp) => Number(inp.dataset.reminderInterval));
      void saveEventReminder(eventId, enabled, checkedDays).then(() => {
        ctx.rerenderIfView("calendar");
      });
      return true;
    }
    if (
      target instanceof HTMLInputElement &&
      target.dataset.reminderInterval
    ) {
      const eventId = target.dataset.eventId || "";
      const box = target.closest("[data-reminder-event]");
      const toggle = box?.querySelector("[data-reminder-toggle]");
      const enabled = Boolean(toggle?.checked);
      const checkedDays = box
        ? [...box.querySelectorAll("[data-reminder-interval]")]
            .filter((inp) => inp.checked)
            .map((inp) => Number(inp.dataset.reminderInterval))
        : [7, 3, 1];
      if (enabled && checkedDays.length === 0) {
        target.checked = true;
        ctx.toast("Keep at least one reminder interval selected, or turn the reminder off.");
        return true;
      }
      void saveEventReminder(eventId, enabled, checkedDays).then(() => {
        ctx.rerenderIfView("calendar");
      });
      return true;
    }
    return false;
  }

  return {
    state: calState,
    refreshData,
    renderCalendarView,
    renderSavedDashboardView,
    handleAction,
    handleChange,
    openEventDetailModal,
    openNotificationsModal,
    updateNavBadges,
  };
}
