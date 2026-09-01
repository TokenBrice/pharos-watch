import type { TelegramCreds } from "../lib/telegram";
import { makeAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { setCache } from "../lib/db-cache";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { readRequestTextBounded } from "../lib/api-json-body";
import {
  DIGEST_STYLE_GATE_MODE_CACHE_KEYS,
  type DigestStyleGateKind,
  parseDigestStyleGateMode,
  resolveDigestStyleGateModes,
} from "../lib/digest-style-gate";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { normalizeBlacklistSyncStateKey } from "../lib/db";

interface TriggerDigestRouteContext extends AdminRouteContext {
  execCtx: ExecutionContext;
  anthropicApiKey?: string | null;
  telegramCreds?: TelegramCreds | null;
}

/**
 * Cache key used by `digest-trigger-poll` to decide whether to run the digest
 * out-of-band on its next scheduled tick. The JSON value is a bounded retry
 * intent, with no TTL so dead letters remain visible for operator inspection.
 */
export const DIGEST_FORCE_RUN_CACHE_KEY = "digest:force-run-request";

export const handleTriggerDigest = makeAdminRoute(
  "route-trigger-digest",
  async ({ db, request }: TriggerDigestRouteContext) =>
    runIdempotentAdminAction(db, "trigger-digest", request, async () => {
      const requestText = await readRequestTextBounded(request, 1_024);
      if (requestText instanceof Response) return requestText;
      let requestedStyleGateMode: { kind: DigestStyleGateKind; mode: "shadow" | "enforce" } | null = null;
      if (requestText.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(requestText);
        } catch {
          return errorResponse(400, "Request body must be valid JSON");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return errorResponse(400, "Request body must be a JSON object");
        }
        const body = parsed as Record<string, unknown>;
        if (Object.keys(body).some((key) => key !== "styleGateMode")) {
          return errorResponse(400, "Request body contains an unknown field");
        }
        if (Object.prototype.hasOwnProperty.call(body, "styleGateMode")) {
          const candidate = body.styleGateMode;
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            return errorResponse(400, "styleGateMode must target exactly one of daily or weekly");
          }
          const entries = Object.entries(candidate);
          if (entries.length !== 1 || (entries[0]?.[0] !== "daily" && entries[0]?.[0] !== "weekly")) {
            return errorResponse(400, "styleGateMode must target exactly one of daily or weekly");
          }
          const [kind, value] = entries[0] as [DigestStyleGateKind, unknown];
          const mode = parseDigestStyleGateMode(value);
          if (!mode) return errorResponse(400, 'styleGateMode value must be "shadow" or "enforce"');
          requestedStyleGateMode = { kind, mode };
        }
      }
      if (requestedStyleGateMode) {
        await setCache(
          db,
          DIGEST_STYLE_GATE_MODE_CACHE_KEYS[requestedStyleGateMode.kind],
          requestedStyleGateMode.mode,
        );
      }
      const effectiveStyleGateMode = await resolveDigestStyleGateModes(db);
      if (requestedStyleGateMode) {
        effectiveStyleGateMode[requestedStyleGateMode.kind] = requestedStyleGateMode.mode;
      }
      const requestId = `manual-digest-${crypto.randomUUID()}`;
      const requestedAt = Math.floor(Date.now() / 1000);
      await setCache(
        db,
        DIGEST_FORCE_RUN_CACHE_KEY,
        JSON.stringify({
          requestedAt,
          requestId,
          attempts: 0,
          nextAttemptAt: requestedAt,
          state: "pending",
          lastError: null,
        }),
      );
      return jsonResponse(
        {
          ok: true,
          accepted: true,
          requestId,
          styleGateMode: effectiveStyleGateMode,
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
          `UPDATE blacklist_sync_state
           SET
             last_block = MAX(MAX(last_block, COALESCE(cursor_value, 0)) - 50000, 0),
             cursor_value = MAX(MAX(last_block, COALESCE(cursor_value, 0)) - 50000, 0),
             attempt_generation = attempt_generation + 1,
             last_succeeded_at = NULL,
             consecutive_skips = 0,
             consecutive_failures = 0,
             last_outcome = 'admin_rewind'
           WHERE config_key NOT LIKE 'tron-%'`,
        ),
        db.prepare(
          `UPDATE blacklist_sync_state
           SET
             last_block = MAX(MAX(last_block, COALESCE(cursor_value, 0)) - 604800000, 0),
             cursor_value = MAX(MAX(last_block, COALESCE(cursor_value, 0)) - 604800000, 0),
             attempt_generation = attempt_generation + 1,
             last_succeeded_at = NULL,
             consecutive_skips = 0,
             consecutive_failures = 0,
             last_outcome = 'admin_rewind'
           WHERE config_key LIKE 'tron-%'`,
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
        .prepare(
          `SELECT
             config_key,
             last_block,
             cursor_kind,
             cursor_value,
             attempt_generation,
             last_attempted_at,
             last_succeeded_at,
             last_skipped_at,
             last_failed_at,
             consecutive_skips,
             consecutive_failures,
             last_outcome,
             last_observed_safe_head,
             last_safe_head_observed_at
           FROM blacklist_sync_state
           ORDER BY config_key`,
        )
        .all<{
          config_key: string;
          last_block: number;
          cursor_kind: string;
          cursor_value: number | null;
          attempt_generation: number;
          last_attempted_at: number | null;
          last_succeeded_at: number | null;
          last_skipped_at: number | null;
          last_failed_at: number | null;
          consecutive_skips: number;
          consecutive_failures: number;
          last_outcome: string | null;
          last_observed_safe_head: number | null;
          last_safe_head_observed_at: number | null;
        }>(),
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

    const stateByKey = new Map((stateRows.results ?? []).map((row) => [
      normalizeBlacklistSyncStateKey(row.config_key),
      row,
    ]));
    const eventByKey = new Map((eventRows.results ?? []).map((row) => [
      normalizeBlacklistSyncStateKey(row.config_key),
      row,
    ]));
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
      const state = stateByKey.get(normalizeBlacklistSyncStateKey(config.configKey));
      const event = eventByKey.get(normalizeBlacklistSyncStateKey(config.configKey));
      const cursorValue = Math.max(state?.last_block ?? 0, state?.cursor_value ?? 0);
      const cursorAgeSec = config.chain.type === "tron" && cursorValue > 0
        ? Math.max(0, now - Math.floor(cursorValue / 1000))
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
        cursorKind: state?.cursor_kind ?? (config.chain.type === "tron" ? "tron_timestamp_ms" : "evm_block"),
        cursorValue,
        lastBlock: state?.last_block ?? 0,
        cursorAgeSec,
        attemptGeneration: state?.attempt_generation ?? 0,
        lastAttemptedAt: state?.last_attempted_at ?? null,
        lastSucceededAt: state?.last_succeeded_at ?? null,
        lastSkippedAt: state?.last_skipped_at ?? null,
        lastFailedAt: state?.last_failed_at ?? null,
        consecutiveSkips: state?.consecutive_skips ?? 0,
        consecutiveFailures: state?.consecutive_failures ?? 0,
        lastOutcome: state?.last_outcome ?? null,
        lastObservedSafeHead: state?.last_observed_safe_head ?? null,
        lastSafeHeadObservedAt: state?.last_safe_head_observed_at ?? null,
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
