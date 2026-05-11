/**
 * Daily 08:05 UTC trigger (5 8 * * *):
 *   sync-bluechip (3)          ← parallel waitUntil
 *   daily-digest (1) → weekly-digest (1)  ← chained to share connection pool
 *
 * Digests are chained; bluechip runs as an independent waitUntil promise.
 * Worst case peak is bluechip batch (3) + digest chain (1).
 * Connection budget: 4/6 peak.
 */
import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { generateWeeklyRecap } from "../../cron/weekly-recap";
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runDaily0805Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await Promise.all([
    runBestEffortScheduledJob(runtime, "daily 08:05 slot", "sync-bluechip", (signal) => syncBluechip(runtime.db, signal)),
    (async () => {
      await runBestEffortScheduledJob(runtime, "daily 08:05 slot", "daily-digest", (signal) => {
        return generateDailyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTwitterCreds(runtime.env),
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
  ]);
}
