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
import { runBestEffortScheduledJob } from "./run-best-effort-job";

/** Runs the former 08:05 jobs; called from the consolidated 08:00 slot. */
export async function runDaily0805Jobs(runtime: ScheduledRuntimeContext): Promise<void> {
  await Promise.all([
    runBestEffortScheduledJob(runtime, "daily 08:05 slot", "sync-bluechip", (signal) => syncBluechip(runtime.db, signal)),
    (async () => {
      await runBestEffortScheduledJob(runtime, "daily 08:05 slot", "daily-digest", (signal) => {
        return generateDailyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          null,
          false,
          buildTelegramCreds(runtime.env),
          signal,
        );
      });
      await runBestEffortScheduledJob(runtime, "daily 08:05 slot", "weekly-recap", (signal) => {
        return generateWeeklyRecap(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTelegramCreds(runtime.env),
          signal,
        );
      });
    })(),
    runBestEffortScheduledJob(runtime, "daily 08:05 slot", "discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)),
  ]);
}
