import type { RedemptionBackstopConfig } from "./shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
  stablecoinRedeemBase,
} from "./shared";

const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);

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
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
    docs: [
      sourceRef(
        "Origin Dollar (OUSD)",
        "https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd",
        ["route", "capacity"],
      ),
      sourceRef(
        "Origin March 2023 token holder update",
        "https://www.originprotocol.com/blog/march-2023-token-holder-update?lang=en",
        ["route", "fees"],
      ),
      sourceRef(
        "Origin pricing and peg management",
        "https://docs.originprotocol.com/security-and-risk/price-oracles",
        ["route", "capacity"],
      ),
    ],
    notes: ["Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only"],
  },
  "ousg-ondo-finance": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "Instant mint/redemption at daily NAV via OUSGInstantManager against USDC (T+0 via BUIDL on-chain liquidity)",
    ),
    notes: ["Token transfers restricted to KYC-verified whitelisted addresses on-chain"],
  },
  "usde-ethena": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "immediate",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.005,
    },
    costModel: documentedVariableFee(
      "Ethena docs describe direct USDe redemption for whitelisted mint users at $1 into supported stable assets, with users reimbursing transaction gas and execution costs rather than paying a separate fixed protocol fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef(
        "Ethena peg arbitrage mechanism",
        "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism",
        ["route", "capacity", "access"],
      ),
      sourceRef(
        "USDe terms and conditions",
        "https://docs.ethena.fi/resources/usde-terms-and-conditions",
        ["route", "fees", "access"],
      ),
      sourceRef(
        "Ethena collateral API",
        "https://app.ethena.fi/api/positions/current/collateral",
        ["capacity"],
      ),
    ],
    notes: [
      "Fresh live reserve metadata scores against Ethena's current Liquid Cash bucket, while the 0.5% fallback ratio reflects the smaller hot-contract stable buffer documented for on-demand redemptions",
    ],
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
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      10,
      "GAIB docs currently show a 10 bps sell fee in the dApp, while direct AID minting and redemption are reserved for whitelisted users and partners",
    ),
    docs: [
      sourceRef(
        "GAIB AI Dollar (AID)",
        "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid",
        ["route", "capacity", "access", "fees"],
      ),
      sourceRef(
        "GAIB economy",
        "https://docs.gaib.ai/gaib-overview/gaib-economy",
        ["route", "capacity"],
      ),
    ],
    notes: [
      "Regular users typically exit AID through the GAIB app or DEX liquidity, while the modeled primary redemption rail is the whitelisted direct burn-and-withdraw contract path",
    ],
  },
  "u-united-stables": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
    ),
  },
  "usx-solstice": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Direct minting and redemption of USX is reserved for KYC'd institutional investors depositing or withdrawing USDC and USDT through the Solstice protocol; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Solstice USX", "https://solstice.finance/usx", ["route", "capacity", "access"]),
    ],
    notes: ["Retail users access USX primarily through DEX liquidity or the Solstice platform, while the primary mint/redeem rail is institution-only"],
  },
  "usda-avalon": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "USDa docs state holders can convert USDa to USDT 1:1 by bridging to Ethereum mainnet and depositing into the conversion vault, with claims available within one business day",
    ),
    docs: [
      sourceRef(
        "How to Use USDa",
        "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/how-to-use-usda",
        ["route", "capacity", "settlement"],
      ),
      sourceRef(
        "USDa risk management",
        "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/risk-management",
        ["capacity"],
      ),
    ],
    notes: ["The modeled redemption rail is the documented USDa-to-USDT conversion vault on Ethereum mainnet rather than offchain BTC collateral withdrawals"],
  },
  "usd0-usual": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
    ),
  },
  "usdai-usd-ai": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "USD.AI docs describe USDai as instantly redeemable by burning into supported stablecoins, while the longer unstaking queue applies to sUSDai rather than base USDai",
    ),
    docs: [
      sourceRef("USD.AI buy / stake", "https://docs.usd.ai/app-guide/buy-stake", ["route", "capacity"]),
      sourceRef(
        "USD.AI technical overview",
        "https://docs.usd.ai/technical-overview/technical-protocol-overview",
        ["route", "capacity"],
      ),
    ],
    notes: ["Current route models the base USDai burn-and-withdraw path; the asynchronous queue in docs applies to sUSDai unstaking, not direct USDai redemption"],
  },
  "frxusd-frax": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct Ethereum mint and redeem contracts support 1:1 conversion between frxUSD and USDC; public docs do not publish a fixed redemption fee",
    ),
    docs: [
      sourceRef(
        "frxUSD mint and redeem overview",
        "https://docs.frax.com/frxusd/mint-and-redeem-overview",
        ["route", "capacity"],
      ),
      sourceRef(
        "frxUSD USDC quickstart",
        "https://docs.frax.com/frxusd/mint-and-redeem-quickstarts/usdc",
        ["route"],
      ),
      sourceRef(
        "FraxNetDeposit contract",
        "https://docs.frax.com/fraxnet/contracts/fraxnetDeposit",
        ["route", "capacity"],
      ),
    ],
    notes: ["Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail"],
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
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Apyx docs describe mint and redeem against approved assets for whitelisted participants, with offchain execution spreads and expenses reflected in the price rather than a fixed protocol fee",
    ),
    docs: [
      sourceRef(
        "How to Buy apxUSD",
        "https://docs.apyx.fi/app-guide/how-to-buy-apxusd",
        ["route", "access"],
      ),
      sourceRef(
        "How Apyx Works",
        "https://docs.apyx.fi/apyx-overview/how-apyx-works",
        ["route", "capacity", "fees"],
      ),
      sourceRef(
        "Peg Stability Model",
        "https://docs.apyx.fi/solution-overview/peg-stability-model",
        ["route", "capacity"],
      ),
    ],
    notes: ["Retail users primarily access apxUSD via the Curve pool, while direct minting and redemption are reserved for whitelisted participants who rebalance the market"],
  },
};
