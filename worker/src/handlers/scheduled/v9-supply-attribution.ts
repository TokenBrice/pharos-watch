import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import { computeDepegResolver } from "../../cron/compute-depeg-resolver";
import type { ScheduledRuntimeContext } from "./context";
import { parseStablecoinsCapabilities } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

const V9_SUPPLY_WINDOW_MS = 3 * 60_000;
const V9_SUPPLY_MINIMUM_REMAINING_MS = 60_000;

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
  return runScheduledSlotGroups(runtime, "fenced V9 supply-attribution slot", [
    {
      mode: "serial",
      label: "v9-supply-ddr",
      tasks: [
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
        {
          job: "compute-depeg-resolver",
          run: async (signal) => {
            const capabilities = await loadLatestStablecoinsCapabilities(
              runtime.db,
              runtime.slotStartedAt,
            );
            return computeDepegResolver({
              db: runtime.db,
              signal,
              slot: "v9-supply-attribution-follow-up",
              stablecoinsCacheSafe: capabilities.stablecoinsCacheSafe,
              depegPipelineHealthy: capabilities.depegPipelineHealthy,
              syncCapabilities: capabilities.syncCapabilities,
            });
          },
        },
      ],
    },
  ]);
}
