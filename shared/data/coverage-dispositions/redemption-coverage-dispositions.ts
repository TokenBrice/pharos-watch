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
const REVIEWED_DATE = "2026-07-12";

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
 * or no-longer-active rows so this list cannot silently become stale.
 */
export const REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS: readonly ReviewedRedemptionCoverageDisposition[] = [
  reviewedOn("2026-08-12", {
    id: "bnusd-balanced",
    disposition: "defer",
    reasonCode: "route-status-unverified",
    blocker:
      "The tracked asset is Balanced v1 bnUSD(old) on ICON, and the maintained documentation has narrowed to wind-down tasks — withdraw funds, move loans to v2, migrate assets, claim rewards, unstake sICX. No Stability Fund redemption page survives there, and the marketing page describes the Stability Fund as working 'behind the scenes with SODAX Intents', on token identities distinct from the tracked contract.",
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
    id: "cdxusd-cod3x",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker: "Only protocol-authorized Facilitators are documented as able to mint or burn cdxUSD.",
    rationale: "Facilitator balance-sheet operations are not a holder-exercisable redemption route.",
    evidenceNeeded:
      "New official terms and a callable route that lets an ordinary holder exchange cdxUSD for a defined output asset.",
    evidenceUrls: ["https://www.cod3x.org/unveiling-the-cod3x-tech-stack/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "crvusd-curve",
    disposition: "hard-reject",
    reasonCode: "pegkeeper-only",
    blocker:
      "Curve documents loan repayment and PegKeeper market operations, not broad crvUSD-holder redemption for collateral.",
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
      "Current Frax materials describe AMO and balance-sheet peg management without a broad FRAX holder redemption facility.",
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
      "ISC claims liquid exits, but the current dashboard reports zero reserves and supply and no executable holder route is documented.",
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
  reviewedOn("2026-08-12", {
    id: "iusd-initia",
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker:
      "Initia's maintained documentation does not identify an iUSD-specific unwrap, redemption contract, output asset, or capacity; the bridge page re-read on 2026-08-12 does not mention iUSD at all.",
    rationale:
      "The shape research suggests — burn iUSD, unlock AUSD0 locally, reverse the LayerZero route, then redeem through Agora — is assembled from generic bridge and issuer functionality, and no documented Move view or entry point exposes the vault's unlocked balance, the burn entrypoint, or a fee and settlement schedule.",
    evidenceNeeded:
      "Official iUSD product docs, contract address, holder exit mechanics, underlying asset, fees, and current status.",
    evidenceUrls: ["https://docs.initia.xyz/home/tools/bridge", "https://scan.initia.xyz"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "luausd-lumi-finance",
    disposition: "needs-research",
    reasonCode: "capacity-unpublished",
    blocker:
      "Lumi materials do not provide a source-reviewed LUAUSD holder redemption limit, cooldown, output asset, and current route status.",
    rationale:
      "The NAV-token classification suggests a queued or vault exit, but a route family is not assigned without product-specific evidence.",
    evidenceNeeded:
      "Official LUAUSD redeem or withdraw docs, deployed contract, underlying output, queue terms, fees, and capacity.",
    evidenceUrls: ["https://lumi-finance.gitbook.io/docs/", "https://lumi.finance/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "lvusd-leverup",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "LeverUp describes lvUSD borrowing and repayment but not an independent holder redemption against collateral.",
    rationale: "Repayment burns a borrower's debt and does not give unrelated holders access to protocol collateral.",
    evidenceNeeded: "Official holder redemption mechanics and live capacity, fee, and settlement support.",
    evidenceUrls: ["https://leverup.gitbook.io/docs/liquidity-layer/lvusd-stablecoin"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewedOn("2026-08-12", {
    id: "mai-qidao",
    disposition: "defer",
    reasonCode: "documentation-insufficient",
    blocker:
      "QiDao's Peg Stability Module, fee, and contract-address pages all return HTTP 404, so the three-day withdrawal queue can no longer be read from a live primary source.",
    rationale:
      "Search engines still serve a cached copy of the old PSM page, but a cached snapshot is not evidence that the route is documented today, and even that text describes a redemption fee without a numeric bound.",
    evidenceNeeded:
      "A reachable official PSM page with the current queue duration and a numeric redemption fee, plus live PSM balances and contract verification for the active deployments.",
    evidenceUrls: ["https://docs.mai.finance/"],
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
      "Current Synapse documentation no longer provides an operational NUSD holder redemption route or maintained product terms.",
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
      "Nereus materials do not establish a broad NXUSD holder redemption route beyond borrower repayment and markets.",
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
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker:
      "SoulPeg documents wrapping into transferable spUSD but no verified reverse path from spUSD through sUSDC to USDC for ordinary holders.",
    rationale: "One-way wrapping and secondary liquidity do not establish a stablecoin redemption backstop.",
    evidenceNeeded:
      "New audited reverse conversion and USDC withdrawal documentation with current capacity and access.",
    evidenceUrls: ["https://docs.soulpeg.io/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "stusd-stoneyield",
    disposition: "needs-research",
    reasonCode: "capacity-unpublished",
    blocker:
      "StoneYield's public docs do not provide a complete current stUSD burn, withdrawal, cooldown, and capacity specification.",
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
      "Last/HypurrFi materials support CDP debt repayment but do not describe direct USDXL holder redemption at par.",
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
  reviewed({
    id: "vusd-virtue",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker: "Virtue explicitly states that redemption is temporarily restricted to protocol-level actors.",
    rationale:
      "The collateral redemption design exists but is not exercisable by ordinary holders in the documented launch state.",
    evidenceNeeded:
      "An official access update plus live contract evidence that general-holder redemption has been enabled.",
    evidenceUrls: ["https://docs.virtue.money/redemption"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "xtusd-xt",
    disposition: "hard-reject",
    reasonCode: "secondary-market-only",
    blocker:
      "XTUSD's CDP design and XT.com market access do not provide a holder redemption claim against vault collateral or fiat.",
    rationale: "Borrower repayment and exchange liquidity are not scoreable redemption routes.",
    evidenceNeeded: "New official ordinary-holder redemption terms and live route evidence.",
    evidenceUrls: ["https://www.xt.com/"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewedOn("2026-08-12", {
    id: "zeusd-zoth",
    disposition: "hard-reject",
    reasonCode: "borrower-repay-only",
    blocker:
      "Zoth documents repayment to reclaim a user's own RWA collateral, not broad ZeUSD-holder redemption for reserve assets. Re-verified 2026-08-12: the route is the ZeDP position NFT holder burning that position's own ZeUSD debt to withdraw the exact collateral originally deposited, and the shared V1 deposit/redemption router is recorded as paused.",
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
    id: "zkusd-goal3",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The former Goal3 portal and official product documentation are unavailable, so the claimed 1:1 USDC route cannot be verified as live.",
    rationale:
      "The token contract remains identifiable on-chain, but an ERC-20 contract alone does not prove a working redemption gateway.",
    evidenceNeeded:
      "Maintained official docs or a live portal/API plus gateway contract, USDC capacity, fees, access, and settlement evidence.",
    evidenceUrls: ["https://era.zksync.network/address/0xfc7e56298657b002b3e656400e746b7212912757"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
];
