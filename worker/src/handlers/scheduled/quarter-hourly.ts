/**
 * Quarter-hourly trigger (every 15 min):
 *   sync-fx-rates (2) → sync-stablecoins (3) → snapshot-supply (0)
 *
 * All jobs run sequentially in-slot to avoid cross-job connection spikes.
 * Run FX first so Chainlink gets a clean RPC window before the heavier
 * stablecoin pricing pipeline consumes the slot's shared fetch budget.
 */
import { getCache } from "../../lib/db-cache";
import { sendAlert } from "../../lib/alerts";

import { syncStablecoins } from "../../cron/sync-stablecoins";
import { syncFxRates } from "../../cron/sync-fx-rates";
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotChainSupply } from "../../cron/snapshot-chain-supply";
import { parseStablecoinsCapabilities, type ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runQuarterHourlySlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "quarter-hour slot", "sync-fx-rates", (signal) =>
    syncFxRates(
      runtime.db,
      signal,
      runtime.env.OPENEXCHANGERATES_API_KEY,
      runtime.chainRpcs,
      runtime.env.DRPC_API_KEY ?? null,
      runtime.env.ETHERSCAN_API_KEY ?? null,
    ),
  );

  const stablecoinsResult = await runBestEffortScheduledJob(
    runtime,
    "quarter-hour slot",
    "sync-stablecoins",
    (signal, reportProgress) => syncStablecoins(
      runtime.db,
      runtime.env.CMC_API_KEY,
      signal,
      runtime.alertWebhookUrl,
      runtime.coingeckoApiKey,
      runtime.chainRpcs,
      reportProgress,
    ),
  );
  const stablecoinsCapabilities = parseStablecoinsCapabilities(stablecoinsResult);
  const stablecoinsCacheSafe = stablecoinsCapabilities.stablecoinsCache;
  if (stablecoinsResult && !stablecoinsCacheSafe) {
    console.warn("[cron] sync-stablecoins completed without downstream-safe cache write — skipping dependent jobs");
  }

  if (stablecoinsCacheSafe) {
    await runBestEffortScheduledJob(runtime, "quarter-hour slot", "snapshot-supply", (signal) => snapshotSupply(runtime.db, signal));
  }

  if (stablecoinsCacheSafe) {
    await runBestEffortScheduledJob(runtime, "quarter-hour slot", "snapshot-chain-supply", (signal) => snapshotChainSupply(runtime.db, signal));
  }

  try {
    const cached = await getCache(runtime.db, "stablecoins");
    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
      if (age > 1800) {
        await sendAlert(runtime.alertWebhookUrl, "Data stale", `Stablecoins cache is ${Math.round(age / 60)}min old (expected <20min)`);
      }
    }
  } catch {
    // Non-blocking.
  }
}
