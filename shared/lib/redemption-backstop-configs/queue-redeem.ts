import type { RedemptionBackstopConfig } from "./shared";
import { defineRecordEntries, finalizeBackstopRegistry } from "./factory";
import {
  cloneRedemptionBackstopConfig,
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  queueRedeemBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "./shared";
import { NEST_NAV_VAULT_CONFIGS } from "./queue-redeem-nest-nav";
import {
  REVIEWED_EXIT_CREDIT_AT,
  REVIEWED_FIRST_WAVE_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_WRAPPER_WAVE_AT,
  REVIEWED_YIELD_COVERAGE_WAVE_AT,
} from "./review-dates";

const REVIEWED_QUEUE_REDEMPTION_AT = REVIEWED_FIRST_WAVE_AT;
const REVIEWED_WRAPPER_QUEUE_AT = REVIEWED_WRAPPER_WAVE_AT;
const REVIEWED_PHASE_4_COVERAGE_AT = "2026-05-10";
const REVIEWED_CONFIG_ONLY_GAPS_AT = "2026-05-17";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";

function defineQueueRedeemConfig(overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig { return { ...queueRedeemBase, ...overrides }; }

function defineReviewedQueueRedeemConfig(reviewedAt: string, overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig { return { ...queueRedeemBase, ...documentedBoundSupplyFull(reviewedAt), ...overrides }; }

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
  v9RouteReviewTerms?: RedemptionBackstopConfig["v9RouteReviewTerms"];
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
    v9RouteReviewTerms,
    telemetrySubject,
    settlementConstraint,
  } = options;

  return cloneRedemptionBackstopConfig({
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
    ...(v9RouteReviewTerms ? { v9RouteReviewTerms } : {}),
    notes: [
      ...notes,
      `Fresh ERC-4626 reserve telemetry reads ${telemetrySubject} as the current redeemable bound while ${settlementConstraint} still governs settlement; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.`,
    ],
  });
}

const RAW_QUEUE_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "earnusd-lido": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    holderEligibility: "any-holder",
    capacityModel: { kind: "unquantified" },
    costModel: documentedVariableFee(
      "The exact Mellow FeeManager exposes the mutable redeemFeeD6 / 1e6 fee on async requests. The conditional sync rail additionally applies penaltyD6; observed zeros are snapshots, not permanent or all-in cost bounds. Gas and wallet charges remain separate.",
      "formula",
    ),
    reviewedAt: "2026-10-05",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale: "Public USDC request/claim is established, but oracle reporting and funded batch processing have no guaranteed completion maximum. Sync liquidity and a rolling share limit are conditional diagnostics, not executed same-notional capacity. Mutable protocol fees are observed each run; all-in execution costs remain unmeasured.",
      reviewedAt: "2026-10-05",
      docs: [
        sourceRefFull("Lido earnUSD exact deployed queues", "https://docs.lido.fi/earn/deployment-contracts"),
        sourceRef("Mellow earnUSD withdrawal timing", "https://docs.mellow.finance/lido-earn/earnusd.md", ["route", "settlement"]),
      ],
    },
    docs: [
      sourceRefFull("Lido earnUSD exact deployed queues", "https://docs.lido.fi/earn/deployment-contracts"),
      sourceRef("Exact USDC async RedeemQueue implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x000000000c139266ba06170ed1deaca6d11903c1", ["route", "access", "fees", "settlement"]),
      sourceRef("Exact USDC SyncRedeemQueue implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x0000000038801c7281284f8f68b80b679f64a074", ["route", "capacity", "fees"]),
    ],
    notes: [
      "The direct producer observes the actual Mellow modular-vault queues, distinct from Ember eEARN; no ERC-4626 or nonexistent live-reserves adapter is required.",
      "USDC async queue 0x9e36a74fe278906a76e7615263e46a83fc40c47f locks holder shares and claim(receiver,timestamps) pays only funded processed batches belonging to the caller. Burn pause, global lockup and account blacklisting remain applicable.",
      "USDC sync queue 0xe0eee7e956a94bd00546d9ca07e5012f11a5059d requires a usable oracle report, liquidity and rolling-limit headroom. Its maxAge=86400 is price staleness, not settlement; the API average 216000 seconds (60 hours) is not a maximum. No full-supply, zero-capacity, fixed fee or measured-unwind credit is inferred.",
    ],
  }),
  "strusd-tori": defineQueueRedeemConfig({
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "deterministic-onchain",
    outputAssets: ["trusd-tori"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(0, "Tori explicitly states staking and unstaking are free; gas, rounding and downstream trUSD issuer repurchase are separate."),
    reviewedAt: "2026-10-03",
    docs: [
      sourceRefFull("Tori strUSD staking and unstaking", "https://docs.tori.finance/products/strusd.md"),
      sourceRefFull("Verified StakedTrUSD implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x6561272e3ebc9f2e07cdb12b7c474db9132b977a"),
      sourceRef("Tori native and bridged deployments", "https://docs.tori.finance/resources/contracts.md", ["route"]),
    ],
    notes: [
      "Native Ethereum shares redeem to trUSD, subject to restricted-address checks. Bridged shares must return to the native vault first; trUSD issuer repurchase is a separate KYC-approved discretionary rail.",
      "The seven-day cooldown observed at Ethereum block 26107706 is mutable up to 90 days, not a permanently fixed settlement SLA. The aggregate 1e18-share floor is not a holder-wide economic redemption minimum.",
      "The configured erc4626-single-asset reader measures fresh native idle trUSD, capped by current convertible share backing. Separate cooldown-silo assets already fund burned claims and are not additive available capacity for new requests. No static full-supply fallback is configured.",
    ],
  }),
  "syrupusdg-maple": defineQueueRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdg-paxos"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "The native syrupUSDG PoolManager / WithdrawalManager queue path, reviewed at Ethereum block 26122343 (2026-10-04), transfers calculated NAV assets without a separate redemption-fee deduction. This is the native protocol redemption fee only, not a promise of par value or all-in zero cost: loan impairments, gas, wallet and third-party charges remain separate, as the Interface Terms section 1.4 states.",
    ),
    reviewedAt: "2026-10-03",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
      rationale: "FIFO withdrawals depend on funded liquidity and impairments; the reported average below 24 hours is not a guaranteed completion maximum. Exact executable queue throughput remains unavailable. The reviewed native protocol fee is zero, while gas, wallet and third-party costs remain separate.",
      reviewedAt: "2026-10-05",
      docs: [
        sourceRefFull("Maple syrupUSDG withdrawal risk disclosures", "https://docs.maple.finance/legal/syrupusdc-and-syrupusdt-risks.md"),
        sourceRef("Exact syrupUSDG queue implementation (reviewed 2026-10-05)", "https://eth.blockscout.com/api/v2/smart-contracts/0xf95e5722226a1018d058cd757b75f1d10289e967", ["route", "fees"]),
      ],
    },
    docs: [
      sourceRefFull("Maple syrupUSDG withdrawal risk disclosures", "https://docs.maple.finance/legal/syrupusdc-and-syrupusdt-risks.md"),
      sourceRef("Maple defaults and impairments", "https://docs.maple.finance/legal/syrupusdc-and-syrupusdt-defaults-and-impairments.md", ["capacity", "settlement"]),
      sourceRef("Exact syrupUSDG deployed contract", "https://eth.blockscout.com/api/v2/smart-contracts/0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a", ["route", "access"]),
      sourceRef("Exact syrupUSDG queue implementation (reviewed 2026-10-05)", "https://eth.blockscout.com/api/v2/smart-contracts/0xf95e5722226a1018d058cd757b75f1d10289e967", ["route", "fees"]),
      sourceRef("Maple Interface Terms section 1.4 (reviewed 2026-10-05)", "https://docs.maple.finance/legal/interface-terms-of-use-syrupusdc-and-syrupusdt.md", ["fees"]),
    ],
    notes: ["Protocol permission checks and published jurisdiction restrictions apply, including exclusions for the United States and Australia. The configured erc4626-single-asset reader measures fresh idle USDG but does not infer FIFO allocation, funded processing throughput or queue completion from that balance. No holder minimum, 30-day sibling maximum, 10% queue buffer, DEX capacity or static fallback is inferred."],
  }),
  "susdat-saturn": defineQueueRedeemConfig({
    reviewedAt: "2026-10-05",
    holderEligibility: "any-holder",
    outputAssets: ["usdat-saturn"],
    capacityModel: { kind: "unquantified" },
    costModel: documentedVariableFee(
      "Native WithdrawalQueueERC721 request/process/claim fee is determined at processing, not submission: Regular/Elevated mode parameters and gas must be observed at the request notional; no permanent fee ceiling inferred from initial runbook values",
      "formula",
    ),
    docs: [
      sourceRef("Saturn V2 deployment runbook", "https://raw.githubusercontent.com/saturn-organization/saturn-yield-dollar/main/docs/v2-deployment-runbook.md", ["route", "access", "fees", "settlement"]),
      sourceRef("Native StakedUSDat implementation", "https://sourcify.dev/server/v2/contract/1/0x2b7074cf6681382b70e239063931ebe83c0f4e0a?fields=sources,abi,runtimeMatch", ["route", "capacity", "access", "fees"]),
    ],
    notes: ["Native sUSDat requests escrow shares, operators process against available USDat, and the request owner claims USDat. Pauses and restrictions apply. Neither the runbook schedule nor idle assets establish funded request capacity or a final-completion SLA; this is not the USDat primary-market route."],
  }),
  "susdx-axis": defineQueueRedeemConfig({
    reviewedAt: "2026-10-05",
    outputAssets: ["usdx-axis"],
    capacityModel: { kind: "unquantified" },
    costModel: undisclosedReviewedFee("No complete holder fee commitment; issuer terms permit fees and third-party/gas costs."),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      reviewedAt: "2026-10-05",
      rationale: "The eligibility cooldown does not bound privileged servicing; reserved burned-share liabilities are not capacity for new requests.",
      docs: [sourceRef("Axis asynchronous servicing", "https://docs.axis.to/risk/custody-liquidity-risk.md", ["route", "settlement"])],
    },
    docs: [
      sourceRef("Axis asynchronous servicing", "https://docs.axis.to/risk/custody-liquidity-risk.md", ["route", "capacity", "access", "settlement"]),
      sourceRef("Axis terms of service", "https://www.axis.to/terms-of-service", ["fees", "settlement"]),
    ],
    notes: ["Native Ethereum StakedUSDx 0xeb892628d1e58bc475a6dcb7f5dbc4f591632aa4 burns shares on requestRedeem and reserves USDx inside the vault. A redemption-servicer must call serviceRedemptions before withdraw/redeem can claim. Read accountedAssets, pendingRedeemAssets and claimableRedeemAssets separately; there is no separate silo or instant ERC-4626 capacity proof."],
  }),
  "alusd-alchemix": defineReviewedQueueRedeemConfig(REVIEWED_QUEUE_REDEMPTION_AT, {
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
      "Ethereum V3 Transmuter 0x2584e8b0616b3e750492c9629a3b27679c410cb9 is a distinct MYT-receipt route, not this legacy V2 DAI rail. Its mutable transmutationFee applies to distributable yield and exitFee to the untransmuted synthetic portion; position maturity, exact payout legs and gas require a separately identified observer. V3 fee readings must never overwrite the legacy 1:1 DAI terms.",
    ],
  }),
  "iusd-infinifi": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: fixedFee(0, "Tracked protocol metadata describes 1:1 mint/redeem against USDC with no fees"),
  }),
  "dusd-dialectic": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    accessModel: "permissionless-onchain",
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
    reviewedAt: "2026-09-03",
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
      sourceRefRouteCapacity("Makina DUSD strategy", "https://makina.finance/strategy/dusd"),
      sourceRef(
        "DUSD AsyncRedeemer sanctions-check implementation",
        "https://eth.blockscout.com/address/0x49c4762ab838f2e5d8252b69b90a1e8587a74511?tab=contract",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef("DUSD Machine Terms", "https://makina.finance/MeccanicoToS.pdf", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "At Ethereum block 25899375 the DirectDepositor and AsyncRedeemer whitelists were disabled and both sanctions checks were enabled. The current on-chain route is permissionless for addresses that pass those checks, while the Risk Manager retains authority to re-enable either whitelist.",
      "The reviewed AsyncRedeemer sanctions-check implementation advances sequential request IDs and charges no redemption fee, but the Machine Terms provide no contractual queue priority and no perpetual zero-fee covenant.",
      "A DUSD buyback request is not a contractual redemption right, may remain unfilled indefinitely, and has only a 12-hour minimum finalization delay rather than a maximum settlement SLA.",
      "The access model records the currently executable contract path. Holder eligibility remains issuer-discretionary because the published Machine Terms retain Verified-User admission, suspension, and revocation, with no promised appeal SLA. U.S. persons and other Prohibited Persons or Jurisdictions are ineligible, and EU/EEA-originating transactions may be refused.",
      "Settlement is available only in Ethereum USDC after the operator frees accounting-token liquidity; there is no committed alternate settlement asset, and the operator may cease the Machine without notice.",
      "Fresh Makina route telemetry computes currently available queue liquidity as max(0, the Machine's idle Ethereum USDC minus the USDC liability of DUSD shares locked in the AsyncRedeemer). Because finalization is operator-batched and has no proven maximum completion bound, an open route is published as unproven settlement capacity rather than a measured zero-capacity exit. If the same-block onchain proof fails validation, the route remains missing-capacity rather than falling back to AUM, full supply, deployed positions, or a static ratio.",
    ],
  }),
  "acred-apollo-securitize": defineReviewedQueueRedeemConfig(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT, {
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
      sourceRefFull("RWA.xyz ACRED profile", "https://app.rwa.xyz/assets/ACRED"),
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
  }),
  "usdf-falcon": defineQueueRedeemConfig({
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
  }),
  "syrupusdc-maple": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      0,
      "Maple WithdrawalManager docs process queued shares into assets at the current exchange rate, with no separate protocol redemption fee described",
    ),
    docs: mapleSyrupDocs(),
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues processed as liquidity becomes available",
      "Settlement reviewed 2026-10-07: the current risk disclosures state there is no guaranteed maximum withdrawal period, so no settlement SLA exists to curate; the previously noted 30-day figure is not an issuer-published maximum",
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
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues processed as liquidity becomes available",
      "Settlement reviewed 2026-10-07: the current risk disclosures state there is no guaranteed maximum withdrawal period, so no settlement SLA exists to curate; the previously noted 30-day figure is not an issuer-published maximum",
      "Modeled route excludes secondary-market exits and instead scores the documented protocol withdrawal rail",
    ],
    telemetrySubject: "the pool's idle USDT balance",
    settlementConstraint: "the FIFO queue",
  }),
  "reusd-re-protocol": defineQueueRedeemConfig({
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
  }),
  "susdai-usd-ai": defineReviewedQueueRedeemConfig("2026-04-04", {
    costModel: documentedVariableFee(
      "sUSDai redemptions use conservative NAV while deposits use optimistic NAV; the dynamic forward-pricing spread varies with loan repayments rather than a fixed redemption fee, and no same-notional bound is evaluated",
      "formula",
    ),
    docs: [
      sourceRef("USD.AI FAQ", "https://docs.usd.ai/faq/usdai-and-susdai-101", ["route", "capacity", "settlement"]),
      sourceRef("USDai product page", "https://usd.ai/usdai", ["route", "settlement"]),
      sourceRef(
        "USD.AI sUSDai withdrawal estimates (reviewed 2026-10-03)",
        "https://docs.usd.ai/depositor/susdai/susdai-withdrawal-estimates",
        ["fees"],
      ),
    ],
    notes: [
      "Current route models sUSDai as an eventual queued exit back into USDai rather than as an immediate stablecoin redemption rail",
      "Issuer docs describe a limited instant-liquidity buffer, but Pharos does not assign a numeric immediate-capacity bound until a trustworthy public figure exists",
    ],
  }),
  "asusdf-astherus": defineQueueRedeemConfig({
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound", basis: "strategy-buffer" },
    reviewedAt: "2026-05-14",
    settlementModel: "same-day",
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Aster FAQ says there are no fees to mint or withdraw asUSDF"),
    docs: [
      sourceRefFull("Aster asUSDF FAQ", "https://docs.asterdex.com/usdf-stablecoin/overview/faqs"),
      sourceRef("Aster Earn asUSDF", "https://docs.asterdex.com/product/aster-earn/mint-asusdf", ["route"]),
    ],
    notes: [
      "asUSDF is the yield-bearing asToken wrapper over USDF; withdrawals return USDF after the documented T+1 hour / two-hour waiting period.",
      "Downstream par-exit quality then depends on USDF's own USDT redemption route.",
    ],
  }),
  "susd1plus-lorenzo": defineReviewedQueueRedeemConfig(REVIEWED_CONFIG_ONLY_GAPS_AT, {
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Lorenzo states it does not charge user deposit or withdrawal fees; yield is distributed net of protocol and execution service fees",
    ),
    docs: [
      sourceRefFull("Lorenzo USD1+ OTF launch", "https://medium.com/@lorenzoprotocol/usd1-mainnet-launch-72550abac2ed"),
      sourceRef("Lorenzo OTF app", "https://app.lorenzo-protocol.xyz/otf", ["route", "access", "settlement"]),
      sourceRef("Lorenzo website", "https://lorenzo-protocol.xyz/home", ["capacity"]),
    ],
    notes: [
      "sUSD1+ holders submit withdrawal requests through the Lorenzo OTF flow; published terms describe weekly review cycles and typical 7-14 day settlement.",
      "Executed redemptions automatically convert sUSD1+ into USD1 at processing-day NAV, so the route is modeled as queued eventual redeemability rather than an immediate stablecoin buffer.",
    ],
  }),
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
    settlementConstraint: "the live cooldownDuration() value published by reserve sync (rather than a fixed 7-day assumption)",
  }),
  "syusd-aegis": erc4626ReserveTelemetryQueueConfig({
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
  }),
  "witry-brix": defineQueueRedeemConfig({
    reviewedAt: "2026-10-05",
    capacityModel: { kind: "unquantified" },
    unresolvedOutputAssetKeys: ["asset:itry"],
    unresolvedOutputDisposition: "reviewed-external",
    accessModel: "whitelisted-onchain",
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "The canonical Ethereum wiTRY cooldownShares/unstake path (verified source, read at block 26114896 on 2026-10-03) withdraws the full assets from the silo with no protocol exit fee; the role-gated fast-redeem branch, gas, and cross-chain transport are separate",
    ),
    docs: [
      sourceRefFull("Brix iTRY audit scope overview", "https://hackmd.io/@EKJz7PaeT2GeAUJS83WWVw/SJPLb3QZWe"),
      sourceRefRouteCapacityAccess("Code4rena Brix Money audit repository", "https://github.com/code-423n4/2025-11-brix-money"),
      sourceRef("Brix website", "https://www.brix.money/", ["route", "access"]),
      sourceRef(
        "wiTRY verified source (Sourcify, reviewed 2026-10-03)",
        "https://sourcify.dev/server/v2/contract/1/0xe346c29b5b60ef870b9724c57ccfbbc631e47dee?fields=sources,abi",
        ["fees"],
      ),
    ],
    notes: [
      "Canonical Ethereum cooldownShares/unstake releases iTRY subject to the request-specific cooldownEnd and sender/receiver restrictions. At reviewed block 26122489 cooldownDuration was 300 seconds and MAX_COOLDOWN_DURATION is 90 days; neither is an unconditional final USD completion SLA. A new cooldown resets the accumulated request deadline.",
      "iTRY redemption is whitelist-gated and serviced first by the FastAccessVault DLF liquidity buffer, with custodian-managed redemption when immediate DLF liquidity is insufficient.",
      "The exact wrapper output remains unresolved for scoring because iTRY has no tracked Pharos stablecoin id; asset:itry is retained as a diagnostic identity.",
      "MegaETH redemption additionally requires the Ethereum composer and return bridge; canonical cooldown release does not bound cross-chain completion.",
    ],
  }),
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
  "cgusd-cygnus-finance": defineReviewedQueueRedeemConfig(REVIEWED_QUEUE_REDEMPTION_AT, {
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
  }),
  "uty-xsy": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(),
    reviewedAt: "2026-10-02",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The Base UTY vault identifies USDC and a current 604800-second minimum unlock delay, not a guaranteed completion deadline. Claiming still requires a funded on-chain USDC buffer; the existing 30% capacity heuristic and undisclosed-reviewed fee do not establish executable same-notional capacity or an all-in cost bound.",
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef(
          "YieldPoint UTY Base redemption",
          "https://docs.yieldpoint.io/protocol/architecture/flows.md",
          ["route", "settlement"],
        ),
        sourceRef(
          "YieldPoint Base operations",
          "https://docs.yieldpoint.io/protocol/integration/base-operations.md",
          ["route", "settlement"],
        ),
      ],
    },
    docs: [
      sourceRef(
        "YieldPoint UTY Base redemption",
        "https://docs.yieldpoint.io/protocol/architecture/flows.md",
        ["route", "settlement"],
      ),
      sourceRef(
        "YieldPoint UTY deployed contracts",
        "https://docs.yieldpoint.io/protocol/architecture/contracts.md",
        ["route"],
      ),
      sourceRef(
        "XSY UTY peg-arbitrage docs",
        "https://xsy-1.gitbook.io/xsy-main/open-market-peg-arbitrage.md",
        ["route"],
      ),
      sourceRef("XSY UTY overview", "https://xsy-1.gitbook.io/xsy-main/unity-uty-overview.md", ["route"]),
      sourceRef("XSY Accountable dashboard", "https://accountable.xsy.fi/", ["capacity"]),
    ],
    notes: [
      "Output re-reviewed 2026-10-02: current YieldPoint documentation and the Base UTY vault's asset() identify Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) as the payout asset. UTY-to-USDC redemption is Base-only; spoke holders must bridge UTY to Base before requesting redemption.",
      "The current getBondingPeriod() is 604800 seconds (7 days), establishing the async request's minimum unlock delay, not a guaranteed completion SLA. redeemById pays from the on-chain USDC buffer; current executable capacity and a fixed holder fee remain unverified. The small-amount instant extension does not establish a same-notional stress exit.",
      "The 30% ratio is a reviewed heuristic reflecting delta-neutral AVAX hedge composition rather than a published instant-liquidity floor",
    ],
  }),
  "usp-pikudao": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
    costModel: fixedFee(20, "Piku docs list a 20 bps redemption fee"),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [
      sourceRef("Piku docs", "https://docs.piku.co/piku", ["route", "capacity", "access", "fees", "settlement"]),
      sourceRef("Piku website", "https://piku.co/", ["route"]),
      sourceRef(
        "Piku USP vault holder terms",
        "https://piku.co/app/detail/USP",
        ["route", "fees", "settlement"],
      ),
    ],
    v9RouteReviewTerms: {
      settlementDelaySec: 172_800,
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef(
          "Piku USP vault holder terms",
          "https://piku.co/app/detail/USP",
          ["route", "settlement"],
        ),
      ],
    },
    notes: [
      "Piku's exact USP vault page describes FIFO redemptions processed within 48 hours, a 2-day redemption period, and a 0.20% redemption fee.",
      "The existing 10% documented-bound capacity model is unchanged; the 2026-10-02 holder-terms review verifies the fee and 48-hour settlement disclosure, not a current 10% executable cash buffer.",
    ],
  }),
  "aznd-mu-digital": defineReviewedQueueRedeemConfig(REVIEWED_QUEUE_REDEMPTION_AT, {
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
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
      "2026-09-04 adjudication: Mu Digital Terms of Use Section 4.E.ix grants eligible AZND holders the right to withdraw for USDC, and Mu Digital's mint/redeem documentation describes an approximately 7-day queue; the redemption output is therefore resolved to USDC.",
    ],
  }),
  "avusd-avant": defineReviewedQueueRedeemConfig(REVIEWED_QUEUE_REDEMPTION_AT, {
    outputAssets: ["usdc-circle"],
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Avant's avUSD redemption interface displayed a 0.05% (5 bps) redemption fee when reviewed 2026-10-05. The fee docs require checking the current frontend quote before confirmation. This is an observed issuer fee, not a perpetual ceiling or fixed all-in cost; request applicability, current fee and network gas still require producer observation.",
    ),
    docs: [
      sourceRef(
        "Avant redeeming avAssets",
        "https://docs.avantprotocol.com/overview/using-the-avant-protocol/redeeming-avassets",
        ["route", "settlement", "fees", "capacity"],
      ),
      sourceRefRouteCapacity("Avant core tokens", "https://docs.avantprotocol.com/overview/core-tokens"),
      sourceRef("Avant avUSD redemption fee display (reviewed 2026-10-05)", "https://app.avantprotocol.com/products/avusd?product=avusd&action=redeem", ["fees"]),
      sourceRef("Avant Protocol Revenue & Fees (reviewed 2026-10-05)", "https://docs.avantprotocol.com/yield-strategies-and-revenue/protocol-revenue-and-fees.md", ["fees"]),
    ],
    v9RouteReviewTerms: {
      settlementDelaySec: 604_800,
      reviewedAt: "2026-10-03",
      docs: [
        sourceRef(
          "Avant redeeming avAssets (reviewed 2026-10-03)",
          "https://docs.avantprotocol.com/overview/using-avant-protocol/redeeming-avassets",
          ["route", "settlement"],
        ),
      ],
    },
    notes: [
      "Avant docs describe redeeming avUSD back into USDC through an onchain request flow that usually completes within hours but can take up to 7 days depending on liquidity",
      "Settlement reviewed 2026-10-03: the redemption docs state requests can take up to 7 days depending on market liquidity and other conditions, so V9 uses that published 604,800-second maximum. It is not independent proof of funded execution.",
    ],
  }),
  "usdu-unitas": defineQueueRedeemConfig({
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    outputAssetType: "mixed-collateral",
    outputAssets: ["asset:sol", "asset:btc", "asset:eth"],
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: fixedFee(0, "Unitas docs list a 0% redemption fee"),
    reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
    docs: [
      sourceRefRouteCapacityAccess("Unitas minting USDu", "https://docs.unitas.so/solution-design/minting-usdu"),
      sourceRef("Unitas overview", "https://docs.unitas.so/", ["route", "fees"]),
      sourceRef("Unitas off-exchange settlement", "https://docs.unitas.so/off-exchange-settlement", ["settlement"]),
      sourceRef("Unitas terms of service", "https://docs.unitas.so/resources/terms-of-service", ["route"]),
      sourceRefRouteCapacity("Unitas delta-neutral stability", "https://docs.unitas.so/solution-overview/delta-neutral-stability"),
    ],
    notes: [
      "Direct USDu minting and redemption are restricted to whitelisted participants, while docs describe on-demand redemption flows supported by Unitas's OES settlement rails",
      "Because USDu relies on a delta-neutral collateral stack rather than a pure cash-equivalent reserve bucket, the route keeps a conservative reviewed 5% immediate-capacity bound instead of scoring against full supply",
      "Output declared 2026-07-19: the Unitas terms define redemption as burning USDu to withdraw a pro-rata share of the underlying collateral, and the delta-neutral design page names the collateral classes as SOL, BTC, and ETH (JLP and the short-perp hedge leg are strategy positions rather than deliverable collateral classes); no single-stablecoin payout is documented.",
    ],
  }),
  "yzusd-yuzu": defineReviewedQueueRedeemConfig(REVIEWED_QUEUE_REDEMPTION_AT, {
    accessModel: "issuer-api",
    outputAssets: ["usdt-tether"],
    settlementModel: "days",
    costModel: fixedFee(
      0,
      "Queued redeem orders carry redeemOrderFeePpm()=0 at Plasma block 34126349 (2026-10-03); the separate direct-redeem fee (3000 ppm) does not apply to this queued route. The fee is role-mutable and gas is separate",
    ),
    docs: [
      sourceRefRouteCapacityAccess("Yuzu Money documentation", "https://yuzu-money.gitbook.io/yuzu-money"),
      sourceRef("Yuzu Accountable dashboard", "https://yuzu.accountable.capital/", ["capacity"]),
      sourceRef(
        "Yuzu redemption contract verified source (Routescan, reviewed 2026-10-03)",
        "https://api.routescan.io/v2/network/mainnet/evm/9745/etherscan/api?module=contract&action=getsourcecode&address=0x8e02392855a51d9d5d18d71a7cfc731f56c68ea5",
        ["fees"],
      ),
    ],
    notes: [
      "Yuzu documents primary minting and redemption for eligible KYC / AML-cleared investors; current model treats that rail as a reviewed queued exit rather than assuming continuously available public stablecoin liquidity",
    ],
  }),
  "usdat-saturn": defineQueueRedeemConfig({
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(
      "Saturn documents KYC-gated 1:1 USDC mint and redeem through the M0 Swap Facility (Uniswap V3 1bps tier); public docs reviewed do not publish a separate USDAT protocol redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRefRouteCapacity("Saturn USDAT", "https://saturn.money/usdat"),
      sourceRef("Saturn documentation", "https://docs.saturn.money/", ["route", "access"]),
    ],
    notes: [
      "USDAT is a permissioned M0 wrapper: mint/redeem requires KYC onboarding and is geofenced away from US, EEA, and OFAC jurisdictions; routes through the Uniswap V3 1bps tier against USDC",
      "The 50% ratio is a reviewed heuristic placeholder for M0 Swap Facility liquidity pending a published quantitative buffer bound",
    ],
  }),
  "usdnr-nerona": defineQueueRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["m-m0"],
    settlementModel: "days",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Nerona's fee documentation states there are no mint or redeem fees on USDnr itself at the protocol level; the 1% instant fee and the four-day unwind apply to sUSDnr, not USDnr",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
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
  }),
  "usdh-hermetica": defineQueueRedeemConfig({
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
      sourceRefRouteCapacityAccess("Hermetica documentation", "https://docs.hermetica.fi/"),
    ],
    notes: [
      "Delta-neutral BTC strategy (spot long + short perpetual) on Stacks; KYC-gated mint/redeem via the Hermetica app",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol cash buffers rather than a published Hermetica-specific figure",
    ],
  }),
  "usdrif-rif": defineReviewedQueueRedeemConfig(REVIEWED_PHASE_4_COVERAGE_AT, {
    outputAssets: ["asset:rif"],
    outputAssetType: "mixed-collateral",
    costModel: fixedFee(25, "RIF On Chain FAQ lists a 0.25% mint/redeem fee paid in RIF for USDRIF"),
    docs: [
      sourceRef(
        "Legacy RIF On Chain USDRIF redemption docs",
        "https://docs.moneyonchain.com/rdoc-contract/integration-with-roc-platform/getting-rdocs/redeeming-rdocs",
        ["route", "settlement", "access"],
      ),
      sourceRefRouteCapacityFees("RIF On Chain FAQ", "https://wiki.rifonchain.com/frequently-asked-questions/web-app-faq"),
      sourceRef(
        "RIF On Chain system states",
        "https://docs.moneyonchain.com/rdoc-contract/rif-on-chain-platform/system-states",
        ["route", "capacity", "settlement"],
      ),
      sourceRef(
        "RIF bucket MocQueue verified implementation (reviewed 2026-10-07)",
        "https://rootstock.blockscout.com/api/v2/smart-contracts/0x8d7a31357ba29fecd3e6ce5b6110a2a28f619c97",
        ["route", "settlement"],
      ),
    ],
    notes: [
      "Settlement review 2026-10-07: at Rootstock block 9304993 (2026-10-07T15:41:38Z), legacy MoCSettlement getters revert because the protocol migrated to V2; its old 90-day target is not a current USDRIF payout maximum.",
      "The RIF bucket queue 0x47f5014115d3bb29b20b5168ee75050d6f8c3bf1 at the same block uses implementation 0x8d7a31357ba29fecd3e6ce5b6110a2a28f619c97 and min/max operation waits of 1/6 blocks. These are execution-eligibility thresholds, not deadlines: guarded batch execution and failed operations leave final payout unbounded. Keyless pinned RPC: https://public-node.rsk.co.",
    ],
  }),
  "apyusd-apyx": erc4626ReserveTelemetryQueueConfig({
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: {
      ...documentedVariableFee(
        "At Ethereum block 26140624 (2026-10-07), apyUSD charges a 10 bps upfront vault fee and escrows apxUSD in UnlockReceipt; the receipt fee is bounded from 0 to 3.4%, with claims enabled after 259200 seconds and the fee reaching zero after 1728000 seconds. The 350 bps ceiling bounds protocol fees, not gas or a downstream apxUSD-to-fiat redemption.",
        "formula",
      ),
      feeBpsMin: 10,
      feeBpsMax: 350,
    },
    v9RouteReviewTerms: {
      settlementDelaySec: 259_200,
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef(
          "apyUSD active vault, receipt pointer and unlocking fee (Ethereum block 26140624)",
          "https://eth.blockscout.com/address/0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A?tab=contract",
          ["route", "settlement"],
        ),
        sourceRef(
          "UnlockReceipt funded escrow, claim and fee curve (Ethereum block 26140624)",
          "https://eth.blockscout.com/address/0x9bf51f33955ec70f87c4b5c49441815589043237?tab=contract",
          ["route", "settlement"],
        ),
      ],
    },
    docs: [
      sourceRefFull("apyUSD overview", "https://docs.apyx.fi/product-overview/apyusd-overview"),
      sourceRef("Apyx smart contract addresses", "https://docs.apyx.fi/resources/smart-contract-addresses", ["route"]),
      sourceRefFull("apyUSD active vault source (implementation pinned at Ethereum block 26140624)", "https://eth.blockscout.com/address/0xfD616567EcC1607F61073951A1E822F7315bB112?tab=contract"),
      sourceRefFull("UnlockReceipt claim and bounded fee source (implementation pinned at Ethereum block 26140624)", "https://eth.blockscout.com/address/0x54F1c7fFe10bC392f08AE9432A7e21a6E86bB982?tab=contract"),
    ],
    telemetrySubject: "the vault's idle apxUSD balance",
    settlementConstraint: "the documented unlock window",
  }),
  "savusd-avant": erc4626ReserveTelemetryQueueConfig({
      reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
      settlementModel: "days",
      executionModel: "rules-based-nav",
      costModel: fixedFee(
        0,
        "StakedAvUSDV2 ERC-4626 (0x06d47f3fb376649c3a9dafe069b3d6e35572219e) charges no exit fee: on-chain previewRedeem == convertToAssets, source shows a vesting-only adjustment; the Avant redemption 'fee' applies to the downstream avUSD leg",
      ),
      docs: [
        sourceRefFull(
          "Avant staking avAssets",
          "https://docs.avantprotocol.com/overview/using-the-avant-protocol/staking-avtokens-avusd-avbtc",
        ),
        sourceRef(
          "Avant unstaking savAssets",
          "https://docs.avantprotocol.com/overview/using-the-avant-protocol/unstaking-savassets",
          ["settlement", "capacity"],
        ),
      ],
      telemetrySubject: "the staking vault's idle avUSD balance",
      settlementConstraint: "the one-day cooldown",
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
  }),
  "srusde-strata": defineQueueRedeemConfig({
    reviewedAt: "2026-10-05",
    capacityModel: { kind: "reserve-sync-metadata", requiredOutputAssetKeys: ["usde-ethena", "susde-ethena"] },
    accessModel: "whitelisted-onchain",
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    unresolvedOutputAssetKeys: ["usde-ethena", "susde-ethena"],
    unresolvedOutputDisposition: "reviewed-external",
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
      "Holder-selected sUSDe and USDe payouts are mutually exclusive, not a basket. A successful sUSDe withdrawal can be atomic only when the same-run senior strategy cooldown is zero; USDe instead unstakes through Ethena and has no proven final-completion SLA. Neither the FAQ's seven days nor a current Ethena cooldown is a request-to-final-claim bound.",
      "Separate output-bound executable observations must retain their shared Strata resources. The existing idle underlying telemetry is not a two-output basket quote and must not establish a branch's settlement or capacity.",
    ],
  }),
  "scusd-rings": defineReviewedQueueRedeemConfig(REVIEWED_YIELD_COVERAGE_WAVE_AT, {
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether", "dai-makerdao"],
    settlementModel: "days",
    costModel: documentedVariableFee("Rings docs describe scAsset redemption after a three-day cooldown"),
    reviewedAt: "2026-07-27",
    docs: [
      sourceRefFull("Rings backing", "https://docs.rings.money/backing"),
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
  }),
  "hbusdt-hyperbeat": defineReviewedQueueRedeemConfig(REVIEWED_YIELD_COVERAGE_WAVE_AT, {
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
      sourceRefFull("Hyperbeat USDT vault", "https://docs.hyperbeat.org/hyperbeat-earn/usdt-vault"),
      sourceRef("Hyperbeat addresses", "https://docs.hyperbeat.org/resources/addresses", ["route"]),
    ],
  }),
  ...NEST_NAV_VAULT_CONFIGS,
  "inalpha-nest": defineReviewedQueueRedeemConfig(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT, {
    outputAssets: ["usdc-circle", "pusd-plume"],
    accessModel: "issuer-api",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-basket",
    costModel: undisclosedReviewedFee(
      "Nest docs describe nALPHA/inALPHA redemption requests through the app and atomic queue; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("Nest liquidity and redemptions", "https://docs.nest.credit/about/liquidity-and-redemptions"),
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
  }),
  "busd0-usual": defineReviewedQueueRedeemConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
    settlementModel: "queued",
    costModel: undisclosedReviewedFee(
      "Usual docs describe permissionless bUSD0 redemption into USD0: early par exit requires the matching rt-bUSD0 token, while bUSD0 alone redeems at maturity; public docs reviewed do not publish a separate redemption fee",
    ),
    docs: [
      sourceRefFull("Usual bUSD0 docs", "https://docs.usual.money/usual-products/yield-products/usd-products/bond-usd0"),
      sourceRefFull(
        "Usual bUSD0 fact sheet",
        "https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/busd0",
      ),
    ],
    notes: [
      "Before June 11, 2028, par redemption requires recombining bUSD0 with rt-bUSD0; bUSD0-only redemption is modeled as documented-bound eventual capacity because the standalone bond leg does not redeem at par until maturity",
      "Secondary-market exits and optional governance floor redemption are excluded from the modeled route",
    ],
  }),
  "usdm-monetrix": defineQueueRedeemConfig({
    settlementModel: "days",
    executionModel: "deterministic-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    reviewedAt: "2026-10-01",
    costModel: undisclosedReviewedFee(
      "Monetrix public docs specify 1:1 redemption and cooldown but no numeric redemption fee; network gas remains separate",
    ),
    routeExitCorrelation: "same-protocol-liquidity",
    docs: [
      sourceRef("Redeem guide", "https://doc.monetrix.xyz/guide/getting-started/redeem.md", ["route", "settlement", "access"]),
      sourceRefRouteCapacityAccess("Mint guide", "https://doc.monetrix.xyz/guide/getting-started/mint.md"),
      sourceRef("Delta-neutral strategy", "https://doc.monetrix.xyz/how-it-works/delta-neutral-strategy.md", [
        "capacity",
        "route",
      ]),
      sourceRef("FAQ", "https://doc.monetrix.xyz/guide/getting-started/faq.md", ["route", "settlement", "fees"]),
      sourceRef("Audits and contracts", "https://doc.monetrix.xyz/risk-and-security/audits-and-contracts.md", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "USDM redemption is a permissionless request/claim flow: requestRedeem burns USDM and locks a 1:1 USDC claim, then claimRedeem transfers USDC after the governance-set three-day cooldown.",
      "Capacity re-reviewed 2026-10-01: the current redemption guide still documents the USDC request/claim rail and a governance-adjustable three-day cooldown, but publishes no hard executable USDC buffer. The 10% strategy-buffer ratio therefore remains heuristic, not a live balance or full-supply promise. The guide expressly says the TVL cap is mint-side and should not affect redemption.",
    ],
  }),
};

const FINALIZED_QUEUE_REDEEM_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  defineRecordEntries(RAW_QUEUE_REDEEM_BACKSTOP_CONFIGS),
  [{ stablecoinIds: ["iusd-infinifi"], reviewedAt: REVIEWED_REMEDIATION_AT }],
);

export const QUEUE_REDEEM_BACKSTOP_ENTRIES = FINALIZED_QUEUE_REDEEM_BACKSTOP_REGISTRY.entries;
