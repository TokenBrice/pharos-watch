import { createRateLimiter } from "../../lib/evm-logs";
import { mapCronStatusToCircuitOutcome, recordOutcomeDecision, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncBlacklist } from "../../cron/sync-blacklist";
import type { ScheduledRuntimeContext } from "./context";

export async function runHourlyBlacklistSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const etherscanAllowed = await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.ETHERSCAN);
  if (!etherscanAllowed) {
    console.warn("[cron] Etherscan circuit open — skipping blacklist sync");
    return;
  }

  const etherscanRL = createRateLimiter(4);
  const etherscanKey = runtime.env.ETHERSCAN_API_KEY ?? null;
  const blacklistJob = runtime.runLeasedCron("sync-blacklist", (signal, reportProgress) =>
    syncBlacklist({
      db: runtime.db,
      etherscanApiKey: etherscanKey,
      trongridApiKey: runtime.env.TRONGRID_API_KEY ?? null,
      drpcApiKey: runtime.env.DRPC_API_KEY ?? null,
      externalEtherscanRL: etherscanRL,
      signal,
      onProgress: reportProgress,
      chainRpcs: runtime.chainRpcs,
    }),
  );

  try {
    const result = await blacklistJob;
    await recordOutcomeDecision(
      runtime.db,
      CIRCUIT_SOURCE.ETHERSCAN,
      mapCronStatusToCircuitOutcome(result?.status),
    ).catch((err) => {
      console.error("[cron] Failed to record Etherscan success outcome:", err);
    });
  } catch (err) {
    await recordOutcomeDecision(runtime.db, CIRCUIT_SOURCE.ETHERSCAN, "failure").catch((outcomeErr) => {
      console.error("[cron] Failed to record Etherscan failure outcome:", outcomeErr);
    });
    throw err;
  }
}
