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

type ActiveNetFlowDirection24h = Exclude<NetFlowDirection24h, "inactive">;
export type CoinFlowCompositeState =
  | "inactive"
  | `${ActiveNetFlowDirection24h}-${PressureShiftState}`;

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
] as const satisfies readonly CoinFlowCompositeState[];
