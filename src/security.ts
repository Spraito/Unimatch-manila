/**
 * Security helpers for the Express application.
 *
 * Uses bcryptjs for password hashing, AES-256-GCM for PII encryption,
 * HMAC-SHA256 for email lookups & timed password-reset tokens, and RFC 6238
 * HMAC-SHA1 for TOTP two-factor authentication.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request } from "express";

const ENCRYPTION_CONTEXT = Buffer.from("unimatch-profile-pii-v1", "utf8");
const LOOKUP_CONTEXT = Buffer.from("unimatch-email-lookup-v1", "utf8");
const RESET_SALT = "unimatch-password-reset-v1";
export const RESET_MAX_AGE_SECONDS = 30 * 60;
const TOTP_STEP = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

function decodeKeyOrRandom(envValue: string | undefined): Buffer {
  if (envValue && envValue.trim()) {
    try {
      const normalized = envValue.trim().replace(/-/g, "+").replace(/_/g, "/");
      const raw = Buffer.from(normalized, "base64");
      if (raw.length === 32) return raw;
    } catch {
      // Fall back to ephemeral key in non-production runtime
    }
  }
  return crypto.randomBytes(32);
}

export const SESSION_SECRET =
  process.env.SECRET_KEY?.trim() || crypto.randomBytes(48).toString("base64url");
const DATA_KEY_BYTES = decodeKeyOrRandom(process.env.UNIMATCH_DATA_KEY);
const LOOKUP_KEY_BYTES = decodeKeyOrRandom(process.env.UNIMATCH_LOOKUP_KEY);
export const IS_PRODUCTION =
  (process.env.UNIMATCH_ENV || "").toLowerCase() === "production";

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function getCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  return req.session.csrfToken;
}

export function refreshCsrfToken(req: Request): string {
  req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  return req.session.csrfToken;
}

export function isCsrfValid(req: Request, supplied?: string): boolean {
  const expected = req.session.csrfToken;
  const candidate =
    supplied ||
    (typeof req.body?.csrf_token === "string" ? req.body.csrf_token : "") ||
    (typeof req.headers["x-csrf-token"] === "string"
      ? req.headers["x-csrf-token"]
      : "");
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalizeEmail(value: string): string {
  const email = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (email.length > 254) {
    throw new Error("Email address is too long");
  }
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    throw new Error("Enter a valid email address");
  }
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (
    !domain ||
    !domain.includes(".") ||
    /\s/.test(email) ||
    local.length > 64
  ) {
    throw new Error("Enter a valid email address");
  }
  return email;
}

export function emailLookupHash(email: string): string {
  const normalized = normalizeEmail(email);
  return crypto
    .createHmac("sha256", LOOKUP_KEY_BYTES)
    .update(Buffer.concat([LOOKUP_CONTEXT, Buffer.from(":" + normalized, "utf8")]))
    .digest("hex");
}

export function encryptPii(value: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", DATA_KEY_BYTES, nonce);
  cipher.setAAD(ENCRYPTION_CONTEXT);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64url");
}

export function decryptPii(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length <= 28) {
      throw new Error("malformed encrypted payload");
    }
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(12, payload.length - 16);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      DATA_KEY_BYTES,
      nonce,
    );
    decipher.setAAD(ENCRYPTION_CONTEXT);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new DecryptionError(
      "Profile data could not be decrypted. The encryption key may have changed or the stored value is damaged.",
    );
  }
}

export function isSafeNextUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  if (value.length > 2000) return false;
  if (value.includes("\\") || /[\x00-\x1f]/.test(value)) return false;
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.origin === "http://localhost" && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}

export function makeResetToken(userId: string, sessionVersion: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      sv: sessionVersion || 0,
      iat: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", `${SESSION_SECRET}:${RESET_SALT}`)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function loadResetToken(
  token: string,
  maxAge = RESET_MAX_AGE_SECONDS,
): { user_id: string; session_version: number } {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    throw new Error("This reset link is invalid.");
  }
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", `${SESSION_SECRET}:${RESET_SALT}`)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("This reset link is invalid.");
  }
  let data: { uid?: string; sv?: number; iat?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("This reset link is invalid.");
  }
  if (!data || typeof data.uid !== "string" || !data.uid) {
    throw new Error("This reset link is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof data.iat !== "number" || now - data.iat > maxAge) {
    throw new Error("This reset link has expired. Request a new one.");
  }
  return { user_id: data.uid, session_version: Number(data.sv || 0) };
}

// --- RFC 6238 TOTP ---
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(secret: string): Buffer {
  const cleaned = String(secret || "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/=+$/, "");
  if (!cleaned) throw new Error("TOTP secret is empty");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, forTimeSeconds?: number): string {
  const nowSec = forTimeSeconds ?? Date.now() / 1000;
  const counter = BigInt(Math.floor(nowSec / TOTP_STEP));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const digest = crypto
    .createHmac("sha1", base32Decode(secret))
    .update(counterBuf)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const codeInt =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(codeInt % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(
  secret: string,
  code: string,
  forTimeSeconds?: number,
  window = TOTP_WINDOW,
): boolean {
  const candidate = String(code || "").replace(/\D+/g, "");
  if (candidate.length !== TOTP_DIGITS) return false;
  const base = forTimeSeconds ?? Date.now() / 1000;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = totpCode(secret, base + offset * TOTP_STEP);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(candidate, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

export function totpUri(
  secret: string,
  account: string,
  issuer = "UniMatch PH",
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function normalizeRecoveryCode(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(
      [
        crypto.randomBytes(2).toString("hex"),
        crypto.randomBytes(2).toString("hex"),
        crypto.randomBytes(2).toString("hex"),
      ].join("-"),
    );
  }
  return codes;
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((c) => hashPassword(normalizeRecoveryCode(c)));
}

export function consumeRecoveryCode(
  hashes: string[],
  code: string,
): { matched: boolean; remaining: string[] } {
  const candidate = normalizeRecoveryCode(code);
  if (!candidate) return { matched: false, remaining: hashes };
  for (let i = 0; i < hashes.length; i += 1) {
    if (verifyPassword(candidate, hashes[i])) {
      return {
        matched: true,
        remaining: [...hashes.slice(0, i), ...hashes.slice(i + 1)],
      };
    }
  }
  return { matched: false, remaining: hashes };
}
