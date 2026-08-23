import { clamp } from "./math";
import type { NetFlowDirection24h, PressureShiftState } from "../types/mint-burn-signals";

export { PRESSURE_SHIFT_STATE_VALUES } from "../types/mint-burn-signals";
export type { CoinFlowCompositeState, NetFlowDirection24h, PressureShiftState } from "../types/mint-burn-signals";

const PRESSURE_SHIFT_STABLE_BAND_MAX = 10;

export function getNetFlowDirection24h(input: { netFlow24hUsd: number; has24hActivity: boolean }): NetFlowDirection24h {
  if (!input.has24hActivity) {
    return "inactive";
  }
  if (input.netFlow24hUsd > 0) {
    return "minting";
  }
  if (input.netFlow24hUsd < 0) {
    return "burning";
  }
  return "flat";
}

export function getPressureShiftState(score: number | null): PressureShiftState {
  if (score === null) {
    return "nr";
  }
  if (score > PRESSURE_SHIFT_STABLE_BAND_MAX) {
    return "improving";
  }
  if (score < -PRESSURE_SHIFT_STABLE_BAND_MAX) {
    return "worsening";
  }
  return "stable";
}

export function getLiteralMintingPressureScore(input: {
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
}): number | null {
  const totalFlow24h = input.mintVolume24hUsd + input.burnVolume24hUsd;
  if (totalFlow24h <= 0) {
    return null;
  }
  return clamp(((input.mintVolume24hUsd - input.burnVolume24hUsd) / totalFlow24h) * 100, -100, 100);
}
