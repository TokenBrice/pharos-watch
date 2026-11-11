import { computeLiveReserveConfigFingerprint, LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { PinnedNativeShareObservationSchema } from "@shared/types/reserve-nav-supply";
import { getReserveAdapter } from "../../src/cron/reserve-adapters/index";
import { createReserveAdapterRunner } from "../../src/cron/reserve-adapter-runner";
import { createAdapterLatencyCollector, syncReserveCoin } from "../../src/cron/sync-live-reserves-core";
import { resolveLiveReserveSyncBudgetConfig } from "../../src/cron/sync-live-reserves-config";
import { STAGED_BOOTSTRAP_COINS } from "../../src/cron/sync-live-reserves-shared";
import { getReserveCompositionRow, getReserveSyncState, didReserveSyncSuccessBecomeAuthoritative } from "../../src/lib/live-reserves/store";
import { parseReserveCompositionRow } from "../../src/lib/live-reserves/store-row-decoding";
import { decodeReserveNavPrice, reserveNavSupplyScopeReason } from "../../src/lib/reserve-nav-price";
import { fetchPinnedNativeShares } from "../../src/cron/sync-stablecoins/supplemental-assets/onchain-supply";
import type { ChainRpcConfig } from "../../src/lib/chain-registry";
import { throwIfAborted } from "../../src/lib/abort";

/** Fixed allowlist: capture a staged row without touching active membership or scoring generations. */
export async function bootstrapJltxxReserves(db: D1Database, chainRpcs: Map<string, ChainRpcConfig>, signal: AbortSignal) {
  const tracked = STAGED_BOOTSTRAP_COINS.find((coin) => coin.id === "jltxx-jpmorgan");
  const config = LiveReservesConfigSchema.safeParse(tracked?.liveReservesConfig);
  if (!tracked || !config.success) {
    throw new Error("JLTXX bootstrap requires the quarantined tracked jpmorgan-nav binding");
  }
  const coin = { ...tracked, liveReservesConfig: config.data };
  const adapter = getReserveAdapter("jpmorgan-nav");
  if (!adapter) throw new Error("JLTXX adapter is unavailable");
  const budgets = resolveLiveReserveSyncBudgetConfig();
  const deadlineMs = Date.now() + budgets.minimumAttemptBudgetMs + budgets.adapterTimeoutMs;
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(budgets.minimumAttemptBudgetMs + budgets.adapterTimeoutMs)]);
  const previousState = await getReserveSyncState(db, coin.id);
  const runAdapter = createReserveAdapterRunner({
    signal: attemptSignal, adapterCtx: { db, chainRpcs, requestCache: new Map() },
    adapterTimeoutMs: budgets.adapterTimeoutMs, telemetry: createAdapterLatencyCollector(),
  });
  const result = await syncReserveCoin({
    db, coin, signal: attemptSignal, adapter, previousState, breakerCanFetch: new Map(),
    d1FinalizeTimeoutMs: budgets.d1FinalizeTimeoutMs, deadlineMs,
    runAdapter: async (...args) => {
      const reserve = await runAdapter(...args);
      const nativeSignal = AbortSignal.any([attemptSignal, AbortSignal.timeout(Math.max(1, Math.min(budgets.adapterTimeoutMs, deadlineMs - Date.now())))]);
      const nativeShares = await fetchPinnedNativeShares(coin, chainRpcs, nativeSignal);
      return {
        ...reserve,
        metadata: { ...reserve.metadata, details: { ...reserve.metadata?.details, nativeShareObservation: nativeShares } },
      };
    },
  });
  throwIfAborted(attemptSignal);
  const [row, state] = await Promise.all([getReserveCompositionRow(db, coin.id), getReserveSyncState(db, coin.id)]);
  const fingerprint = computeLiveReserveConfigFingerprint(config.data);
  if (!row || !state || result.status !== "synced" || result.publishedAt !== row.fetched_at ||
      row.source !== "jpmorgan-nav" || state.adapterKey !== row.source ||
      row.config_fingerprint !== fingerprint || state.configFingerprint !== fingerprint ||
      !row.attempt_id || row.attempt_id !== state.lastSuccessAttemptId || row.attempt_id !== state.lastAttemptId ||
      state.pendingAttemptId != null || state.lastSuccessAt !== row.fetched_at ||
      !await didReserveSyncSuccessBecomeAuthoritative(db, coin.id, row.fetched_at, row.attempt_id)) {
    return { evidenceCaptured: false, admissionAllowed: false, runtimePriceMarketcapPass: false, reason: "bootstrap-authoritative-readback-unavailable", attemptStatus: result.status, configFingerprint: fingerprint };
  }
  const parsed = parseReserveCompositionRow(row, state).record;
  const nav = decodeReserveNavPrice(row);
  const native = PinnedNativeShareObservationSchema.safeParse(parsed?.metadata?.details?.nativeShareObservation);
  const scopeReason = reserveNavSupplyScopeReason(nav, native.success ? native.data : null);
  return {
    evidenceCaptured: nav != null, admissionAllowed: false, runtimePriceMarketcapPass: false,
    reason: scopeReason ?? "explicit-admission-review-and-runtime-price-marketcap-pass-required",
    stablecoinId: coin.id, attemptId: row.attempt_id, configFingerprint: fingerprint,
    reserveFetchedAt: row.fetched_at, navObservedAt: nav?.observedAt ?? null,
    nativeShares: native.success ? native.data : null,
    scopePassed: scopeReason == null,
  };
}
