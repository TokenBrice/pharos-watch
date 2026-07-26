import type { DexApiPool } from "../../lib/dex-api-types";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";

interface SolanaMeasuredExecutionAdapterIdentity {
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"];
  protocol: SolanaMeasuredExecutionTarget["protocol"];
  poolType: SolanaMeasuredExecutionTarget["poolType"];
  provider: "raydium-trade-api" | "jupiter-swap-api";
}

export interface SolanaMeasuredExecutionPriorityTargetIdentity {
  policyId: string;
  targetId: string;
  stablecoinId: string;
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"];
  protocol: SolanaMeasuredExecutionTarget["protocol"];
  poolType: SolanaMeasuredExecutionTarget["poolType"];
  poolId: string;
  tokenInAddress: string;
  tokenInDecimals: number;
  tokenOutAddress: string;
  tokenOutDecimals: number;
  tokenOutTrackedAssetId: string;
}

export type SolanaMeasuredExecutionAdapterRegistration = SolanaMeasuredExecutionAdapterIdentity &
  (
    | { activation: "shadow"; scoreEligible: false }
    | { activation: "active"; scoreEligible: true }
  );

export const SOLANA_MEASURED_EXECUTION_ADAPTERS: readonly SolanaMeasuredExecutionAdapterRegistration[] = [
  {
    adapterProfileId: "raydium-clmm-trade-api-v1",
    protocol: "raydium",
    poolType: "raydium-clmm",
    provider: "raydium-trade-api",
    scoreEligible: false,
    activation: "shadow",
  },
  {
    adapterProfileId: "orca-whirlpool-jupiter-v1",
    protocol: "orca",
    poolType: "orca-whirlpool",
    provider: "jupiter-swap-api",
    scoreEligible: false,
    activation: "shadow",
  },
] as const;

/**
 * Exact target directions with production-validated shadow proofs that must
 * not be crowded out by the much larger discovery inventory. Priority affects
 * collection cadence only; adapter activation remains an independent policy.
 */
export const SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS: readonly SolanaMeasuredExecutionPriorityTargetIdentity[] = [
  {
    policyId: "hyusd-usdc-orca-4tjw-v1",
    targetId:
      "solana-measured-target-v1|orca-whirlpool-jupiter-v1|hyusd-hylo|solana|orca|4tJW2axbTxtT6nKbjB5pZwePtW84cB7E1B6tdCCLGfrC|5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    stablecoinId: "hyusd-hylo",
    adapterProfileId: "orca-whirlpool-jupiter-v1",
    protocol: "orca",
    poolType: "orca-whirlpool",
    poolId: "4tJW2axbTxtT6nKbjB5pZwePtW84cB7E1B6tdCCLGfrC",
    tokenInAddress: "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E",
    tokenInDecimals: 6,
    tokenOutAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tokenOutDecimals: 6,
    tokenOutTrackedAssetId: "usdc-circle",
  },
] as const;

export function getSolanaMeasuredExecutionPriorityTarget(
  target: SolanaMeasuredExecutionTarget,
): SolanaMeasuredExecutionPriorityTargetIdentity | null {
  return (
    SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS.find(
      (entry) =>
        target.targetId === entry.targetId &&
        target.stablecoinId === entry.stablecoinId &&
        target.adapterProfileId === entry.adapterProfileId &&
        target.protocol === entry.protocol &&
        target.poolType === entry.poolType &&
        target.poolId === entry.poolId &&
        target.tokenIn.address === entry.tokenInAddress &&
        target.tokenIn.decimals === entry.tokenInDecimals &&
        target.tokenIn.trackedAssetId === entry.stablecoinId &&
        target.tokenOut.address === entry.tokenOutAddress &&
        target.tokenOut.decimals === entry.tokenOutDecimals &&
        target.tokenOut.trackedAssetId === entry.tokenOutTrackedAssetId,
    ) ?? null
  );
}

export function getSolanaMeasuredExecutionAdapter(
  source: DexApiPool["source"],
  poolType: string,
): SolanaMeasuredExecutionAdapterRegistration | null {
  return (
    SOLANA_MEASURED_EXECUTION_ADAPTERS.find((entry) => entry.protocol === source && entry.poolType === poolType) ?? null
  );
}

export function getSolanaMeasuredExecutionAdapterByProfile(
  adapterProfileId: string,
): SolanaMeasuredExecutionAdapterRegistration | null {
  return SOLANA_MEASURED_EXECUTION_ADAPTERS.find((entry) => entry.adapterProfileId === adapterProfileId) ?? null;
}

export function isSolanaMeasuredExecutionAdapterScoreEligible(
  adapter: SolanaMeasuredExecutionAdapterRegistration,
): boolean {
  return adapter.activation === "active" && adapter.scoreEligible;
}
