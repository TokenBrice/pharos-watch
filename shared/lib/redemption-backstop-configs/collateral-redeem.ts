import type { RedemptionBackstopConfig } from "./shared";
import {
  collateralRedeemBase,
  documentedVariableFee,
  expandIds,
  fixedFee,
  LIQUITY_STYLE_REDEMPTION_FEE,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
} from "./shared";

export const COLLATERAL_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...expandIds(
    ["bold-liquity", "lusd-liquity", "feusd-felix", "meusd-mezo", "nect-beraborrow", "fxusd-f-x-protocol"],
    collateralRedeemBase,
  ),
  "bold-liquity": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "lusd-liquity": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "feusd-felix": {
    ...collateralRedeemBase,
    costModel: fixedFee(0, "Felix docs describe redemption as fee-free"),
  },
  "meusd-mezo": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee("75 bps, or 0 bps when redeeming against your own debt"),
  },
  "nect-beraborrow": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "fxusd-f-x-protocol": {
    ...collateralRedeemBase,
    costModel: fixedFee(50, "Protocol docs list a 50 bps redemption fee"),
  },
  "usdaf-asymmetry": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "usnd-nerite": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "ebusd-ebisu": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "ussd-sonic-labs": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-full" },
    costModel: fixedFee(0, "Zero minting and redemption fees per Sonic Labs documentation"),
  },
  "reusd-resupply": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-full" },
    costModel: fixedFee(100, "Communal redemption model with 1% fee establishing a price floor"),
  },
  "cusd-celo": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-ratio", ratio: 0.5 },
    costModel: documentedVariableFee(
      "Mento AMM burn-to-redeem against reserve assets at oracle rate; circuit breakers enforce safety bounds",
    ),
  },
  "ceur-celo": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-ratio", ratio: 0.5 },
    costModel: documentedVariableFee(
      "BiPoolManager virtual AMM on Celo; mint/burn against reserve assets at oracle-enforced EUR rate; circuit breaker limits",
    ),
  },
  "gyd-gyroscope": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee("Primary-market AMM (PAMM) adjusts redemption prices based on reserve ratio"),
  },
  "usdp-parallel": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee(
      "Parallelizer module: dynamic minting/burning fees adjust to correct peg deviations; depeg penalty applied proportionally",
    ),
  },
  "satusd-river": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(
      "Omni-CDP with $1-of-collateral redemption arbitrage; public fee schedule not disclosed",
    ),
  },
  "fpi-frax": {
    version: 1,
    routeFamily: "collateral-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee(
      "CPI-indexed redemption price grows on-chain per second at 12-month US CPI-U rate; 100% collateral ratio maintained via AMOs",
    ),
  },
};
