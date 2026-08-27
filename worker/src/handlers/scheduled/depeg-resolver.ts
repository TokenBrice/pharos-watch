import type { ScheduledRuntimeContext } from "./context";
import { parseStablecoinsCapabilities } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";
import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";

const DDR_WINDOW_MS = 2 * 60_000;
const DDR_MINIMUM_REMAINING_MS = 60_000;

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

export async function runDepegResolverSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runScheduledSlotGroups(runtime, "fenced depeg resolver slot", [
    {
      mode: "serial",
      label: "depeg-resolver",
      tasks: [
        {
          job: "compute-depeg-resolver",
          run: (signal) =>
            runV9AfterCoreWithinWindow(
              {
                db: runtime.db,
                scheduledTimeMs: runtime.scheduledTimeMs,
                slotStartedAt: runtime.slotStartedAt,
                workerVersion: runtime.workerVersion ?? null,
                signal,
                deadlineOffsetMs: DDR_WINDOW_MS,
                minimumRemainingMs: DDR_MINIMUM_REMAINING_MS,
                lane: "compute-depeg-resolver",
                currentSlotKey: runtime.scheduleKey,
              },
              async (windowSignal) => {
                const capabilities = await loadLatestStablecoinsCapabilities(
                  runtime.db,
                  runtime.slotStartedAt,
                );
                const { computeDepegResolver } = await import(
                  "../../cron/compute-depeg-resolver"
                );
                return computeDepegResolver({
                  db: runtime.db,
                  signal: windowSignal,
                  slot: "scheduled-quarter-hour",
                  stablecoinsCacheSafe: capabilities.stablecoinsCacheSafe,
                  depegPipelineHealthy: capabilities.depegPipelineHealthy,
                  syncCapabilities: capabilities.syncCapabilities,
                });
              },
            ),
        },
      ],
    },
  ]);
}
