import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { parseStablecoinsCapabilities } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

const V9_SUPPLY_WINDOW_MS = 3 * 60_000;
const V9_SUPPLY_MINIMUM_REMAINING_MS = 60_000;
// Covers DDR abort propagation, terminal-row persistence, and serial handoff
// before attribution evaluates its minimum-remaining admission contract.
const DDR_HANDOFF_MARGIN_MS = 10_000;

function ddrBudgetExhausted(): CronResult {
  const reason = "ddr-budget-exhausted";
  return {
    status: "skipped_neutral",
    itemCount: 0,
    metadata: JSON.stringify({ reason }),
    productivity: {
      productive: false,
      reason,
    },
  };
}

interface StablecoinsCapabilityRow {
  metadata: string | null;
  started_at: number;
}

async function loadLatestStablecoinsCapabilities(
  db: D1Database,
  nowSec: number,
) {
  const row = await db
    .prepare(
      `SELECT metadata, started_at
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .first<StablecoinsCapabilityRow>();
  const capabilities = parseStablecoinsCapabilities(
    row ? { metadata: row.metadata ?? undefined } : null,
  );
  const stale = row == null || row.started_at < nowSec - 30 * 60;
  return {
    stablecoinsCacheSafe: !stale && capabilities.stablecoinsCache,
    depegPipelineHealthy: !stale && capabilities.depegPipeline,
    syncCapabilities: {
      ...capabilities,
      source: "latest-sync-stablecoins-cron-run",
      latestSyncStartedAt: row?.started_at ?? null,
      stale,
    },
  };
}

export async function runV9SupplyAttributionSlot(
  runtime: ScheduledRuntimeContext,
) {
  const scheduledTimeMs =
    runtime.scheduledTimeMs ?? runtime.slotStartedAt * 1_000;
  const ddrDeadlineMs =
    scheduledTimeMs + V9_SUPPLY_WINDOW_MS -
    V9_SUPPLY_MINIMUM_REMAINING_MS - DDR_HANDOFF_MARGIN_MS;

  return runScheduledSlotGroups(runtime, "fenced V9 supply-attribution slot", [
    {
      mode: "serial",
      label: "v9-supply-ddr",
      tasks: [
        // Capture before DDR allocates its large review graph. Both jobs share
        // one Worker isolate even though they are serial, so running DDR first
        // can leave enough live heap for the observer import to exceed the
        // isolate memory limit.
        {
          job: "sync-v9-supply-attribution",
          run: (signal) =>
            runV9AfterCoreWithinWindow(
              {
                db: runtime.db,
                scheduledTimeMs: runtime.scheduledTimeMs,
                slotStartedAt: runtime.slotStartedAt,
                workerVersion: runtime.workerVersion ?? null,
                signal,
                deadlineOffsetMs: V9_SUPPLY_WINDOW_MS,
                minimumRemainingMs:
                  V9_SUPPLY_MINIMUM_REMAINING_MS,
                lane: "sync-v9-supply-attribution",
                currentSlotKey: runtime.scheduleKey,
              },
              (windowSignal) =>
                import("../../cron/sync-v9-supply-attribution").then(
                  ({ syncSafetyScoreV9SupplyAttribution }) =>
                    syncSafetyScoreV9SupplyAttribution(
                      runtime.db,
                      runtime.chainRpcs,
                      windowSignal,
                    ),
                ),
            ),
        },
        // DDR is D1-only and reads the latest stablecoins capability metadata,
        // not the supply-attribution generation captured above. Import it only
        // after capture so its module and run-scoped review state cannot raise
        // the observer's peak heap.
        {
          job: "compute-depeg-resolver",
          run: async (signal) => {
            const remainingMs = ddrDeadlineMs - Date.now();
            if (remainingMs <= 0) return ddrBudgetExhausted();

            // This is cooperative mitigation only: it cannot contain an
            // isolate OOM or a D1 stall that ignores cancellation. Hard
            // containment would require a separate physical trigger.
            const timeout = createTimeoutSignal({
              timeoutMs: remainingMs,
              timeoutReason: new DOMException(
                "compute-depeg-resolver exceeded its V9 supply attribution admission budget",
                "TimeoutError",
              ),
              parentSignal: signal,
            });
            try {
              const capabilities = await loadLatestStablecoinsCapabilities(
                runtime.db,
                runtime.slotStartedAt,
              );
              const { computeDepegResolver } = await import(
                "../../cron/compute-depeg-resolver"
              );
              return await computeDepegResolver({
                db: runtime.db,
                signal: timeout.signal,
                slot: "v9-supply-attribution-follow-up",
                stablecoinsCacheSafe: capabilities.stablecoinsCacheSafe,
                depegPipelineHealthy: capabilities.depegPipelineHealthy,
                syncCapabilities: capabilities.syncCapabilities,
              });
            } finally {
              timeout.dispose();
            }
          },
        },
      ],
    },
  ]);
}
