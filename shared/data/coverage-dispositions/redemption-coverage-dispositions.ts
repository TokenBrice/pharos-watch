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
  reviewedOn("2026-10-07", {
    id: "usdx-axis",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "No current executable USDC/USDT RFQ capacity or exact-route capacity adapter is available.",
    rationale: "Current USDxMarket 0x5ae365ac83638418c4c30555d32f9a91ccaef58c and MarketConfig 0xce2cf8b00fcb5946f495ebd15ff9f0001e024d46 expose checkSettlement for a current signed order, not a pre-quote holder entitlement. KYC/KYB RFQs remain discretionary before operator submission; indicative 2%-of-book/day and seven-day bands are not committed throughput or completion SLAs.",
    evidenceNeeded: "Current accepted-quote executable capacity, binding settlement and fee terms, and an exact-route capacity reader.",
    evidenceUrls: [
      "https://docs.axis.to/usdx-the-synthetic-dollar/mint-and-redeem.md",
      "https://docs.axis.to/resources-and-legal/eligibility-and-onboarding.md",
      "https://docs.axis.to/reference/core-contracts.md",
      "https://www.axis.to/terms-of-service",
    ],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  {
    id: "mantrausd-mantra",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker: "The documentary mantraUSD-to-wM path has no fresh enabled-route proof or honest exact-output executable capacity model.",
    rationale: "Verified MANTRA token and SwapFacility code bind the documentary path from mantraUSD 0xd2b95283011e47257917770d28bb3ee44c849f6f to wM 0x437cc33344a0b27a429f795ff6b469c72698b291 through SwapFacility 0xb6807116b3b1b321a390594e31ecd6e0076f6278. The extension-to-extension path checks permissioning, transfers and unwraps the input, measures received M, then wraps that amount to the recipient atomically without a separate protocol deduction. Approved, non-permissioned extensions, unpaused contracts, holder freeze and allowance checks remain applicable; source verification is not a current enabled-path observation. wM rounding and network gas leave all-in same-notional cost unbounded. Native-M balances and sampled approved-swapper telemetry cannot establish wM output capacity. The whitepaper's conditional T+2 fiat/collateral redemption for onboarded institutions is a separate rail, not a direct-M, USDC or fiat guarantee for this holder conversion.",
    evidenceNeeded: "Fresh pinned configuration and guard evidence for the exact enabled mantraUSD-to-wM path, plus same-notional wM output capacity, rounding, gas-priced execution and all applicable access checks. No backing balance, native-M telemetry or static full-supply fallback may substitute.",
    evidenceUrls: [
      "https://blockscout.mantrascan.io/api/v2/smart-contracts/0x9d7a7b406568668e7943740f5b370c86e13dcca8",
      "https://blockscout.mantrascan.io/api/v2/smart-contracts/0xb6807116b3b1b321a390594e31ecd6e0076f6278",
      "https://blockscout.mantrascan.io/api/v2/smart-contracts/0x21a657d7dae3f33548252d350ebbe48c82c23c3c",
      "https://docs.m0.org/resources/addresses/m0-platform",
      "https://docs.m0.org/build/accessing-liquidity",
      "https://assets.mantrausd.com/whitepaper.pdf",
    ],
    reviewer: "Sol curation campaign 2026-10-09 (Lane22Stoneyield)",
    reviewedDate: "2026-10-09",
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  },
  {
    id: "zarsc-supercoin",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Supercoin terms section 7.1 describes direct issuer redemption through the Supercoin App only once launched; current Supported Exchange off-ramps have no guaranteed price, availability or settlement outcome.",
    rationale:
      "The future app's two-business-day bank-payment term is not a launched holder route. Supported-exchange sales and the August reserve attestation do not establish issuer par redemption, app availability or funded executable payout capacity.",
    evidenceNeeded:
      "Primary evidence that the Supercoin App redemption channel is live, with current onboarding, payout, minimum, fee, liquidity and settlement terms.",
    evidenceUrls: ["https://www.supercoin.co.za/terms-of-service"],
    reviewer: REVIEWER,
    reviewedDate: "2026-10-07",
    allowedRouteFamilyIfProven: "offchain-issuer",
  },
  reviewedOn("2026-10-07", {
    id: "bnusd-balanced",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Balanced's current v1 documentation says the original app is no longer supported and must be withdrawn from or migrated before December 1, 2026. The migration guide distinguishes bnUSD(old), used by v1 loans and pools, from the new bnUSD; it does not establish a current stablecoin redemption for the tracked old token.",
    rationale:
      "The current guide describes bnUSD(old)-to-new-bnUSD migration 1:1 on ICON, Stellar and Sui, not old-token USDC/USDT redemption. Sonic/SODAX reserve context belongs to a different contract and supply census. Neither migration value nor that inventory can be credited as tracked-old-token exit capacity before the December 1 retirement.",
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
  reviewedOn("2026-10-07", {
    id: "isc-international-stable-currency",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The ISC website and dashboard recovered with non-browser HTTP 200 on 2026-10-07, but neither identifies a holder-callable redemption. The whitepaper describes issuer reserve-market buying and selling; the mutable reserve API provides no binding payout identity, fee or source period.",
    rationale:
      "Recovered websites, a Solana mint identity and reserve-market buybacks do not prove an ordinary-holder claim. Historical dashboard zero figures are not current observed capacity.",
    evidenceNeeded:
      "An identified current program/instruction or binding issuer holder-redemption terms with complete output, execution, capacity, fees and completed-settlement evidence.",
    evidenceUrls: [
      "https://isc.money/",
      "https://isc.money/dashboard",
      "https://wp.isc.money/how-isc-works/the-isc-reserves/basic-mechanics",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewedOn("2026-10-07", {
    id: "iusd-initia",
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker:
      "Initia's current generic SkipGo, LayerZero, CCTP and IBC bridge docs identify no tracked-iUSD burn/unlock entrypoint, output or fee. Existing Move vault AUSD0/supply reads measure backing, not a complete holder exit.",
    rationale:
      "A proposed iUSD burn, local AUSD0 unlock and downstream Agora redemption combines generic functionality without proving the exact tracked-token path or ledger-bound executable capacity.",
    evidenceNeeded:
      "Official iUSD product docs, contract address, holder exit mechanics, underlying asset, fees, and current status.",
    evidenceUrls: ["https://docs.initia.xyz/home/tools/bridge", "https://scan.initia.xyz"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewedOn("2026-10-07", {
    id: "lvusd-leverup",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "Current LeverUp docs retain a protocol-loss redemption path below 0.99 and a secondary-market TWAP below 0.90 enabling daily quota exits. The exact reserve reader does not establish current gateway activation, quota, exchange rate, fees or output limits.",
    rationale:
      "Reserve USDC is not an enabled continuously open par claim. The conditional loss/quota paths may be below par and remain unconfigured until exact current state and complete holder execution terms are verified.",
    evidenceNeeded:
      "Exact deployed LVUSD/USDC gateway, live activation condition, daily quota, exchange-rate calculation, fee, and current executable USDC inventory.",
    evidenceUrls: ["https://leverup.gitbook.io/docs/liquidity-layer/lvusd-stablecoin"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-07", {
    id: "mai-qidao",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker:
      "QiDao's PSM documentation is reachable at /docs/peg-stability-module and explicitly describes permissionless MAI redemption after a three-day public withdrawal queue. It names USDC and DAI strategies but gives no numeric redemption fee or live executable PSM capacity.",
    rationale:
      "Recovered three-day PSM queue docs name USDC/DAI strategies but do not close the active deployment census, withdrawal fee, withdrawable liquidity or pending liabilities. The legacy 15-chain list and current two-chain text also need reconciliation; deposited assets or CDP repayment fees cannot substitute for current payout capacity.",
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
  reviewedOn("2026-10-07", {
    id: "pht-pht",
    disposition: "defer",
    reasonCode: "no-holder-route",
    blocker:
      "APACX's Redeem action repays the caller's own PHT debt and returns that borrower's own collateral; the beta Tron reserve wallet is not a public collateral claim.",
    rationale: "Borrower debt closure does not serve an unrelated holder and a reserve wallet does not establish holder-funded redemption capacity.",
    evidenceNeeded: "A new ordinary-holder callable redemption with complete output, fee, capacity and settlement terms, distinct from repaying one's own debt.",
    evidenceUrls: ["https://www.apacx.io/PHT", "https://docs.apacx.io/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewedOn("2026-10-07", {
    id: "spusd-soulpeg",
    disposition: "defer",
    reasonCode: "documentation-insufficient",
    blocker:
      "Official docs describe SPUSD-to-sUSDC reverse wrapping, while the current product page says one-way/no unwrap. Published wrapper addresses disagree, and neither source closes the tracked-token deployment or a secondary-holder USDC withdrawal.",
    rationale:
      "Contradictory wrapper terms must be reconciled before modeling a route. Even reverse conversion into sUSDC does not prove unlocked Venus-backed USDC payout or funded executable capacity.",
    evidenceNeeded:
      "Reconciled official terms, exact live wrapper/source and tracked-token identity, secondary-holder lock/access conditions, USDC withdrawal fees and same-run capacity.",
    evidenceUrls: ["https://docs.soulpeg.io/", "https://soulpeg.io/spusd"],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewedOn("2026-10-07", {
    id: "stusd-stoneyield",
    disposition: "needs-research",
    reasonCode: "capacity-unpublished",
    blocker:
      "StoneYield's current contract-design page describes manually unlocked STUSD, owner-controlled strategy withdrawals, and an internal Venus ERC-4626 vault; it does not identify a complete public STUSD burn-to-USDC route or executable capacity.",
    rationale:
      "Owner/manual-unlock core STUSD and transferable sUSDC are distinct identities. An internal Venus ERC-4626 reserve is not a public tracked-STUSD burn-to-USDC route; the reserve adapter's token-identity mismatch remains a separate blocker.",
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
  reviewedOn("2026-10-07", {
    id: "usdxl-last",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Current HypurrFi documentation explicitly says direct redemption from supplementary USDT0 is not enabled. The recovered Last site and a roadmap facility do not establish an active ordinary-holder USDXL gateway.",
    rationale: "Borrower debt settlement and protocol-owned market liquidity are not general redemption.",
    evidenceNeeded: "Official ordinary-holder redemption mechanics with capacity, output, fees, and route status.",
    evidenceUrls: ["https://www.last.net/", "https://hypurrfi.com/", "https://hypurrfi.com/blog-posts/usdxl-position-backed-cdp"],
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
  reviewedOn("2026-10-07", {
    id: "vcred-vcred",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "vCred's current site labels the token staking product as coming soon and publishes no redeem or withdraw terms.",
    rationale: "The staking product still says Coming soon; a Hemi token identity or vault NAV flag cannot establish launched withdrawal mechanics or a numeric redemption bound.",
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
  reviewedOn("2026-10-07", {
    id: "usdv-solomon-v2",
    disposition: "defer",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Solomon's replacement USDv docs confirm approved counterparties can burn USDv for an approved payout asset, subject to onboarding, liquidity, operational controls, program terms, and processing windows. They do not enumerate the complete direct-redemption payout set or publish quantitative capacity, fees, or a settlement bound.",
    rationale:
      "The replacement Chancery Solana mint is distinct from legacy USDv. The dated backing API covers selected authority accounts, not an approved payout registry or guaranteed institution burn/settlement throughput; USDC/USDG reserve assets and open-market swaps do not identify complete issuer redemption outputs.",
    evidenceNeeded:
      "Current Chancery redemption instruction and approved payout registry, counterparty access, live limits and payout liquidity, numeric fees, and processing/settlement terms for the replacement mint.",
    evidenceUrls: [
      "https://docs.solomonlabs.org/usdv/acquiring-and-redeeming/",
      "https://docs.solomonlabs.org/usdv/peg-stability-and-reserves",
      "https://github.com/SolomonLabs/chancery/blob/main/config/networks/mainnet.ts",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewedOn("2026-10-07", {
    id: "zkusd-goal3",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The tracked ZKsync token remains identifiable, but maintained issuer links and holder-redemption terms remain unavailable. The 2026-10-07 explorer result is a generic shell and the portal lookup failed; these fetch outcomes do not prove that a route is absent.",
    rationale:
      "An ERC-20 identity alone is not a holder gateway, and failed source recovery does not refresh historical route state or quantify USDC capacity.",
    evidenceNeeded:
      "Maintained official docs or a live portal/API plus gateway contract, USDC capacity, fees, access, and settlement evidence.",
    evidenceUrls: ["https://era.zksync.network/address/0xfc7e56298657b002b3e656400e746b7212912757"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
];
