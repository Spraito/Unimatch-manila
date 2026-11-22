/**
 * Environment bootstrap for the UniMatch PH Node.js backend.
 *
 * Loads variables from a local `.env` file via `dotenv` (the Node.js equivalent
 * of Python's `python-dotenv` / `load_dotenv()`) without overriding variables
 * already provided by the hosting platform or shell environment.
 *
 * Import this module first in entry points and configuration modules so
 * `process.env` is populated before other modules read configuration values.
 */
import dotenv from "dotenv";

dotenv.config();

/**
 * Resolves the active runtime environment name, defaulting safely to
 * `"production"` whenever `UNIMATCH_ENV` is unset or blank.
 */
export function resolveUnimatchEnv(
  rawValue: string | undefined = process.env.UNIMATCH_ENV,
): string {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return normalized || "production";
}

export function isProductionEnv(
  rawValue: string | undefined = process.env.UNIMATCH_ENV,
): boolean {
  return resolveUnimatchEnv(rawValue) === "production";
}

export const UNIMATCH_ENV = resolveUnimatchEnv(process.env.UNIMATCH_ENV);
export const IS_PRODUCTION = isProductionEnv(process.env.UNIMATCH_ENV);
