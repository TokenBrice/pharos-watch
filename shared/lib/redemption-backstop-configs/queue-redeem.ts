import type { RedemptionBackstopConfig } from "./shared";
import {
  applyTrackedReviewedDocs,
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  queueRedeemBase,
  sourceRef,
} from "./shared";

const REVIEWED_QUEUE_REDEMPTION_AT = "2026-03-23";
const REVIEWED_REMEDIATION_AT = "2026-03-30";
const REVIEWED_WRAPPER_QUEUE_AT = "2026-04-21";
const REVIEWED_PHASE_4_COVERAGE_AT = "2026-05-10";
const REVIEWED_YIELD_EXPANSION_AT = "2026-05-11";
const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";
const reviewedQueueRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_QUEUE_REDEMPTION_AT);

export const QUEUE_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "alusd-alchemix": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee("1:1 via the Transmuter; no separate redemption fee is disclosed"),
    docs: [
      sourceRef("Alchemix Transmuter docs", "https://v2-docs.alchemix.fi/alchemix-ecosystem/transmuter", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("Alchemix protocol docs", "https://v2-docs.alchemix.fi/alchemix-ecosystem/alchemist", ["capacity"]),
    ],
    notes: [
      "Alchemix documents the Transmuter as the 1:1 alUSD redemption rail, with claims settling as underlying collateral is repaid and harvested from yield strategies rather than as an instant stablecoin buffer",
    ],
  },
  "iusd-infinifi": {
    ...queueRedeemBase,
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: fixedFee(0, "Tracked protocol metadata describes 1:1 mint/redeem against USDC with no fees"),
  },
  "acred-apollo-securitize": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: fixedFee(0, "RWA.xyz lists 0% ACRED redemption fees"),
    docs: [
      sourceRef(
        "Apollo / Securitize ACRED launch",
        "https://www.nasdaq.com/press-release/apollo-and-securitize-announce-partnership-and-launch-tokenized-access-credit-fund",
        ["route", "access", "settlement"],
      ),
      sourceRef("RWA.xyz ACRED profile", "https://app.rwa.xyz/assets/ACRED", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Securitize launch materials describe ACRED as offering native redemptions at daily NAV for qualifying Securitize Markets investors, while public RWA.xyz metadata lists quarterly redemption timing; Pharos therefore models the route as queued documented-bound NAV redemption rather than immediate liquidity",
    ],
  },
  "usdf-falcon": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Falcon docs state users bear gas and execution costs while Falcon does not charge a separate protocol-specific redemption fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef(
        "Falcon redeem guide",
        "https://docs.falcon.finance/resources/quick-app-guide/navigating-the-swap-tab/redeem",
        ["route", "settlement", "access"],
      ),
      sourceRef("Falcon FAQ", "https://docs.falcon.finance/resources/frequently-asked-questions-faq", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Falcon transparency API", "https://api.falcon.finance/api/v1/transparency", ["capacity"]),
    ],
    notes: [
      "Fresh live reserve metadata scores against Falcon's current stablecoin reserve bucket; redeemed assets are still credited only after the documented 7-day cooldown",
      "If the Falcon transparency API snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
    ],
  },
  "syrupusdc-maple": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Maple docs describe FIFO queued withdrawal requests for syrupUSDC and do not publish a separate protocol redemption fee",
    ),
    docs: [
      sourceRef(
        "Maple syrupUSDC / syrupUSDT withdrawals",
        "https://docs.maple.finance/syrupusdc-usdt-for-lenders/risk",
        ["route", "settlement", "fees"],
      ),
      sourceRef("Maple Pools technical reference", "https://docs.maple.finance/technical-resources/pools/pools", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits on Uniswap or Balancer and instead scores the documented protocol withdrawal rail",
    ],
  },
  "syrupusdt-maple": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Maple docs describe FIFO queued withdrawal requests for syrupUSDT and do not publish a separate protocol redemption fee",
    ),
    docs: [
      sourceRef(
        "Maple syrupUSDC / syrupUSDT withdrawals",
        "https://docs.maple.finance/syrupusdc-usdt-for-lenders/risk",
        ["route", "settlement", "fees"],
      ),
      sourceRef("Maple Pools technical reference", "https://docs.maple.finance/technical-resources/pools/pools", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits and instead scores the documented protocol withdrawal rail",
    ],
  },
  "reusd-re-protocol": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "documented-bound" },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [
      sourceRef("Re Protocol docs", "https://docs.re.xyz/", ["route", "settlement", "capacity"]),
      sourceRef("Re Protocol transparency", "https://app.re.xyz/transparency", ["capacity"]),
    ],
    notes: [
      "Tracked metadata describes atomic redemption when instant liquidity is available and queue settlement otherwise",
      "The reviewed 20% bound matches the tracked USDC instant-redemption buffer rather than assuming the full reUSD reserve stack is immediately withdrawable",
    ],
  },
  "susdai-usd-ai": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull("2026-04-04"),
    costModel: documentedVariableFee(
      "USD.AI documents sUSDai unstaking as a queued withdrawal into USDai with fixed 30-day processing windows; public docs reviewed do not publish a numeric redemption fee or a quantified instant-liquidity bound",
    ),
    docs: [
      sourceRef("USD.AI FAQ", "https://docs.usd.ai/faq/usdai-and-susdai-101", ["route", "capacity", "settlement"]),
      sourceRef("USDai product page", "https://usd.ai/usdai", ["route", "settlement"]),
    ],
    notes: [
      "Current route models sUSDai as an eventual queued exit back into USDai rather than as an immediate stablecoin redemption rail",
      "Issuer docs describe a limited instant-liquidity buffer, but Pharos does not assign a numeric immediate-capacity bound until a trustworthy public figure exists",
    ],
  },
  "susde-ethena": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_QUEUE_AT),
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Ethena staking docs describe sUSDe unstaking as a 7-day cooldown into USDe, with users bearing transaction and execution costs rather than paying a separate fixed protocol redemption fee",
    ),
    docs: [
      sourceRef("Ethena staking docs", "https://docs.ethena.fi/solution-design/staking-usde", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef(
        "Ethena staking key functions",
        "https://docs.ethena.fi/solution-design/staking-usde/staking-key-functions",
        ["route", "access", "settlement"],
      ),
      sourceRef("Ethena key addresses", "https://docs.ethena.fi/solution-design/key-addresses", ["route"]),
    ],
    notes: [
      "sUSDe burns immediately into a claim on underlying USDe, but the user can only withdraw that USDe after the cooldown window has elapsed",
      "Ethena staking includes jurisdictional and sanctions-based restrictions on the staking contract itself, so the wrapper route is modeled as whitelisted-onchain rather than fully permissionless",
    ],
  },
  "syusd-aegis": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_QUEUE_AT),
    settlementModel: "days",
    costModel: fixedFee(0, "Aegis docs describe sYUSD staking and unstaking with 0% protocol fee"),
    docs: [
      sourceRef("Aegis sYUSD docs", "https://docs.aegis.im/tokens/syusd-yield-bearing-token", [
        "route",
        "capacity",
        "fees",
        "settlement",
      ]),
      sourceRef("Aegis smart contracts", "https://docs.aegis.im/smart-contracts", ["route"]),
    ],
    notes: [
      "sYUSD exits through a documented 7-day cooldown back into YUSD at the live staking-vault exchange rate",
      "The wrapper queue is distinct from YUSD's own primary-market redemption path and does not assume a separate instant-liquidity buffer beyond the contract's cooldown release",
    ],
  },
  "stkgho-umbrella-aave": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_PHASE_4_COVERAGE_AT),
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Aave Umbrella unstake guide", "https://aave.com/help/umbrella/unstake", [
        "route",
        "access",
        "settlement",
      ]),
      sourceRef("Aave Umbrella overview", "https://aave.com/help/umbrella/umbrella", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef(
        "Aave stkGHO token contract",
        "https://etherscan.io/address/0x4f827a63755855cdf3e8f3bcd20265c833f15033",
        ["capacity"],
      ),
    ],
    notes: [
      "stkGHO exits through Aave Umbrella's cooldown and withdrawal-window flow back into GHO rather than through an immediate public stablecoin buffer",
      "Staked assets remain slashable during cooldown, so the route is modeled as queued eventual redeemability and not as live direct redemption capacity",
    ],
  },
  "cgusd-cygnus-finance": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    settlementModel: "days",
    costModel: fixedFee(35, "Cygnus docs list a 35 bps withdrawal fee on cgUSD / wcgUSD -> USDC withdrawals"),
    docs: [
      sourceRef(
        "Cygnus cgUSD redemption",
        "https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/protocol-mechanics/redemption",
        ["route", "settlement", "capacity"],
      ),
      sourceRef(
        "Cygnus cgUSD withdrawals FAQ",
        "https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/faq/withdrawals",
        ["route", "settlement", "fees", "capacity"],
      ),
      sourceRef(
        "Cygnus cgUSD mechanics",
        "https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/token-and-contract/cgusd/how-it-works",
        ["capacity"],
      ),
    ],
    notes: [
      "Cygnus docs describe a request-and-claim withdrawal queue represented by NFTs, with normal completion in 5-7 days and no published min/max withdrawal size",
    ],
  },
  "uty-xsy": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [
      sourceRef("XSY documentation", "https://xsy-1.gitbook.io/xsy-main", ["route", "capacity"]),
      sourceRef("XSY website", "https://xsy.fi/about", ["route", "settlement"]),
      sourceRef("XSY Accountable dashboard", "https://accountable.xsy.fi/", ["capacity"]),
    ],
    notes: [
      "XSY documents a 7-day unbonding redemption path for UTY back into USDC; current model scores the reviewed queued exit rather than a separately measured live liquid buffer",
      "The 30% ratio is a reviewed heuristic reflecting delta-neutral AVAX hedge composition rather than a published instant-liquidity floor",
    ],
  },
  "usp-pikudao": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
    costModel: fixedFee(20, "Piku docs list a 20 bps redemption fee"),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [
      sourceRef("Piku docs", "https://docs.piku.co/piku", ["route", "capacity", "access", "fees", "settlement"]),
      sourceRef("Piku website", "https://piku.co/", ["route"]),
    ],
    notes: [
      "Piku materials describe KYC-gated FIFO redemptions with settlement inside roughly 24 hours",
      "The reviewed 10% bound matches the tracked USDC/USDT cash buffer rather than assuming the full strategy book is immediately redeemable",
    ],
  },
  "aznd-mu-digital": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    ...reviewedQueueRedemptionSupplyFull,
    costModel: fixedFee(0, "Mu Digital docs describe minting and redemption as fee-free"),
    docs: [
      sourceRef("Mu Digital docs", "https://docs.mudigital.net", ["route", "capacity", "access", "fees", "settlement"]),
      sourceRef("Mu Accountable dashboard", "https://mu.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Tracked metadata describes KYC-gated weekly AZND redemptions against the full reserve book rather than an always-live stablecoin hot-wallet buffer",
    ],
  },
  "avusd-avant": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee("Avant docs say the redemption fee is shown in-app before confirmation"),
    docs: [
      sourceRef(
        "Avant redeeming avAssets",
        "https://docs.avantprotocol.com/overview/using-the-avant-protocol/redeeming-avassets",
        ["route", "settlement", "fees", "capacity"],
      ),
      sourceRef("Avant core tokens", "https://docs.avantprotocol.com/overview/core-tokens", ["route", "capacity"]),
    ],
    notes: [
      "Avant docs describe redeeming avUSD back into USDC through an onchain request flow that usually completes within hours but can take up to 7 days depending on liquidity",
    ],
  },
  "usdu-unitas": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: fixedFee(0, "Unitas docs list a 0% redemption fee"),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [
      sourceRef("Unitas minting USDu", "https://docs.unitas.so/solution-design/minting-usdu", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("Unitas overview", "https://docs.unitas.so/", ["route", "fees"]),
      sourceRef("Unitas off-exchange settlement", "https://docs.unitas.so/off-exchange-settlement", ["settlement"]),
    ],
    notes: [
      "Direct USDu minting and redemption are restricted to whitelisted participants, while docs describe on-demand redemption flows supported by Unitas's OES settlement rails",
      "Because USDu relies on a delta-neutral collateral stack rather than a pure cash-equivalent reserve bucket, the route keeps a conservative reviewed 5% immediate-capacity bound instead of scoring against full supply",
    ],
  },
  "yzusd-yuzu": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "days",
    ...reviewedQueueRedemptionSupplyFull,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Yuzu Money documentation", "https://yuzu-money.gitbook.io/yuzu-money", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("Yuzu Accountable dashboard", "https://yuzu.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Yuzu documents primary minting and redemption for eligible KYC / AML-cleared investors; current model treats that rail as a reviewed queued exit rather than assuming continuously available public stablecoin liquidity",
    ],
  },
  "usdat-saturn": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Saturn documents KYC-gated 1:1 USDC mint and redeem through the M0 Swap Facility (Uniswap V3 1bps tier); public docs reviewed do not publish a separate USDAT protocol redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Saturn USDAT", "https://saturn.money/usdat", ["route", "capacity"]),
      sourceRef("Saturn documentation", "https://docs.saturn.money/", ["route", "access"]),
    ],
    notes: [
      "USDAT is a permissioned M0 wrapper: mint/redeem requires KYC onboarding and is geofenced away from US, EEA, and OFAC jurisdictions; routes through the Uniswap V3 1bps tier against USDC",
      "The 50% ratio is a reviewed heuristic placeholder for M0 Swap Facility liquidity pending a published quantitative buffer bound",
    ],
  },
  "usdnr-nerona": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Nerona documents permissioned 1:1 USDnr mint and redeem against underlying M; public docs reviewed do not publish a separate numeric redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [sourceRef("Nerona documentation", "https://docs.nerona.finance/", ["route", "capacity", "access"])],
    notes: [
      "Permissioned M0 wrapper: KYC-gated to Nerona's private wealth platform clients; T-bill yield accrues to M0/Nerona rather than USDnr holders",
      "The 50% ratio is a reviewed heuristic placeholder pending a published primary-market liquidity bound for Nerona's M wrapper",
    ],
  },
  "usdh-hermetica": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Hermetica documents KYC-gated USDH mint and redemption against a delta-neutral BTC position; public docs reviewed do not publish a fixed redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Hermetica", "https://hermetica.fi/", ["route"]),
      sourceRef("Hermetica documentation", "https://docs.hermetica.fi/", ["route", "capacity", "access"]),
    ],
    notes: [
      "Delta-neutral BTC strategy (spot long + short perpetual) on Stacks; KYC-gated mint/redeem via the Hermetica app",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol cash buffers rather than a published Hermetica-specific figure",
    ],
  },
  "usdrif-rif": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_PHASE_4_COVERAGE_AT),
    outputAssetType: "mixed-collateral",
    costModel: fixedFee(25, "RIF On Chain FAQ lists a 0.25% mint/redeem fee paid in RIF for USDRIF"),
    docs: [
      sourceRef(
        "RIF On Chain USDRIF redemption docs",
        "https://docs.moneyonchain.com/rdoc-contract/integration-with-roc-platform/getting-rdocs/redeeming-rdocs",
        ["route", "settlement", "access"],
      ),
      sourceRef("RIF On Chain FAQ", "https://wiki.rifonchain.com/frequently-asked-questions/web-app-faq", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef(
        "RIF On Chain system states",
        "https://docs.moneyonchain.com/rdoc-contract/rif-on-chain-platform/system-states",
        ["route", "capacity", "settlement"],
      ),
    ],
    notes: [
      "USDRIF supports settlement-cycle redemption requests into RIF collateral; the 90-day settlement cadence means Pharos treats the broad holder route as queued eventual redeemability",
      "Outside-settlement redemption is limited to free USDRIF, so immediate capacity is not modeled until live Rootstock telemetry exposes free redeemable amount, queue depth, and current system state",
    ],
  },
  "nusd-neutrl": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Neutrl redemption is available to whitelisted KYC participants and supports instant or queued execution depending on AssetReserve liquidity; public fee schedule is not disclosed",
    ),
    docs: [
      sourceRef("Neutrl minting", "https://docs.neutrl.finance/protocol-mechanics/minting", ["route", "capacity"]),
      sourceRef("Neutrl redemption", "https://docs.neutrl.finance/protocol-mechanics/redemption", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("Neutrl transparency", "https://docs.neutrl.finance/protocol-design/transparency", ["capacity"]),
    ],
    notes: [
      "Neutrl docs establish a dual-path redemption system with instant execution when AssetReserve liquidity is available and an onchain queued fallback when it is not; current model scores eventual redeemability rather than a separately measured live instant buffer",
    ],
  },
  "onyc-onre": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.025, confidence: "documented-bound", basis: "strategy-buffer" },
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    costModel: fixedFee(25, "OnRe docs list a 25 bps redemption fee"),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("OnRe redemptions", "https://docs.onre.finance/for-capital-providers/redemptions", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("OnRe transparency", "https://app.onre.finance/earn/transparency", ["capacity"]),
    ],
    notes: [
      "OnRe currently documents weekly redemption capacity up to 2.5% of NAV, a target liquidity reserve up to 20% of NAV, and payouts in USDC or USDG for verified/accredited holders.",
    ],
  },
  "apyusd-apyx": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: documentedVariableFee("apyUSD unlocks to apxUSD over roughly 30 days, then apxUSD primary redemption depends on eligible participants"),
    docs: [
      sourceRef("apyUSD overview", "https://docs.apyx.fi/product-overview/apyusd-overview", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Apyx smart contract addresses", "https://docs.apyx.fi/resources/smart-contract-addresses", ["route"]),
    ],
  },
  "savusd-avant": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Avant docs describe savAsset unstaking with a one-day cooldown before receiving the underlying avAsset"),
    docs: [
      sourceRef("Avant staking avAssets", "https://docs.avantprotocol.com/overview/using-the-avant-protocol/staking-avtokens-avusd-avbtc", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Avant unstaking savAssets", "https://docs.avantprotocol.com/overview/using-the-avant-protocol/unstaking-savassets", ["settlement", "capacity"]),
    ],
  },
  "srusde-strata": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: fixedFee(2.5, "Strata docs list a 2.5 bps senior redemption fee"),
    docs: [
      sourceRef("Strata srUSDe docs", "https://docs.strata.money/using-strata/srusde", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Strata FAQ", "https://docs.strata.markets/resources/faqs", ["settlement"]),
    ],
  },
  "scusd-rings": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    settlementModel: "days",
    costModel: documentedVariableFee("Rings docs describe scAsset redemption after a three-day cooldown"),
    docs: [
      sourceRef("Rings backing", "https://docs.rings.money/backing", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Rings docs", "https://docs.rings.money/", ["route", "settlement"]),
    ],
  },
  "hbusdt-hyperbeat": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Hyperbeat docs describe instant redemption to USDT0 with a 0.5% fee when liquidity exists, or classic redemption within three working days with no fee"),
    docs: [
      sourceRef("Hyperbeat USDT vault", "https://docs.hyperbeat.org/hyperbeat-earn/usdt-vault", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Hyperbeat addresses", "https://docs.hyperbeat.org/resources/addresses", ["route"]),
    ],
  },
  "ntbill-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("Nest docs describe nTBILL redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", ["route", "capacity", "fees", "access", "settlement"]),
    ],
    notes: ["Nest docs list an expected nTBILL redemption window of 1-3 business days."],
  },
  "inalpha-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee(
      "Nest docs describe nALPHA/inALPHA redemption requests through the app and atomic queue; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Nest liquidity and redemptions", "https://docs.nest.credit/about/liquidity-and-redemptions", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", ["route", "capacity", "settlement"]),
      sourceRef(
        "Nest nALPHA vault integration",
        "https://docs.nest.credit/developers/evm-integration-guides/nalpha-vault",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Nest's nALPHA guide documents redemption requests from Plume or Ethereum into pUSD or USDC through the atomic queue; Pharos tracks inALPHA as the same Alpha vault LP exposure.",
      "Nest docs list a 3-5 business day nALPHA redemption window and broader queue mechanics, so the route is modeled as delayed NAV redemption rather than instant stablecoin liquidity.",
    ],
  },
  "nbasis-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("Nest docs describe nBASIS redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", ["route", "capacity", "fees", "access", "settlement"]),
    ],
    notes: ["Nest docs list an expected nBASIS redemption window of 3-5 business days."],
  },
  "nopal-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("Nest docs describe nOPAL redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", ["route", "capacity", "fees", "access", "settlement"]),
    ],
    notes: ["Nest docs list an expected nOPAL redemption window from minutes to 7 business days."],
  },
  "nwisdom-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("Nest docs describe nWISDOM redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", ["route", "capacity", "fees", "access", "settlement"]),
    ],
    notes: ["Nest docs list an expected nWISDOM redemption window from minutes to 7 business days."],
  },
  "busd0-usual": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    costModel: documentedVariableFee(
      "Usual docs describe permissionless bUSD0 redemption into USD0: early par exit requires the matching rt-bUSD0 token, while bUSD0 alone redeems at maturity; public docs reviewed do not publish a separate redemption fee",
    ),
    docs: [
      sourceRef("Usual bUSD0 docs", "https://docs.usual.money/usual-products/yield-products/usd-products/bond-usd0", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Usual bUSD0 fact sheet",
        "https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/busd0",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
    ],
    notes: [
      "Before June 11, 2028, par redemption requires recombining bUSD0 with rt-bUSD0; bUSD0-only redemption is modeled as documented-bound eventual capacity because the standalone bond leg does not redeem at par until maturity",
      "Secondary-market exits and optional governance floor redemption are excluded from the modeled route",
    ],
  },
};

applyTrackedReviewedDocs(QUEUE_REDEEM_BACKSTOP_CONFIGS, ["iusd-infinifi"], REVIEWED_REMEDIATION_AT);
