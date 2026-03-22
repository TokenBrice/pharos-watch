import type { RedemptionBackstopConfig } from "./shared";
import {
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
  stablecoinRedeemBase,
} from "./shared";

export const STABLECOIN_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "dusd-dtrinity": {
    ...stablecoinRedeemBase,
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.4 },
    costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
  },
  "ousd-origin-protocol": {
    ...stablecoinRedeemBase,
    costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
    notes: ["Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only"],
  },
  "ousg-ondo-finance": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "Instant mint/redemption at daily NAV via OUSGInstantManager against USDC (T+0 via BUIDL on-chain liquidity)",
    ),
    notes: ["Token transfers restricted to KYC-verified whitelisted addresses on-chain"],
  },
  "syrupusdc-maple": {
    ...stablecoinRedeemBase,
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.3 },
    costModel: documentedVariableFee(
      "ERC-4626 vault; near-instant redemptions via dynamic liquidity buffer; no separate fee disclosed",
    ),
  },
  "syrupusdt-maple": {
    ...stablecoinRedeemBase,
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.3 },
    costModel: documentedVariableFee(
      "ERC-4626 vault; near-instant redemptions via dynamic liquidity buffer; no separate fee disclosed",
    ),
  },
  "yousd-yield-optimizer": {
    ...stablecoinRedeemBase,
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.2 },
    costModel: documentedVariableFee(
      "ERC-4626 vault; instant redemptions up to liquidity buffer, larger withdrawals up to 24h as cross-chain positions unwind",
    ),
  },
  "wsrusd-reservoir": {
    ...stablecoinRedeemBase,
    executionModel: "rules-based-nav",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee("ERC-4626 unwrap to rUSD, then PSM exit to USDC; no separate fee disclosed"),
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("Reservoir Proof of Reserves", "https://app.reservoir.xyz/reserves", ["route", "capacity"]),
    ],
  },
  "usdf-astherus": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
  "usr-resolv": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
  "yusd-aegis": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee("1:1 redemption via Aegis Mint contract; no separate fee disclosed"),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
  "usn-noon": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
  "aid-gaib": {
    ...stablecoinRedeemBase,
    costModel: documentedVariableFee("1:1 mint and burn against accepted stablecoins; no separate fee disclosed"),
  },
  "u-united-stables": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
    ),
  },
  "usd0-usual": {
    ...stablecoinRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
    ),
  },
  "jupusd-jupiter": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.1 },
    costModel: documentedVariableFee(
      "Reserve-backed 1:1 mint and redeem on Solana against USDC; Ethena manages reserve operations",
    ),
  },
  "msusd-main-street": {
    ...stablecoinRedeemBase,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "apxusd-apyx": {
    ...stablecoinRedeemBase,
    costModel: documentedVariableFee(
      "1:1 collateral deposit and redemption through Apyx protocol; POL stability buffer",
    ),
  },
};
