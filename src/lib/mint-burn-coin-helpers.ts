import type { MintBurnCoinFlow } from "@shared/types";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";

/** Canonical activity inference — checks explicit flag first, then derives from fields. */
export function inferHas24hActivity(coin: MintBurnCoinFlow): boolean {
  if (coin.has24hActivity !== undefined) return coin.has24hActivity;
  return Boolean(
    coin.mintCount24h
    || coin.burnCount24h
    || coin.mintVolume24hUsd
    || coin.burnVolume24hUsd
    || coin.netFlow24hUsd,
  );
}

export function resolvePressureScore(coin: MintBurnCoinFlow): number | null {
  return coin.pressureShiftScore ?? coin.flowIntensity;
}

export function resolvePressureState(coin: MintBurnCoinFlow): PressureShiftState {
  return coin.pressureShiftState ?? getPressureShiftState(resolvePressureScore(coin));
}

export function resolveNetDirection(coin: MintBurnCoinFlow): NetFlowDirection24h {
  return coin.netFlowDirection24h
    ?? getNetFlowDirection24h({
      netFlow24hUsd: coin.netFlow24hUsd,
      has24hActivity: inferHas24hActivity(coin),
    });
}
