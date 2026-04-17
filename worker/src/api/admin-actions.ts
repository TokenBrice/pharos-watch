import type { TelegramCreds } from "../lib/telegram";
import { makeAdminRoute, runAdminRoute } from "../lib/route-wrappers";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { setCache } from "../lib/db-cache";
import { jsonResponse } from "../lib/api-utils";
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

/**
 * Cache key used by `digest-trigger-poll` to decide whether to run the digest
 * out-of-band on its next scheduled tick. Plain JSON value, no TTL.
 */
export const DIGEST_FORCE_RUN_CACHE_KEY = "digest:force-run-request";

export const handleTriggerDigest = makeAdminRoute(
  "route-trigger-digest",
  async ({ db, request }: TriggerDigestRouteContext) =>
    runIdempotentAdminAction(db, "trigger-digest", request, async () => {
      const requestId = `manual-digest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await setCache(
        db,
        DIGEST_FORCE_RUN_CACHE_KEY,
        JSON.stringify({
          requestedAt: Math.floor(Date.now() / 1000),
          requestId,
        }),
      );
      return jsonResponse(
        {
          ok: true,
          accepted: true,
          requestId,
          message: "Digest trigger queued; will execute on the next polling tick (≤5 min).",
        },
        { status: 202, noStore: true },
      );
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

export function handleDiscoveryCandidateDismiss(
  { db, request, trustedAdmin }: AdminRouteContext,
  candidateId: number,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "route-discovery-candidate-dismiss",
      request,
      trustedAdmin,
    },
    () => handleDismissCandidate(db, candidateId),
  );
}
