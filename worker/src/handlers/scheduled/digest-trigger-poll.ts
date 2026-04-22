// Digest trigger poll slot (every 5 minutes, cron "*/5 * * * *"):
//   If `digest:force-run-request` cache key is set, run daily-digest under
//   scheduled-event wall-clock (15 min). The `daily-digest` lease serializes
//   execution with the 08:05 UTC scheduled run; if the lease is held, we
//   preserve the flag for the next poll. Otherwise we clear the flag and
//   persist a `digest:last-trigger-result` key so the ops UI can report the
//   outcome of the most recent manual trigger.
//
// The manual trigger HTTP endpoint writes the flag synchronously and returns
// 202; this poll slot is the execution surface. See
// `2026-04-17-daily-digest-root-cause-and-fix-plan.md` for why HTTP
// `ctx.waitUntil` was abandoned.
import { generateDailyDigest } from "../../cron/daily-digest";
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import { deleteCache, getCache, setCache } from "../../lib/db-cache";
import { DIGEST_FORCE_RUN_CACHE_KEY } from "../../api/admin-actions";
import type { ScheduledRuntimeContext } from "./context";
import type { CronResult } from "../../lib/cron-logger";

export const DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY = "digest:last-trigger-result";

interface DigestForceRunRequest {
  requestedAt: number;
  requestId: string;
}

function parseForceRunPayload(value: string): DigestForceRunRequest | null {
  try {
    const parsed = JSON.parse(value) as { requestedAt?: unknown; requestId?: unknown };
    if (typeof parsed.requestedAt !== "number" || typeof parsed.requestId !== "string") {
      return null;
    }
    return { requestedAt: parsed.requestedAt, requestId: parsed.requestId };
  } catch {
    return null;
  }
}

export async function runDigestTriggerPollSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const pending = await getCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
  if (!pending) return;

  const payload = parseForceRunPayload(pending.value);
  if (!payload) {
    console.warn(
      `[digest-trigger-poll] Malformed force-run payload, clearing: ${pending.value.slice(0, 200)}`,
    );
    await deleteCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
    return;
  }

  let result: CronResult | void = undefined;
  let caught: unknown = null;

  try {
    result = await runtime.runLeasedCron("daily-digest", (signal) =>
      generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        buildTwitterCreds(runtime.env),
        true,
        buildTelegramCreds(runtime.env),
        signal,
      ),
    );
  } catch (err) {
    caught = err;
    console.error(`[digest-trigger-poll] daily-digest failed for request ${payload.requestId}:`, err);
  }

  const leaseLocked =
    (result as { status?: string } | null | undefined)?.status === "skipped_locked";

  // Preserve the flag when the 08:05 scheduled run holds the lease so the next
  // poll can retry. Clear it on every other outcome (ok, degraded, error,
  // thrown exception) so persistent failures don't loop.
  if (!leaseLocked) {
    await deleteCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
  }

  // Surface the outcome for the ops UI. Use a short, bounded payload — we only
  // need enough for operators to see whether their trigger landed.
  const finishedAt = Math.floor(Date.now() / 1000);
  let outcome: "ok" | "degraded" | "error" | "skipped_locked" | "skipped" = "ok";
  let errorMessage: string | null = null;
  if (caught) {
    outcome = "error";
    errorMessage = caught instanceof Error ? caught.message : String(caught);
  } else if (leaseLocked) {
    outcome = "skipped_locked";
  } else {
    const status = (result as { status?: string } | null | undefined)?.status;
    if (status === "degraded" || status === "error") {
      outcome = status;
    } else if (status === "skipped_locked") {
      outcome = "skipped_locked";
    } else if (typeof (result as { metadata?: unknown } | null | undefined)?.metadata === "string"
      && ((result as { metadata: string }).metadata.startsWith("skipped:"))) {
      outcome = "skipped";
    }
  }
  try {
    await setCache(
      runtime.db,
      DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY,
      JSON.stringify({
        requestId: payload.requestId,
        requestedAt: payload.requestedAt,
        finishedAt,
        outcome,
        error: errorMessage ? errorMessage.slice(0, 500) : null,
      }),
    );
  } catch (err) {
    console.warn("[digest-trigger-poll] Failed to persist last-trigger-result:", err);
  }

  // Do not re-throw: logCronRun (inside runLeasedCron) already wrote the
  // error row to cron_runs. Swallowing matches the five-minute-telegram slot
  // pattern and keeps the scheduled slot fence clean.
}
