/**
 * Firebase Admin Auth initialization for ID token verification only.
 *
 * Uses verifyIdToken(token) exclusively (no IAM roles required; works on all projects).
 */
import fs from "node:fs";
import path from "node:path";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { ROOT } from "../store.js";

function readProjectId(): string {
  const configPath = path.join(ROOT, "firebase-applet-config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as { projectId?: string };
  if (!parsed.projectId || parsed.projectId === "remixed-project-id") {
    throw new Error("Firebase project configuration is missing.");
  }
  return parsed.projectId;
}

const adminApp = getApps().length
  ? getApp()
  : initializeApp({
      projectId: readProjectId(),
    });

export const adminAuth = getAuth(adminApp);

const BOOTSTRAPPED_ADMIN_EMAILS = new Set(["enricomigsduran@gmail.com"]);

export function isVerifiedAdminToken(decoded: DecodedIdToken): boolean {
  if (!decoded.email_verified || typeof decoded.email !== "string") {
    return false;
  }
  return BOOTSTRAPPED_ADMIN_EMAILS.has(decoded.email.trim().toLowerCase());
}
