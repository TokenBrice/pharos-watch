import type { TelegramCreds } from "../../telegram/delivery/telegram";
import { throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { recordCronFailure } from "../../lib/cron-logger";

export function mapTelegramDigestPermittedDelivery(delivery: {
  outcome: "sent" | "pending" | "execution_unknown" | "failed_permanent" | "skipped";
  state: string;
  errorClass: string | null;
}, labels: {
  success: string;
  alreadySent: string;
}): string {
  if (delivery.outcome === "sent") return labels.success;
  if (delivery.outcome === "skipped" && delivery.state === "sent") return labels.alreadySent;
  if (delivery.outcome === "skipped") return `queued: ${delivery.state}`;
  return `failed: Telegram digest ${delivery.outcome}: ${delivery.errorClass ?? "unknown"}`;
}

/**
 * Digests share the generic Telegram API circuit with the alert dispatcher
 * (which owns its outcomes): while it is open the edition stays queued in the
 * outbox instead of crossing the send boundary.
 */
export async function runTelegramDigestDeliveryWithPermit(params: {
  db: D1Database;
  creds: TelegramCreds | null;
  owner: string;
  editionKey: string;
  signal?: AbortSignal;
  deliver: (creds: TelegramCreds) => Promise<string>;
}): Promise<string> {
  if (!params.creds) return "no-creds";

  throwIfAborted(params.signal);
  let allowed: boolean;
  try {
    allowed = await shouldAttemptFetch(params.db, CIRCUIT_SOURCE.TELEGRAM_API);
  } catch (error) {
    recordCronFailure(params.owner, error, {
      metadata: { stage: "telegram-transport-permit", editionKey: params.editionKey, fatal: false },
    });
    return "queued: transport-control-unavailable";
  }
  if (!allowed) return "queued: transport-circuit-open";

  try {
    throwIfAborted(params.signal);
    return await params.deliver(params.creds);
  } catch (error) {
    recordCronFailure(params.owner, error, {
      metadata: { stage: "channel-delivery", channel: "Telegram", editionKey: params.editionKey, fatal: false },
    });
    return `failed: ${String(error).slice(0, 100)}`;
  }
}
