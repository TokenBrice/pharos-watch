/**
 * Daily 08:05 UTC trigger (5 8 * * *):
 *   sync-bluechip (1)          ← parallel waitUntil
 *   daily-digest (1) → weekly-digest (1)  ← chained to share connection pool
 *   discovery-scan (1)         ← parallel waitUntil
 *
 * Digests are chained; bluechip and discovery run as independent waitUntil
 * promises. Worst case all four run concurrently but each uses only 1 conn.
 * Connection budget: 4/6 peak (unlikely; digests are chained so typically 3/6)
 */
import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { generateWeeklyRecap } from "../../cron/weekly-recap";
import { runDiscoveryScan } from "../../cron/discovery-scan";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";

export async function runDaily0805Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await Promise.all([
    runtime.runLeasedCron("sync-bluechip", (signal) => syncBluechip(runtime.db, signal)),
    runtime.runLeasedCron("daily-digest", (signal) => {
      return generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        null,
        false,
        buildTelegramCreds(runtime.env),
        signal,
      );
    }).finally(() =>
      runtime.runLeasedCron("weekly-recap", (signal) => {
        return generateWeeklyRecap(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTelegramCreds(runtime.env),
          signal,
        );
      }),
    ),
    runtime.runLeasedCron("discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)),
  ]);
}
