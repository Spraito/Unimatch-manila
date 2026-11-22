/**
 * UniMatch PH — Firebase Auth (Google Sign-In) & Cloud Firestore client module.
 *
 * Persists private student profiles, recommendation preferences, and saved/compare
 * shortlists in per-user Firestore documents enforced by firestore.rules.
 */
import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";
import { AdminCatalogController } from "./adminPanel.js";
import {
  CatalogOpType,
  catalogRecordToExplorerDetail,
  loadPublishedCatalogUniversities,
  mergeLiveAndBaselineCatalog,
  scoreLiveCatalogRecommendations,
  verifyAdminAccess,
  type CatalogUniversityRecord,
} from "./catalogService.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("the client is offline")
    ) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

void testConnection();

// --- Blueprint-aligned payload sanitizers ---
const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_SECTORS = new Set(["", "Public", "Private"]);
const VALID_BASES = new Set(["semester", "trimester", "year", "unit"]);

interface CloudPreferences {
  program: string;
  city: string;
  sector: "" | "Public" | "Private";
  budget: number | null;
  budgetBasis: "semester" | "trimester" | "year" | "unit";
  weights: {
    program: number;
    location: number;
    budget: number;
    sector: number;
  };
}

interface CloudShortlist {
  savedIds: string[];
  compareIds: string[];
}

interface CloudProfile {
  uid: string;
  displayName: string;
  email: string;
}

const DEFAULT_WEIGHTS = {
  program: 0.45,
  location: 0.2,
  budget: 0.2,
  sector: 0.15,
};

function sanitizeDisplayName(value: unknown, fallback = "Student"): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return cleaned || fallback;
}

function sanitizeIdList(values: unknown, maxSize: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!VALID_ID_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxSize) break;
  }
  return out;
}

function sanitizePreferences(raw: Partial<CloudPreferences>): CloudPreferences {
  const program = String(raw.program ?? "").trim().slice(0, 200);
  const city = String(raw.city ?? "").trim().slice(0, 200);
  const rawSector = String(raw.sector ?? "").trim();
  const sector = (VALID_SECTORS.has(rawSector) ? rawSector : "") as
    | ""
    | "Public"
    | "Private";

  let budget: number | null = null;
  if (raw.budget !== null && raw.budget !== undefined && String(raw.budget) !== "") {
    const parsed = Number(raw.budget);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000_000) {
      budget = Math.round(parsed * 100) / 100;
    }
  }

  const rawBasis = String(raw.budgetBasis ?? "semester").trim().toLowerCase();
  const budgetBasis = (VALID_BASES.has(rawBasis) ? rawBasis : "semester") as
    | "semester"
    | "trimester"
    | "year"
    | "unit";

  const srcWeights = raw.weights ?? DEFAULT_WEIGHTS;
  const clamp = (v: unknown, fb: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return fb;
    return n > 1 ? Math.min(1, n / 100) : n;
  };
  const w = {
    program: clamp(srcWeights.program, DEFAULT_WEIGHTS.program),
    location: clamp(srcWeights.location, DEFAULT_WEIGHTS.location),
    budget: clamp(srcWeights.budget, DEFAULT_WEIGHTS.budget),
    sector: clamp(srcWeights.sector, DEFAULT_WEIGHTS.sector),
  };
  const total = w.program + w.location + w.budget + w.sector;
  const weights =
    total > 0
      ? {
          program: Math.round((w.program / total) * 10000) / 10000,
          location: Math.round((w.location / total) * 10000) / 10000,
          budget: Math.round((w.budget / total) * 10000) / 10000,
          sector: Math.round((w.sector / total) * 10000) / 10000,
        }
      : { ...DEFAULT_WEIGHTS };

  return { program, city, sector, budget, budgetBasis, weights };
}

function isSafeRedirect(value: string | null | undefined): string {
  if (!value) return "/cloud-profile";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/cloud-profile";
  }
  return value;
}

function escapeHTML(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] || ch,
  );
}

// --- Firestore data access ---
const inFlightProfileEnsure = new Map<string, Promise<CloudProfile>>();

