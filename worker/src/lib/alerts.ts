/**
 * Simple webhook alerting for cron failures and health degradation.
 * Supports Discord and Slack webhook URLs (auto-detected by format).
 * No-op if ALERT_WEBHOOK_URL is not configured.
 */

let webhookUrl: string | null = null;

export function initAlerts(url: string | undefined): void {
  webhookUrl = url?.trim() || null;
}

export async function sendAlert(title: string, message: string): Promise<void> {
  if (!webhookUrl) return;

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

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    // Never let alerting failures propagate
    console.error("[alerts] Failed to send webhook:", err);
  }
}
