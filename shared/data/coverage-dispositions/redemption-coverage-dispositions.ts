import type { RedemptionRouteFamily } from "@shared/types/redemption";

export const REDEMPTION_COVERAGE_DISPOSITIONS = ["add", "defer", "hard-reject", "needs-research"] as const;
export type RedemptionCoverageDisposition = (typeof REDEMPTION_COVERAGE_DISPOSITIONS)[number];

export const REDEMPTION_COVERAGE_REASON_CODES = [
  "borrower-repay-only",
  "capacity-unpublished",
  "documentation-insufficient",
  "holder-route-confirmed",
  "issuer-terms-missing",
  "no-holder-route",
  "pegkeeper-only",
  "route-status-unverified",
  "secondary-market-only",
] as const;
export type RedemptionCoverageReasonCode = (typeof REDEMPTION_COVERAGE_REASON_CODES)[number];

export interface ReviewedRedemptionCoverageDisposition {
  id: string;
  disposition: RedemptionCoverageDisposition;
  reasonCode: RedemptionCoverageReasonCode;
  blocker: string;
  rationale: string;
  evidenceNeeded: string;
  evidenceUrls: readonly string[];
  reviewer: string;
  reviewedDate: string;
  allowedRouteFamilyIfProven: RedemptionRouteFamily | null;
}

const REVIEWER = "Pharos Safety research";
const REVIEWED_DATE = "2026-10-01";

function reviewed(
  row: Omit<ReviewedRedemptionCoverageDisposition, "reviewer" | "reviewedDate">,
): ReviewedRedemptionCoverageDisposition {
  return { ...row, reviewer: REVIEWER, reviewedDate: REVIEWED_DATE };
}

/**
 * Rows reviewed after the {@link REVIEWED_DATE} sweep carry their own evidence
 * pin. `reviewedDate` is the date the evidence was read, never the date the
 * file was edited.
 */
function reviewedOn(
  reviewedDate: string,
  row: Omit<ReviewedRedemptionCoverageDisposition, "reviewer" | "reviewedDate">,
): ReviewedRedemptionCoverageDisposition {
  return { ...row, reviewer: REVIEWER, reviewedDate };
}

/**
 * Source-reviewed decisions for every active stablecoin without a redemption
 * config. The coverage audit rejects missing, duplicate, unknown, configured,
 * or no-longer-active rows so this list cannot silently become stale. The
 * October 2026 review includes dated source-recovery outcomes; a failed fetch
 * retains the earlier adverse assessment, never proves that a route is absent.
 */
