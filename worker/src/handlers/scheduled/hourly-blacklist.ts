import { createRateLimiter } from "../../lib/evm-logs";
import { syncBlacklist } from "../../cron/sync-blacklist";
import type { ScheduledRuntimeContext } from "./context";
import { runSinglePropagatingSlotJob } from "./slot-summary";

export async function runSixHourlyBlacklistSlot(runtime: ScheduledRuntimeContext) {
  const etherscanKey = runtime.env.ETHERSCAN_API_KEY ?? null;
  return runSinglePropagatingSlotJob(runtime, "sync-blacklist", (signal, reportProgress) => {
    const etherscanRL = createRateLimiter(4);
    return syncBlacklist({
      db: runtime.db,
      etherscanApiKey: etherscanKey,
      trongridApiKey: runtime.env.TRONGRID_API_KEY ?? null,
      drpcApiKey: runtime.env.DRPC_API_KEY ?? null,
      externalEtherscanRL: etherscanRL,
      signal,
      onProgress: reportProgress,
      chainRpcs: runtime.chainRpcs,
    });
  });
}
