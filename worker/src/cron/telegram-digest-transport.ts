import type { TelegramCreds } from "../lib/telegram";
import { throwIfAborted } from "../lib/abort";
import {
  claimTelegramTransportPermit,
  recordTelegramTransportOutcomes,
  type TelegramTransportOutcome,
  type TelegramTransportPermit,
} from "../lib/telegram/transport-control";
import { recordCronFailure } from "../lib/cron-logger";
import { parseTelegramTransportErrorClass } from "../lib/telegram/transport-errors";

export interface TelegramDigestPermittedDelivery {
  status: string;
  transportOutcome: TelegramTransportOutcome["result"] | null;
}

export function mapTelegramDigestPermittedDelivery(delivery: {
  outcome: "sent" | "pending" | "execution_unknown" | "failed_permanent" | "skipped";
  state: string;
  errorClass: string | null;
  retryAfterSec: number | null;
}, labels: {
  success: string;
  alreadySent: string;
}): TelegramDigestPermittedDelivery {
  if (delivery.outcome === "sent") {
    return {
      status: labels.success,
      transportOutcome: { ok: true, errorClass: null, retryAfterSec: null },
    };
  }
  if (delivery.outcome === "skipped" && delivery.state === "sent") {
    return { status: labels.alreadySent, transportOutcome: null };
  }
  if (delivery.outcome === "skipped") {
    return { status: `queued: ${delivery.state}`, transportOutcome: null };
  }
  const errorClass = parseTelegramTransportErrorClass(delivery.errorClass);
  return {
    status: `failed: Telegram digest ${delivery.outcome}: ${delivery.errorClass ?? "unknown"}`,
    transportOutcome: {
      ok: false,
      errorClass,
      retryAfterSec: errorClass == null ? null : delivery.retryAfterSec,
    },
  };
}

/**
 * Digests map explicitly to the authoritative `fresh` delivery pause. The D1
 * permit is claimed immediately before the outbox crosses the Telegram send
 * boundary, and its outcome is recorded only after that send has returned.
 */
export async function runTelegramDigestDeliveryWithPermit(params: {
  db: D1Database;
  creds: TelegramCreds | null;
  owner: string;
  editionKey: string;
  signal?: AbortSignal;
  deliver: (creds: TelegramCreds) => Promise<TelegramDigestPermittedDelivery>;
}): Promise<string> {
  if (!params.creds) return "no-creds";

  throwIfAborted(params.signal);
  const nowSec = Math.floor(Date.now() / 1000);
  let permit: TelegramTransportPermit;
  try {
    permit = await claimTelegramTransportPermit(params.db, {
      mode: "fresh",
      owner: `${params.owner}:${params.editionKey}`,
      nowSec,
      requestedDistinctChats: 1,
    });
  } catch (error) {
    recordCronFailure(params.owner, error, {
      metadata: { stage: "telegram-transport-permit", editionKey: params.editionKey, fatal: false },
    });
    return "queued: transport-control-unavailable";
  }

  if (!permit.allowed) {
    return `queued: transport-${permit.reason}`;
  }

  try {
    throwIfAborted(params.signal);
    const delivered = await params.deliver(params.creds);
    await recordTelegramTransportOutcomes(
      params.db,
      permit,
      delivered.transportOutcome == null
        ? []
        : [{ chatId: params.creds.chatId, result: delivered.transportOutcome }],
      Math.floor(Date.now() / 1000),
    );
    return delivered.status;
  } catch (error) {
    try {
      await recordTelegramTransportOutcomes(params.db, permit, [], Math.floor(Date.now() / 1000));
    } catch (releaseError) {
      recordCronFailure(params.owner, releaseError, {
        metadata: { stage: "telegram-transport-permit-release", editionKey: params.editionKey, fatal: false },
      });
    }
    recordCronFailure(params.owner, error, {
      metadata: { stage: "channel-delivery", channel: "Telegram", editionKey: params.editionKey, fatal: false },
    });
    return `failed: ${String(error).slice(0, 100)}`;
  }
}
