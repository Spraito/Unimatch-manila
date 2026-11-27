/**
 * Transactional email delivery via Brevo HTTPS REST API.
 *
 * Uses Brevo's v3 transactional email endpoint (`POST https://api.brevo.com/v3/smtp/email`)
 * with `process.env.BREVO_API_KEY` in the `api-key` header and sends strictly from
 * `spraitospraito@gmail.com` (sender name "UniMatch PH").
 *
 * Security design:
 * - Reads BREVO_API_KEY strictly from process.env (never hardcoded or logged).
 * - Escapes HTML content interpolated into transactional emails.
 * - Logs exact HTTP status and response body returned by Brevo without exposing
 *   the API key.
 */
import "./env.js";

export const DEFAULT_BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
export const DEFAULT_BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account";
export const STRICT_SENDER_EMAIL = "spraitospraito@gmail.com";
export const STRICT_SENDER_NAME = "UniMatch PH";

export interface SendBrevoEmailInput {
  to: string;
  toName?: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}

export interface BrevoSendResult {
  ok: boolean;
  configured: boolean;
  status?: number;
  statusText?: string;
  messageId?: string;
  responseBody?: unknown;
  error?: string;
}

export interface BrevoMailerOptions {
  apiKey?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export function getBrevoApiKey(): string {
  return String(process.env.BREVO_API_KEY || "").trim();
}

export function isBrevoConfigured(): boolean {
  return Boolean(getBrevoApiKey());
}

export function getSenderEmail(): string {
  return STRICT_SENDER_EMAIL;
}

export function getBrevoApiUrl(): string {
  return String(process.env.BREVO_API_URL || "").trim() || DEFAULT_BREVO_API_URL;
}

function escapeHtml(value: string): string {
  return String(value).replace(
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

export async function sendBrevoEmail(
  input: SendBrevoEmailInput,
  options: BrevoMailerOptions = {},
): Promise<BrevoSendResult> {
  const apiKey = (options.apiKey ?? getBrevoApiKey()).trim();
  const senderEmail = STRICT_SENDER_EMAIL;
  const senderName = STRICT_SENDER_NAME;
  const endpoint = (options.apiUrl ?? getBrevoApiUrl()).trim() || DEFAULT_BREVO_API_URL;
  const fetchFn = options.fetchImpl ?? fetch;

  if (!apiKey) {
    console.warn(
      "[mailer] Skipping transactional email: BREVO_API_KEY is not configured.",
    );
    return {
      ok: false,
      configured: false,
      error: "BREVO_API_KEY is not configured.",
    };
  }

  const recipientEmail = String(input.to || "").trim().toLowerCase();
  if (!recipientEmail || !recipientEmail.includes("@")) {
    return {
      ok: false,
      configured: true,
      error: "Recipient email address is invalid.",
    };
  }

  const payload = {
    sender: {
      name: senderName,
      email: senderEmail,
    },
    to: [
      {
        email: recipientEmail,
        ...(input.toName ? { name: input.toName.trim().slice(0, 80) } : {}),
      },
    ],
    subject: input.subject,
    htmlContent: input.htmlContent,
    ...(input.textContent ? { textContent: input.textContent } : {}),
  };

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const rawBody = await response.text();
    let parsedBody: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }
    }
    const responseBody: unknown = parsedBody ?? rawBody;

    if (!response.ok) {
      console.error("[mailer] Brevo REST API error response:", {
        endpoint,
        sender: { name: senderName, email: senderEmail },
        status: response.status,
        statusText: response.statusText,
        responseBody,
      });
      return {
        ok: false,
        configured: true,
        status: response.status,
        statusText: response.statusText,
        responseBody,
        error:
          (parsedBody && typeof parsedBody.message === "string"
            ? parsedBody.message
            : rawBody) || `Brevo API returned HTTP ${response.status}`,
      };
    }

    const messageId =
      parsedBody && typeof parsedBody.messageId === "string"
        ? parsedBody.messageId
        : undefined;

    console.log("[mailer] Brevo REST API success response:", {
      endpoint,
      sender: { name: senderName, email: senderEmail },
      status: response.status,
      statusText: response.statusText,
      responseBody,
    });

    return {
      ok: true,
      configured: true,
      status: response.status,
      statusText: response.statusText,
      messageId,
      responseBody,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mailer] Brevo REST API network error:", {
      endpoint,
      sender: { name: senderName, email: senderEmail },
      error: message,
    });
    return {
      ok: false,
      configured: true,
      error: message,
    };
  }
}

