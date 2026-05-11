import type { RequiredInitialSelfServeEnv } from "./types";

interface SendVerificationEmailInput {
  to: string;
  verificationUrl: string;
  requestId: string;
  expiresInMinutes: number;
}

interface ResendSendResponse {
  id?: string;
}

const RESEND_SEND_TIMEOUT_MS = 8_000;

export async function sendVerificationEmail(
  env: RequiredInitialSelfServeEnv,
  input: SendVerificationEmailInput,
): Promise<{ providerMessageId: string | null }> {
  const subject = "Verify your Pharos API key request";
  const text = [
    "Verify your Pharos API key request",
    "",
    `Open this link within ${input.expiresInMinutes} minutes to verify your email address and reveal your API key:`,
    input.verificationUrl,
    "",
    `Request ID: ${input.requestId}`,
    "",
    "The API key is not included in this email and will only be shown once after verification.",
  ].join("\n");
  const html = [
    "<p>Verify your Pharos API key request.</p>",
    `<p><a href="${escapeHtml(input.verificationUrl)}">Verify email and reveal API key</a></p>`,
    `<p>This link expires in ${input.expiresInMinutes} minutes. The API key is not included in this email and will only be shown once after verification.</p>`,
    `<p>Request ID: <code>${escapeHtml(input.requestId)}</code></p>`,
  ].join("");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(RESEND_SEND_TIMEOUT_MS),
    body: JSON.stringify({
      from: env.API_KEY_SELF_SERVE_EMAIL_FROM,
      to: [input.to],
      reply_to: env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO,
      subject,
      html,
      text,
      tags: [
        { name: "feature", value: "api-key-self-serve" },
        { name: "request_id", value: input.requestId },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend email send failed: ${response.status} ${redactProviderBody(body).slice(0, 200)}`);
  }

  const body = await response.json().catch(() => ({})) as ResendSendResponse;
  return { providerMessageId: body.id ?? null };
}

export function redactProviderBody(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bakv_[A-Za-z0-9_-]+\b/g, "[redacted-verification-token]")
    .replace(/\bph_live_[0-9a-f]{16}_[A-Za-z0-9_-]{32}\b/g, "[redacted-api-key]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
