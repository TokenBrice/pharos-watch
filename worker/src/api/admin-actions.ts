import type { TelegramCreds } from "../lib/telegram";
import { generateDailyDigest } from "../cron/daily-digest";
import { makeAdminRoute } from "../lib/route-wrappers";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { createLeaseOwner, runCronWithLease } from "../lib/cron-lease";
import { logCronRun, type CronResult } from "../lib/cron-logger";
import { normalizeCronMetadata } from "../lib/cron-metadata";
import { jsonResponse, withErrorHandler } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { handleDismissCandidate } from "./discovery";

interface AdminRouteContext {
  db: D1Database;
  request: Request;
  trustedAdmin: boolean;
}

interface TriggerDigestRouteContext extends AdminRouteContext {
  execCtx: ExecutionContext;
  anthropicApiKey?: string | null;
  telegramCreds?: TelegramCreds | null;
}

function createAcceptedJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

async function runManualDigestTrigger(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null,
  requestId: string,
): Promise<void> {
  const leaseOwner = createLeaseOwner("daily-digest");
  await logCronRun(db, "daily-digest", async (signal): Promise<CronResult> => {
    const lease = await runCronWithLease(
      db,
      "daily-digest",
      ({ signal: leaseSignal }) => generateDailyDigest(db, anthropicApiKey, null, true, telegramCreds, leaseSignal),
      { owner: leaseOwner, abortSignal: signal },
    );

    if (lease.status === "skipped_locked") {
      return {
        status: "skipped_locked",
        metadata: normalizeCronMetadata(undefined, {
          reason: "lease-locked",
          trigger: "manual",
          requestId,
          leaseOwner: lease.leaseOwner,
          renewFailures: lease.renewFailures,
        }),
      };
    }

    return {
      ...(lease.result ?? {}),
      metadata: normalizeCronMetadata(lease.result, {
        trigger: "manual",
        requestId,
        leaseOwner: lease.leaseOwner,
        renewFailures: lease.renewFailures,
      }),
    };
  });
}

export const handleTriggerDigest = makeAdminRoute(
  "route-trigger-digest",
  async ({ db, execCtx, request, anthropicApiKey, telegramCreds }: TriggerDigestRouteContext) =>
    runIdempotentAdminAction(db, "trigger-digest", request, async () => {
      const cryptoObj = globalThis as typeof globalThis & {
        crypto?: { randomUUID?: () => string };
      };
      const requestId = cryptoObj.crypto?.randomUUID?.() ?? `manual-digest-${Date.now()}`;
      execCtx.waitUntil(
        runManualDigestTrigger(db, anthropicApiKey ?? null, telegramCreds ?? null, requestId)
          .catch((err) => {
            console.error(`[trigger-digest] Manual digest run failed (${requestId}):`, err);
          }),
      );
      return createAcceptedJsonResponse({
        ok: true,
        accepted: true,
        requestId,
        message: "Digest trigger accepted and running in the background.",
      });
    }),
);

export const handleResetBlacklistSync = makeAdminRoute(
  "route-reset-blacklist-sync",
  async ({ db, request }: AdminRouteContext) =>
    runIdempotentAdminAction(db, "reset-blacklist-sync", request, async () => {
      const result = await db.batch([
        db.prepare(
          "UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'",
        ),
        db.prepare(
          "UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'",
        ),
      ]);
      const evmChanged = result[0]?.meta?.changes ?? 0;
      const tronChanged = result[1]?.meta?.changes ?? 0;
      return jsonResponse({ ok: true, evmReset: evmChanged, tronReset: tronChanged });
    }),
);

export const handleDebugSyncState = makeAdminRoute(
  "route-debug-sync-state",
  async ({ db }: AdminRouteContext) => {
    const rows = await db.prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key").all();
    return jsonResponse(rows.results);
  },
);

export const handleDiscoveryCandidateDismiss = withErrorHandler(
  "route-discovery-candidate-dismiss",
  async (
    { db, request, trustedAdmin }: AdminRouteContext,
    candidateId: number,
  ): Promise<Response> =>
    withAdmin(request, () => handleDismissCandidate(db, candidateId), trustedAdmin),
);
