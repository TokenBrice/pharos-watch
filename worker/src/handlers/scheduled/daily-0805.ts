import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { runDiscoveryScan } from "../../cron/discovery-scan";
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";

export function runDaily0805Slot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("sync-bluechip", (signal) => syncBluechip(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron("daily-digest", (signal) => {
    return generateDailyDigest(
      runtime.db,
      runtime.env.ANTHROPIC_API_KEY ?? null,
      buildTwitterCreds(runtime.env),
      false,
      buildTelegramCreds(runtime.env),
      signal,
    );
  }));
  runtime.ctx.waitUntil(runtime.runLeasedCron("discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)));
}
