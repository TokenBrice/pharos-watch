import { TRACKED_META_BY_ID } from "./stablecoins";
import type {
  RedemptionAccessModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
} from "../types";

export type RedemptionCostModel =
  | { kind: "fee-bps"; feeBps: number }
  | { kind: "dynamic-or-unclear" }
  | { kind: "manual-or-unbounded" };

export type RedemptionCapacityModel =
  | { kind: "supply-full" }
  | { kind: "supply-ratio"; ratio: number }
  | { kind: "reserve-sync-metadata"; fallbackRatio?: number };

export interface RedemptionBackstopConfig {
  version: number;
  routeFamily: RedemptionRouteFamily;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
  executionModel: RedemptionExecutionModel;
  outputAssetType: RedemptionOutputAssetType;
  capacityModel: RedemptionCapacityModel;
  costModel: RedemptionCostModel;
  totalScoreCap?: number;
  notes?: string[];
}

function expandIds(
  ids: readonly string[],
  config: RedemptionBackstopConfig,
): Record<string, RedemptionBackstopConfig> {
  return Object.fromEntries(ids.map((id) => [id, config]));
}

const issuerBase: RedemptionBackstopConfig = {
  version: 1,
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: { kind: "dynamic-or-unclear" },
};

const collateralRedeemBase: RedemptionBackstopConfig = {
  version: 1,
  routeFamily: "collateral-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "bluechip-collateral",
  capacityModel: { kind: "supply-full" },
  costModel: { kind: "dynamic-or-unclear" },
};

const queueRedeemBase: RedemptionBackstopConfig = {
  version: 1,
  routeFamily: "queue-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-ratio", ratio: 0.1 },
  costModel: { kind: "dynamic-or-unclear" },
};

export const REDEMPTION_BACKSTOP_CONFIGS: Record<
  string,
  RedemptionBackstopConfig
> = {
  ...expandIds(
    [
      "usdt-tether",
      "usdc-circle",
      "pyusd-paypal",
      "fdusd-first-digital",
      "rlusd-ripple",
      "eurc-circle",
      "usdp-paxos",
      "gusd-gemini",
      "usdg-paxos",
      "usdx-hex-trust",
      "xusd-straitsx",
      "xsgd-straitsx",
      "euri-banking-circle",
      "usdq-quantoz",
      "eurq-quantoz",
      "usd1-world-liberty-financial",
      "ausd-agora",
      "usdo-openeden",
      "usdm-moneta",
    ],
    issuerBase,
  ),
  "cusd-cap": {
    version: 1,
    routeFamily: "basket-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-full" },
    costModel: { kind: "dynamic-or-unclear" },
  },
  "dai-makerdao": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.33 },
    costModel: { kind: "fee-bps", feeBps: 0 },
  },
  "gho-aave": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.13 },
    costModel: { kind: "fee-bps", feeBps: 0 },
  },
  "dola-inverse-finance": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.08 },
    costModel: { kind: "fee-bps", feeBps: 0 },
  },
  "eura-angle": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.30 },
    costModel: { kind: "fee-bps", feeBps: 10 },
  },
  "buck-bucket-protocol": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.25 },
    costModel: { kind: "fee-bps", feeBps: 10 },
  },
  "hollar-hydrated": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: { kind: "dynamic-or-unclear" },
  },
  "dusd-dtrinity": {
    version: 1,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.40 },
    costModel: { kind: "fee-bps", feeBps: 50 },
  },
  ...expandIds(
    [
      "bold-liquity",
      "lusd-liquity",
      "feusd-felix",
      "meusd-mezo",
      "nect-beraborrow",
      "fxusd-f-x-protocol",
    ],
    collateralRedeemBase,
  ),
  "usdaf-asymmetry": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
  },
  "usnd-nerite": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
  },
  "ebusd-ebisu": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
  },
  "alusd-alchemix": {
    version: 1,
    routeFamily: "queue-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.30 },
    costModel: { kind: "dynamic-or-unclear" },
  },
  "iusd-infinifi": {
    ...queueRedeemBase,
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: { kind: "fee-bps", feeBps: 0 },
  },
  "reusd-re-protocol": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.20 },
  },
  "cgusd-cygnus-finance": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
  },
  "uty-xsy": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.30 },
  },
  "usp-pikudao": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: { kind: "fee-bps", feeBps: 20 },
  },
  "aznd-mu-digital": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
  },
  "avusd-avant": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: { kind: "fee-bps", feeBps: 5 },
  },
  "usdu-unitas": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.05 },
  },
  "yzusd-yuzu": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
  },
  "nusd-neutrl": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.20 },
  },
};

for (const stablecoinId of Object.keys(REDEMPTION_BACKSTOP_CONFIGS)) {
  if (!TRACKED_META_BY_ID.has(stablecoinId)) {
    throw new Error(
      `Unknown redemption backstop config id "${stablecoinId}"`,
    );
  }
}

export function getRedemptionBackstopConfig(
  stablecoinId: string,
): RedemptionBackstopConfig | null {
  return REDEMPTION_BACKSTOP_CONFIGS[stablecoinId] ?? null;
}

export function getConfiguredRedemptionBackstopIds(): string[] {
  return Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
}
