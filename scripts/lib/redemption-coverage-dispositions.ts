import type { RedemptionRouteFamily } from "../../shared/types/redemption";

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
 * Source-reviewed decisions for every active stablecoin without a redemption
 * config. The coverage audit rejects missing, duplicate, unknown, configured,
 * or no-longer-active rows so this list cannot silently become stale.
 */
export const REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS: readonly ReviewedRedemptionCoverageDisposition[] = [
  reviewed({
    id: "bnusd-balanced",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Balanced documents borrower repayment and secondary swaps, not a face-value exit exercisable by any bnUSD holder.",
    rationale:
      "Repaying bnUSD releases only the borrower's own collateral; that is not a general holder redemption backstop.",
    evidenceNeeded:
      "An official callable redemption path, output asset, fee, capacity, and access terms for ordinary holders.",
    evidenceUrls: ["https://docs.balanced.network/finance/loans"],
    allowedRouteFamilyIfProven: "collateral-redeem",
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
    id: "emxn-telcoin",
    disposition: "needs-research",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Telcoin's current Digital Cash pages do not publish eMXN-specific holder redemption eligibility, fees, settlement, or limits.",
    rationale:
      "The issuer-managed product may have a wallet or bank exit, but the public evidence is not specific enough to model one.",
    evidenceNeeded:
      "Official eMXN redemption terms or API documentation covering eligible holders, MXN output, limits, fees, and timing.",
    evidenceUrls: ["https://www.telco.in/en/digital-cash", "https://bank.telco.in/"],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewed({
    id: "euro3-3a-dao",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The route is documented; config work must still verify current contracts, minHF availability, dynamic fee, and executable capacity.",
    rationale:
      "3A states that holders can exchange EURO3 for vault collateral, subject to vault health conditions and a governance-set fee.",
    evidenceNeeded:
      "Current contract addresses, reachable collateral capacity, dynamic fee bounds, and route-status evidence.",
    evidenceUrls: [
      "https://docs.3adao.org/3a-protocol/protocol-documentation/lending/redemptions",
      "https://docs.3adao.org/3a-protocol/protocol-documentation/euro3-coin/euro3-price-stability",
    ],
    allowedRouteFamilyIfProven: "collateral-redeem",
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
    id: "fxd-fathom",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Fathom documents CDP repayment and a StableSwap market, not broad FXD redemption against protocol collateral.",
    rationale: "Debt repayment is position-specific and a swap facility is not automatically a redemption claim.",
    evidenceNeeded: "Official ordinary-holder redemption mechanics and live capacity, fee, and settlement evidence.",
    evidenceUrls: ["https://docs.fathom.fi/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "ggbr-goldfish-gold",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The physical-gold route is documented; a config still needs KYC eligibility, delivery costs, minimums, and operational status.",
    rationale:
      "Goldfish exposes a holder redemption flow for physical gold with KYC and a stated five-to-seven-business-day process.",
    evidenceNeeded:
      "Verified minimum, shipping and insurance costs, eligible jurisdictions, settlement status, and capacity terms.",
    evidenceUrls: ["https://app.goldfishgold.com/redemption", "https://goldfishgold.com/Goldfish-Cyfrin.pdf"],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewed({
    id: "gramg-token-teknoloji",
    disposition: "hard-reject",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Published reserve evidence does not provide a holder redemption schedule for physical gold or the PAXG reserve asset.",
    rationale: "Backing evidence alone does not establish that an ordinary GRAMG holder can exercise redemption.",
    evidenceNeeded:
      "Issuer redemption terms covering eligibility, output, minimum, fee, settlement, and current availability.",
    evidenceUrls: [
      "https://www.token.com.tr/rezerv-tokenlar/gram-gold-gramg/",
      "https://www.token.com.tr/rezerv-kanitlari/",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "grams-token-teknoloji",
    disposition: "hard-reject",
    reasonCode: "issuer-terms-missing",
    blocker: "Published reserve evidence does not provide a holder redemption schedule for physical silver.",
    rationale: "The documented bank-held backing is not itself a holder-exercisable exit.",
    evidenceNeeded:
      "Issuer redemption terms covering eligibility, output, minimum, fee, settlement, and current availability.",
    evidenceUrls: [
      "https://www.token.com.tr/en/reserve-tokens/gram-silver-grams/",
      "https://www.token.com.tr/rezerv-kanitlari/",
    ],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "hchf-hedera-swiss-franc",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The permissionless route is documented; executable HBAR capacity, current frontend status, and the dynamic fee require capture.",
    rationale:
      "HLiquity explicitly states any HCHF holder can redeem at face value for HBAR from the lowest-ratio Troves.",
    evidenceNeeded:
      "Live redemption capacity, fee formula inputs, contract addresses, and current route-status evidence.",
    evidenceUrls: ["https://docs.hliquity.org/deep-dive/redemptions-and-hchf-price-stability"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "hlusd-hela",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "StableHodl documents the sell flow, but config work must verify current OTC capacity, claim timing, and geographic access.",
    rationale:
      "Connected holders can sell HLUSD for USDT or USDC and claim the output after a disclosed one-percent fee.",
    evidenceNeeded:
      "Current route status, maximum capacity, claim settlement time, supported jurisdictions, and contract or operator evidence.",
    evidenceUrls: ["https://docs.stablehodl.com/product/trade-hlusd"],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "hollar-hydrated",
    disposition: "needs-research",
    reasonCode: "capacity-unpublished",
    blocker:
      "The HSM conditionally buys HOLLAR only when its market logic permits and explicitly does not accept arbitrary amounts.",
    rationale:
      "The PSM family is proven, but callable capacity, trigger state, output, and fee evidence are not yet wired.",
    evidenceNeeded:
      "On-chain or protocol-API route status, buyback capacity, price formula, fees, and settlement certainty.",
    evidenceUrls: ["https://docs.hydration.net/products/hollar/"],
    allowedRouteFamilyIfProven: "psm-swap",
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
  reviewed({
    id: "iusd-indigo-protocol",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Indigo documents synthetic debt repayment and liquidation but no broad iUSD-holder collateral redemption.",
    rationale: "Closing an individual CDP is not an exit available to holders who did not originate the debt.",
    evidenceNeeded: "Official holder redemption documentation plus live route, capacity, fee, and settlement evidence.",
    evidenceUrls: ["https://docs.indigoprotocol.io/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "iusd-initia",
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker:
      "Initia's maintained documentation does not identify an iUSD-specific unwrap, redemption contract, output asset, or capacity.",
    rationale: "Generic bridge and DEX functionality cannot establish a redemption backstop for this specific asset.",
    evidenceNeeded:
      "Official iUSD product docs, contract address, holder exit mechanics, underlying asset, fees, and current status.",
    evidenceUrls: ["https://docs.initia.xyz/home/tools/bridge", "https://scan.initia.xyz"],
    allowedRouteFamilyIfProven: null,
  }),
  reviewed({
    id: "jpyt-dephaser",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The route is documented and live; config work must measure current USDT/USDC capacity, exchange-rate formula, and delayed settlement.",
    rationale:
      "DePhaser documents an on-chain burn of JPYT to recover USDT or USDC, with redemption completing within 24 hours.",
    evidenceNeeded:
      "Live contract balances, rate calculation, any fee, chain-specific capacity, and route-status evidence.",
    evidenceUrls: [
      "https://docs.dephaser.com/how-it-works/money-flow/",
      "https://docs.dephaser.com/policy/terms-of-service",
      "https://app.dephaser.com/en",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "jusd-juicedollar",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The bridge burn path is documented; current bridge assets, limits, stopped state, fees, and deployed capacity remain to be captured.",
    rationale:
      "Juice Dollar's StablecoinBridge exposes public JUSD burn functions that return the configured external stablecoin.",
    evidenceNeeded:
      "Deployed bridge address, current output stablecoin, limit and minted values, stopped state, fees, and transaction tests.",
    evidenceUrls: [
      "https://docs.juicedollar.com/smart-contracts/functions",
      "https://docs.juicedollar.com/smart-contracts/deployments",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "jusd-jusd-stable-token",
    disposition: "hard-reject",
    reasonCode: "no-holder-route",
    blocker:
      "JUSD Stable Token materials do not establish a current ordinary-holder redemption route with defined output and capacity.",
    rationale: "Issuer assertions and exchange liquidity are insufficient for redemption scoring.",
    evidenceNeeded: "New official holder redemption terms and live operational evidence.",
    evidenceUrls: ["https://jusd.app/", "https://jusd.app/whitepaper.pdf"],
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
  reviewed({
    id: "mai-qidao",
    disposition: "defer",
    reasonCode: "capacity-unpublished",
    blocker:
      "QiDao documents a permissionless three-day PSM withdrawal queue, but current withdrawable capacity is not published or wired.",
    rationale: "A holder route exists, but without a capacity source it cannot yet receive a scoring config.",
    evidenceNeeded:
      "Live PSM balances across active deployments, queue status, fees, and current contract verification.",
    evidenceUrls: [
      "https://docs.mai.finance/peg-stability-module",
      "https://docs.mai.finance/functions/smart-contract-addresses",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
  }),
  reviewed({
    id: "mim-abracadabra",
    disposition: "hard-reject",
    reasonCode: "borrower-repay-only",
    blocker:
      "Abracadabra documents MIM debt repayment and market liquidity, not a broad collateral redemption right for holders.",
    rationale: "Repaying a Cauldron position releases only its borrower's collateral.",
    evidenceNeeded: "New official ordinary-holder redemption terms and live execution evidence.",
    evidenceUrls: [
      "https://docs.abracadabra.money/learn/tokens/tokenomics",
      "https://docs.abracadabra.money/learn/intro/liquidations",
    ],
    allowedRouteFamilyIfProven: null,
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
    id: "pc0000031-tradable",
    disposition: "needs-research",
    reasonCode: "issuer-terms-missing",
    blocker:
      "The public deal surface does not expose complete holder redemption, maturity, transfer, fees, and settlement terms for this SSTN.",
    rationale:
      "A tokenized credit instrument may settle at maturity, but no generic route can be inferred across Tradable deals.",
    evidenceNeeded: "Deal-specific offering or redemption terms and current investor portal evidence.",
    evidenceUrls: [
      "https://doc.tradable.xyz/product-docs",
      "https://app.tradable.xyz/investor/deals/861cce9e-08ae-45a0-aca8-9fa229a0189d",
    ],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewed({
    id: "pc0000033-tradable",
    disposition: "needs-research",
    reasonCode: "issuer-terms-missing",
    blocker:
      "The public deal surface does not expose complete holder redemption, maturity, transfer, fees, and settlement terms for this SSTN.",
    rationale:
      "A tokenized credit instrument may settle at maturity, but no generic route can be inferred across Tradable deals.",
    evidenceNeeded: "Deal-specific offering or redemption terms and current investor portal evidence.",
    evidenceUrls: [
      "https://doc.tradable.xyz/product-docs",
      "https://app.tradable.xyz/investor/deals/e2c78ce9-1c20-4f4a-b6ca-eba1b2f575b1",
    ],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewed({
    id: "pc0000089-tradable",
    disposition: "needs-research",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Public product documentation does not expose deal-specific redemption, maturity, transfer, fee, and settlement terms for this SSTL.",
    rationale: "The instrument needs its own reviewed lifecycle and exit terms rather than a family-level assumption.",
    evidenceNeeded: "Deal-specific offering or redemption terms and current investor portal evidence.",
    evidenceUrls: ["https://doc.tradable.xyz/product-docs", "https://www.tradable.xyz/"],
    allowedRouteFamilyIfProven: "offchain-issuer",
  }),
  reviewed({
    id: "pc0000101-tradable",
    disposition: "needs-research",
    reasonCode: "issuer-terms-missing",
    blocker:
      "Public product documentation does not expose deal-specific redemption, maturity, transfer, fee, and settlement terms for this receivables token.",
    rationale: "The instrument needs its own reviewed lifecycle and exit terms rather than a family-level assumption.",
    evidenceNeeded: "Deal-specific offering or redemption terms and current investor portal evidence.",
    evidenceUrls: ["https://doc.tradable.xyz/product-docs", "https://www.tradable.xyz/"],
    allowedRouteFamilyIfProven: "offchain-issuer",
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
    id: "rusd-reservoir",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The permissionless PSM route is documented; a config still needs live per-asset balances and route-status capture.",
    rationale:
      "Reservoir states anyone can convert rUSD to USDC at parity and documents 1:1 mint and redemption for USDC, USDT, and USD1.",
    evidenceNeeded:
      "Live PSM balances by output asset, contract status, fees, geographic access policy, and failure behavior.",
    evidenceUrls: [
      "https://docs.reservoir.xyz/products/stablecoin-rusd",
      "https://docs.reservoir.xyz/security-and-compliance/faq",
      "https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses",
    ],
    allowedRouteFamilyIfProven: "psm-swap",
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
    id: "suiusde-sui",
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker:
      "Sui's launch material describes suiUSDe but not a holder redemption or conversion rail, output asset, capacity, or fees.",
    rationale:
      "A whitelabel relationship to Ethena does not prove that Ethena's primary-market route is inherited on Sui.",
    evidenceNeeded:
      "Official suiUSDe mint and redeem docs, deployed contract or app route, eligibility, output, fees, and capacity.",
    evidenceUrls: ["https://blog.sui.io/esui-dollar-suiusde-deepbook-margin/"],
    allowedRouteFamilyIfProven: null,
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
    id: "tbill-openeden",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The queued route is fully documented; config work must encode permissioned eligibility, NAV, queue capacity, and status.",
    rationale:
      "Onboarded whitelisted investors can burn TBILL for USDC through a FIFO queue, typically settling next U.S. business day for a five-basis-point fee.",
    evidenceNeeded:
      "Current queue or liquidity capacity, NAV source, route status, whitelist eligibility, and contract addresses.",
    evidenceUrls: [
      "https://docs.openeden.com/tbill/redemptions",
      "https://docs.openeden.com/tbill/faq",
      "https://docs.openeden.com/tbill/fees",
    ],
    allowedRouteFamilyIfProven: "queue-redeem",
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
    id: "usdh-hubble",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Hubble documents USDH CDP repayment and liquidations but no broad holder redemption for vault collateral.",
    rationale: "Only a borrower can use USDH to close that borrower's debt position.",
    evidenceNeeded: "Official holder redemption docs or audited callable route available to ordinary holders.",
    evidenceUrls: ["https://docs.hubbleprotocol.io"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "usdm-monetrix",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "Monetrix claims 1:1 USDC mint and redemption, but its current official docs could not be fetched and route limits, fees, and status remain unverified.",
    rationale:
      "The claimed route family is plausible, but inaccessible source terms and missing live evidence preclude an add decision.",
    evidenceNeeded:
      "Reachable official redemption docs plus live vault status, USDC capacity, fees, settlement, and access terms.",
    evidenceUrls: [
      "https://www.monetrix.xyz/",
      "https://doc.monetrix.xyz/",
      "https://www.monetrix.xyz/app/transparency",
    ],
    allowedRouteFamilyIfProven: "stablecoin-redeem",
  }),
  reviewed({
    id: "usdpt-western-union",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "Issuer redemption is confirmed, but direct customer eligibility, fee schedule, limits, and settlement must be sourced for config.",
    rationale:
      "Anchorage states its issued stablecoins are redeemable 1:1 on its platform, while Western Union confirms USDPT is 1:1 redeemable and available through fiat channels.",
    evidenceNeeded:
      "Anchorage platform eligibility, direct redemption workflow, minimums, fees, daily limits, settlement, and route status.",
    evidenceUrls: [
      "https://www.anchorage.com/platform/transparency-stablecoin-reserves",
      "https://ir.westernunion.com/news/archived-press-releases/press-release-details/2026/Bybit-Becomes-First-Major-Crypto-Exchange-to-Integrate-Western-Unions-USDPT-Stablecoin-Bridging-Two-Financial-Worlds-Through-One-Stablecoin/default.aspx",
    ],
    allowedRouteFamilyIfProven: "offchain-issuer",
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
    id: "vndc-jade-labs",
    disposition: "needs-research",
    reasonCode: "route-status-unverified",
    blocker:
      "The issuer-controlled VNDC exit cannot be verified as reliably available under current public terms and withdrawal conditions.",
    rationale: "Historical platform conversion does not establish a currently credible ordinary-holder backstop.",
    evidenceNeeded:
      "Current binding withdrawal terms, reserve evidence, route availability, output currency, fees, limits, and settlement.",
    evidenceUrls: ["https://vndc.io/", "https://goonus.io/en/"],
    allowedRouteFamilyIfProven: "offchain-issuer",
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
    id: "xai-silo-finance",
    disposition: "defer",
    reasonCode: "borrower-repay-only",
    blocker:
      "Silo documents XAI borrowing and repayment, with the peg otherwise depending on arbitrage and DEX liquidity.",
    rationale: "Debt repayment closes a borrower's position but does not let arbitrary XAI holders redeem collateral.",
    evidenceNeeded: "New official ordinary-holder redemption docs and audited callable route evidence.",
    evidenceUrls: ["https://docs.silo.finance/"],
    allowedRouteFamilyIfProven: "collateral-redeem",
  }),
  reviewed({
    id: "xofm-mento",
    disposition: "add",
    reasonCode: "holder-route-confirmed",
    blocker:
      "The oracle-priced route is documented; config work must verify XOFm's live pair directions, reserve limits, fees, and breaker status.",
    rationale: "Mento documents direct XOFm swaps in its app at an oracle rate without slippage.",
    evidenceNeeded:
      "Current pair addresses, bidirectional route, reserve or trading limits, fee, and circuit-breaker status.",
    evidenceUrls: [
      "https://docs.mento.org/mento-v3/other/getting-mento-stables/on-celo",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
    ],
    allowedRouteFamilyIfProven: "psm-swap",
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
  reviewed({
    id: "zeusd-zoth",
    disposition: "hard-reject",
    reasonCode: "borrower-repay-only",
    blocker:
      "Zoth documents repayment to reclaim a user's own RWA collateral, not broad ZeUSD-holder redemption for reserve assets.",
    rationale: "CDP debt closure is position-specific and does not create a claim for secondary holders.",
    evidenceNeeded:
      "Official ordinary-holder redemption mechanics with access, output, capacity, fee, and settlement evidence.",
    evidenceUrls: [
      "https://docs.zoth.io/zoth/products/zeusd-an-omni-chain-and-composable-stable-token/mechanics-of-zeusd",
      "https://docs.zoth.io/zoth/products/zeusd-debt-position-zedp",
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
