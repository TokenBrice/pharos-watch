import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { throwIfAborted } from "../lib/abort";
import { createLeaseOwner, runCronWithLease } from "../lib/cron-lease-primitives";
import {
  createReserveLeaseOwner,
  RESERVE_CONFIG_RECOVERY_LEASE_SEC,
  type ReserveRecoveryPollIdentity,
} from "../lib/reserve-producer-priority";
import { recordOutcomeSafe } from "../lib/circuit-breaker";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { loadReserveSyncStateMap, type ReserveSyncStateRecord } from "../lib/live-reserves/store";
import { logWorkerEvent } from "../lib/structured-log";
import type { AdapterContext } from "./reserve-adapters/types";
import { resolveLiveReserveSyncBudgetConfig } from "./sync-live-reserves-config";
import { CONFIGURED_COINS, type ConfiguredCoin } from "./sync-live-reserves-shared";

const RESERVE_CONFIG_RECOVERY_MAX_COINS = 6;
const RESERVE_CONFIG_RECOVERY_BUDGET_MS = 2 * 60_000;

type FingerprintRow = {
  stablecoin_id: string;
  config_fingerprint: string;
  binding_source: "snapshot" | "attempt";
};

/** Partition each proven mismatch once so operator counts name its actual hold. */
function partitionReserveConfigRecoveries(
  coins: readonly ConfiguredCoin[],
  attemptedFingerprints: ReadonlyMap<string, string>,
  currentFingerprints: ReadonlyMap<string, string>,
  states: ReadonlyMap<string, ReserveSyncStateRecord>,
  missingFetcherIds: ReadonlySet<string>,
) {
  const suspended: string[] = [];
  const missingFetchers: string[] = [];
  const skippedSameFingerprint: string[] = [];
  const due: ConfiguredCoin[] = [];
  for (const coin of coins) {
    const config = coin.liveReservesConfig!;
    if (attemptedFingerprints.get(coin.id) === currentFingerprints.get(coin.id)) {
      skippedSameFingerprint.push(coin.id);
    } else if (config.suspended) {
      suspended.push(coin.id);
    } else if (missingFetcherIds.has(coin.id)) {
      missingFetchers.push(coin.id);
    } else {
      due.push(coin);
    }
  }
  due.sort((a, b) => (states.get(a.id)?.lastAttemptedAt ?? 0) - (states.get(b.id)?.lastAttemptedAt ?? 0));
  return { suspended, missingFetchers, skippedSameFingerprint, due };
}

