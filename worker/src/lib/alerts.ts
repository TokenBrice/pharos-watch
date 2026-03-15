/**
 * Simple webhook alerting for cron failures and health degradation.
 * Supports Discord and Slack webhook URLs (auto-detected by format).
 * No-op if no webhook URL is provided.
 */

const MAX_FAILURE_BODY_CHARS = 300;

/** Normalize a raw env URL to a trimmed string or null. */
export function normalizeWebhookUrl(url: string | undefined): string | null {
  return url?.trim() || null;
}

function truncateFailureBody(body: string): string {
  if (body.length <= MAX_FAILURE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_FAILURE_BODY_CHARS)}...`;
}

export async function sendAlert(webhookUrl: string | null | undefined, title: string, message: string): Promise<boolean> {
  if (!webhookUrl) return false;

  try {
    const isDiscord = webhookUrl.includes("discord.com/api/webhooks");

    const body = isDiscord
      ? JSON.stringify({
          embeds: [{
            title: `[Pharos] ${title}`,
            description: message,
            color: 0xff4444, // red
            timestamp: new Date().toISOString(),
          }],
        })
      : JSON.stringify({
          text: `*[Pharos] ${title}*\n${message}`,
        });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      let responseText = "";
      try {
        responseText = truncateFailureBody(await response.text());
      } catch {
        responseText = "<unavailable>";
      }
      console.error(
        `[alerts] Webhook rejected alert "${title}" (status ${response.status}): ${responseText}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    // Never let alerting failures propagate
    console.error("[alerts] Failed to send webhook:", err);
    return false;
  }
}
