import { TRACKED_META_BY_ID } from "./stablecoins";
import type {
  RedemptionAccessModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
} from "../types";

export type RedemptionCostModel =
  | { kind: "fee-bps"; feeBps: number; feeDescription?: string }
  | { kind: "dynamic-or-unclear"; feeDescription?: string }
  | { kind: "manual-or-unbounded"; feeDescription?: string };

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

function fixedFee(
  feeBps: number,
  feeDescription?: string,
): RedemptionCostModel {
  return feeDescription
    ? { kind: "fee-bps", feeBps, feeDescription }
    : { kind: "fee-bps", feeBps };
}

function documentedVariableFee(
  feeDescription: string,
): RedemptionCostModel {
  return { kind: "dynamic-or-unclear", feeDescription };
}

const NO_PUBLIC_NUMERIC_REDEMPTION_FEE =
  "Public docs reviewed do not publish a numeric redemption fee.";
const LIQUITY_STYLE_REDEMPTION_FEE =
  "Minimum 50 bps + baseRate (decays over time).";

const issuerBase: RedemptionBackstopConfig = {
  version: 1,
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
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
      "usdcv-societe-generale-forge",
      "usdh-native-markets",
      "fidd-fidelity",
      "usdgo-osl",
      "wusd-worldwide",
      "sbc-brale",
      "usda-anzens",
      "eurcv-societe-generale-forge",
      "aeur-anchored-coins",
      "eure-monerium",
      "usdr-stablr",
      "eurr-stablr",
      "europ-schuman",
      "eurau-allunity",
    ],
    issuerBase,
  ),
  "usdt-tether": {
    ...issuerBase,
    costModel: documentedVariableFee("0.10% with a $1,000 minimum"),
  },
  "usdc-circle": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary",
    ),
  },
  "pyusd-paypal": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a PYUSD redemption fee; bank or network fees may still apply",
    ),
  },
  "fdusd-first-digital": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Redeemable 1:1; public fee schedule not disclosed",
    ),
  },
  "rlusd-ripple": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Redeemable 1:1 less fees; public fee schedule not disclosed",
    ),
  },
  "eurc-circle": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "EEA burn fee is 0 bps; other Circle redemption fees may vary",
    ),
  },
  "usdp-paxos": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a USDP redemption fee",
    ),
  },
  "gusd-gemini": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Gemini describes GUSD conversion and redemption as fee-free",
    ),
  },
  "usdg-paxos": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a USDG redemption fee",
    ),
  },
  "usdx-hex-trust": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Redeemable through approved parties; public fee schedule not disclosed",
    ),
  },
  "xusd-straitsx": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "No platform conversion fee; bank or network fees may apply",
    ),
  },
  "xsgd-straitsx": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "No platform conversion fee; bank or network fees may apply",
    ),
  },
  "euri-banking-circle": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Issuer docs describe EURI redemption as fee-free at par",
    ),
  },
  "usdq-quantoz": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Issuer docs describe redemption as free of charge; bank fees may still apply",
    ),
  },
  "eurq-quantoz": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Issuer docs describe redemption as free of charge; bank fees may still apply",
    ),
  },
  "usd1-world-liberty-financial": {
    ...issuerBase,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "ausd-agora": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Fees may apply; public docs do not publish a fixed redemption rate",
    ),
  },
  "usdo-openeden": {
    ...issuerBase,
    costModel: fixedFee(
      10,
      "OpenEden docs list a 10 bps redemption fee",
    ),
  },
  "usdm-moneta": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Redeemable 1:1; public fee schedule not disclosed",
    ),
  },
  "cusd-cap": {
    version: 1,
    routeFamily: "basket-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee(
      "Fixed redemption fee, but public docs do not publish the current rate",
    ),
  },
  "dai-makerdao": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.33 },
    costModel: fixedFee(
      0,
      "LitePSM docs show fees are not activated for DAI <-> USDC",
    ),
  },
  "usds-sky": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.33 },
    costModel: fixedFee(
      0,
      "USDS uses the LitePSMWrapper-USDS-USDC route, and Sky docs show LitePSM fees are not activated for the underlying DAI <-> USDC leg",
    ),
    notes: [
      "USDS <-> USDC routes through LitePSMWrapper-USDS-USDC and the fee-free DAI <-> USDS converter, so it shares the same LitePSM liquidity path as DAI",
    ],
  },
  "gho-aave": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.13 },
    costModel: documentedVariableFee(
      "GSM exit fee is governance-set; recent Aave docs show roughly 8-10 bps on redemption",
    ),
  },
  "usdd-tron-dao-reserve": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.16 },
    costModel: fixedFee(
      0,
      "USDD docs describe 1:1 PSM conversions between USDD and USDT/USDC/TUSD",
    ),
  },
  "dola-inverse-finance": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.08 },
    costModel: fixedFee(
      20,
      "Inverse FiRM docs list a 20 bps DOLA -> USDS exit fee",
    ),
  },
  "buck-bucket-protocol": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.25 },
    costModel: fixedFee(
      30,
      "Modeled route uses PSM OUT at 30 bps; collateral redemptions use a separate dynamic fee",
    ),
  },
  "hollar-hydrated": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "lisusd-lista": {
    version: 1,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: fixedFee(
      200,
      "Lista docs list a 2% fee on lisUSD -> centralized stablecoin conversions and a 500,000 lisUSD daily redemption limit",
    ),
    notes: ["Docs also publish a 500,000 lisUSD daily redemption limit for PSM exits"],
  },
  "dusd-dtrinity": {
    version: 1,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.40 },
    costModel: fixedFee(
      50,
      "Protocol docs describe redemption fees of up to 50 bps",
    ),
  },
  "honey-berachain": {
    version: 1,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee(
      "Current redeem fees are asset-specific: 0 bps for USDT/byUSD and 5 bps for USDC/USDe",
    ),
    notes: [
      "Basket Mode activates when any collateral asset depegs and turns redemptions into proportional basket exits",
    ],
  },
  "ousd-origin-protocol": {
    version: 1,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-full" },
    costModel: fixedFee(
      25,
      "Origin docs list a 0.25% exit fee on OUSD redemptions",
    ),
    notes: [
      "Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only",
    ],
  },
  "eusd-electronic-usd": {
    version: 1,
    routeFamily: "basket-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-full" },
    costModel: documentedVariableFee(
      "Reserve Index docs describe mint and TVL fees, but do not document a separate redemption fee",
    ),
    notes: [
      "Redemption requires receiving the underlying basket composition rather than selecting a single stablecoin output",
    ],
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
  "bold-liquity": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE),
  },
  "lusd-liquity": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE),
  },
  "feusd-felix": {
    ...collateralRedeemBase,
    costModel: fixedFee(
      0,
      "Felix docs describe redemption as fee-free",
    ),
  },
  "meusd-mezo": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(
      "75 bps, or 0 bps when redeeming against your own debt",
    ),
  },
  "nect-beraborrow": {
    ...collateralRedeemBase,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE),
  },
  "fxusd-f-x-protocol": {
    ...collateralRedeemBase,
    costModel: fixedFee(
      50,
      "Protocol docs list a 50 bps redemption fee",
    ),
  },
  "usdaf-asymmetry": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE),
  },
  "usnd-nerite": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE),
  },
  "ebusd-ebisu": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "alusd-alchemix": {
    version: 1,
    routeFamily: "queue-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-ratio", ratio: 0.30 },
    costModel: documentedVariableFee(
      "1:1 via the Transmuter; no separate redemption fee is disclosed",
    ),
  },
  "iusd-infinifi": {
    ...queueRedeemBase,
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "reusd-re-protocol": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.20 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "cgusd-cygnus-finance": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(
      "Docs describe 1:1 redemption if fees are excluded; current fee is not disclosed",
    ),
  },
  "uty-xsy": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.30 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "usp-pikudao": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: fixedFee(
      20,
      "Piku docs list a 20 bps redemption fee",
    ),
  },
  "aznd-mu-digital": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: fixedFee(
      0,
      "Mu Digital docs describe minting and redemption as fee-free",
    ),
  },
  "avusd-avant": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: documentedVariableFee(
      "Avant docs say the redemption fee is shown in-app before confirmation",
    ),
  },
  "usdu-unitas": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.05 },
    costModel: fixedFee(
      0,
      "Unitas docs list a 0% redemption fee",
    ),
  },
  "yzusd-yuzu": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.10 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "nusd-neutrl": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.20 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
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