export async function recoverLiveReserveConfigChanges(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx: AdapterContext,
  pollIdentity: ReserveRecoveryPollIdentity = {},
) {
  // The outer scheduled reserve-recovery lease/fence owns this phase. Take the
  // producer's lease too so the four-hourly writer and this targeted writer
  // cannot overlap. Read candidates only AFTER taking it (idempotent on retry).
  const leased = await runCronWithLease(db, "sync-live-reserves", async ({ signal: leaseSignal }) => {
    throwIfAborted(leaseSignal);
    const startedMs = Date.now();
    const deadlineMs = startedMs + RESERVE_CONFIG_RECOVERY_BUDGET_MS;
    // Published bindings take priority. Without one, a recorded prior attempt
    // still proves a changed existing config; never bootstrap unattempted feeds.
    // No composition or attempt payloads are loaded, only compact binding rows.
    const rows = await runWithOverloadRetry(() => db.prepare(
      `SELECT stablecoin_id, config_fingerprint, 'snapshot' AS binding_source
         FROM reserve_composition WHERE config_fingerprint IS NOT NULL
       UNION ALL
       SELECT s.stablecoin_id, s.config_fingerprint, 'attempt' AS binding_source
         FROM reserve_sync_state s
        WHERE s.config_fingerprint IS NOT NULL AND s.last_attempted_at > 0`,
    ).all<FingerprintRow>(), 3, leaseSignal);
    const snapshotFingerprints = new Map<string, string>();
    const attemptedFingerprints = new Map<string, string>();
    for (const row of rows.results ?? []) {
      (row.binding_source === "snapshot" ? snapshotFingerprints : attemptedFingerprints)
        .set(row.stablecoin_id, row.config_fingerprint);
    }
    const currentFingerprints = new Map(CONFIGURED_COINS.map((coin) => [coin.id, computeLiveReserveConfigFingerprint(coin.liveReservesConfig!)]));
    const priorBindingSources = { snapshot: 0, attempt: 0 };
    const mismatched = CONFIGURED_COINS.filter((coin) => {
      const snapshot = snapshotFingerprints.get(coin.id);
      const prior = snapshot ?? attemptedFingerprints.get(coin.id);
      if (prior == null || prior === currentFingerprints.get(coin.id)) return false;
      priorBindingSources[snapshot != null ? "snapshot" : "attempt"]++;
      return true;
    });
    const states = await loadReserveSyncStateMap(db, mismatched.map((coin) => coin.id));
    const initial = partitionReserveConfigRecoveries(
      mismatched, attemptedFingerprints, currentFingerprints, states, new Set(),
    );
    // Consumed and suspended opportunities never initialize adapter machinery.
    const adapterRegistry = initial.due.length > 0 ? await import("./reserve-adapters/index") : null;
    const missingFetcherIds = new Set(initial.due.filter((coin) =>
      adapterRegistry!.getReserveAdapter(coin.liveReservesConfig!.adapter) == null,
    ).map((coin) => coin.id));
    const partition = partitionReserveConfigRecoveries(
      mismatched, attemptedFingerprints, currentFingerprints, states, missingFetcherIds,
    );
    const { due } = partition;
    const warnings = partition.missingFetchers.map((stablecoinId) => ({
      stablecoinId, code: "config-recovery-missing-fetcher", severity: "warning" as const,
    }));
    for (const warning of warnings) {
      logWorkerEvent({
        scope: "handler", level: "warn", job: "reserve-recovery",
        event: warning.code, message: "Skipping live reserve config mismatch without a registered fetcher",
        metadata: { stablecoinId: warning.stablecoinId },
      });
    }
    const budget = resolveLiveReserveSyncBudgetConfig({ runBudgetMs: RESERVE_CONFIG_RECOVERY_BUDGET_MS });
    const attempted: string[] = [];
    const healed: string[] = [];
    const failed: string[] = [];
    const breakerOutcomes = new Map<string, boolean>();
    const breakerCanFetch = new Map<string, boolean>();
    // Initialize execution machinery only when a coin can actually be retried.
    const execution = due.length > 0 ? await Promise.all([
      import("./reserve-adapter-runner"),
      import("./sync-live-reserves-core"),
    ]) : null;
    for (const coin of due.slice(0, RESERVE_CONFIG_RECOVERY_MAX_COINS)) {
      throwIfAborted(leaseSignal);
      if (deadlineMs - Date.now() < budget.minimumAttemptBudgetMs) break;
      // Per-coin caches/telemetry are released before the next coin. The shared
      // runner supplies the same body-draining adapters, fallbacks, timeouts and
      // two-operation I/O limiter as the normal sync; no new transport path.
      const runAdapter = execution![0].createReserveAdapterRunner({
        signal: leaseSignal,
        adapterCtx: { ...adapterCtx, db, requestCache: new Map() },
        adapterTimeoutMs: budget.adapterTimeoutMs,
        telemetry: execution![1].createAdapterLatencyCollector(),
      });
      const result = await execution![1].syncReserveCoin({
        db, coin, signal: leaseSignal,
        adapter: adapterRegistry!.getReserveAdapter(coin.liveReservesConfig!.adapter),
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
      disposition: warnings.length > 0 ? "config-recovery-partial" : "config-recovery-checked",
      mismatchCount: mismatched.length,
      priorBindingSources,
      suspendedCount: partition.suspended.length,
      missingFetcherCount: partition.missingFetchers.length,
      skippedSameFingerprint: partition.skippedSameFingerprint,
      skippedSameFingerprintCount: partition.skippedSameFingerprint.length,
      dueCount: due.length,
      attemptedCount: attempted.length,
      deferredCount: due.length - attempted.length,
      warnings, attempted, healed, failed,
    };
  }, {
    abortSignal: signal, ttlSec: RESERVE_CONFIG_RECOVERY_LEASE_SEC, heartbeatSec: 30,
    reserveRecoveryAdmission: true,
    owner: createReserveLeaseOwner(createLeaseOwner("reserve-recovery"), "reserve-recovery", "reserve-config-recovery", pollIdentity),
  });
  if (leased.status === "skipped_neutral") {
    return { disposition: "config-recovery-priority", reason: leased.producerPriority!.reason,
      producerPriority: leased.producerPriority, attemptedCount: 0, attempted: [], healed: [], failed: [] };
  }
  return leased.status === "skipped_locked"
    ? { disposition: "config-recovery-skipped", reason: "sync-live-reserves-lease-held", blockedBy: leased.blockedBy,
      attempted: [], healed: [], failed: [] }
    : leased.result!;
}
