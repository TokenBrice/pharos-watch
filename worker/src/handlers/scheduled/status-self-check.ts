import { rethrowIfAborted } from "../../lib/abort";
import { runPriceDexRefresh } from "../../cron/sync-stablecoins/price-dex-refresh";
import { recordBudgetSurfaceTelemetry } from "../../lib/budget-surface-telemetry";
import { logCronEvent } from "../../lib/cron-logger";
import {
  isPriceCorroborationSlot,
  runPriceCorroboration,
  summarizePriceCorroboration,
} from "../../cron/sync-stablecoins/price-corroboration";
import { runDataInvariantCanary } from "../../cron/data-invariant-canary";
import { runStatusSelfCheck } from "../../cron/status-self-check";
import { runCronSentinel } from "../../cron/cron-sentinel";
import { buildTelegramOperatorCreds } from "../../lib/runtime-credentials";
import { resolveCloudflareD1StatusConfig } from "../../lib/env";
import { normalizeWorkerCanaryMode } from "../../lib/canary-checks";
import { runRuntimeBudgetOnlyTask, type ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

export function buildStatusSelfCheckSlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("statusSelfCheckOffset", {
    mode: "serial",
    label: "status-self-check",
    implementations: {
      "status-self-check": (signal, reportProgress) =>
        runStatusSelfCheck(runtime.db, {
          selfUrl: runtime.env.SELF_URL,
          signal,
          reportProgress,
          ctx: runtime.ctx,
          mintBurnFreshnessConfig: runtime.mintBurnFreshnessConfig,
          siteApiSharedSecret: runtime.env.SITE_API_SHARED_SECRET,
          d1StatusConfig: resolveCloudflareD1StatusConfig(runtime.env) ?? undefined,
          coingeckoApiKey: runtime.coingeckoApiKey,
          workerCanaryMode: normalizeWorkerCanaryMode(runtime.env.WORKER_CANARY_MODE),
        }),
      "data-invariant-canary": (signal) =>
        runDataInvariantCanary(runtime.db, {
          mode: runtime.env.WORKER_CANARY_MODE,
          // The serial slot can reach the canary after a newer producer
          // publication. Freshness checks must use execution time; the
          // scheduled slot clock remains available in cron telemetry.
          observedAt: Math.max(
            runtime.slotStartedAt,
            Math.floor(Date.now() / 1_000),
          ),
          signal,
        }),
      "cron-sentinel": (signal) => runCronSentinel(runtime.db, {
        mode: "status",
        nowSec: Math.floor(Date.now() / 1_000),
        operatorTelegramCreds: buildTelegramOperatorCreds(runtime.env),
        signal,
      }),
    },
  });
}

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext) {
  const summary = await runScheduledSlotGroups(runtime, "isolated status self-check slot", buildStatusSelfCheckSlotGroups(runtime));
  // Collect after the monitors and before the :15 primary, without delaying publication.
  {
    const startedMs = Date.now();
    try {
      // Declared in the registry as a budget-only entry (maxConnections 4);
      // calling it outside the wrapper spent those fetches unaccounted.
      const collected = await runRuntimeBudgetOnlyTask(
        runtime,
        "price-corroboration",
        async (signal) => {
          const phaseErrors: Record<string, string> = {};
          const collect = async <T>(phase: string, run: () => Promise<T>): Promise<T | null> => {
            try { return await run(); } catch (error) {
              rethrowIfAborted(error, signal);
              phaseErrors[phase] = error instanceof Error && ["Error", "TypeError", "RangeError", "TimeoutError", "AbortError"].includes(error.name)
                ? error.name : "unknown-error";
              return null;
            }
          };
          const addressProvider = { enabledProviders: runtime.env.ADDRESS_PRICE_PROVIDERS_ENABLED,
            cgApiKey: runtime.coingeckoApiKey };
          const dex = await collect("dex-refresh", () => runPriceDexRefresh({ db: runtime.db, syncStartSec: runtime.slotStartedAt, signal, addressProvider }));
          const corroboration = isPriceCorroborationSlot(runtime.slotStartedAt)
            ? await collect("hourly", () => runPriceCorroboration({
                db: runtime.db, syncStartSec: runtime.slotStartedAt, signal,
                cmcApiKey: runtime.env.CMC_API_KEY, jupiterApiKey: runtime.env.JUPITER_API_KEY,
                coingeckoApiKey: runtime.coingeckoApiKey, chainRpcs: runtime.chainRpcs,
                addressProvider,
              })) : null;
          return { dex, corroboration, phaseErrors };
        },
      );
      const summary = collected.corroboration ? summarizePriceCorroboration(collected.corroboration) : null;
      const dex = collected.dex;
      const phaseFailed = Object.keys(collected.phaseErrors).length > 0;
      // Cohort composition (assets with no reviewed DEX target or no DEX market)
      // is not a lane failure: unsupportedAssets and missingQuotes stay telemetry
      // metadata only. Transport failures, timeouts, budget-exhaustion deferrals,
      // phase errors, hourly pass/provider failures, and a slot where no
      // previously resolvable exact route produced a quote still degrade.
      // A slot refused only by DexScreener's shared-egress throttle is recorded
      // as a circuit failure instead: three consecutive throttled slots open the
      // refresh circuit, and the resulting `circuit-open` class degrades.
      // The address coverage lane degrades on its own terms: its circuit state,
      // a spent deadline, or a failed request all mean the rows only this lane
      // can price lose their quote before the next publication.
      const throttledOnly = !!dex && !dex.timedOut && dex.errorClasses.length > 0
        && dex.errorClasses.every((errorClass) => errorClass === "rate-limited");
      const addressRefreshRefused = !!dex?.addressRefresh?.enabled
        && (dex.addressRefresh.circuitOpen || dex.addressRefresh.timedOut || dex.addressRefresh.failureClasses.length > 0);
      const degraded = phaseFailed
        || !!dex && !throttledOnly && (dex.errorClasses.length > 0 || dex.timedOut || dex.deferredBatches > 0
          || (dex.hintedAttempted > 0 && dex.hintedResolved === 0))
        || addressRefreshRefused
        || !!summary && (summary.failedPasses.length > 0 || summary.providerDiagnostics.some((row) => !row.success));
      await recordBudgetSurfaceTelemetry(runtime.db, {
        surface: "price-corroboration", durationMs: Date.now() - startedMs,
        dueCount: collected.corroboration?.cohortSize ?? dex?.cohortSize ?? 0, processedCount: collected.corroboration?.cacheEntriesWritten ?? dex?.resolved ?? 0,
        outcome: phaseFailed ? "error" : degraded ? "degraded" : "ok",
        ...(phaseFailed ? { error: Object.values(collected.phaseErrors)[0] } : {}),
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null, dexRefresh: dex, addressRefresh: dex?.addressRefresh ?? null, phaseErrors: collected.phaseErrors, ...(phaseFailed ? { errorClass: Object.values(collected.phaseErrors)[0] } : {}) },
      });
      await logCronEvent(runtime.db, {
        job: "sync-stablecoins",
        eventType: "price-corroboration",
        severity: degraded ? "warning" : "info",
        message: `Price observation collection refreshed ${dex?.resolved ?? 0}/${dex?.cohortSize ?? 0} DEX rows`
          + `${dex?.addressRefresh.enabled ? ` and ${dex.addressRefresh.resolved}/${dex.addressRefresh.cohortSize} exact-address rows` : ""}`
          + `${summary ? " and completed hourly corroboration" : ""}`,
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null, ...(summary ?? {}), dexRefresh: dex, addressRefresh: dex?.addressRefresh ?? null, phaseErrors: collected.phaseErrors, ...(phaseFailed ? { errorClass: Object.values(collected.phaseErrors)[0] } : {}) },
      });
    } catch (error) {
      rethrowIfAborted(error, runtime.slotSignal);
      const errorClass = error instanceof Error && ["Error", "TypeError", "RangeError", "TimeoutError", "AbortError"].includes(error.name)
        ? error.name : "unknown-error";
      await recordBudgetSurfaceTelemetry(runtime.db, {
        surface: "price-corroboration", durationMs: Date.now() - startedMs,
        dueCount: 0, processedCount: 0, outcome: "error", error: errorClass,
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null },
      });
      await logCronEvent(runtime.db, {
        job: "sync-stablecoins", eventType: "price-corroboration", severity: "warning",
        message: "Price observation collection failed before the next stablecoin publication",
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null,
          errorClass },
      });
    }
  }
  return summary;
}
