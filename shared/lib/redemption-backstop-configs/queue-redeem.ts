import type { RedemptionBackstopConfig } from "./shared";
import { defineRecordEntries, finalizeBackstopRegistry } from "./factory";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  queueRedeemBase,
  sourceRef,
} from "./shared";
import { NEST_NAV_VAULT_CONFIGS } from "./queue-redeem-nest-nav";
import {
  REVIEWED_EXIT_CREDIT_WAVE2_AT,
  REVIEWED_FIRST_WAVE_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_WRAPPER_WAVE_AT,
  REVIEWED_YIELD_COVERAGE_WAVE_AT as REVIEWED_YIELD_EXPANSION_AT,
} from "./review-dates";

const REVIEWED_QUEUE_REDEMPTION_AT = REVIEWED_FIRST_WAVE_AT;
const REVIEWED_WRAPPER_QUEUE_AT = REVIEWED_WRAPPER_WAVE_AT;
const REVIEWED_PHASE_4_COVERAGE_AT = "2026-05-10";
const REVIEWED_CONFIG_ONLY_GAPS_AT = "2026-05-17";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";
const reviewedQueueRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_QUEUE_REDEMPTION_AT);

/** syrupUSDC and syrupUSDT share this 3-element docs[]; their cost/notes prose
 *  diverges and stays inline at each entry. */
const mapleSyrupDocs = () => [
  sourceRef("Maple syrupUSDC / syrupUSDT withdrawals", "https://docs.maple.finance/syrupusdc-usdt-for-lenders/risk", [
    "route",
    "capacity",
    "settlement",
    "fees",
  ]),
  sourceRef("Maple Pools technical reference", "https://docs.maple.finance/technical-resources/pools/pools", [
    "route",
    "access",
    "settlement",
  ]),
  sourceRef(
    "Maple WithdrawalManager queue",
    "https://docs.maple.finance/technical-resources/withdrawal-managers/withdrawal-manager-queue",
    ["route", "capacity", "settlement"],
  ),
];

function erc4626ReserveTelemetryQueueConfig(options: {
  reviewedAt: string;
  accessModel?: RedemptionBackstopConfig["accessModel"];
  settlementModel?: RedemptionBackstopConfig["settlementModel"];
  executionModel?: RedemptionBackstopConfig["executionModel"];
  outputAssetType?: RedemptionBackstopConfig["outputAssetType"];
  outputAssets?: RedemptionBackstopConfig["outputAssets"];
  totalScoreCap?: number;
  costModel: RedemptionBackstopConfig["costModel"];
  docs: NonNullable<RedemptionBackstopConfig["docs"]>;
  notes?: string[];
  telemetrySubject: string;
  settlementConstraint: string;
}): RedemptionBackstopConfig {
  const {
    reviewedAt,
    accessModel,
    settlementModel,
    executionModel,
    outputAssetType,
    outputAssets,
    totalScoreCap,
    costModel,
    docs,
    notes = [],
    telemetrySubject,
    settlementConstraint,
  } = options;

  return {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(reviewedAt),
    capacityModel: { kind: "reserve-sync-metadata" },
    ...(accessModel ? { accessModel } : {}),
    ...(settlementModel ? { settlementModel } : {}),
    ...(executionModel ? { executionModel } : {}),
    ...(outputAssetType ? { outputAssetType } : {}),
    ...(outputAssets ? { outputAssets: [...outputAssets] } : {}),
    ...(totalScoreCap ? { totalScoreCap } : {}),
    costModel,
    docs,
    notes: [
      ...notes,
      `Fresh ERC-4626 reserve telemetry reads ${telemetrySubject} as the current redeemable bound while ${settlementConstraint} still governs settlement; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.`,
    ],
  };
}

