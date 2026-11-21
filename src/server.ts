/**
 * UniMatch PH — Express + EJS web server (migrated from Flask/SQLite to Node.js).
 */
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { getProfile, getUser } from "./accounts.js";
import {
  CRITERION_LABELS,
  DEFAULT_WEIGHTS,
  FORMULA,
  parseWeights,
} from "./algorithms/matching.js";
import { authRouter } from "./routes/auth.js";
import { SESSION_SECRET, getCsrfToken } from "./security.js";
import {
  ROOT,
  collectionHistory,
  datasetStats,
  getUniversityDetail,
  initStore,
  loadStructured,
  queryPrograms,
  queryUniversities,
  rankedRecommendations,
  serializeSchool,
  universities,
} from "./store.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    sessionVersion?: number;
    csrfToken?: string;
    flashes?: Array<{ category: string; message: string }>;
    pending2faUserId?: string;
    pending2faNext?: string;
    pending2faAttempts?: number;
    pendingTotpSetup?: { secret: string; uri: string; account: string };
    newRecoveryCodes?: string[];
  }
}

initStore();

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    name: "unimatch_session",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: false,
    },
  }),
);

// Adapt cookie flags when served over HTTPS inside an iframe preview
app.use((req, _res, next) => {
  const isHttps =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  if (isHttps && req.session?.cookie) {
    req.session.cookie.secure = true;
    req.session.cookie.sameSite = "none";
  }
  next();
});

// Security headers (allowing AI Studio iframe embedding)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  const sensitivePaths = new Set([
    "/login",
    "/login/2fa",
    "/register",
    "/forgot-password",
    "/profile",
    "/logout",
  ]);
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/reset-password/") ||
    sensitivePaths.has(req.path)
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// Static assets mounted at /static to match original templates and scripts
app.use("/static", express.static(path.join(ROOT, "public", "static")));

// Load current user & template helpers
app.use((req, res, next) => {
  let currentUser = null;
  const userId = req.session.userId;
  if (userId) {
    const row = getUser(userId);
    if (
      !row ||
      !row.is_active ||
      Number(req.session.sessionVersion ?? 0) !== row.session_version
    ) {
      delete req.session.userId;
      delete req.session.sessionVersion;
    } else {
      currentUser = row;
    }
  }
  res.locals.currentUser = currentUser;
  res.locals.accountName = () => {
    if (!currentUser) return "";
    try {
      return getProfile(currentUser.id).display_name;
    } catch {
      return "Student";
    }
  };
  res.locals.csrfToken = () => getCsrfToken(req);
  next();
});

app.use(authRouter);

function textQuery(req: Request, name: string): string {
  const raw = req.query[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length > 200) {
    throw new Error(`${name} must be at most 200 characters`);
  }
  return value;
}

// Page routes
app.get("/", (_req, res) => {
  res.render("landing");
});

app.get("/explore", (_req, res) => {
  res.render("index");
});

// JSON API routes
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", universities: universities.size });
});

app.get("/api/stats", (_req, res) => {
  res.json(datasetStats());
});

app.get("/api/universities", (req, res, next) => {
  try {
    const search = textQuery(req, "search");
    const city = textQuery(req, "city");
    const sector = textQuery(req, "sector");
    const sort = textQuery(req, "sort") || "featured";
    const items = queryUniversities(search, city, sector, sort);
    res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

app.get("/api/universities/:schoolId", (req, res) => {
  const item = getUniversityDetail(req.params.schoolId);
  if (!item) {
    return res.status(404).json({ error: "University not found" });
  }
  return res.json(item);
});

app.get("/api/programs", (req, res, next) => {
  try {
    const search = textQuery(req, "search");
    const schoolId = textQuery(req, "university_id");
    const topic = textQuery(req, "topic");
    const pageRaw = typeof req.query.page === "string" ? req.query.page : "1";
    const limitRaw =
      typeof req.query.limit === "string" ? req.query.limit : "12";
    const page = Number(pageRaw);
    const limit = Number(limitRaw);
    if (!Number.isInteger(page) || !Number.isInteger(limit)) {
      throw new Error("page and limit must be integers");
    }
    if (page < 1 || page > 10000 || limit < 1 || limit > 100) {
      throw new Error("page must be 1–10000 and limit must be 1–100");
    }
    res.json(queryPrograms(search, schoolId, topic, page, limit));
  } catch (err) {
    next(err);
  }
});

app.get("/api/compare", (req, res, next) => {
  try {
    const rawIds = textQuery(req, "ids");
    const ids = Array.from(new Set(rawIds.split(",")));
    if (ids.length < 1 || ids.length > 3 || !ids.every(Boolean)) {
      throw new Error("Select between one and three universities");
    }
    const items = [];
    for (const id of ids) {
      const school = universities.get(id);
      if (!school) {
        return res.status(404).json({ error: "University not found" });
      }
      const serialized = serializeSchool(school, true);
      serialized.structured = loadStructured(id);
      items.push(serialized);
    }
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

app.get("/api/recommendation-config", (_req, res) => {
  res.json({
    default_weights: DEFAULT_WEIGHTS,
    criteria: CRITERION_LABELS,
    budget_bases: ["semester", "trimester", "year", "unit"],
    formula: FORMULA,
    unknown_policy:
      "Missing source data scores 0 for that criterion and is reported as unknown; it is never treated as a match.",
  });
});

app.get("/api/recommendations", (req, res, next) => {
  try {
    const program = textQuery(req, "program");
    const city = textQuery(req, "city");
    const sector = textQuery(req, "sector");
    const basis = textQuery(req, "budget_basis");
    const rawBudget =
      typeof req.query.budget === "string" ? req.query.budget.trim() : "";
    let budget: number | null = null;
    if (rawBudget) {
      const parsed = Number(rawBudget);
      if (Number.isNaN(parsed)) {
        throw new Error("Budget must be a number");
      }
      budget = parsed;
    }
    const rawLimit =
      typeof req.query.limit === "string" ? req.query.limit : "20";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit)) {
      throw new Error("limit must be an integer");
    }
    const rawWeights =
      typeof req.query.weights === "string" ? req.query.weights : null;
    const weights = parseWeights(rawWeights);
    const result = rankedRecommendations(
      { program, city, sector, budget, budget_basis: basis },
      weights,
      limit,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/api/collection/status", (_req, res) => {
  res.json(collectionHistory());
});

// Error handler for API validation errors
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (req.path.startsWith("/api/")) {
    return res.status(400).json({ error: err.message || "Bad request" });
  }
  return res.status(500).send(err.message || "Internal server error");
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UniMatch PH server running at http://0.0.0.0:${PORT}`);
});
