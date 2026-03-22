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
    costModel: fixedFee(75, "75 bps standard; 0 bps when redeeming against your own debt"),
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
    ...collateralRedeemBase,
    outputAssetType: "stable-single",
    costModel: fixedFee(0, "Zero minting and redemption fees per Sonic Labs documentation"),
  },
  "reusd-resupply": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: fixedFee(100, "Communal redemption model with 1% fee establishing a price floor"),
  },
  "cusd-celo": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-ratio", ratio: 0.5 },
    costModel: documentedVariableFee(
      "Mento AMM burn-to-redeem against reserve assets at oracle rate; circuit breakers enforce safety bounds",
    ),
  },
  "ceur-celo": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    capacityModel: { kind: "supply-ratio", ratio: 0.5 },
    costModel: documentedVariableFee(
      "BiPoolManager virtual AMM on Celo; mint/burn against reserve assets at oracle-enforced EUR rate; circuit breaker limits",
    ),
  },
  "gyd-gyroscope": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee("Primary-market AMM (PAMM) adjusts redemption prices based on reserve ratio"),
  },
  "usdp-parallel": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
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
  "usbd-bima": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redemption fee = coreRate + 75 bps; coreRate rises with redeemed supply and decays with a 24-hour half-life",
      "formula",
    ),
    notes: [
      "Docs also describe a PSM against USDC, USDP, and GUSD, but the primary modeled exit is direct redemption into BTC-derivative vault collateral",
    ],
  },
  "fpi-frax": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "CPI-indexed redemption price grows on-chain per second at 12-month US CPI-U rate; 100% collateral ratio maintained via AMOs",
    ),
  },
};