export const REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS: readonly ReviewedRedemptionCoverageDisposition[] = [
  reviewedOn("2026-10-03", {
    id: "usdfr-forest-road",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No completed exact-controller USDC redemption-capacity adapter exists.",
    rationale: "Eligible KYC-verified, nonblocked Ethereum holders redeem atomically while fully backed and unpaused through controller 0x50ac018eb6400f247ffe0fa7f1d4e0e900cdb47c against reserve 0x8317736611b542ddb4a820fe344b621a904bdd48. Idle USDC alone does not prove effective controller gates or executable same-notional output. Public credit/revenue history does not establish holder cash capacity. The sUSDfr 21-day queue and its minimum are separate.",
    evidenceNeeded: "Fresh canonical-USDC output capacity with exact-controller eligibility, pause/backing gates and any effective caps; binding current direct redemption fees.",
    evidenceUrls: [
      "https://forestroadvault.com/docs/how-to",
      "https://forestroadvault.com/docs/addresses",
      "https://forestroadvault.com/docs/roles-and-governance",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "usdx-axis",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No current executable USDC/USDT RFQ capacity or exact-route capacity adapter is available.",
    rationale: "Approved KYC/KYB primary counterparties require discretionary RFQ approval and operator submission before atomic settlement. Indicative 2%-of-book/day and seven-day bands are not committed throughput, completion SLAs or binding fees. Unmeasured liquidity is unavailable, not zero.",
    evidenceNeeded: "Current accepted-quote executable capacity, binding settlement and fee terms, and an exact-route capacity reader.",
    evidenceUrls: [
      "https://docs.axis.to/usdx-the-synthetic-dollar/mint-and-redeem.md",
      "https://docs.axis.to/resources-and-legal/eligibility-and-onboarding.md",
      "https://www.axis.to/terms-of-service",
    ],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewedOn("2026-10-03", {
    id: "susdc-spark-v1",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "Legacy V1 USDC capacity requires the current PSM pocket; no exact-route capacity/fee adapter exists.",
    rationale: "USDC and in-kind sUSDS shares are distinct holder choices, not an equal-weight portfolio or additive pocket. Governance-variable tin/tout and zero values at the research pin do not establish enduring fees. Share conversion alone does not establish available output liquidity.",
    evidenceNeeded: "Fresh USDC PSM pocket capacity and fee/gate reads, separately scoped from any sUSDS in-kind redemption.",
    evidenceUrls: [
      "https://docs.spark.finance/products/spark-savings",
      "https://eth.blockscout.com/api/v2/smart-contracts/0xf943cb8d5f06f2bbf352878ebef3ec5c537a20ba",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "usdr-rise",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No exact-route telemetry measures executable same-chain wM output through SwapFacility.",
    rationale: "The reviewed child-to-wM route requires an unrestricted holder, allowance, approved extensions and unpaused SwapFacility. Native M is approved-swapper-only; telemetry for child-to-native-M gates or custody backing cannot certify wM output capacity. No dollars, solver exit or full-supply capacity is inferred.",
    evidenceNeeded: "Fresh same-chain wM quote, output liquidity and effective SwapFacility/extension gates for the holder route, distinct from native-M telemetry.",
    evidenceUrls: [
      "https://docs.risechain.com/docs/rise-evm/usdr",
      "https://docs.m0.org/resources/addresses/m0-platform",
      "https://explorer.risechain.com/api/v2/smart-contracts/0xf9733d0bf530b02929ab81cf78e7d0befd3a2d7b",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "mantrausd-mantra",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No exact-route telemetry measures executable same-chain wM output through SwapFacility.",
    rationale: "The reviewed child-to-wM route requires an unrestricted holder, allowance, approved extensions and unpaused SwapFacility. Native M is approved-swapper-only; telemetry for child-to-native-M gates or custody backing cannot certify wM output capacity. No dollars, solver exit or full-supply capacity is inferred.",
    evidenceNeeded: "Fresh same-chain wM quote, output liquidity and effective SwapFacility/extension gates for the holder route, distinct from native-M telemetry.",
    evidenceUrls: [
      "https://mantrausd.com/",
      "https://docs.m0.org/resources/addresses/m0-platform",
      "https://blockscout.mantrascan.io/api/v2/smart-contracts/0x9d7a7b406568668e7943740f5b370c86e13dcca8",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "susdat-saturn",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No exact-route adapter measures funded NFT-queue settlement or operator throughput; availability remains unknown.",
    rationale: "Eligible unrestricted holders request at least 10 USDat, then operator processing and a funded claim must precede payout. An unpaused vault does not establish resumed processing after the undated V2 migration hold. Research-pin cash and STRCon NAV are reserve evidence, not executable queue capacity; processing-time fee mode is not an all-in fee bound.",
    evidenceNeeded: "Current operator-processing availability, funded same-notional USDat claims, queue throughput, completion bounds and effective fees.",
    evidenceUrls: [
      "https://saturncredit.gitbook.io/saturn-docs/solution/susdat-overview/staking-and-unstaking-process.md",
      "https://raw.githubusercontent.com/saturn-organization/saturn-yield-dollar/main/docs/v2-deployment-runbook.md",
      "https://eth.blockscout.com/api/v2/smart-contracts/0x2b7074cf6681382b70e239063931ebe83c0f4e0a",
      "https://saturn.credit/legal/terms-conditions",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "earnusd-lido",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No exact-route adapter measures funded USDC RedeemQueue settlement capacity.",
    rationale: "The non-ERC-4626 ShareManager request-and-claim route returns USDC with configurable access, locks and pauses. A typical three-day wait is not a completion maximum. Research-pin zero FeeManager values are not enduring fee terms; ERC-4626 probes and historical balances cannot replace exact queue telemetry.",
    evidenceNeeded: "Fresh USDC RedeemQueue funded claims, effective ShareManager gates, queue throughput, completion bounds and current all-in fees.",
    evidenceUrls: [
      "https://docs.lido.fi/earn/",
      "https://docs.lido.fi/earn/deployment-contracts",
      "https://docs.lido.fi/earn/architecture/managers/sharemanager/",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "susdx-axis",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No exact-route adapter measures USDx funded service capacity or executable queue throughput.",
    rationale: "The configurable seven-day cooldown is a minimum, not completion: privileged servicing must make USDx claimable afterward. ERC-7540 preview methods intentionally revert. Parent RFQ pricing and sUSDe fees cannot establish this holder's USDx settlement or all-in costs.",
    evidenceNeeded: "Fresh serviced and funded USDx claims, effective cooldown/access gates, maximum completion terms and exact holder fees.",
    evidenceUrls: [
      "https://docs.axis.to/susdx-the-rewards-vault/stake-and-unstake.md",
      "https://docs.axis.to/reference/staking-contracts.md",
      "https://docs.axis.to/reference/access-control.md",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewedOn("2026-10-03", {
    id: "xgld-unitas",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "Committed native XAUt capacity and funded stressed strategy-unwind throughput are undisclosed.",
    rationale: "Whitelisted users redeem on BNB Chain for XAUt after a seven-day cooldown and strategy reduction. The cooldown is not a funded claim or completion maximum; Base holders must first bridge back. The published 0.1% redemption fee excludes gas/bridge charges and does not prove dollars or physical delivery.",
    evidenceNeeded: "Exact native redemption-contract funded XAUt capacity, eligibility, holder minimum and bounded unwind/settlement terms.",
    evidenceUrls: ["https://docs.unitas.so/overview/xgld.md"],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  {
    id: "zarsc-supercoin",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Supercoin terms section 7.1 describes direct issuer redemption through the Supercoin App only once launched; current Supported Exchange off-ramps have no guaranteed price, availability or settlement outcome.",
    rationale:
      "The future app's two-business-day bank-payment term is not a currently usable holder route. Trading or selling through an exchange cannot establish issuer par redemption or funded executable capacity.",
    evidenceNeeded:
      "Primary evidence that the Supercoin App redemption channel is live, with current onboarding, payout, minimum, fee, liquidity and settlement terms.",
    evidenceUrls: ["https://www.supercoin.co.za/terms-of-service"],
    reviewer: "Sol addition batch 2026-10-03 (orchestrated)",
    reviewedDate: "2026-10-03",
    allowedRouteFamilyIfProven: "offchain-issuer",
  },
  reviewedOn("2026-10-01", {
    id: "bnusd-balanced",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Balanced's current v1 documentation says the original app is no longer supported and must be withdrawn from or migrated before December 1, 2026. The migration guide distinguishes bnUSD(old), used by v1 loans and pools, from the new bnUSD; it does not establish a current stablecoin redemption for the tracked old token.",
    rationale:
      "A 1:1 Stability Fund swap into USDC or USDT is documented in the abstract, but nothing published shows a holder of the tracked v1 token calling it today: the only documented v1 action is migrating bnUSD(old) 1:1 into the new bnUSD, and that new identity is not this tracked asset. Crediting the fund's capacity here would attribute a route on one token to a different one.",
    evidenceNeeded:
      "The active Stability Fund or SODAX route identifier reachable from the tracked ICON contract, plus its pause state, stablecoin balances, redemption limits, fee, and access terms — or a tracked-asset identity update to the current bnUSD deployment.",
    evidenceUrls: [
      "https://docs.balanced.network/",
      "https://docs.balanced.network/migrate-assets",
      "https://balanced.network/stablecoin/",
      "https://www.sodax.com/partners/balanced",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "btcusd-btcfi",
    disposition: "hard-reject",
    reasonCode: "borrower-repay-only",
    blocker:
      "BTCFi materials document BtcUSD repayment against the user's own loan and Everdex liquidity, not holder redemption for collateral.",
    rationale: "A CDP close path is available to borrowers only and cannot be credited as an exit for acquired BtcUSD.",
    evidenceNeeded:
      "Official holder redemption documentation and live contract or app evidence including fees and capacity.",
    evidenceUrls: [
      "https://docs.bifrostnetwork.com/eng.btcfi.one",
      "https://docs.bifrostnetwork.com/eng.btcfi.one/dashboard/4.-repay-btcusd",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "crvusd-curve",
    disposition: "hard-reject",
    reasonCode: "pegkeeper-only",
    blocker:
      "The earlier review identified borrower repayment and PegKeeper operations, not holder collateral redemption. Both cited resources URLs returned HTTP 404 on 2026-10-01; that source-recovery failure does not establish any new route or re-verify their historical contents.",
    rationale:
      "Borrower debt repayment and protocol-operated pool rebalancing do not give an unrelated holder a redemption claim.",
    evidenceNeeded:
      "A new audited permissionless holder redemption function and evidence of its current capacity and fees.",
    evidenceUrls: [
      "https://resources.curve.finance/crvusd/loan-concepts/",
      "https://resources.curve.finance/crvusd/pegkeepers/overview/",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "eurot-token-teknoloji",
    disposition: "hard-reject",
    reasonCode: "secondary-market-only",
    blocker:
      "Token Teknoloji describes reserve backing and sale through Bitlo, but no direct euro redemption rail for token holders.",
    rationale:
      "Conversion through an exchange to Turkish lira is secondary-market liquidity, not issuer redemption into the peg asset.",
    evidenceNeeded:
      "Issuer terms proving direct EUROT redemption for euros, including eligibility, minimums, fees, and settlement.",
    evidenceUrls: [
      "https://www.token.com.tr/rezerv-tokenlar/euro-token-eurot/",
      "https://www.token.com.tr/rezerv-kanitlari/",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "frax-frax",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker:
      "The maintained Frax documentation index describes frxUSD and other current products but does not establish a holder redemption facility for the separately tracked legacy FRAX token. The earlier AMO-only assessment is retained, not transferred to the frxUSD identity.",
    rationale: "Protocol treasury operations and secondary liquidity cannot be treated as a deterministic holder exit.",
    evidenceNeeded: "New official holder-facing redemption terms with callable mechanics, output, fees, and capacity.",
    evidenceUrls: ["https://docs.frax.finance/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "home-homecoin",
    disposition: "hard-reject",
    reasonCode: "documentation-insufficient",
    blocker:
      "HomeCoin's public site and repository do not provide current holder redemption mechanics, capacity, fees, or status.",
    rationale: "A route cannot be inferred from the token's branding or reserve claims without executable terms.",
    evidenceNeeded:
      "Maintained official documentation and live contract or app evidence for a holder-exercisable exit.",
    evidenceUrls: ["https://www.homecoin.finance/", "https://github.com/homecoin-finance/gitbook"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "isc-international-stable-currency",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The ISC website and dashboard could not be fetched on 2026-10-01. The reachable whitepaper describes reserve buying and selling in markets, not an identified holder-callable redemption; the prior dashboard's zero figures are historical and are not treated as current observations.",
    rationale:
      "Reserve-market buybacks described in the whitepaper are issuer operations, not enough to prove a currently usable holder redemption.",
    evidenceNeeded:
      "A live app or contract route, output basket or asset, execution rules, capacity, fees, and settlement evidence.",
    evidenceUrls: [
      "https://isc.money/",
      "https://isc.money/dashboard",
      "https://wp.isc.money/how-isc-works/the-isc-reserves/basic-mechanics",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewedOn("2026-10-01", {
    id: "iusd-initia",
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker:
      "Initia's bridge page re-read on 2026-10-01 describes generic Skip, LayerZero, CCTP, IBC, and DEX routing, but names no iUSD-specific burn, unwrap, output contract, fee, or capacity.",
    rationale:
      "The shape research suggests — burn iUSD, unlock AUSD0 locally, reverse the LayerZero route, then redeem through Agora — is assembled from generic bridge and issuer functionality, and no documented Move view or entry point exposes the vault's unlocked balance, the burn entrypoint, or a fee and settlement schedule.",
    evidenceNeeded:
      "Official iUSD product docs, contract address, holder exit mechanics, underlying asset, fees, and current status.",
    evidenceUrls: ["https://docs.initia.xyz/home/tools/bridge", "https://scan.initia.xyz"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "lvusd-leverup",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Current LeverUp docs do describe conditional LVUSD-to-USDC holder redemption, contrary to the earlier borrower-only classification: protocol-loss redemptions use the prevailing circulation exchange rate, and a secondary-market TWAP below 0.9 enables daily quota-based exits.",
    rationale:
      "A conditional, quota-limited, potentially below-par exit is not a continuously open 1:1 collateral claim. No live gateway state, quota, fee, or complete execution bound was established in this review.",
    evidenceNeeded:
      "Exact deployed LVUSD/USDC gateway, live activation condition, daily quota, exchange-rate calculation, fee, and current executable USDC inventory.",
    evidenceUrls: ["https://leverup.gitbook.io/docs/liquidity-layer/lvusd-stablecoin"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-01", {
    id: "mai-qidao",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker:
      "QiDao's PSM documentation is reachable at /docs/peg-stability-module and explicitly describes permissionless MAI redemption after a three-day public withdrawal queue. It names USDC and DAI strategies but gives no numeric redemption fee or live executable PSM capacity.",
    rationale:
      "Source recovery completes the documentation milestone, not route admission: neither CDP repayment fees nor deposited strategy assets establish the PSM payout fee or currently withdrawable inventory.",
    evidenceNeeded:
      "Exact active PSM deployments and complete payout identities, current queue and fee parameters, pause state, and same-run executable withdrawal capacity.",
    evidenceUrls: [
      "https://docs.mai.finance/docs/peg-stability-module",
      "https://docs.mai.finance/docs/fees",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewed({
    id: "money-defi-money",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "defi.money documents CDP repayment and PegKeeper operations, not permissionless MONEY redemption for protocol collateral.",
    rationale: "The Curve-style borrowing architecture gives borrowers a repay path while holders depend on markets.",
    evidenceNeeded: "Official holder redemption contract evidence with output, capacity, fees, and current status.",
    evidenceUrls: [
      "https://docs.defi.money/welcome/money/money-a-stablecoin",
      "https://docs.defi.money/welcome/how-does-it-work/borrow-rate",
    ],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "msusd-metronome",
    disposition: "hard-reject",
    reasonCode: "secondary-market-only",
    blocker:
      "Metronome documents synth-to-synth marketplace trades and external DEX liquidity, not msUSD redemption into posted collateral.",
    rationale: "Internal swaps and protocol-owned liquidity are market exits rather than a holder redemption claim.",
    evidenceNeeded: "Official ordinary-holder redemption mechanics with output, capacity, fees, and settlement.",
    evidenceUrls: [
      "https://docs.metronome.io/metronome-synth/metronome-synth-protocol/synth-marketplace",
      "https://docs.metronome.io/metronome-synth/protocol-owned-liquidity/external-liquidity",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "nusd-nexus",
    disposition: "hard-reject",
    reasonCode: "route-status-unverified",
    blocker:
      "The Synapse documentation endpoint could not be fetched on 2026-10-01. The current website documents bridging but no maintained NUSD holder redemption terms; the earlier unverified-route assessment remains, without treating a failed fetch as proof of nonexistence.",
    rationale: "Legacy token history and secondary bridge liquidity are insufficient to model a current backstop.",
    evidenceNeeded: "New maintained issuer or protocol documentation plus live callable route evidence.",
    evidenceUrls: ["https://docs.synapseprotocol.com/", "https://synapseprotocol.com/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "nxusd-nereus",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Nereus's current site describes perpetual trading and cross-chain deposits and withdrawals, but does not identify an NXUSD redemption gateway. The historical borrower-repayment path is not a verified current holder route.",
    rationale: "The lending position close path is not available to arbitrary token holders.",
    evidenceNeeded: "Official redemption docs or audited callable route for ordinary holders.",
    evidenceUrls: ["https://nereus.finance/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "pht-pht",
    disposition: "defer",
    reasonCode: "no-holder-route",
    blocker:
      "PHT materials do not document a broad holder-exercisable redemption against collateral or an issuer reserve.",
    rationale: "A stablecoin claim without callable holder mechanics is not a scoreable route.",
    evidenceNeeded: "Official redemption docs or an audited callable route for ordinary holders.",
    evidenceUrls: ["https://www.apacx.io/PHT", "https://docs.apacx.io/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "spusd-soulpeg",
    disposition: "defer",
    reasonCode: "documentation-insufficient",
    blocker:
      "SoulPeg's current introduction promises 1:1 conversion between sUSDC and SPUSD, so reverse wrapping is not ruled out. It still does not establish a complete ordinary-holder SPUSD-to-USDC withdrawal with executable capacity, lock conditions, fees, and deployed contract identity.",
    rationale:
      "The documented wrapper conversion alone does not prove that a secondary SPUSD holder can unlock and withdraw Venus-backed USDC.",
    evidenceNeeded:
      "Audited reverse-wrapper and USDC withdrawal contracts, secondary-holder access and lock conditions, fees, and same-run withdrawable capacity.",
    evidenceUrls: ["https://docs.soulpeg.io/"],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewed({
    id: "stusd-stoneyield",
    disposition: "needs-research",
    reasonCode: "capacity-unpublished",
    blocker:
      "StoneYield's current contract-design page describes manually unlocked STUSD, owner-controlled strategy withdrawals, and an internal Venus ERC-4626 vault; it does not identify a complete public STUSD burn-to-USDC route or executable capacity.",
    rationale:
      "The USDC-linked wrapper may have a vault exit, but the accessible sources are insufficient to model it safely.",
    evidenceNeeded: "Deployed redeem function, USDC output, queue or cooldown, fees, live capacity, and route status.",
    evidenceUrls: ["https://docs.stoneyield.io/", "https://docs.stoneyield.io/docs/protocol/contract-design"],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewed({
    id: "susd-hedgecore",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker:
      "HedgeCore documents operator-controlled redemption and a one-way transferable wrapper without a reverse conversion for ordinary holders.",
    rationale: "Operator discretion and the absent reverse wrapper path prevent treating sUSD as holder-redeemable.",
    evidenceNeeded:
      "New public reverse conversion and USDC withdrawal mechanics with audited contracts and current capacity.",
    evidenceUrls: ["https://docs.hedgecore.io/docs/protocol/yield-generation"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "usda-alpha-partner",
    disposition: "hard-reject",
    reasonCode: "documentation-insufficient",
    blocker:
      "Alpha Partner publishes no verifiable reserves, mint/redeem process, holder eligibility, fees, capacity, or settlement terms.",
    rationale:
      "Issuer marketing claims and owner-controlled mint/burn permissions do not create a holder redemption right.",
    evidenceNeeded: "Audited reserve evidence and binding official redemption terms backed by a live route.",
    evidenceUrls: ["https://alphapartner.vip/", "https://ap-organization-1.gitbook.io/alpha-partners"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "usdr-ring",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker:
      "Ring documents protocol-controlled reserve and liquidity management without a holder-exercisable USDR redemption claim.",
    rationale: "Protocol-controlled value and secondary pools cannot substitute for deterministic redemption.",
    evidenceNeeded: "New official holder redemption terms and live callable route evidence.",
    evidenceUrls: ["https://docs.ring.exchange/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "usdu-usdu-finance",
    disposition: "hard-reject",
    reasonCode: "secondary-market-only",
    blocker:
      "USDU materials describe DAO adapter issuance and Curve conversion, not a contractual holder redemption into USDC.",
    rationale: "A Curve trade is already part of market liquidity and is not a separate redemption backstop.",
    evidenceNeeded: "New protocol redemption mechanics with deterministic output, capacity, fees, and route status.",
    evidenceUrls: ["https://usdu.gitbook.io/docs/", "https://usdu.finance/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "usdx-kava",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker: "Kava Mint documents USDX repayment to close an owner's CDP, not broad holder redemption for collateral.",
    rationale: "The position-specific repay flow does not serve a holder who acquired USDX elsewhere.",
    evidenceNeeded: "Official holder redemption documentation and a current callable route.",
    evidenceUrls: ["https://help.app.kava.io/article/15-what-is-kava-mint"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "usdxl-last",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Last's website could not be fetched on 2026-10-01; the reachable HypurrFi site describes lending, trading, and credit products but no USDXL-specific holder redemption. The earlier borrower-only assessment remains historical, not a fresh operational claim.",
    rationale: "Borrower debt settlement and protocol-owned market liquidity are not general redemption.",
    evidenceNeeded: "Official ordinary-holder redemption mechanics with capacity, output, fees, and route status.",
    evidenceUrls: ["https://www.last.net/", "https://hypurrfi.com/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "usg-tangent",
    disposition: "hard-reject",
    reasonCode: "pegkeeper-only",
    blocker:
      "Tangent explicitly relies on Peg Keepers, incentives, and borrower repayment rather than collateral redemption for holders.",
    rationale: "The documented system has no holder collateral claim to score as a redemption route.",
    evidenceNeeded: "A future audited permissionless holder redemption function and current capacity evidence.",
    evidenceUrls: ["https://docs.tangent.finance/docs/usg/overview_usg"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "uusd-anything-labs",
    disposition: "hard-reject",
    reasonCode: "documentation-insufficient",
    blocker:
      "Anything Labs publishes no reserve composition, attestation, holder redemption mechanics, capacity, fees, or settlement terms.",
    rationale: "Owner-controlled mint and burn functions do not grant holders a claim on an identified output asset.",
    evidenceNeeded: "Binding issuer redemption terms, audited reserves, and a live operational exit.",
    evidenceUrls: ["https://uusd.ai/", "https://github.com/uusdai/uusd"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "vcred-vcred",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "vCred's current site labels the token staking product as coming soon and publishes no redeem or withdraw terms.",
    rationale: "A NAV-token flag is insufficient when the holder product is not evidenced as live.",
    evidenceNeeded:
      "Live vault contracts and official deposit, redeem, cooldown, fee, capacity, and status documentation.",
    evidenceUrls: ["https://vcred.trade/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewedOn("2026-10-01", {
    id: "zeusd-zoth",
    disposition: "hard-reject",
    reasonCode: "borrower-repay-only",
    blocker:
      "The earlier 2026-08-12 source review found position-specific ZeDP repayment and a paused legacy V1 router, not secondary-holder redemption. The mechanics and ZeDP documentation endpoints returned HTTP 404 on 2026-10-01, so those historical facts are retained pending source recovery rather than asserted as newly observed state.",
    rationale:
      "CDP debt closure is position-specific and does not create a claim for secondary holders. V1 is additionally deprecated, so even the position route is not currently exercisable; the separate V2 contracts are a different deployment and cannot be substituted for the tracked asset.",
    evidenceNeeded:
      "Official ordinary-holder redemption mechanics with access, output, capacity, fee, and settlement evidence.",
    evidenceUrls: [
      "https://docs.zoth.io/zoth/products/zeusd-an-omni-chain-and-composable-stable-token/mechanics-of-zeusd",
      "https://docs.zoth.io/zoth/products/zeusd-debt-position-zedp",
      "https://docs.zoth.io/zoth/tech-center/contract-deployments",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "usdv-solomon-v2",
    disposition: "defer",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Solomon's replacement USDv docs confirm approved counterparties can burn USDv for an approved payout asset, subject to onboarding, liquidity, operational controls, program terms, and processing windows. They do not enumerate the complete direct-redemption payout set or publish quantitative capacity, fees, or a settlement bound.",
    rationale:
      "The replacement Chancery mint is distinct from legacy USDv. USDC/USDG reserves and onchain market pairs do not by themselves identify guaranteed direct-redemption outputs, and open market swaps are not issuer redemption.",
    evidenceNeeded:
      "Current Chancery redemption instruction and approved payout registry, counterparty access, live limits and payout liquidity, numeric fees, and processing/settlement terms for the replacement mint.",
    evidenceUrls: [
      "https://docs.solomonlabs.org/usdv/acquiring-and-redeeming/",
      "https://docs.solomonlabs.org/usdv/peg-stability-and-reserves",
      "https://github.com/SolomonLabs/chancery/blob/main/config/networks/mainnet.ts",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "zkusd-goal3",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The former Goal3 portal and product documentation were unavailable in the earlier review. The current explorer page identifies the token, but no holder gateway, active capacity, or maintained 1:1 USDC redemption terms were established on 2026-10-01.",
    rationale:
      "The token contract remains identifiable on-chain, but an ERC-20 contract alone does not prove a working redemption gateway.",
    evidenceNeeded:
      "Maintained official docs or a live portal/API plus gateway contract, USDC capacity, fees, access, and settlement evidence.",
    evidenceUrls: ["https://era.zksync.network/address/0xfc7e56298657b002b3e656400e746b7212912757"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
];
