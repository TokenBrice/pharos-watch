import { CRON_SCHEDULE_CADENCES } from "./cron-cadences";
import { FluidSwapStatusSchema, FluidSwapUnknownReasonSchema, type FluidSwapStatus } from "../types/dex-liquidity";

export const FLUID_SWAP_STATUS_MAX_AGE_SEC = CRON_SCHEDULE_CADENCES.halfHourlyOffset.intervalSec;

export function hasUnresolvedFluidSwaps(reasons: Readonly<Record<string, number>>): boolean {
  return FluidSwapUnknownReasonSchema.options.some((reason) => reasons[reason] > 0);
}

export function unknownFluidSwapStatus(
  reason: Extract<FluidSwapStatus, { status: "unknown" }>["reason"],
  poolAddress: string | null = null,
  checkedAtSec: number | null = null,
): FluidSwapStatus {
  return { status: "unknown", reason, checkedAtSec, maxAgeSec: FLUID_SWAP_STATUS_MAX_AGE_SEC, poolAddress };
}

export function admitFluidSwapStatus(observation: FluidSwapStatus | undefined, nowSec: number): FluidSwapStatus {
  if (!observation || !FluidSwapStatusSchema.safeParse(observation).success) {
    return unknownFluidSwapStatus("fluid-swap-state-missing");
  }
  if (observation.status === "unknown") return observation;
  if (observation.maxAgeSec !== FLUID_SWAP_STATUS_MAX_AGE_SEC || !Number.isSafeInteger(nowSec) ||
      observation.checkedAtSec > nowSec ||
      nowSec - observation.checkedAtSec >= FLUID_SWAP_STATUS_MAX_AGE_SEC) {
    return unknownFluidSwapStatus("fluid-swap-state-expired", observation.poolAddress, observation.checkedAtSec);
  }
  return observation;
}
