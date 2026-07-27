import type { DexApiPool } from "../../lib/dex-api-types";

export const SUNSWAP_V2_FACTORY_ADDRESS = "TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY" as const;
export const SUNSWAP_V2_FACTORY_CODE_HASH =
  "0x4d942d934b574c09244bf6876f248e0cbac1fa3d18128e8efcb82aa6b234b1fe" as const;
export const SUNSWAP_V2_PAIR_CODE_HASH =
  "0x41625dc36ebfc3d0d2d89132975e84ad64738f2b4ee892f4561cbf33796d14d8" as const;
export const SUNSWAP_V2_ROUTER_QUOTE_URL = "https://rot.endjgfsv.link/swap/routerUniversal" as const;

interface TronMeasuredExecutionAdapterIdentity {
  adapterProfileId: "sunswap-v2-router-v1";
  protocol: "sunswap";
  poolType: "sunswap-v2";
}

export type TronMeasuredExecutionAdapter = TronMeasuredExecutionAdapterIdentity &
  (
    | { activation: "shadow"; scoreEligible: false }
    | { activation: "active"; scoreEligible: true }
  );

const SUNSWAP_V2_ADAPTER: TronMeasuredExecutionAdapter = {
  adapterProfileId: "sunswap-v2-router-v1",
  protocol: "sunswap",
  poolType: "sunswap-v2",
  activation: "active",
  scoreEligible: true,
};

export function getTronMeasuredExecutionAdapter(
  source: DexApiPool["source"],
  poolType: string,
): TronMeasuredExecutionAdapter | null {
  return source === "sunswap" && poolType === "sunswap-v2" ? SUNSWAP_V2_ADAPTER : null;
}

export function getTronMeasuredExecutionAdapterByProfile(
  adapterProfileId: string,
): TronMeasuredExecutionAdapter | null {
  return adapterProfileId === SUNSWAP_V2_ADAPTER.adapterProfileId ? SUNSWAP_V2_ADAPTER : null;
}

export function isTronMeasuredExecutionAdapterScoreEligible(
  adapter: TronMeasuredExecutionAdapter,
): boolean {
  return adapter.activation === "active" && adapter.scoreEligible;
}