const RAW_QUEUE_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "alusd-alchemix": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    outputAssets: ["dai-makerdao"],
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
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: fixedFee(0, "Tracked protocol metadata describes 1:1 mint/redeem against USDC with no fees"),
  },
  "dusd-dialectic": {
    ...queueRedeemBase,
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    holderEligibility: "issuer-discretionary",
    settlementModel: "queued",
    executionModel: "opaque",
    capacityModel: {
      kind: "reserve-sync-metadata",
      liveCapacityConfidence: "documented-bound",
      basis: "live-proxy-buffer",
    },
    costModel: fixedFee(0, "The reviewed standard AsyncRedeemer implementation does not charge a DUSD redemption fee"),
    routeStatus: "open",
    routeExitCorrelation: "same-protocol-liquidity",
    reviewedAt: "2026-07-30",
    docs: [
      sourceRef("Makina Machine lifecycle", "https://docs.makina.finance/concepts/architecture/lifecycle", [
        "route",
        "settlement",
      ]),
      sourceRef("Makina redemptions", "https://docs.makina.finance/concepts/architecture/machine/redemptions", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRef("Makina DUSD strategy", "https://makina.finance/strategy/dusd", ["route", "capacity"]),
      sourceRef(
        "DUSD AsyncRedeemer verified source",
        "https://eth.blockscout.com/address/0xd53dc14e0f268494c7540153126d78e4f54cc01c?tab=contract",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef("DUSD Machine Terms", "https://makina.finance/MeccanicoToS.pdf", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "The reviewed AsyncRedeemer implementation currently advances sequential request IDs and charges no redemption fee, but the Machine Terms provide no contractual queue priority and no perpetual zero-fee covenant.",
      "A DUSD buyback request is not a contractual redemption right, may remain unfilled indefinitely, and has only a 12-hour minimum finalization delay rather than a maximum settlement SLA.",
      "Verified-User admission, suspension, and revocation are discretionary and have no promised appeal SLA. U.S. persons and other Prohibited Persons or Jurisdictions are ineligible, and EU/EEA-originating transactions may be refused.",
      "Settlement is available only in Ethereum USDC after the operator frees accounting-token liquidity; there is no committed alternate settlement asset, and the operator may cease the Machine without notice.",
      "Fresh Makina route telemetry computes usable queue capacity as max(0, the Machine's idle Ethereum USDC minus the USDC liability of DUSD shares locked in the AsyncRedeemer). If that same-block onchain proof fails validation, the route remains missing-capacity rather than falling back to AUM, full supply, deployed positions, or a static ratio.",
    ],
  },
  "acred-apollo-securitize": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    accessModel: "issuer-api",
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdg-paxos"],
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
      sourceRef(
        "Securitize ACRED fund page",
        "https://securitize.io/primary-market/apollo-diversified-credit-securitize-fund",
        ["route", "settlement"],
      ),
    ],
    notes: [
      "Securitize launch materials describe ACRED as offering native redemptions at daily NAV for qualifying Securitize Markets investors, while public RWA.xyz metadata lists quarterly redemption timing; Pharos therefore models the route as queued documented-bound NAV redemption rather than immediate liquidity",
      "Output declared 2026-07-19: the current Securitize ACRED fund page lists redemption off-ramps as USDC and USDG (proceeds paid at NAV on the quarterly repurchase cycle), so the nav placeholder type was replaced with the documented stablecoin basket; the queued settlement model is unchanged.",
    ],
  },
  "usdf-falcon": {
    ...queueRedeemBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdt-tether", "usdc-circle", "fdusd-first-digital"],
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Falcon docs state users bear gas and execution costs while Falcon does not charge a separate protocol-specific redemption fee",
    ),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
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
  "syrupusdc-maple": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      0,
      "Maple WithdrawalManager docs process queued shares into assets at the current exchange rate, with no separate protocol redemption fee described",
    ),
    docs: mapleSyrupDocs(),
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits on Uniswap or Balancer and instead scores the documented protocol withdrawal rail",
    ],
    telemetrySubject: "the pool's idle USDC balance",
    settlementConstraint: "the FIFO queue",
  }),
  "syrupusdt-maple": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      0,
      "Maple docs state syrupUSDC and syrupUSDT are redeemed at the smart-contract exchange rate with no slippage and no separate protocol redemption fee (mirrors syrupUSDC)",
    ),
    docs: mapleSyrupDocs(),
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits and instead scores the documented protocol withdrawal rail",
    ],
    telemetrySubject: "the pool's idle USDT balance",
    settlementConstraint: "the FIFO queue",
  }),
  "reusd-re-protocol": {
    ...queueRedeemBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "dai-makerdao", "susde-ethena", "usde-ethena"],
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.2, confidence: "documented-bound" },
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    costModel: documentedVariableFee(
      "Re Protocol docs state redemption and transaction fees currently start at 6 bps (0.06%).",
      "formula",
    ),
    docs: [
      sourceRef("Re Protocol reUSD docs", "https://docs.re.xyz/insurance-capital-layers/what-is-reusd", [
        "route",
        "settlement",
        "capacity",
        "fees",
      ]),
      sourceRef("Re Protocol transparency", "https://app.re.xyz/transparency", ["capacity"]),
    ],
    notes: [
      "Tracked metadata describes atomic redemption when instant liquidity is available and queue settlement otherwise",
      "Fresh Re Metrics reserve telemetry reads the current instant redemption vault balances as the direct bounded capacity; if that payload is unavailable, the reviewed 20% fallback matches the prior tracked instant-redemption buffer rather than assuming the full reUSD reserve stack is immediately withdrawable",
    ],
  },
  "susdai-usd-ai": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull("2026-04-04"),
    costModel: undisclosedReviewedFee(
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
  "asusdf-astherus": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound", basis: "strategy-buffer" },
    reviewedAt: "2026-05-14",
    settlementModel: "same-day",
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Aster FAQ says there are no fees to mint or withdraw asUSDF"),
    docs: [
      sourceRef("Aster asUSDF FAQ", "https://docs.asterdex.com/usdf-stablecoin/overview/faqs", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Aster Earn asUSDF", "https://docs.asterdex.com/product/aster-earn/mint-asusdf", ["route"]),
    ],
    notes: [
      "asUSDF is the yield-bearing asToken wrapper over USDF; withdrawals return USDF after the documented T+1 hour / two-hour waiting period.",
      "Downstream par-exit quality then depends on USDF's own USDT redemption route.",
    ],
  },
  "susd1plus-lorenzo": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_CONFIG_ONLY_GAPS_AT),
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Lorenzo states it does not charge user deposit or withdrawal fees; yield is distributed net of protocol and execution service fees",
    ),
    docs: [
      sourceRef("Lorenzo USD1+ OTF launch", "https://medium.com/@lorenzoprotocol/usd1-mainnet-launch-72550abac2ed", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Lorenzo OTF app", "https://app.lorenzo-protocol.xyz/otf", ["route", "access", "settlement"]),
      sourceRef("Lorenzo website", "https://lorenzo-protocol.xyz/home", ["capacity"]),
    ],
    notes: [
      "sUSD1+ holders submit withdrawal requests through the Lorenzo OTF flow; published terms describe weekly review cycles and typical 7-14 day settlement.",
      "Executed redemptions automatically convert sUSD1+ into USD1 at processing-day NAV, so the route is modeled as queued eventual redeemability rather than an immediate stablecoin buffer.",
    ],
  },
  "susde-ethena": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_WRAPPER_QUEUE_AT,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    costModel: fixedFee(
      0,
      "Ethena staking docs and StakedUSDeV2 contract describe unstaking as burning sUSDe for proportionate USDe after cooldown, with no protocol redemption fee",
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
      sourceRef(
        "Ethena StakedUSDeV2 contract",
        "https://github.com/ethena-labs/code4arena-contest/blob/main/protocols/USDe/contracts/StakedUSDeV2.sol",
        ["route", "fees"],
      ),
      sourceRef("Ethena key addresses", "https://docs.ethena.fi/solution-design/key-addresses", ["route"]),
    ],
    notes: [
      "sUSDe burns immediately into a claim on underlying USDe, but the user can only withdraw that USDe after the cooldown window has elapsed",
      "Ethena staking includes jurisdictional and sanctions-based restrictions on the staking contract itself, so the wrapper route is modeled as whitelisted-onchain rather than fully permissionless",
    ],
    telemetrySubject: "the staking contract's USDe holdings",
    settlementConstraint: "the documented 7-day cooldown",
  }),
  "syusd-aegis": {
    ...erc4626ReserveTelemetryQueueConfig({
      reviewedAt: REVIEWED_WRAPPER_QUEUE_AT,
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
      telemetrySubject: "the staking vault's YUSD holdings",
      settlementConstraint: "the cooldown",
    }),
    v9RouteReviewTerms: {
      settlementDelaySec: 604_800,
      reviewedAt: "2026-08-24",
      docs: [
        sourceRef(
          "sYUSD Ethereum contract read at block 25825927",
          "https://etherscan.io/address/0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
          ["route"],
        ),
      ],
    },
  },
  "witry-brix": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_CONFIG_ONLY_GAPS_AT),
    unresolvedOutputAssetKeys: ["asset:itry"],
    unresolvedOutputDisposition: "reviewed-external",
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "Brix protocol materials describe standard wiTRY unstaking through a 3-day cooldown plus a fast-withdraw option with an additional fee; public materials reviewed do not publish one global fixed fee",
    ),
    docs: [
      sourceRef("Brix iTRY audit scope overview", "https://hackmd.io/@EKJz7PaeT2GeAUJS83WWVw/SJPLb3QZWe", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Code4rena Brix Money audit repository", "https://github.com/code-423n4/2025-11-brix-money", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("Brix website", "https://www.brix.money/", ["route", "access"]),
    ],
    notes: [
      "wiTRY is the staked ERC-4626-style wrapper over iTRY; unstaking returns iTRY after the documented 3-day cooldown unless the holder uses the fee-bearing fast-withdraw path (re-confirmed 2026-07-27 against the issuer-published audit scope overview, Kimi data review).",
      "iTRY redemption is whitelist-gated and serviced first by the FastAccessVault DLF liquidity buffer, with custodian-managed redemption when immediate DLF liquidity is insufficient.",
      "The exact wrapper output remains unresolved for scoring because iTRY has no tracked Pharos stablecoin id; asset:itry is retained as a diagnostic identity.",
    ],
  },
  "stkgho-umbrella-aave": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_PHASE_4_COVERAGE_AT,
    costModel: fixedFee(
      0,
      "Aave Umbrella StakeToken docs describe ERC-4626 redeem/withdraw after cooldown with no exit fee",
    ),
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
      sourceRef(
        "Aave Umbrella StakeToken README",
        "https://github.com/aave-dao/aave-umbrella/blob/main/src/contracts/stakeToken/README.md",
        ["route", "fees"],
      ),
    ],
    notes: [
      "stkGHO exits through Aave Umbrella's cooldown and withdrawal-window flow back into GHO rather than through an immediate public stablecoin buffer",
      "Staked assets remain slashable during cooldown, so the route is modeled as queued eventual redeemability and not as live direct redemption capacity",
    ],
    telemetrySubject: "the staking contract's idle GHO-denominated holdings",
    settlementConstraint: "the cooldown and withdrawal window",
  }),
  "cgusd-cygnus-finance": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
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
    unresolvedOutputDisposition: "issuer-undisclosed",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(),
    reviewedAt: "2026-08-27",
    docs: [
      sourceRef(
        "XSY UTY peg-arbitrage docs",
        "https://xsy-1.gitbook.io/xsy-main/open-market-peg-arbitrage.md",
        ["route"],
      ),
      sourceRef("XSY UTY overview", "https://xsy-1.gitbook.io/xsy-main/unity-uty-overview.md", ["route"]),
      sourceRef("XSY Accountable dashboard", "https://accountable.xsy.fi/", ["capacity"]),
    ],
    notes: [
      "Output re-reviewed 2026-08-27: current XSY docs say users can redeem UTY through the issuance smart contract for approximately $1 in value, but do not name a payout asset. The UTY overview also states that holders have no ownership rights over specific underlying assets, so outputAssets is intentionally unset.",
      "Current public XSY materials do not establish a fixed holder fee, executable capacity, or settlement SLA for the issuance-contract route. The prior 7-day USDC assertion is not retained as current output evidence.",
      "The 30% ratio is a reviewed heuristic reflecting delta-neutral AVAX hedge composition rather than a published instant-liquidity floor",
    ],
  },
  "usp-pikudao": {
    ...queueRedeemBase,
    outputAssets: ["usdc-circle"],
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
    unresolvedOutputDisposition: "issuer-undisclosed",
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    ...reviewedQueueRedemptionSupplyFull,
    costModel: fixedFee(0, "Mu Digital docs describe minting and redemption as fee-free"),
    docs: [
      sourceRef("Mu Digital docs", "https://docs.mudigital.net", ["route", "capacity", "access", "fees", "settlement"]),
      sourceRef("Mu Digital AZND mint/redeem", "https://docs.mudigital.net/protocol-overview/asia-dollar-aznd/mint-redeem", [
        "route",
        "access",
        "fees",
        "settlement",
      ]),
      sourceRef("Mu Accountable dashboard", "https://mu.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Tracked metadata describes KYC-gated weekly AZND redemptions against the full reserve book rather than an always-live stablecoin hot-wallet buffer",
      "2026-07-27 recheck (Kimi data review): Mu Digital documents accepted mint funding assets (USDC, USDT, or AUSD) but still does not identify the asset used to settle an approved AZND redemption ('receipt of funds' after the weekly queue). The output therefore remains an unresolved asset with no guessed identity.",
    ],
  },
  "avusd-avant": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
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
    outputAssetType: "mixed-collateral",
    outputAssets: ["asset:sol", "asset:btc", "asset:eth"],
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: fixedFee(0, "Unitas docs list a 0% redemption fee"),
    reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
    docs: [
      sourceRef("Unitas minting USDu", "https://docs.unitas.so/solution-design/minting-usdu", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("Unitas overview", "https://docs.unitas.so/", ["route", "fees"]),
      sourceRef("Unitas off-exchange settlement", "https://docs.unitas.so/off-exchange-settlement", ["settlement"]),
      sourceRef("Unitas terms of service", "https://docs.unitas.so/resources/terms-of-service", ["route"]),
      sourceRef("Unitas delta-neutral stability", "https://docs.unitas.so/solution-overview/delta-neutral-stability", [
        "route",
        "capacity",
      ]),
    ],
    notes: [
      "Direct USDu minting and redemption are restricted to whitelisted participants, while docs describe on-demand redemption flows supported by Unitas's OES settlement rails",
      "Because USDu relies on a delta-neutral collateral stack rather than a pure cash-equivalent reserve bucket, the route keeps a conservative reviewed 5% immediate-capacity bound instead of scoring against full supply",
      "Output declared 2026-07-19: the Unitas terms define redemption as burning USDu to withdraw a pro-rata share of the underlying collateral, and the delta-neutral design page names the collateral classes as SOL, BTC, and ETH (JLP and the short-perp hedge leg are strategy positions rather than deliverable collateral classes); no single-stablecoin payout is documented.",
    ],
  },
  "yzusd-yuzu": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    outputAssets: ["usdt-tether"],
    settlementModel: "days",
    ...reviewedQueueRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(),
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
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(
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
    outputAssets: ["m-m0"],
    settlementModel: "days",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Nerona's fee documentation states there are no mint or redeem fees on USDnr itself at the protocol level; the 1% instant fee and the four-day unwind apply to sUSDnr, not USDnr",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    docs: [
      sourceRef("Nerona redemptions", "https://docs.nerona.xyz/redemptions", ["route", "capacity", "settlement"]),
      sourceRef("Nerona fees and revenue", "https://docs.nerona.xyz/fees-revenue", ["fees"]),
    ],
    notes: [
      "Permissioned M0 wrapper: KYC-gated to Nerona's private wealth platform clients; T-bill yield accrues to M0/Nerona rather than USDnr holders",
      "Fresh live reserve metadata reads the current M balance held by the USDnr extension as the directly redeemable bound and verifies the M0 SwapFacility path is not paused; if the live snapshot is unavailable, the route is left unrated instead of using a static supply heuristic",
      "Fee bounded 2026-08-12 at 0 bps for the modeled USDnr -> M leg, which is the leg this config scores. The docs' 0.01% figure is the Uniswap V3 pool tier on the separate downstream wM -> USDC corridor, so it is not a fee of the modeled route; a holder continuing to USDC pays it plus AMM slippage on top.",
      "Doc citations replaced 2026-08-12: the previously cited docs.nerona.finance host no longer resolves, and the current documentation lives at docs.nerona.xyz.",
    ],
  },
  "usdh-hermetica": {
    ...queueRedeemBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(
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
    outputAssets: ["asset:rif"],
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
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    costModel: undisclosedReviewedFee(
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
    outputAssets: ["usdc-circle", "usdg-paxos"],
    capacityModel: { kind: "supply-ratio", ratio: 0.025, confidence: "documented-bound", basis: "strategy-buffer" },
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    costModel: fixedFee(25, "OnRe docs list a 25 bps redemption fee"),
    v9RouteReviewTerms: {
      settlementModel: "queued",
      reviewedAt: "2026-05-28",
      docs: [
        sourceRef("OnRe redemptions", "https://docs.onre.finance/for-capital-providers/redemptions", ["route"]),
      ],
    },
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("OnRe redemptions", "https://docs.onre.finance/for-capital-providers/redemptions", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("OnRe transparency", "https://app.onre.finance/earn/transparency", ["capacity"]),
    ],
    notes: [
      "OnRe currently targets monthly redemption capacity up to 2.5% of NAV, reserves up to 15% of underwriting capital for liquidity, and pays USDC or USDG to verified/accredited holders.",
    ],
  },
  "apyusd-apyx": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: documentedVariableFee(
      "apyUSD redemptions become claimable after 3 days, with an early-redemption fee that declines linearly from 3.5% to 0.1% over the claimable window (waiting longer lowers the fee)",
      "formula",
    ),
    docs: [
      sourceRef("apyUSD overview", "https://docs.apyx.fi/product-overview/apyusd-overview", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Apyx smart contract addresses", "https://docs.apyx.fi/resources/smart-contract-addresses", ["route"]),
    ],
    telemetrySubject: "the vault's idle apxUSD balance",
    settlementConstraint: "the documented unlock window",
  }),
  "savusd-avant": {
    ...erc4626ReserveTelemetryQueueConfig({
      reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
      settlementModel: "days",
      executionModel: "rules-based-nav",
      costModel: fixedFee(
        0,
        "StakedAvUSDV2 ERC-4626 (0x06d47f3fb376649c3a9dafe069b3d6e35572219e) charges no exit fee: on-chain previewRedeem == convertToAssets, source shows a vesting-only adjustment; the Avant redemption 'fee' applies to the downstream avUSD leg",
      ),
      docs: [
        sourceRef(
          "Avant staking avAssets",
          "https://docs.avantprotocol.com/overview/using-the-avant-protocol/staking-avtokens-avusd-avbtc",
          ["route", "capacity", "fees", "access", "settlement"],
        ),
        sourceRef(
          "Avant unstaking savAssets",
          "https://docs.avantprotocol.com/overview/using-the-avant-protocol/unstaking-savassets",
          ["settlement", "capacity"],
        ),
      ],
      telemetrySubject: "the staking vault's idle avUSD balance",
      settlementConstraint: "the one-day cooldown",
    }),
    v9RouteReviewTerms: {
      settlementDelaySec: 86_400,
      reviewedAt: "2026-08-19",
      docs: [
        sourceRef(
          "Avant unstaking savAssets",
          "https://docs.avantprotocol.com/overview/using-the-avant-protocol/unstaking-savassets",
          ["route"],
        ),
      ],
    },
  },
  "srusde-strata": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: "2026-08-27",
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    outputAssets: ["usde-ethena", "susde-ethena"],
    totalScoreCap: 65,
    costModel: fixedFee(2.5, "Strata docs list a 2.5 bps senior redemption fee"),
    docs: [
      sourceRef("Strata srUSDe market", "https://docs.strata.markets/markets/ethena-usde/srusde", [
        "route",
        "fees",
        "settlement",
      ]),
      sourceRef("Strata FAQ", "https://docs.strata.markets/resources/faqs", ["route", "fees", "settlement"]),
    ],
    notes: [
      "Output re-reviewed 2026-08-27: Strata's current FAQ states srUSDe can be redeemed for USDe and sUSDe. It documents instant sUSDe redemptions and a seven-day cooldown for USDe, so both tracked outputs are declared as the complete current set.",
    ],
    telemetrySubject: "the tranche vault's idle underlying balance",
    settlementConstraint: "the documented redemption window",
  }),
  "scusd-rings": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether", "dai-makerdao"],
    settlementModel: "days",
    costModel: documentedVariableFee("Rings docs describe scAsset redemption after a three-day cooldown"),
    reviewedAt: "2026-07-27",
    docs: [
      sourceRef("Rings backing", "https://docs.rings.money/backing", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Rings docs", "https://docs.rings.money/", ["route", "settlement"]),
      sourceRef("Rings minting tutorial (archived)", "https://web.archive.org/web/20250206125740/https://docs.rings.money/tutorials/minting", [
        "route",
        "settlement",
      ]),
    ],
    notes: [
      "Rings documents 1:1 scAsset redemption into a user-selected underlying stablecoin after a multi-day cooldown; the conservative redeemable set is USDC, USDT, and DAI per the archived issuer tutorial (2026-07-27 review, Kimi data review applied by coordinator).",
      "Secondary sources also list GHO and USDS as collateral; both are excluded pending primary confirmation because docs.rings.money renders as an unreadable GitBook shell to non-browser clients (re-verified 2026-07-27).",
    ],
  },
  "hbusdt-hyperbeat": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Hyperbeat docs state classic redemption completes within two days with no fee"),
    v9RouteReviewTerms: {
      settlementDelaySec: 172_800,
      reviewedAt: "2026-01-06",
      docs: [
        sourceRef("Hyperbeat USDT vault", "https://docs.hyperbeat.org/hyperbeat-earn/usdt-vault", ["route"]),
      ],
    },
    docs: [
      sourceRef("Hyperbeat USDT vault", "https://docs.hyperbeat.org/hyperbeat-earn/usdt-vault", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Hyperbeat addresses", "https://docs.hyperbeat.org/resources/addresses", ["route"]),
    ],
  },
  ...NEST_NAV_VAULT_CONFIGS,
  "inalpha-nest": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    outputAssets: ["usdc-circle", "pusd-plume"],
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    costModel: undisclosedReviewedFee(
      "Nest docs describe nALPHA/inALPHA redemption requests through the app and atomic queue; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Nest liquidity and redemptions", "https://docs.nest.credit/about/liquidity-and-redemptions", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Nest available vaults", "https://docs.nest.credit/about/available-vaults", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef(
        "Nest nALPHA vault integration",
        "https://docs.nest.credit/developers/evm-integration-guides/nalpha-vault",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Nest's nALPHA guide documents redemption requests from Plume or Ethereum into pUSD or USDC through the atomic queue; Pharos tracks inALPHA as the same Alpha vault LP exposure.",
      "Nest docs list a 3-5 business day nALPHA redemption window and broader queue mechanics, so the route is modeled as delayed NAV redemption rather than instant stablecoin liquidity.",
      "Output type corrected 2026-07-19: the documented payout assets (pUSD or USDC) were already declared, so the nav placeholder type was replaced with stable-basket, matching the four sibling Nest vault entries retyped in the 2026-07-15 output wave; the delayed-NAV settlement semantics are unchanged.",
    ],
  },
  "busd0-usual": {
    ...queueRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    costModel: undisclosedReviewedFee(
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
  "usdm-monetrix": {
    ...queueRedeemBase,
    settlementModel: "days",
    executionModel: "deterministic-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    reviewedAt: "2026-08-13",
    costModel: undisclosedReviewedFee(
      "Monetrix public docs specify 1:1 redemption and cooldown but no numeric redemption fee; network gas remains separate",
    ),
    routeExitCorrelation: "same-protocol-liquidity",
    docs: [
      sourceRef("Redeem guide", "https://doc.monetrix.xyz/guide/redeem.md", ["route", "settlement", "access"]),
      sourceRef("Mint guide", "https://doc.monetrix.xyz/guide/mint.md", ["route", "capacity", "access"]),
      sourceRef("Delta-neutral strategy", "https://doc.monetrix.xyz/how-it-works/delta-neutral-strategy.md", [
        "capacity",
        "route",
      ]),
      sourceRef("FAQ", "https://doc.monetrix.xyz/guide/faq.md", ["route", "settlement", "fees"]),
      sourceRef("Audits and contracts", "https://doc.monetrix.xyz/risk-and-security/audits-and-contracts.md", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "USDM redemption is a permissionless request/claim flow: requestRedeem burns USDM and locks a 1:1 USDC claim, then claimRedeem transfers USDC after the governance-set three-day cooldown.",
      "The reviewed 10% strategy-buffer heuristic avoids treating Monetrix's delta-neutral positions as immediately redeemable full supply; the cooldown, pause, deposit limits, and TVL-cap controls can also block or constrain the route.",
    ],
  },
};

const FINALIZED_QUEUE_REDEEM_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  defineRecordEntries(RAW_QUEUE_REDEEM_BACKSTOP_CONFIGS),
  [{ stablecoinIds: ["iusd-infinifi"], reviewedAt: REVIEWED_REMEDIATION_AT }],
);

export const QUEUE_REDEEM_BACKSTOP_CONFIGS = FINALIZED_QUEUE_REDEEM_BACKSTOP_REGISTRY.configs;
export const QUEUE_REDEEM_BACKSTOP_ENTRIES = FINALIZED_QUEUE_REDEEM_BACKSTOP_REGISTRY.entries;
