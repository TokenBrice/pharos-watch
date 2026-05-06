import type { TelegramCreds } from "../lib/telegram";
import { makeAdminRoute, runAdminRoute } from "../lib/route-wrappers";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { setCache } from "../lib/db-cache";
import { jsonResponse } from "../lib/api-utils";
import { handleDismissCandidate } from "./discovery";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";

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
      const requestId = `manual-digest-${crypto.randomUUID()}`;
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
    const now = Math.floor(Date.now() / 1000);
    const [stateRows, eventRows, latestRun] = await Promise.all([
      db
        .prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key")
        .all<{ config_key: string; last_block: number }>(),
      db
        .prepare(
          `SELECT
             config_key,
             COUNT(*) AS event_count,
             MAX(timestamp) AS last_event_at,
             MAX(block_number) AS last_event_block
           FROM blacklist_events
           WHERE suppression_reason IS NULL
             AND config_key IS NOT NULL
           GROUP BY config_key`,
        )
        .all<{
          config_key: string;
          event_count: number;
          last_event_at: number | null;
          last_event_block: number | null;
        }>(),
      db
        .prepare(
          `SELECT started_at, status, metadata
           FROM cron_runs
           WHERE job = 'sync-blacklist'
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .first<{ started_at: number; status: string; metadata: string | null }>()
        .catch(() => null),
    ]);

    const stateByKey = new Map((stateRows.results ?? []).map((row) => [row.config_key, row]));
    const eventByKey = new Map((eventRows.results ?? []).map((row) => [row.config_key, row]));
    const latestRunMetadata = (() => {
      if (!latestRun?.metadata) return null;
      try {
        const parsed = JSON.parse(latestRun.metadata) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as { apiErrorConfigs?: Array<{ configKey?: string; reason?: string; errorMessage?: string }> }
          : null;
      } catch {
        return null;
      }
    })();
    const latestRunErrorByConfig = new Map(
      (latestRunMetadata?.apiErrorConfigs ?? [])
        .filter((entry) => typeof entry.configKey === "string")
        .map((entry) => [entry.configKey!, entry]),
    );

    const rows = CONTRACT_CONFIGS.map((config) => {
      const state = stateByKey.get(config.configKey);
      const event = eventByKey.get(config.configKey);
      const cursorAgeSec = config.chain.type === "tron" && state?.last_block
        ? Math.max(0, now - Math.floor(state.last_block / 1000))
        : null;
      const lastEventAgeSec = event?.last_event_at != null ? Math.max(0, now - event.last_event_at) : null;
      const latestError = latestRunErrorByConfig.get(config.configKey);
      return {
        configKey: config.configKey,
        stablecoin: config.stablecoin,
        stablecoinId: config.stablecoinId,
        chainId: config.chain.chainId,
        chainName: config.chain.chainName,
        contractAddress: config.contractAddress,
        providerSource: config.chain.type === "tron" ? "trongrid" : "evm-logs",
        lastBlock: state?.last_block ?? 0,
        cursorAgeSec,
        lastEventAt: event?.last_event_at ?? null,
        lastEventAgeSec,
        lastEventBlock: event?.last_event_block ?? null,
        eventCount: event?.event_count ?? 0,
        lastRunStartedAt: latestRun?.started_at ?? null,
        lastRunStatus: latestRun?.status ?? null,
        lastErrorClass: latestError?.reason ?? null,
        lastErrorMessage: latestError?.errorMessage ?? null,
      };
    }).sort((a, b) => a.configKey.localeCompare(b.configKey));

    return jsonResponse(rows);
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