export async function sendPasswordResetEmail(
  params: {
    to: string;
    displayName?: string;
    resetUrl: string;
  },
  options: BrevoMailerOptions = {},
): Promise<BrevoSendResult> {
  const safeName = escapeHtml((params.displayName || "there").trim());
  const safeUrl = escapeHtml(params.resetUrl);
  const subject = "Reset your UniMatch PH password";

  const textContent = [
    `Hi ${params.displayName || "there"},`,
    "",
    "We received a request to reset your UniMatch PH account password.",
    `Use this link within 30 minutes to choose a new password: ${params.resetUrl}`,
    "",
    "If you did not request a password reset, you can safely ignore this email.",
  ].join("\n");

  const htmlContent = `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2421; line-height: 1.5; margin: 0; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; border: 1px solid #d7ded8; border-radius: 12px; padding: 24px;">
      <h1 style="font-size: 20px; margin: 0 0 12px;">Reset your UniMatch PH password</h1>
      <p style="margin: 0 0 14px;">Hi ${safeName},</p>
      <p style="margin: 0 0 18px;">We received a request to reset the password for your UniMatch PH account. This link expires in 30 minutes.</p>
      <p style="margin: 0 0 20px;">
        <a href="${safeUrl}" style="display: inline-block; background: #1f6b53; color: #ffffff; text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 8px;">Reset password</a>
      </p>
      <p style="font-size: 13px; color: #526058; margin: 0 0 8px;">Or copy and paste this link into your browser:</p>
      <p style="font-size: 13px; word-break: break-all; margin: 0 0 18px;"><a href="${safeUrl}">${safeUrl}</a></p>
      <p style="font-size: 12px; color: #526058; margin: 0;">If you did not request this password reset, you can safely ignore this message.</p>
    </div>
  </body>
</html>`;

  return sendBrevoEmail(
    {
      to: params.to,
      toName: params.displayName,
      subject,
      htmlContent,
      textContent,
    },
    options,
  );
}

export async function sendGoogleSignInReminderEmail(
  params: {
    to: string;
    displayName?: string;
    loginUrl: string;
  },
  options: BrevoMailerOptions = {},
): Promise<BrevoSendResult> {
  const safeName = escapeHtml((params.displayName || "there").trim());
  const safeLoginUrl = escapeHtml(params.loginUrl);
  const subject = "Sign in to UniMatch PH with Google";

  const textContent = [
    `Hi ${params.displayName || "there"},`,
    "",
    "We received a password reset request for your UniMatch PH account.",
    "Your account was created using Google Sign-In, so it does not use a separate UniMatch PH password.",
    `To access your account, please open the login page and choose "Continue with Google": ${params.loginUrl}`,
    "",
    "If you did not make this request, you can safely ignore this email.",
  ].join("\n");

  const htmlContent = `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2421; line-height: 1.5; margin: 0; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; border: 1px solid #d7ded8; border-radius: 12px; padding: 24px;">
      <h1 style="font-size: 20px; margin: 0 0 12px;">Use Google Sign-In for UniMatch PH</h1>
      <p style="margin: 0 0 14px;">Hi ${safeName},</p>
      <p style="margin: 0 0 16px;">We received a password reset request for your UniMatch PH account. Because this email is linked to <strong>Google Sign-In</strong>, it does not have a separate UniMatch PH password.</p>
      <p style="margin: 0 0 20px;">
        <a href="${safeLoginUrl}" style="display: inline-block; background: #1f6b53; color: #ffffff; text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 8px;">Continue with Google on UniMatch PH</a>
      </p>
      <p style="font-size: 13px; color: #526058; margin: 0 0 8px;">Or open the sign-in page directly:</p>
      <p style="font-size: 13px; word-break: break-all; margin: 0 0 18px;"><a href="${safeLoginUrl}">${safeLoginUrl}</a></p>
      <p style="font-size: 12px; color: #526058; margin: 0;">If you did not request this, you can safely ignore this email.</p>
    </div>
  </body>
</html>`;

  return sendBrevoEmail(
    {
      to: params.to,
      toName: params.displayName,
      subject,
      htmlContent,
      textContent,
    },
    options,
  );
}

export async function verifyBrevoConfig(
  options: BrevoMailerOptions = {},
): Promise<{
  configured: boolean;
  ok: boolean;
  senderEmail: string;
  senderName: string;
  endpoint: string;
  status?: number;
  error?: string;
}> {
  const apiKey = (options.apiKey ?? getBrevoApiKey()).trim();
  const senderEmail = STRICT_SENDER_EMAIL;
  const senderName = STRICT_SENDER_NAME;
  const endpoint = (options.apiUrl ?? getBrevoApiUrl()).trim() || DEFAULT_BREVO_API_URL;
  const fetchFn = options.fetchImpl ?? fetch;

  if (!apiKey) {
    return {
      configured: false,
      ok: false,
      senderEmail,
      senderName,
      endpoint,
      error: "BREVO_API_KEY is not set in the runtime environment.",
    };
  }

  try {
    const response = await fetchFn(DEFAULT_BREVO_ACCOUNT_URL, {
      method: "GET",
      headers: {
        "api-key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error("[mailer] Brevo account verification failed:", {
        status: response.status,
        statusText: response.statusText,
        responseBody: body,
      });
      return {
        configured: true,
        ok: false,
        senderEmail,
        senderName,
        endpoint,
        status: response.status,
        error: `Brevo API returned HTTP ${response.status}`,
      };
    }
    return {
      configured: true,
      ok: true,
      senderEmail,
      senderName,
      endpoint,
      status: response.status,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      senderEmail,
      senderName,
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
