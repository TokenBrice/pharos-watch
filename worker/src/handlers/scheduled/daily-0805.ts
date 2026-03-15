import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { generateWeeklyDigest } from "../../cron/weekly-digest";
import { runDiscoveryScan } from "../../cron/discovery-scan";
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";

export function runDaily0805Slot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("sync-bluechip", (signal) => syncBluechip(runtime.db, signal)));

  // Chain weekly digest after daily — sequential to share connection pool.
  // Uses .finally() so weekly runs even if daily fails (it reads from D1, not daily result).
  // The weekly-digest function checks if today is Monday and returns immediately on other days.
  runtime.ctx.waitUntil(
    runtime.runLeasedCron("daily-digest", (signal) => {
      return generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        buildTwitterCreds(runtime.env),
        false,
        buildTelegramCreds(runtime.env),
        signal,
      );
    }).finally(() =>
      runtime.runLeasedCron("weekly-digest", (signal) => {
        return generateWeeklyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTelegramCreds(runtime.env),
          signal,
        );
      }),
    ),
  );

  runtime.ctx.waitUntil(runtime.runLeasedCron("discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)));
}
