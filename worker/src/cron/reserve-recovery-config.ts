import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { selectConfigRecoveryTargets } from "../lib/live-reserves/config-recovery-targets";
import { throwIfAborted } from "../lib/abort";
import { runCronWithLease } from "../lib/cron-lease-primitives";
import { recordOutcomeSafe } from "../lib/circuit-breaker";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { loadReserveSyncStateMap, type ReserveSyncStateRecord } from "../lib/live-reserves/store";
import { getReserveAdapter, type AdapterContext } from "./reserve-adapters/index";
import { createReserveAdapterRunner } from "./sync-live-reserves";
import { createAdapterLatencyCollector, syncReserveCoin } from "./sync-live-reserves-core";
import { resolveLiveReserveSyncBudgetConfig } from "./sync-live-reserves-config";
import { CONFIGURED_COINS, type ConfiguredCoin } from "./sync-live-reserves-shared";

const RESERVE_CONFIG_RECOVERY_MAX_COINS = 6;
const RESERVE_CONFIG_RECOVERY_BUDGET_MS = 2 * 60_000;
export const RESERVE_CONFIG_RECOVERY_BACKOFF_SEC = 10 * 60;

type FingerprintRow = { stablecoin_id: string; config_fingerprint: string | null };

/** Missing/legacy snapshots are left to the regular producer; only proven mismatches enter this lane. */
function selectReserveConfigRecoveries(
  coins: readonly ConfiguredCoin[],
  fingerprints: ReadonlyMap<string, string | null>,
  states: ReadonlyMap<string, ReserveSyncStateRecord>,
  now: number,
): ConfiguredCoin[] {
  return coins.filter((coin) => {
    const config = coin.liveReservesConfig;
    const retained = fingerprints.get(coin.id);
    if (!config || config.suspended || retained == null) return false;
    const current = computeLiveReserveConfigFingerprint(config);
    if (retained === current) return false;
    const state = states.get(coin.id);
    return state?.configFingerprint !== current
      || state.lastAttemptedAt == null
      || now - state.lastAttemptedAt >= RESERVE_CONFIG_RECOVERY_BACKOFF_SEC;
  }).sort((a, b) => (states.get(a.id)?.lastAttemptedAt ?? 0) - (states.get(b.id)?.lastAttemptedAt ?? 0));
}

export async function recoverLiveReserveConfigChanges(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx: AdapterContext,
) {
  // The outer scheduled reserve-recovery lease/fence owns this phase. Take the
  // producer's lease too so the four-hourly writer and this targeted writer
  // cannot overlap. Read candidates only AFTER taking it (idempotent on retry).
  const leased = await runCronWithLease(db, "sync-live-reserves", async ({ signal: leaseSignal }) => {
    throwIfAborted(leaseSignal);
    const startedMs = Date.now();
    const deadlineMs = startedMs + RESERVE_CONFIG_RECOVERY_BUDGET_MS;
    // No composition payloads are loaded for the fleet: just fingerprint pairs.
    const rows = await runWithOverloadRetry(() => db.prepare(
      "SELECT stablecoin_id, config_fingerprint FROM reserve_composition WHERE config_fingerprint IS NOT NULL",
    ).all<FingerprintRow>(), 3, leaseSignal);
    const fingerprints = new Map((rows.results ?? []).map((row) => [row.stablecoin_id, row.config_fingerprint]));
    const currentFingerprints = new Map(CONFIGURED_COINS.map((coin) => [coin.id, computeLiveReserveConfigFingerprint(coin.liveReservesConfig!)]));
    const targetIds = new Set(selectConfigRecoveryTargets(fingerprints, currentFingerprints, (id) => {
      const config = TRACKED_META_BY_ID.get(id)?.liveReservesConfig;
      return config != null && getReserveAdapter(config.adapter) != null;
    }));
    const mismatched = CONFIGURED_COINS.filter((coin) => targetIds.has(coin.id));
    const states = await loadReserveSyncStateMap(db, mismatched.map((coin) => coin.id));
    const due = selectReserveConfigRecoveries(CONFIGURED_COINS, fingerprints, states, Math.floor(Date.now() / 1000));
    const budget = resolveLiveReserveSyncBudgetConfig({ runBudgetMs: RESERVE_CONFIG_RECOVERY_BUDGET_MS });
    const attempted: string[] = [];
    const healed: string[] = [];
    const failed: string[] = [];
    const breakerOutcomes = new Map<string, boolean>();
    const breakerCanFetch = new Map<string, boolean>();
    for (const coin of due.slice(0, RESERVE_CONFIG_RECOVERY_MAX_COINS)) {
      throwIfAborted(leaseSignal);
      if (deadlineMs - Date.now() < budget.minimumAttemptBudgetMs) break;
      // Per-coin caches/telemetry are released before the next coin. The shared
      // runner supplies the same body-draining adapters, fallbacks, timeouts and
      // two-operation I/O limiter as the normal sync; no new transport path.
      const runAdapter = createReserveAdapterRunner({
        signal: leaseSignal,
        adapterCtx: { ...adapterCtx, db, requestCache: new Map() },
        adapterTimeoutMs: budget.adapterTimeoutMs,
        telemetry: createAdapterLatencyCollector(),
      });
      const result = await syncReserveCoin({
        db, coin, signal: leaseSignal,
        adapter: getReserveAdapter(coin.liveReservesConfig!.adapter),
        runAdapter: async (attemptCoin, config, adapter, attemptDeadline) => {
          const result = await runAdapter(attemptCoin, config, adapter, (attemptDeadline ?? deadlineMs) - budget.d1FinalizeTimeoutMs);
          throwIfAborted(leaseSignal);
          return result;
        },
        breakerCanFetch,
        previousState: states.get(coin.id) ?? null,
        d1FinalizeTimeoutMs: budget.d1FinalizeTimeoutMs,
        deadlineMs: deadlineMs - budget.finalizationMarginMs,
      });
      attempted.push(coin.id);
      if (result.publishedAt != null) healed.push(coin.id);
      else failed.push(coin.id);
      if (result.breakerOutcome === false || (result.breakerOutcome === true && breakerOutcomes.get(result.breakerKey) !== false)) {
        breakerOutcomes.set(result.breakerKey, result.breakerOutcome);
      }
    }
    for (const [key, success] of breakerOutcomes) {
      throwIfAborted(leaseSignal);
      await recordOutcomeSafe(db, key, success);
    }
    return {
      disposition: "config-recovery-checked",
      mismatchCount: mismatched.length,
      backoffCount: mismatched.length - due.length,
      deferredCount: due.length - attempted.length,
      attempted, healed, failed,
    };
  }, { abortSignal: signal, ttlSec: 180, heartbeatSec: 30 });
  return leased.status === "skipped_locked"
    ? { disposition: "config-recovery-skipped", reason: "sync-live-reserves-lease-held", attempted: [], healed: [], failed: [] }
    : leased.result!;
}
