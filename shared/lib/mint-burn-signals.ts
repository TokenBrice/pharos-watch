import { clamp } from "./math";

export const NET_FLOW_DIRECTION_24H_VALUES = [
  "minting",
  "burning",
  "flat",
  "inactive",
] as const;

export type NetFlowDirection24h = (typeof NET_FLOW_DIRECTION_24H_VALUES)[number];

export const PRESSURE_SHIFT_STATE_VALUES = [
  "improving",
  "stable",
  "worsening",
  "nr",
] as const;

export type PressureShiftState = (typeof PRESSURE_SHIFT_STATE_VALUES)[number];

export const COIN_FLOW_COMPOSITE_STATE_VALUES = [
  "minting-improving",
  "minting-stable",
  "minting-worsening",
  "minting-nr",
  "burning-improving",
  "burning-stable",
  "burning-worsening",
  "burning-nr",
  "flat-improving",
  "flat-stable",
  "flat-worsening",
  "flat-nr",
  "inactive",
] as const;

export type CoinFlowCompositeState =
  (typeof COIN_FLOW_COMPOSITE_STATE_VALUES)[number];

export const PRESSURE_SHIFT_STABLE_BAND_MAX = 10;

export function getNetFlowDirection24h(input: {
  netFlow24hUsd: number;
  has24hActivity: boolean;
}): NetFlowDirection24h {
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

export function getPressureShiftState(
  score: number | null,
): PressureShiftState {
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
  return clamp(
    ((input.mintVolume24hUsd - input.burnVolume24hUsd) / totalFlow24h) * 100,
    -100,
    100,
  );
}

export function getCoinFlowCompositeState(input: {
  netFlow24hUsd: number;
  has24hActivity: boolean;
  pressureShiftScore: number | null;
}): CoinFlowCompositeState {
  const direction = getNetFlowDirection24h(input);
  if (direction === "inactive") {
    return "inactive";
  }
  const pressureState = getPressureShiftState(input.pressureShiftScore);
  return `${direction}-${pressureState}` as CoinFlowCompositeState;
}
