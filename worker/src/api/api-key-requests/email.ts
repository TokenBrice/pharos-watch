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
    throw new Error(`Resend email send failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const body = await response.json().catch(() => ({})) as ResendSendResponse;
  return { providerMessageId: body.id ?? null };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
