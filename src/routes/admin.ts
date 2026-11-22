/**
 * Admin catalog routes & verified-admin polite collection / JSON import endpoints.
 *
 * All /api/admin/* endpoints verify the caller's Firebase ID token server-side
 * via firebase-admin/auth (verifyIdToken, zero IAM required) and require a
 * verified admin email before running any collector or baseline export action.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import {
  collectUniversityPolite,
  exportBaselineCatalog,
  getCollectorConfig,
  parseCollectorJsonImport,
} from "../collector.js";
import { adminAuth, isVerifiedAdminToken } from "../lib/firebaseAdmin.js";
import {
  SlidingFixedWindowLimiter,
  createRateLimitMiddleware,
} from "../securityHardening.js";

export const adminRouter = express.Router();

interface AdminRequest extends Request {
  adminUser?: DecodedIdToken;
}

const collectLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 8,
  keyPrefix: "admin-collect",
});

const importLimiter = new SlidingFixedWindowLimiter({
  windowMs: 5 * 60 * 1000,
  max: 25,
  keyPrefix: "admin-import",
});

async function requireAdminToken(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Admin sign-in is required." });
  }
  const token = header.slice(7).trim();
  if (!token || token.length > 8192) {
    return res.status(401).json({ error: "Invalid authorization token." });
  }
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (!isVerifiedAdminToken(decoded)) {
      return res
        .status(403)
        .json({ error: "Admin access is required for this action." });
    }
    req.adminUser = decoded;
    return next();
  } catch {
    return res
      .status(401)
      .json({ error: "Your sign-in session could not be verified. Sign in again." });
  }
}

adminRouter.get("/admin", (_req, res) => {
  res.render("admin", {
    title: "Catalog manager",
    error: null,
    flashes: [],
  });
});

adminRouter.get("/api/admin/baseline", requireAdminToken, (_req, res) => {
  try {
    return res.json({
      universities: exportBaselineCatalog(),
      collector: getCollectorConfig(),
    });
  } catch (err) {
    console.error("Failed to build baseline catalog export:", err);
    return res
      .status(500)
      .json({ error: "Could not prepare the baseline university catalog." });
  }
});

adminRouter.post(
  "/api/admin/collect",
  createRateLimitMiddleware(collectLimiter),
  requireAdminToken,
  async (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const universityId = String(body.universityId || "").trim();
      const customUrl =
        typeof body.customUrl === "string" ? body.customUrl.trim() : "";
      const discoverSubpages =
        typeof body.discoverSubpages === "boolean" ? body.discoverSubpages : true;
      const rawUrls = Array.isArray(body.urls) ? body.urls : null;

      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(universityId)) {
        return res
          .status(400)
          .json({ error: "Select a valid configured university to collect." });
      }
      if (customUrl.length > 500) {
        return res
          .status(400)
          .json({ error: "Custom URL must be at most 500 characters." });
      }

      let urls: string[] | undefined;
      if (rawUrls !== null) {
        if (rawUrls.length > 12) {
          return res
            .status(400)
            .json({ error: "You can collect at most 12 official URLs per run." });
        }
        urls = [];
        for (const item of rawUrls) {
          if (typeof item !== "string") {
            return res.status(400).json({ error: "Each URL must be a valid HTTPS string." });
          }
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (trimmed.length > 500) {
            return res
              .status(400)
              .json({ error: "Each URL must be at most 500 characters." });
          }
          urls.push(trimmed);
        }
        if (urls.length === 0 && !customUrl) {
          return res
            .status(400)
            .json({ error: "Select at least one configured page or paste an official HTTPS URL." });
        }
      }

      const result = await collectUniversityPolite({
        universityId,
        urls,
        customUrl: customUrl || undefined,
        discoverSubpages,
      });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : "Could not complete polite collection.",
      });
    }
  },
);

adminRouter.post(
  "/api/admin/parse-import",
  createRateLimitMiddleware(importLimiter),
  requireAdminToken,
  (req: AdminRequest, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const rawSnapshot = body.snapshot ?? body;
      const result = parseCollectorJsonImport(rawSnapshot);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : "Could not parse the uploaded collector JSON snapshot.",
      });
    }
  },
);
