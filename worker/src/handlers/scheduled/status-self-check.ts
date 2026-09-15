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
import { normalizeWorkerCanaryMode } from "../../lib/worker-canary-mode";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";
function buildStatusSelfCheckSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "status-self-check",
      tasks: [
        {
          job: "status-self-check",
          errorMessage: "[cron] status-self-check failed in isolated slot:",
          run: (signal, reportProgress) =>
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
        },
        {
          job: "data-invariant-canary",
          errorMessage: "[cron] data-invariant-canary failed in isolated slot:",
          run: (signal) =>
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
        },
        {
          job: "cron-sentinel",
          errorMessage: "[cron] cron-sentinel failed in isolated slot:",
          run: (signal) => runCronSentinel(runtime.db, {
            mode: "status",
            nowSec: Math.floor(Date.now() / 1_000),
            operatorTelegramCreds: buildTelegramOperatorCreds(runtime.env),
            signal,
          }),
        },
      ],
    },
  ];
}

export async function runStatusSelfCheckSlot(runtime: ScheduledRuntimeContext) {
  const summary = await runScheduledSlotGroups(runtime, "isolated status self-check slot", buildStatusSelfCheckSlotGroups(runtime));
  // Collect after the monitors and before the :15 primary, without delaying publication.
  if (isPriceCorroborationSlot(runtime.slotStartedAt)) {
    const startedMs = Date.now();
    try {
      const corroboration = await runPriceCorroboration({
        db: runtime.db,
        syncStartSec: runtime.slotStartedAt,
        signal: runtime.slotSignal,
        cmcApiKey: runtime.env.CMC_API_KEY,
        jupiterApiKey: runtime.env.JUPITER_API_KEY,
        coingeckoApiKey: runtime.coingeckoApiKey,
        chainRpcs: runtime.chainRpcs,
        addressProvider: {
          enabledProviders: runtime.env.ADDRESS_PRICE_PROVIDERS_ENABLED,
          cgApiKey: runtime.coingeckoApiKey,
        },
      });
      const summary = summarizePriceCorroboration(corroboration);
      const degraded = summary.failedPasses.length > 0 || summary.providerDiagnostics.some((row) => !row.success);
      await recordBudgetSurfaceTelemetry(runtime.db, {
        surface: "price-corroboration", durationMs: Date.now() - startedMs,
        dueCount: corroboration.cohortSize, processedCount: corroboration.cacheEntriesWritten,
        outcome: degraded ? "degraded" : "ok",
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null },
      });
      await logCronEvent(runtime.db, {
        job: "sync-stablecoins",
        eventType: "price-corroboration",
        severity: degraded ? "warning" : "info",
        message: `Hourly price corroboration refreshed ${corroboration.cacheEntriesWritten}/${corroboration.cohortSize} cache rows`,
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null, ...summary },
      });
    } catch (error) {
      const errorClass = error instanceof Error && ["Error", "TypeError", "RangeError", "TimeoutError", "AbortError"].includes(error.name)
        ? error.name : "unknown-error";
      await recordBudgetSurfaceTelemetry(runtime.db, {
        surface: "price-corroboration", durationMs: Date.now() - startedMs,
        dueCount: 0, processedCount: 0, outcome: "error", error: errorClass,
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null },
      });
      await logCronEvent(runtime.db, {
        job: "sync-stablecoins", eventType: "price-corroboration", severity: "warning",
        message: "Hourly price corroboration failed before the next stablecoin publication",
        metadata: { slotStartedAt: runtime.slotStartedAt, workerVersion: runtime.workerVersion ?? null,
          errorClass },
      });
    }
  }
  return summary;
}
