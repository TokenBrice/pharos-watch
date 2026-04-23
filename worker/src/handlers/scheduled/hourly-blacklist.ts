import { createRateLimiter } from "../../lib/evm-logs";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncBlacklist } from "../../cron/sync-blacklist";
import type { ScheduledRuntimeContext } from "./context";
import { runCircuitGatedLeasedScheduledJob } from "./run-circuit-gated-job";

export async function runSixHourlyBlacklistSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const etherscanKey = runtime.env.ETHERSCAN_API_KEY ?? null;
  await runCircuitGatedLeasedScheduledJob(runtime, {
    circuitSource: CIRCUIT_SOURCE.ETHERSCAN,
    outcomeLabel: "Etherscan",
    skipMessage: "[cron] Etherscan circuit open — skipping blacklist sync",
    job: "sync-blacklist",
    fn: (signal, reportProgress) => {
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
    },
  });
}