async function ensureCloudProfileInternal(user: User): Promise<CloudProfile> {
  const path = `users/${user.uid}/private/profile`;
  const ref = doc(db, "users", user.uid, "private", "profile");
  const fallbackName = sanitizeDisplayName(
    user.displayName || user.email?.split("@")[0] || "Student",
  );
  const email = (user.email || "").trim().slice(0, 254);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!snap.exists()) {
    try {
      return await runTransaction(db, async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists()) {
          tx.set(ref, {
            uid: user.uid,
            displayName: fallbackName,
            email,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return { uid: user.uid, displayName: fallbackName, email };
        }
        const existingData = current.data() as Partial<CloudProfile>;
        const existingName = sanitizeDisplayName(
          existingData.displayName,
          fallbackName,
        );
        return {
          uid: user.uid,
          displayName: existingName,
          email: email || existingData.email || "",
        };
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  const data = snap.data() as Partial<CloudProfile>;
  const displayName = sanitizeDisplayName(data.displayName, fallbackName);
  if (email && data.email !== email) {
    try {
      await updateDoc(ref, {
        displayName,
        email,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }
  return { uid: user.uid, displayName, email: email || data.email || "" };
}

function ensureCloudProfile(user: User): Promise<CloudProfile> {
  const existingPromise = inFlightProfileEnsure.get(user.uid);
  if (existingPromise) return existingPromise;
  const promise = ensureCloudProfileInternal(user).finally(() => {
    inFlightProfileEnsure.delete(user.uid);
  });
  inFlightProfileEnsure.set(user.uid, promise);
  return promise;
}

async function saveCloudProfileName(
  user: User,
  displayNameInput: string,
): Promise<CloudProfile> {
  const path = `users/${user.uid}/private/profile`;
  const ref = doc(db, "users", user.uid, "private", "profile");
  const displayName = sanitizeDisplayName(displayNameInput, "");
  if (!displayName) {
    throw new Error("Display name must be between 1 and 80 characters.");
  }
  await ensureCloudProfile(user);
  const email = (user.email || "").trim().slice(0, 254);
  try {
    await updateDoc(ref, {
      displayName,
      email,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
  return { uid: user.uid, displayName, email };
}

async function loadCloudPreferences(user: User): Promise<CloudPreferences> {
  const path = `users/${user.uid}/preferences/match`;
  const ref = doc(db, "users", user.uid, "preferences", "match");
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return sanitizePreferences({});
    }
    return sanitizePreferences(snap.data() as Partial<CloudPreferences>);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

async function saveCloudPreferences(
  user: User,
  prefsInput: Partial<CloudPreferences>,
): Promise<CloudPreferences> {
  const path = `users/${user.uid}/preferences/match`;
  const ref = doc(db, "users", user.uid, "preferences", "match");
  const clean = sanitizePreferences(prefsInput);
  try {
    await setDoc(ref, {
      uid: user.uid,
      program: clean.program,
      city: clean.city,
      sector: clean.sector,
      budget: clean.budget,
      budgetBasis: clean.budgetBasis,
      weights: clean.weights,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
  return clean;
}

async function loadCloudShortlist(user: User): Promise<CloudShortlist> {
  const path = `users/${user.uid}/shortlist/state`;
  const ref = doc(db, "users", user.uid, "shortlist", "state");
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return { savedIds: [], compareIds: [] };
    }
    const data = snap.data() as Partial<CloudShortlist>;
    return {
      savedIds: sanitizeIdList(data.savedIds, 50),
      compareIds: sanitizeIdList(data.compareIds, 3),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

async function saveCloudShortlist(
  user: User,
  shortlist: CloudShortlist,
): Promise<CloudShortlist> {
  const path = `users/${user.uid}/shortlist/state`;
  const ref = doc(db, "users", user.uid, "shortlist", "state");
  const clean: CloudShortlist = {
    savedIds: sanitizeIdList(shortlist.savedIds, 50),
    compareIds: sanitizeIdList(shortlist.compareIds, 3),
  };
  try {
    await setDoc(ref, {
      uid: user.uid,
      savedIds: clean.savedIds,
      compareIds: clean.compareIds,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
  return clean;
}

// --- UI wiring across pages ---
let activeUser: User | null = null;
let shortlistSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastKnownDisplayName = "Student";

function showAuthFeedback(message: string, isError = true): void {
  const box = document.querySelector<HTMLElement>("[data-firebase-auth-error]");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("error", isError);
  box.classList.toggle("success", !isError);
  box.hidden = !message;
}

async function triggerGoogleSignIn(button: HTMLButtonElement): Promise<void> {
  const originalLabel = button.textContent || "Continue with Google";
  button.disabled = true;
  button.textContent = "Opening Google sign-in…";
  showAuthFeedback("", false);

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const credential = await signInWithPopup(auth, provider);
    await ensureCloudProfile(credential.user);
    const nextAttr = button.dataset.next || "/cloud-profile";
    const destination = isSafeRedirect(nextAttr);
    if (window.location.pathname !== destination) {
      window.location.assign(destination);
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "auth/popup-closed-by-user") {
      showAuthFeedback("Google sign-in was cancelled. You can try again anytime.");
    } else if (code === "auth/popup-blocked") {
      showAuthFeedback(
        "Your browser blocked the sign-in pop-up. Allow pop-ups for this page and try again.",
      );
    } else {
      showAuthFeedback(
        "Could not complete Google sign-in right now. Please try again.",
      );
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function extractAvatarInitial(name: string | null, fallback = "G"): string {
  const cleaned = String(name || "").trim();
  const match = cleaned.match(/[A-Za-z0-9]/);
  return match ? match[0].toUpperCase() : fallback;
}

function updateHeaderLinksForCloudUser(displayName: string | null): void {
  // Never overwrite an active server-rendered local Express session
  const bodyAccount = document.body.dataset.account;
  if (bodyAccount && bodyAccount !== "guest") return;

  const isSignedIn = Boolean(displayName);
  document
    .querySelectorAll<HTMLElement>("[data-cloud-signed-in]")
    .forEach((el) => {
      el.hidden = !isSignedIn;
    });
  document
    .querySelectorAll<HTMLElement>("[data-cloud-signed-out]")
    .forEach((el) => {
      el.hidden = isSignedIn;
    });
  const initial = isSignedIn ? extractAvatarInitial(displayName, "S") : "G";
  document
    .querySelectorAll<HTMLElement>("[data-cloud-avatar]")
    .forEach((el) => {
      el.textContent = initial;
    });
  if (displayName) {
    document
      .querySelectorAll<HTMLElement>("[data-cloud-display-name]")
      .forEach((el) => {
        el.textContent = displayName;
      });
  }
}

function updateAdminLinksVisibility(isAdmin: boolean): void {
  document
    .querySelectorAll<HTMLElement>("[data-cloud-admin-only]")
    .forEach((el) => {
      el.hidden = !isAdmin;
    });
}

let liveCatalogRecords: CatalogUniversityRecord[] = [];

declare global {
  interface Window {
    __unimatchLiveCatalog?: {
      records: CatalogUniversityRecord[];
      detailsById: Map<string, ReturnType<typeof catalogRecordToExplorerDetail>>;
      scoreRecommendations: typeof scoreLiveCatalogRecommendations;
    };
  }
}

async function hydratePublishedCatalog(): Promise<void> {
  try {
    const [firestoreRecords, baselineRecords] = await Promise.all([
      loadPublishedCatalogUniversities(db, (error, op, path) =>
        handleFirestoreError(error, op as unknown as OperationType, path),
      ),
      fetch("/api/catalog-baseline", { headers: { Accept: "application/json" } })
        .then(async (resp) => {
          if (!resp.ok) return [] as CatalogUniversityRecord[];
          const payload = (await resp.json()) as { items?: CatalogUniversityRecord[] };
          return Array.isArray(payload.items) ? payload.items : [];
        })
        .catch(() => [] as CatalogUniversityRecord[]),
    ]);
    const records = mergeLiveAndBaselineCatalog(firestoreRecords, baselineRecords);
    liveCatalogRecords = records;
    const detailsById = new Map(
      records.map((r) => [r.id, catalogRecordToExplorerDetail(r)]),
    );
    window.__unimatchLiveCatalog = {
      records,
      detailsById,
      scoreRecommendations: scoreLiveCatalogRecommendations,
    };
    window.dispatchEvent(
      new CustomEvent("unimatch:catalog-updated", {
        detail: { count: records.length },
      }),
    );
  } catch {
    // Public catalog gracefully falls back to baseline API if Firestore has not been seeded yet
  }
}

interface RecommendationItem {
  university_id: string;
  university_name: string;
  short_name: string;
  campus_location: string;
  program_name: string;
  topic: string;
  score: number;
  explanations: Array<{
    label: string;
    reason: string;
    status: string;
  }>;
}

async function refreshCloudRecommendations(
  prefs: CloudPreferences,
): Promise<void> {
  const container = document.getElementById("cloud-match-results");
  const countPill = document.getElementById("cloud-match-count");
  if (!container) return;

  const hasAny =
    Boolean(prefs.program) ||
    Boolean(prefs.city) ||
    Boolean(prefs.sector) ||
    prefs.budget !== null;
  if (!hasAny) {
    if (countPill) countPill.hidden = true;
    container.innerHTML =
      '<p class="account-empty">Save at least one preference — program, city, budget or university type — to see personalised matches.</p>';
    return;
  }

  container.innerHTML =
    '<p class="account-help">Refreshing your personalised matches…</p>';
  const url = new URL("/api/recommendations", window.location.origin);
  if (prefs.program) url.searchParams.set("program", prefs.program);
  if (prefs.city) url.searchParams.set("city", prefs.city);
  if (prefs.sector) url.searchParams.set("sector", prefs.sector);
  if (prefs.budget !== null) {
    url.searchParams.set("budget", String(prefs.budget));
    url.searchParams.set("budget_basis", prefs.budgetBasis);
  }
  url.searchParams.set("limit", "10");
  url.searchParams.set(
    "weights",
    Object.entries(prefs.weights)
      .map(([k, v]) => `${k}:${v}`)
      .join(","),
  );

  try {
    let data: {
      total: number;
      items: RecommendationItem[];
    };
    if (liveCatalogRecords.length > 0) {
      const scored = scoreLiveCatalogRecommendations(
        liveCatalogRecords,
        {
          program: prefs.program,
          city: prefs.city,
          sector: prefs.sector,
          budget: prefs.budget,
          budget_basis: prefs.budget !== null ? prefs.budgetBasis : null,
        },
        prefs.weights,
        10,
      );
      data = {
        total: scored.total,
        items: scored.items as unknown as RecommendationItem[],
      };
    } else {
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        throw new Error("Could not load recommendations right now.");
      }
      data = (await resp.json()) as {
        total: number;
        items: RecommendationItem[];
      };
    }
    if (countPill) {
      countPill.textContent = `${data.total} scored matches`;
      countPill.hidden = false;
    }
    if (!data.items || !data.items.length) {
      container.innerHTML =
        '<p class="account-empty">No collected records matched those filters yet. Try a broader program keyword or location.</p>';
      return;
    }

    const groups = new Map<
      string,
      {
        university_name: string;
        campus_location: string;
        items: Array<RecommendationItem & { rank: number }>;
      }
    >();
    data.items.forEach((item, index) => {
      const key = item.university_id || item.university_name;
      if (!groups.has(key)) {
        groups.set(key, {
          university_name: item.university_name,
          campus_location: item.campus_location,
          items: [],
        });
      }
      groups.get(key)!.items.push({ ...item, rank: index + 1 });
    });

    const groupsHtml = [...groups.values()]
      .map(
        (group) => `
        <section class="account-match-group">
          <header class="account-match-group-head">
            <div>
              <h3>${escapeHTML(group.university_name)}</h3>
              <p>${escapeHTML(group.campus_location || "Campus not available")}</p>
            </div>
            <span class="account-pill">${group.items.length} program${group.items.length === 1 ? "" : "s"}</span>
          </header>
          <ol class="account-match-list">
            ${group.items
              .map(
                (item) => `
              <li class="account-match">
                <div class="account-match-head">
                  <div>
                    <h4>${escapeHTML(item.program_name || "All collected programs at this university")}</h4>
                    <p>#${item.rank} overall${item.topic ? ` · ${escapeHTML(item.topic)}` : ""}</p>
                  </div>
                  <strong class="account-score">${escapeHTML(item.score)}<span>/100</span></strong>
                </div>
                <details>
                  <summary>Why this match?</summary>
                  <ul>
                    ${(item.explanations || [])
                      .map(
                        (ex) =>
                          `<li><strong>${escapeHTML(ex.label)}:</strong> ${escapeHTML(ex.reason)} <span class="account-status">${escapeHTML(String(ex.status || "").replace(/_/g, " "))}</span></li>`,
                      )
                      .join("")}
                  </ul>
                </details>
              </li>`,
              )
              .join("")}
          </ol>
        </section>`,
      )
      .join("");

    container.innerHTML = `<p class="account-help">Grouped by university and ranked with the custom stable merge sort. Scores measure fit against your saved preferences, not admission chances.</p><div class="account-match-groups">${groupsHtml}</div>`;
  } catch (err) {
    container.innerHTML = `<p class="account-alert error" role="alert">${escapeHTML(err instanceof Error ? err.message : "Could not load recommendations.")}</p>`;
  }
}

async function hydrateCloudProfilePage(user: User): Promise<void> {
  const signedOutSection = document.getElementById("cloud-signed-out");
  const signedInSection = document.getElementById("cloud-signed-in");
  const loadingNotice = document.getElementById("cloud-loading");
  if (!signedOutSection || !signedInSection) return;

  if (loadingNotice) loadingNotice.hidden = false;
  try {
    const [profile, prefs, shortlist] = await Promise.all([
      ensureCloudProfile(user),
      loadCloudPreferences(user),
      loadCloudShortlist(user),
    ]);
    lastKnownDisplayName = profile.displayName;
    updateHeaderLinksForCloudUser(profile.displayName);

    const greeting = document.getElementById("cloud-greeting-name");
    if (greeting) greeting.textContent = profile.displayName;

    const nameInput = document.getElementById(
      "cloud-display-name",
    ) as HTMLInputElement | null;
    const emailInput = document.getElementById(
      "cloud-email",
    ) as HTMLInputElement | null;
    if (nameInput) nameInput.value = profile.displayName;
    if (emailInput) emailInput.value = profile.email;

    const setVal = (id: string, val: string) => {
      const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLSelectElement
        | null;
      if (el) el.value = val;
    };
    setVal("cloud-pref-program", prefs.program);
    setVal("cloud-pref-city", prefs.city);
    setVal("cloud-pref-sector", prefs.sector);
    setVal(
      "cloud-pref-budget",
      prefs.budget !== null ? String(prefs.budget) : "",
    );
    setVal("cloud-pref-basis", prefs.budgetBasis);
    setVal(
      "cloud-weight-program",
      String(Math.round(prefs.weights.program * 100)),
    );
    setVal(
      "cloud-weight-location",
      String(Math.round(prefs.weights.location * 100)),
    );
    setVal(
      "cloud-weight-budget",
      String(Math.round(prefs.weights.budget * 100)),
    );
    setVal(
      "cloud-weight-sector",
      String(Math.round(prefs.weights.sector * 100)),
    );

    const savedSummary = document.getElementById("cloud-saved-count");
    const compareSummary = document.getElementById("cloud-compare-count");
    if (savedSummary) savedSummary.textContent = String(shortlist.savedIds.length);
    if (compareSummary) {
      compareSummary.textContent = String(shortlist.compareIds.length);
    }

    signedOutSection.hidden = true;
    signedInSection.hidden = false;
    await refreshCloudRecommendations(prefs);
  } catch {
    showAuthFeedback(
      "Could not load your saved cloud profile. Please check your connection and reload.",
    );
  } finally {
    if (loadingNotice) loadingNotice.hidden = true;
  }
}

function wireCloudProfileForms(): void {
  const profileForm = document.getElementById(
    "cloud-profile-form",
  ) as HTMLFormElement | null;
  const prefsForm = document.getElementById(
    "cloud-preferences-form",
  ) as HTMLFormElement | null;
  const signOutBtn = document.getElementById(
    "cloud-signout-btn",
  ) as HTMLButtonElement | null;

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeUser) return;
    const nameInput = document.getElementById(
      "cloud-display-name",
    ) as HTMLInputElement | null;
    try {
      const updated = await saveCloudProfileName(
        activeUser,
        nameInput?.value || "",
      );
      lastKnownDisplayName = updated.displayName;
      const greeting = document.getElementById("cloud-greeting-name");
      if (greeting) greeting.textContent = updated.displayName;
      updateHeaderLinksForCloudUser(updated.displayName);
      showAuthFeedback("Profile display name saved to your account.", false);
    } catch (err) {
      showAuthFeedback(
        err instanceof Error ? err.message : "Could not save profile changes.",
      );
    }
  });

  prefsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeUser) return;
    const val = (id: string) =>
      (
        document.getElementById(id) as
          | HTMLInputElement
          | HTMLSelectElement
          | null
      )?.value || "";

    const rawBudget = val("cloud-pref-budget").trim();
    const budget = rawBudget === "" ? null : Number(rawBudget);
    if (
      budget !== null &&
      (!Number.isFinite(budget) || budget < 0 || budget > 10_000_000)
    ) {
      showAuthFeedback("Budget must be between 0 and 10,000,000 PHP.");
      return;
    }

    try {
      const saved = await saveCloudPreferences(activeUser, {
        program: val("cloud-pref-program"),
        city: val("cloud-pref-city"),
        sector: val("cloud-pref-sector") as "" | "Public" | "Private",
        budget,
        budgetBasis: val("cloud-pref-basis") as
          | "semester"
          | "trimester"
          | "year"
          | "unit",
        weights: {
          program: Number(val("cloud-weight-program") || 45) / 100,
          location: Number(val("cloud-weight-location") || 20) / 100,
          budget: Number(val("cloud-weight-budget") || 20) / 100,
          sector: Number(val("cloud-weight-sector") || 15) / 100,
        },
      });
      showAuthFeedback(
        "Preferences saved to cloud storage. Your matches have been refreshed.",
        false,
      );
      await refreshCloudRecommendations(saved);
    } catch {
      showAuthFeedback("Could not save preferences. Please try again.");
    }
  });

  signOutBtn?.addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.assign("/");
    } catch {
      showAuthFeedback("Could not sign out right now. Please try again.");
    }
  });
}

function wireExploreShortlistSync(): void {
  window.addEventListener("unimatch:shortlist-changed", (event: Event) => {
    if (!activeUser) return;
    const custom = event as CustomEvent<{
      saved?: string[];
      compare?: string[];
    }>;
    const savedIds = sanitizeIdList(custom.detail?.saved || [], 50);
    const compareIds = sanitizeIdList(custom.detail?.compare || [], 3);
    if (shortlistSyncTimer) clearTimeout(shortlistSyncTimer);
    const user = activeUser;
    shortlistSyncTimer = setTimeout(() => {
      void saveCloudShortlist(user, { savedIds, compareIds }).catch(() => {
        // Error already logged by handleFirestoreError
      });
    }, 350);
  });
}

function wireGoogleButtons(): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-firebase-google-signin]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        void triggerGoogleSignIn(button);
      });
    });
}

function boot(): void {
  wireGoogleButtons();
  wireCloudProfileForms();
  wireExploreShortlistSync();

  const isAdminPage = Boolean(document.getElementById("admin-workspace"));
  const adminController = isAdminPage
    ? new AdminCatalogController(db, auth, (error, op, path) =>
        handleFirestoreError(
          error,
          (op as unknown as OperationType) || OperationType.WRITE,
          path,
        ),
      )
    : null;

  if (!isAdminPage) {
    void hydratePublishedCatalog();
  }

  onAuthStateChanged(auth, async (user) => {
    activeUser = user;
    const isCloudProfilePage = Boolean(
      document.getElementById("cloud-signed-in"),
    );

    if (!user) {
      updateHeaderLinksForCloudUser(null);
      updateAdminLinksVisibility(false);
      if (adminController) {
        await adminController.onAuthChanged(null);
      }
      if (isCloudProfilePage) {
        const signedOutSection = document.getElementById("cloud-signed-out");
        const signedInSection = document.getElementById("cloud-signed-in");
        const loadingNotice = document.getElementById("cloud-loading");
        if (loadingNotice) loadingNotice.hidden = true;
        if (signedInSection) signedInSection.hidden = true;
        if (signedOutSection) signedOutSection.hidden = false;
      }
      return;
    }

    const isAdmin = await verifyAdminAccess(db, user);
    updateAdminLinksVisibility(isAdmin);

    if (adminController) {
      await adminController.onAuthChanged(user);
      try {
        const profile = await ensureCloudProfile(user);
        lastKnownDisplayName = profile.displayName;
        updateHeaderLinksForCloudUser(profile.displayName);
      } catch {
        updateHeaderLinksForCloudUser(
          sanitizeDisplayName(user.displayName || user.email?.split("@")[0] || "Admin"),
        );
      }
      return;
    }

    if (isCloudProfilePage) {
      await hydrateCloudProfilePage(user);
      return;
    }

    try {
      const [profile, shortlist, prefs] = await Promise.all([
        ensureCloudProfile(user),
        loadCloudShortlist(user),
        loadCloudPreferences(user),
      ]);
      lastKnownDisplayName = profile.displayName;
      updateHeaderLinksForCloudUser(profile.displayName);
      window.dispatchEvent(
        new CustomEvent("unimatch:cloud-hydrate", {
          detail: {
            uid: user.uid,
            displayName: lastKnownDisplayName,
            savedIds: shortlist.savedIds,
            compareIds: shortlist.compareIds,
            preferences: prefs,
          },
        }),
      );
    } catch {
      updateHeaderLinksForCloudUser(
        sanitizeDisplayName(user.displayName || user.email?.split("@")[0] || "Student"),
      );
    }
  });
}

void CatalogOpType;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
