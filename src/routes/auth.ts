/**
 * Student registration, login, 2FA, password recovery and profile routes.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { hydratePgUserIntoStore } from "../accountPersistence.js";
import {
  AccountConflictError,
  AccountError,
  authenticate,
  beginTotpSetup,
  changePassword,
  createUserAsync,
  disableTotp,
  enableTotp,
  findUserByEmail,
  findUserByEmailAsync,
  getPreferences,
  getProfile,
  getTotpState,
  getUser,
  hasPreferences,
  recommendationPreferences,
  registerOrVerifyGoogleAccount,
  resetPassword as applyPasswordReset,
  savePreferences,
  updateProfile,
  verifySecondFactor,
} from "../accounts.js";
import { dbFindUserByEmail, isPostgresSchemaReady } from "../db/postgres.js";
import { adminAuth } from "../lib/firebaseAdmin.js";
import {
  isBrevoConfigured,
  sendGoogleSignInReminderEmail,
  sendPasswordResetEmail,
} from "../mailer.js";
import {
  DecryptionError,
  IS_PRODUCTION,
  decryptPii,
  isCsrfValid,
  isSafeNextUrl,
  loadResetToken,
  makeResetToken,
  normalizeEmail,
  refreshCsrfToken,
} from "../security.js";
import { isBootstrappedAdminEmail, rankedRecommendations } from "../store.js";
import {
  SlidingFixedWindowLimiter,
  createRateLimitMiddleware,
} from "../securityHardening.js";

export const authRouter = express.Router();

const loginRateLimiter = new SlidingFixedWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "auth-login",
});

const registerRateLimiter = new SlidingFixedWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "auth-register",
});

const resetRateLimiter = new SlidingFixedWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyPrefix: "auth-reset",
});

function rateLimitMessage(retryAfterSeconds: number): string {
  const mins = Math.ceil(retryAfterSeconds / 60);
  return mins > 1
    ? `Too many attempts from this device. Please wait about ${mins} minutes and try again.`
    : `Too many attempts from this device. Please wait ${retryAfterSeconds} seconds and try again.`;
}

export function pushFlash(
  req: Request,
  message: string,
  category: "success" | "error" = "success",
): void {
  if (!req.session.flashes) req.session.flashes = [];
  req.session.flashes.push({ category, message });
}

export function consumeFlashes(
  req: Request,
): Array<{ category: string; message: string }> {
  const flashes = req.session.flashes ?? [];
  req.session.flashes = [];
  return flashes;
}

function loginRequired(req: Request, res: Response, next: NextFunction) {
  if (!res.locals.currentUser) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const nextParam = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${nextParam}`);
  }
  return next();
}

function nextUrl(req: Request, fallback = "/profile"): string {
  const requested =
    (typeof req.body?.next === "string" && req.body.next) ||
    (typeof req.query?.next === "string" && req.query.next) ||
    "";
  return isSafeNextUrl(requested) ? requested : fallback;
}

function clearAuthSession(req: Request) {
  delete req.session.userId;
  delete req.session.sessionVersion;
  delete req.session.pending2faUserId;
  delete req.session.pending2faNext;
  delete req.session.pending2faAttempts;
  delete req.session.pendingTotpSetup;
  delete req.session.newRecoveryCodes;
}

function saveAndRedirect(req: Request, res: Response, location: string) {
  req.session.save(() => {
    res.redirect(location);
  });
}

function regenerateAndRedirect(
  req: Request,
  res: Response,
  populate: () => void,
  location: string,
) {
  req.session.regenerate((err) => {
    if (err) {
      clearAuthSession(req);
    }
    populate();
    refreshCsrfToken(req);
    saveAndRedirect(req, res, location);
  });
}

function buildProfileContext(req: Request, res: Response, error?: string | null) {
  const userId = res.locals.currentUser.id as string;
  const preferences = getPreferences(userId);
  let profileData = null;
  let errMsg = error ?? null;
  try {
    profileData = getProfile(userId);
  } catch (err) {
    if (err instanceof DecryptionError) {
      errMsg = errMsg || err.message;
    }
  }

  let recommendations = null;
  let recommendationGroups = null;
  if (hasPreferences(preferences) && !errMsg) {
    recommendations = rankedRecommendations(
      recommendationPreferences(preferences),
      preferences.weights,
      10,
    );
    const groups: Array<{
      university_id: string;
      university_name: string;
      short_name: string;
      campus_location: string;
      items: Array<Record<string, unknown>>;
    }> = [];
    const indexMap = new Map<string, number>();
    recommendations.items.forEach((item, idx) => {
      const key = item.university_id || item.university_name;
      let groupIdx = indexMap.get(key);
      if (groupIdx === undefined) {
        groupIdx = groups.length;
        indexMap.set(key, groupIdx);
        groups.push({
          university_id: item.university_id,
          university_name: item.university_name,
          short_name: item.short_name,
          campus_location: item.campus_location,
          items: [],
        });
      }
      groups[groupIdx].items.push({ ...item, rank: idx + 1 });
    });
    recommendationGroups = groups;
  }

  const recoveryCodes = req.session.newRecoveryCodes ?? null;
  delete req.session.newRecoveryCodes;

  return {
    title: "My profile",
    profile: profileData,
    preferences,
    recommendations,
    recommendation_groups: recommendationGroups,
    totp: getTotpState(userId),
    totp_setup: req.session.pendingTotpSetup ?? null,
    recovery_codes: recoveryCodes,
    error: errMsg,
    flashes: consumeFlashes(req),
  };
}

authRouter.get("/login", (req, res) => {
  if (res.locals.currentUser) {
    return res.redirect(
      res.locals.currentUser.role === "admin" ? "/admin/dashboard" : "/profile",
    );
  }
  return res.render("login", {
    title: "Log in",
    next_url: nextUrl(req, ""),
    email: "",
    error: null,
    flashes: consumeFlashes(req),
  });
});

const loginLimitMiddleware = createRateLimitMiddleware(
  loginRateLimiter,
  (req, res, result) => {
    return res.status(429).render("login", {
      title: "Log in",
      error: rateLimitMessage(result.retryAfterSeconds),
      email: String(req.body?.email ?? ""),
      next_url: nextUrl(req, "/profile"),
      flashes: consumeFlashes(req),
    });
  },
);

authRouter.post("/login", loginLimitMiddleware, async (req, res) => {
  if (!isCsrfValid(req)) {
    return res.status(400).render("login", {
      title: "Log in",
      error: "Your session expired. Reload the page and try again.",
      email: String(req.body?.email ?? ""),
      next_url: nextUrl(req, "/profile"),
      flashes: consumeFlashes(req),
    });
  }
  const identifier = String(req.body?.email ?? req.body?.identifier ?? "");
  const password = String(req.body?.password ?? "");
  if (identifier.includes("@")) {
    await findUserByEmailAsync(identifier);
  }
  let user;
  try {
    user = authenticate(identifier, password);
  } catch (err) {
    return res.status(401).render("login", {
      title: "Log in",
      error: (err as Error).message,
      email: identifier,
      next_url: nextUrl(req, ""),
      flashes: consumeFlashes(req),
    });
  }

  const defaultTarget = user.role === "admin" ? "/admin/dashboard" : "/profile";
  const target = nextUrl(req, defaultTarget);
  if (user.totp_enabled) {
    return regenerateAndRedirect(
      req,
      res,
      () => {
        req.session.pending2faUserId = user.id;
        req.session.pending2faNext = target;
        req.session.pending2faAttempts = 0;
      },
      "/login/2fa",
    );
  }

  return regenerateAndRedirect(
    req,
    res,
    () => {
      req.session.userId = user.id;
      req.session.sessionVersion = user.session_version;
      pushFlash(req, "Welcome back.", "success");
    },
    target,
  );
});

authRouter.get("/login/2fa", (req, res) => {
  if (!req.session.pending2faUserId) return res.redirect("/login");
  return res.render("two_factor", {
    title: "Two-factor authentication",
    error: null,
    flashes: consumeFlashes(req),
  });
});

const twoFaLimitMiddleware = createRateLimitMiddleware(
  loginRateLimiter,
  (req, res, result) => {
    return res.status(429).render("two_factor", {
      title: "Two-factor authentication",
      error: rateLimitMessage(result.retryAfterSeconds),
      flashes: consumeFlashes(req),
    });
  },
);

authRouter.post("/login/2fa", twoFaLimitMiddleware, (req, res) => {
  const pending = req.session.pending2faUserId;
  if (!pending) return res.redirect("/login");
  if (!isCsrfValid(req)) {
    return res.status(400).render("two_factor", {
      title: "Two-factor authentication",
      error: "Your session expired. Reload the page and try again.",
      flashes: consumeFlashes(req),
    });
  }
  const code = String(req.body?.code ?? "");
  if (!verifySecondFactor(pending, code)) {
    const attempts = (req.session.pending2faAttempts ?? 0) + 1;
    req.session.pending2faAttempts = attempts;
    if (attempts >= 5) {
      clearAuthSession(req);
      pushFlash(req, "Too many invalid codes. Please log in again.", "error");
      return saveAndRedirect(req, res, "/login");
    }
    return res.status(401).render("two_factor", {
      title: "Two-factor authentication",
      error:
        "That code is not valid. Check your authenticator app or use a recovery code.",
      flashes: consumeFlashes(req),
    });
  }

  const row = getUser(pending);
  if (!row || !row.is_active) {
    clearAuthSession(req);
    return saveAndRedirect(req, res, "/login");
  }

  const target = req.session.pending2faNext || "/profile";
  return regenerateAndRedirect(
    req,
    res,
    () => {
      req.session.userId = row.id;
      req.session.sessionVersion = row.session_version;
      pushFlash(req, "Welcome back.", "success");
    },
    isSafeNextUrl(target) ? target : "/profile",
  );
});

authRouter.get("/register", (req, res) => {
  if (res.locals.currentUser) return res.redirect("/profile");
  return res.render("register", {
    title: "Create account",
    next_url: nextUrl(req, "/profile"),
    email: "",
    display_name: "",
    error: null,
    flashes: consumeFlashes(req),
  });
});

const registerLimitMiddleware = createRateLimitMiddleware(
  registerRateLimiter,
  (req, res, result) => {
    return res.status(429).render("register", {
      title: "Create account",
      error: rateLimitMessage(result.retryAfterSeconds),
      email: String(req.body?.email ?? ""),
      display_name: String(req.body?.display_name ?? ""),
      next_url: nextUrl(req, "/profile"),
      flashes: consumeFlashes(req),
    });
  },
);

authRouter.post("/register", registerLimitMiddleware, async (req, res) => {
  const target = nextUrl(req, "/profile");
  if (!isCsrfValid(req)) {
    return res.status(400).render("register", {
      title: "Create account",
      error: "Your session expired. Reload the page and try again.",
      email: String(req.body?.email ?? ""),
      display_name: String(req.body?.display_name ?? ""),
      next_url: target,
      flashes: consumeFlashes(req),
    });
  }
  const email = String(req.body?.email ?? "");
  const displayName = String(req.body?.display_name ?? "");
  const password = String(req.body?.password ?? "");
  const confirmation = String(req.body?.password_confirm ?? "");

  if (password !== confirmation) {
    return res.status(400).render("register", {
      title: "Create account",
      error: "Passwords do not match.",
      email,
      display_name: displayName,
      next_url: target,
      flashes: consumeFlashes(req),
    });
  }

  let user;
  try {
    user = await createUserAsync(email, password, displayName);
  } catch (err) {
    const statusCode =
      err instanceof AccountConflictError
        ? 409
        : err instanceof AccountError
          ? err.statusCode
          : 400;
    return res.status(statusCode).render("register", {
      title: "Create account",
      error: (err as Error).message,
      email,
      display_name: displayName,
      next_url: target,
      flashes: consumeFlashes(req),
    });
  }

  return regenerateAndRedirect(
    req,
    res,
    () => {
      req.session.userId = user.id;
      req.session.sessionVersion = 0;
      pushFlash(
        req,
        "Your account is ready. Add your preferences below.",
        "success",
      );
    },
    target,
  );
});

const googleSyncLimitMiddleware = createRateLimitMiddleware(loginRateLimiter);

authRouter.post(
  "/api/auth/google-sync",
  googleSyncLimitMiddleware,
  async (req, res) => {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Google sign-in authorization token is required." });
    }
    const token = header.slice(7).trim();
    if (!token || token.length > 8192) {
      return res.status(401).json({ error: "Invalid authorization token." });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch {
      return res.status(401).json({
        error: "Your Google sign-in token could not be verified. Please try again.",
      });
    }

    const email = typeof decoded.email === "string" ? decoded.email.trim() : "";
    if (!email) {
      return res.status(400).json({
        error: "Your Google account did not provide a valid email address.",
      });
    }

    try {
      const account = await registerOrVerifyGoogleAccount({
        firebaseUid: decoded.uid,
        email,
        displayName:
          typeof decoded.name === "string" ? decoded.name : undefined,
      });
      return res.json({ ok: true, account });
    } catch (err) {
      if (err instanceof AccountConflictError) {
        return res.status(409).json({
          code: "AUTH_PROVIDER_CONFLICT",
          provider: err.existingProvider,
          error: err.message,
        });
      }
      if (err instanceof AccountError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error("[auth] Failed to sync Google account:", err);
      return res.status(500).json({
        error: "Could not verify your account right now. Please try again.",
      });
    }
  },
);

authRouter.post("/logout", loginRequired, (req, res) => {
  if (!isCsrfValid(req)) {
    return res.status(400).send("Invalid or missing CSRF token");
  }
  clearAuthSession(req);
  refreshCsrfToken(req);
  pushFlash(req, "You have been logged out.", "success");
  return saveAndRedirect(req, res, "/");
});

authRouter.get("/forgot-password", (req, res) => {
  if (res.locals.currentUser) return res.redirect("/profile");
  return res.render("forgot_password", {
    title: "Forgot password",
    submitted: false,
    dev_reset_link: null,
    error: null,
    flashes: consumeFlashes(req),
  });
});

const forgotLimitMiddleware = createRateLimitMiddleware(
  resetRateLimiter,
  (req, res, result) => {
    return res.status(429).render("forgot_password", {
      title: "Forgot password",
      submitted: false,
      dev_reset_link: null,
      error: rateLimitMessage(result.retryAfterSeconds),
      flashes: consumeFlashes(req),
    });
  },
);

function buildBaseOrigin(req: Request): string {
  const fwdProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = fwdProto || req.protocol || "https";
  const fwdHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = fwdHost || String(req.headers.host || "localhost:3000").trim();
  return `${proto}://${host}`;
}

function buildAbsoluteResetUrl(req: Request, token: string): string {
  return `${buildBaseOrigin(req)}/reset-password/${encodeURIComponent(token)}`;
}

function buildAbsoluteLoginUrl(req: Request): string {
  return `${buildBaseOrigin(req)}/login`;
}

authRouter.post("/forgot-password", forgotLimitMiddleware, async (req, res) => {
  if (!isCsrfValid(req)) {
    return res.status(400).render("forgot_password", {
      title: "Forgot password",
      submitted: false,
      dev_reset_link: null,
      error: "Your session expired. Reload the page and try again.",
      flashes: consumeFlashes(req),
    });
  }

  const rawEmail = String(req.body?.email ?? "");
  let devResetLink: string | null = null;
  let normalizedEmail = "";
  try {
    normalizedEmail = normalizeEmail(rawEmail);
  } catch {
    console.log(
      "[forgot-password] Step 1: Submitted email is blank or invalid format; returning neutral response.",
    );
    return res.render("forgot_password", {
      title: "Forgot password",
      submitted: true,
      dev_reset_link: null,
      error: null,
      flashes: consumeFlashes(req),
    });
  }

  const postgresReady = isPostgresSchemaReady();
  let foundInPostgres = false;
  let row = undefined;

  if (postgresReady) {
    try {
      const pgRow = await dbFindUserByEmail(normalizedEmail);
      if (pgRow) {
        foundInPostgres = true;
        row = hydratePgUserIntoStore(pgRow);
      }
      console.log("[forgot-password] Step 1: PostgreSQL user lookup completed:", {
        email: normalizedEmail,
        postgresReady: true,
        foundInPostgres,
        authProvider: row?.auth_provider ?? null,
        isActive: row?.is_active ?? null,
      });
    } catch (err) {
      console.error("[forgot-password] Step 1: PostgreSQL lookup failed:", {
        email: normalizedEmail,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    console.log("[forgot-password] Step 1: PostgreSQL not active; checking in-memory store.", {
      email: normalizedEmail,
      postgresReady: false,
    });
  }

  if (!row) {
    row = findUserByEmail(normalizedEmail);
    if (row) {
      console.log("[forgot-password] Step 1b: User found in local account store:", {
        email: normalizedEmail,
        authProvider: row.auth_provider,
        isActive: row.is_active,
      });
    }
  }

  const isBootstrappedGoogle = isBootstrappedAdminEmail(normalizedEmail);
  const isGoogleOnlyAccount =
    (Boolean(row) && row!.is_active && row!.auth_provider === "google") ||
    (!row && isBootstrappedGoogle);

  if (isGoogleOnlyAccount) {
    let displayName = "Primary Google Admin";
    if (row) {
      try {
        displayName = decryptPii(row.display_name_encrypted) || "there";
      } catch {
        displayName = "there";
      }
    }
    console.log("[forgot-password] Step 2: Account is Google-only; sending Google Sign-In guidance email via Brevo.", {
      email: normalizedEmail,
      foundInPostgres,
      isBootstrappedGoogle,
      brevoConfigured: isBrevoConfigured(),
    });
    const loginUrl = buildAbsoluteLoginUrl(req);
    const delivery = await sendGoogleSignInReminderEmail({
      to: normalizedEmail,
      displayName,
      loginUrl,
    });
    console.log("[forgot-password] Step 3: Brevo response for Google Sign-In reminder:", {
      email: normalizedEmail,
      ok: delivery.ok,
      configured: delivery.configured,
      status: delivery.status ?? null,
      responseBody: delivery.responseBody ?? null,
      error: delivery.error ?? null,
    });
  } else if (row && row.is_active && row.auth_provider === "local") {
    let address = normalizedEmail;
    let displayName = "";
    try {
      address = decryptPii(row.email_encrypted) || normalizedEmail;
      displayName = decryptPii(row.display_name_encrypted);
    } catch {
      address = normalizedEmail;
    }
    const token = makeResetToken(row.id, row.session_version);
    console.log("[forgot-password] Step 2: Active local email/password account found; sending password reset link via Brevo.", {
      email: address,
      foundInPostgres,
      authProvider: row.auth_provider,
      brevoConfigured: isBrevoConfigured(),
    });
    if (isBrevoConfigured()) {
      const resetUrl = buildAbsoluteResetUrl(req, token);
      const delivery = await sendPasswordResetEmail({
        to: address,
        displayName,
        resetUrl,
      });
      console.log("[forgot-password] Step 3: Brevo response for password reset email:", {
        email: address,
        ok: delivery.ok,
        configured: delivery.configured,
        status: delivery.status ?? null,
        responseBody: delivery.responseBody ?? null,
        error: delivery.error ?? null,
      });
    } else if (!IS_PRODUCTION) {
      console.log(
        "[forgot-password] Step 3: BREVO_API_KEY not configured in development mode; exposing local dev_reset_link.",
      );
      devResetLink = `/reset-password/${encodeURIComponent(token)}`;
    } else {
      console.warn(
        "[forgot-password] Step 3: BREVO_API_KEY is not configured in production; password reset email was not sent.",
      );
    }
  } else {
    console.log("[forgot-password] Step 2: No active account matched; skipping email delivery.", {
      email: normalizedEmail,
      foundInPostgres,
      foundInactive: Boolean(row && !row.is_active),
    });
  }

  return res.render("forgot_password", {
    title: "Forgot password",
    submitted: true,
    dev_reset_link: devResetLink,
    error: null,
    flashes: consumeFlashes(req),
  });
});

authRouter.get("/reset-password/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  let data;
  try {
    data = loadResetToken(token);
  } catch (err) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      error: (err as Error).message,
      token: null,
      flashes: consumeFlashes(req),
    });
  }
  const row = getUser(data.user_id);
  if (!row || row.session_version !== data.session_version) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      error: "This reset link is no longer valid. Request a new one.",
      token: null,
      flashes: consumeFlashes(req),
    });
  }
  return res.render("reset_password", {
    title: "Reset password",
    error: null,
    token,
    flashes: consumeFlashes(req),
  });
});

const resetLimitMiddleware = createRateLimitMiddleware(
  resetRateLimiter,
  (req, res, result) => {
    return res.status(429).render("reset_password", {
      title: "Reset password",
      token: String(req.params.token ?? ""),
      error: rateLimitMessage(result.retryAfterSeconds),
      flashes: consumeFlashes(req),
    });
  },
);

authRouter.post("/reset-password/:token", resetLimitMiddleware, (req, res) => {
  const token = String(req.params.token ?? "");
  if (!isCsrfValid(req)) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      token,
      error: "Your session expired. Reload the page and try again.",
      flashes: consumeFlashes(req),
    });
  }
  let data;
  try {
    data = loadResetToken(token);
  } catch (err) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      token: null,
      error: (err as Error).message,
      flashes: consumeFlashes(req),
    });
  }
  const row = getUser(data.user_id);
  if (!row || row.session_version !== data.session_version) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      token: null,
      error: "This reset link is no longer valid. Request a new one.",
      flashes: consumeFlashes(req),
    });
  }
  try {
    applyPasswordReset(
      row.id,
      String(req.body?.password ?? ""),
      String(req.body?.password_confirm ?? ""),
    );
  } catch (err) {
    return res.status(400).render("reset_password", {
      title: "Reset password",
      token,
      error: (err as Error).message,
      flashes: consumeFlashes(req),
    });
  }
  clearAuthSession(req);
  refreshCsrfToken(req);
  pushFlash(
    req,
    "Your password has been changed. Log in with the new password.",
    "success",
  );
  return saveAndRedirect(req, res, "/login");
});

authRouter.get("/profile", loginRequired, (req, res) => {
  return res.render("profile", buildProfileContext(req, res));
});

authRouter.post("/profile", loginRequired, (req, res) => {
  if (!isCsrfValid(req)) {
    return res
      .status(400)
      .render(
        "profile",
        buildProfileContext(
          req,
          res,
          "Your session expired. Reload the page and try again.",
        ),
      );
  }

  const user = res.locals.currentUser;
  const formName = String(req.body?.form_name ?? "");
  try {
    if (formName === "profile") {
      updateProfile(
        user.id,
        String(req.body?.display_name ?? ""),
        String(req.body?.email ?? ""),
      );
      pushFlash(req, "Profile updated.", "success");
    } else if (formName === "preferences") {
      const weights: Record<string, number> = {};
      for (const criterion of ["program", "location", "budget", "sector"]) {
        const raw = String(req.body?.[`weight_${criterion}`] ?? "").trim();
        if (raw) {
          const parsed = Number(raw);
          if (Number.isNaN(parsed)) {
            throw new AccountError("Weights must be numbers");
          }
          weights[criterion] = parsed / 100;
        }
      }
      savePreferences(user.id, {
        program: String(req.body?.program ?? ""),
        city: String(req.body?.city ?? ""),
        sector: String(req.body?.sector ?? ""),
        budget: req.body?.budget ?? "",
        budget_basis: String(req.body?.budget_basis ?? "semester"),
        weights,
      });
      pushFlash(
        req,
        "Preferences saved. Your matches have been refreshed.",
        "success",
      );
    } else if (formName === "password") {
      if (
        user.totp_enabled &&
        !verifySecondFactor(user.id, String(req.body?.code ?? ""))
      ) {
        throw new AccountError(
          "Enter a valid authenticator or recovery code to change your password.",
        );
      }
      const version = changePassword(
        user.id,
        String(req.body?.current_password ?? ""),
        String(req.body?.new_password ?? ""),
        String(req.body?.password_confirm ?? ""),
      );
      req.session.sessionVersion = version;
      refreshCsrfToken(req);
      pushFlash(
        req,
        "Password changed. Other sessions have been signed out.",
        "success",
      );
    } else if (formName === "2fa_start") {
      req.session.pendingTotpSetup = beginTotpSetup(user.id);
      pushFlash(
        req,
        "Enter the secret in your authenticator app, then confirm the six-digit code.",
        "success",
      );
    } else if (formName === "2fa_enable") {
      const setup = req.session.pendingTotpSetup;
      if (!setup?.secret) {
        throw new AccountError("Start two-factor setup again.");
      }
      const codes = enableTotp(
        user.id,
        setup.secret,
        String(req.body?.code ?? ""),
      );
      delete req.session.pendingTotpSetup;
      req.session.newRecoveryCodes = codes;
      pushFlash(
        req,
        "Two-factor authentication is enabled. Save your recovery codes.",
        "success",
      );
    } else if (formName === "2fa_cancel") {
      delete req.session.pendingTotpSetup;
      pushFlash(req, "Two-factor setup cancelled.", "success");
    } else if (formName === "2fa_disable") {
      disableTotp(
        user.id,
        String(req.body?.password ?? ""),
        String(req.body?.code ?? ""),
      );
      pushFlash(req, "Two-factor authentication is disabled.", "success");
    } else {
      throw new AccountError("Unknown profile action");
    }
  } catch (err) {
    return res
      .status(400)
      .render("profile", buildProfileContext(req, res, (err as Error).message));
  }

  return saveAndRedirect(req, res, "/profile");
});
