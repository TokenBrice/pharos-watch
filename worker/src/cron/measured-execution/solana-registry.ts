import type { DexApiPool } from "../../lib/dex-api-types";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";

interface SolanaMeasuredExecutionAdapterIdentity {
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"];
  protocol: SolanaMeasuredExecutionTarget["protocol"];
  poolType: SolanaMeasuredExecutionTarget["poolType"];
  provider: "raydium-trade-api" | "jupiter-swap-api";
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
