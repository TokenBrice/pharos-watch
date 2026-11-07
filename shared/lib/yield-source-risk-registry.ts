import type { YieldDependencyConcentration, YieldVenueRiskTier } from "../types/yield";
import { computeVenueRiskWeighted, deriveVenueRiskTier } from "./yield-scoring";
import type { YieldVenueRiskScores } from "./yield-scoring";

// Shared scores for both Yearn venue slugs (yearn, yearn-finance).
// Edit this constant to update both entries simultaneously.
const YEARN_VENUE_SCORES: YieldVenueRiskScores = {
  audits: 2,
  centralization: 2,
  fundsManagement: 2,
  liquidity: 2,
  operational: 1,
};

// Shared scores for all Morpho venue slugs (morpho, morpho-v1, morpho-blue).
// Edit this constant to update all three entries simultaneously.
const MORPHO_VENUE_SCORES: YieldVenueRiskScores = {
  audits: 2,
  centralization: 4,
  fundsManagement: 3,
  liquidity: 2,
  operational: 2,
};

export interface YieldRiskConfigEntry {
  /**
   * Yearn-style 5-category venue-risk sub-scores (each 1..5, higher = riskier).
   * The coarse {@link YieldVenueRiskTier} and the PYS venue penalty are DERIVED
   * from these via the shared yield-scoring helpers (yield v8.292).
   */
  scores: YieldVenueRiskScores;
  reviewedAt: string;
  confidence?: "verified" | "partial" | "low";
  /** Reviewer verdict; full supporting citations live in the evidence sidecar. */
  rationale?: string;
}

/** Weighted 1..5 venue-risk score for a reviewed config entry. */
export function venueRiskWeightedOf(entry: YieldRiskConfigEntry): number {
  return computeVenueRiskWeighted(entry.scores);
}

/** Coarse tier derived from a reviewed config entry's weighted score. */
export function venueRiskTierOf(entry: YieldRiskConfigEntry): YieldVenueRiskTier {
  return deriveVenueRiskTier(venueRiskWeightedOf(entry));
}

export const YIELD_RISK_CONFIG = {
  // Battle-tested money market since Aave V1 (2020) / V3 (2022); multi-billion-USD TVL
  // across 10+ chains; multiple independent audits and formal verification; mature
  // governance with safety-module stake. Low venue risk.
  "aave-v3": {
    scores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Aave V3 is a mature, multi-billion-USD lending venue with repeated independent audits, formal verification, and an active governance + safety-module stake. 2026-09-23 re-review: the aave-v3-core audit directory still lists eight independent reports (OpenZeppelin 2021 through Sigma Prime 2023), and DeFiLlama reports $18.7B TVL across 21 chains; no surface change that moves the sub-scores.",
  },
  // Established Compound product line; isolated-asset V3 design has matured since 2022
  // with multiple audits and active COMP governance. Low venue risk.
  "compound-v3": {
    scores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Compound III (Comet) is an isolated-asset lending market with a multi-year audit history, billions in TVL, and active COMP governance; the Comet codebase narrowed the protocol surface area relative to V2. 2026-09-23 re-review: the issuer security page still lists Trail of Bits and OpenZeppelin audits plus formal verification and a community bug bounty, and DeFiLlama reports $1.5B TVL across 10 chains; no surface change that moves the sub-scores.",
  },
  // SparkLend is an Aave V3 fork deployed by Sky / former MakerDAO; benefits from
  // upstream audit inheritance, has a billion-plus TVL, and is operated through Sky
  // governance. Low venue risk.
  sparklend: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "SparkLend is an Aave V3 fork operated by the Sky (formerly MakerDAO) ecosystem; it inherits the upstream Aave V3 audit surface, runs significant TVL, and is governed through the Sky framework.",
  },
  "spark-savings": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Spark Savings wrappers route yield through the Sky/Spark savings stack rather than an external credit venue; the reviewed surface inherits Sky governance, issuer-level rate setting, and Spark operational controls.",
  },
  maple: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Maple is an institutional credit venue whose lender pools depend on delegate underwriting, borrower performance, and loan recovery mechanics; that credit-underwriting surface is materially broader than low-risk money-market venues.",
  },
  yearn: {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Yearn is a mature strategy-vault venue with long production history and repeated audits; vault strategy risk remains, but the reviewed stablecoin vault surface is operationally established.",
  },
  "yearn-finance": {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Yearn Finance maps to the same mature strategy-vault family as Yearn; stablecoin vault risk is reviewed as low after accounting for its production history, audit cadence, and vault-level accounting.",
  },
  morpho: {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Morpho sources are reviewed as medium to align with Morpho Blue where vault and market parameters shift risk to market creators and allocators despite the audited lending primitive. 2026-09-23 family re-review (see `morpho-blue`): the audit directory and DeFiLlama scale check still support the medium tier; sub-scores unchanged.",
  },
  "morpho-v1": {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Morpho v1 belongs to the reviewed Morpho lending venue family and inherits allocator, market-parameter, and integration risk that is broader than mature canonical money markets. 2026-09-23 family re-review (see `morpho-blue`); sub-scores unchanged.",
  },
  // Morpho Blue is the modern immutable lending primitive (January 2024) with a
  // multi-auditor trail and a TVL cohort that has since closed on Aave/Compound
  // scale. Medium venue risk reflects the immutable design limiting remediation
  // paths and the market-creator/allocator risk transfer.
  "morpho-blue": {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Morpho Blue is an immutable singleton lending primitive launched in January 2024 with multiple audits; design choices reduce ongoing governance surface but limit remediation, and vault/market risk shifts to curators and allocators. 2026-09-23 re-review: the morpho-blue audit directory still lists the OpenZeppelin (2023-10) and Cantina (2023-11, 2024-01) reports, and DeFiLlama reports $11.0B TVL across 45 chains; scale no longer separates it from the Aave/Compound cohort, while the immutable-design and allocator-risk sub-scores stand.",
  },
  pendle: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-09",
    rationale:
      "Pendle is a mature yield-tokenization venue with isolated markets and a long audit trail; reviewed stablecoin principal/yield markets are low venue risk when market and maturity data remain observable.",
  },
  beefy: {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-09",
    rationale:
      "Beefy is a multi-chain strategy-vault aggregator; reviewed yield rows inherit additional strategy, chain, bridge, and integration risk beyond canonical lending venues.",
  },
  // ── Phase 2 long-tail venues (yield v8.292, reviewed 2026-06-15) ──────────────
  // Uncollateralized / RWA credit (high tier — where `unknown`=0 was most wrong)
  clearpool: {
    scores: { audits: 3, centralization: 5, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Clearpool is uncollateralized institutional credit; a sub-4-signer multisig with no timelock and direct lender default exposure place it in the high venue-risk tier.",
  },
  goldfinch: {
    scores: { audits: 2, centralization: 4, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Goldfinch is uncollateralized RWA credit with realized multi-million-dollar loan losses; strong audits do not offset offchain borrower-default exposure.",
  },
  "3jane-lending": {
    scores: { audits: 4, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "3Jane is an unsecured on-chain credit venue whose core risk is uncollateralized lending against off-chain cash flows with off-chain legal recovery; a 3-of-5 multisig with anonymous signers and heavy off-chain credit operations keep it in the high tier despite real audit coverage. Aligned to Yearn's published USD3 risk report (3.5/5 'Medium — enhanced monitoring', 2026-07-01 cross-check).",
  },
  centrifuge: {
    scores: { audits: 1, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Centrifuge is mature, heavily-audited RWA tokenization; the medium tier reflects offchain asset-performance exposure and redemption/epoch gating rather than contract risk.",
  },
  "flux-finance": {
    scores: { audits: 2, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Flux Finance is a Compound V2 fork lending against tokenized Treasuries; overcollateralized but admin-upgradeable with permissioned liquidations.",
  },
  cap: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Cap routes a 1:1-reserve stablecoin into restaking-backed credit to whitelisted institutional operators; strong audits offset by youth and operator credit risk.",
  },
  avantis: {
    scores: { audits: 3, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Avantis is a perp-DEX LP vault where depositors backstop leveraged traders' PnL; single audit, upgradeable, and market (not credit) principal risk.",
  },
  // EVM money markets / CDPs
  "euler-v2": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-09-23",
    rationale:
      "Euler v2 is a hardened modular relaunch with an exemplary post-2023 security program and full prior-exploit recovery; low venue risk. 2026-09-23 re-review: the protocol security page still documents the formal-verification and audit program (Certora verification of the V2 core and EulerEarn plus independent reviews), and the venue remains live at scale on DeFiLlama; sub-scores unchanged.",
  },
  gearbox: {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Gearbox is a well-audited leverage/credit-account protocol; the leverage and curator-credit model lifts funds and liquidity risk above plain money markets.",
  },
  "curve-llamalend": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Curve LlamaLend is battle-tested but the complex LLAMMA soft-liquidation design and a 2025 bad-debt event keep funds/liquidity risk at low-medium.",
  },
  "fluid-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    rationale:
      "Fluid's capital-efficient shared liquidity layer concentrates cross-module risk; Guardian pause powers and a recent bad-debt sweep put it at low-medium.",
  },
  dolomite: {
    scores: { audits: 2, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Dolomite is well-audited but a 2/3 (sub-4-signer) multisig with a sub-48h timelock and very broad asset support drive its centralization risk up to medium.",
  },
  exactly: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Exactly is a multiply-audited fixed+variable-rate lender with timelocked governance; smaller scale and maturity-pool fragmentation keep it at low.",
  },
  "fraxlend-v2": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Fraxlend v2 is an audited isolated-pair lender; the FRAX-priced-at-$1 assumption and a 2025 WFRAX bad-debt event lift funds/liquidity risk to low-medium.",
  },
  "aave-v4": {
    scores: { audits: 1, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Aave v4 carries best-in-class audits but fresh Mar-2026 hub-and-spoke code plus a live Dec-2025 governance crisis raise centralization/operational risk; still low overall.",
  },
  "compound-v2": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Compound v2 is battle-tested with 2-day-timelock governance; legacy/deprecated status (superseded by Compound III) is the only material lift, keeping it low.",
  },
  "felix-cdp": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Felix is an audited Liquity-v2 fork on Hyperliquid; youth, single-chain concentration, and HYPE/LST collateral with USDC oracle dependency place it at medium.",
  },
  frankencoin: {
    scores: { audits: 2, centralization: 1, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Frankencoin is an immutable, oracle-free CHF stablecoin with strong decentralization; slower auction-based liquidation of volatile collateral keeps funds/liquidity risk at low.",
  },
  // App-chain / non-EVM lenders
  "kamino-lend": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Kamino is the strongest-record Solana lender in the set; oracle and large-supplier concentration are the only soft risks, keeping it low.",
  },
  justlend: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "JustLend is a mature Tron lender with a timelocked DAO; concentrated voting power and Tron/USDD ecosystem exposure temper but do not lift it above low.",
  },
  "benqi-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "BENQI is an established Avalanche lender with a strong audit cadence and a QI safety module; multisig-only admin keeps it at low.",
  },
  "aries-markets": {
    scores: { audits: 3, centralization: 5, fundsManagement: 3, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Aries Markets is the top Aptos lender but a sub-4-signer multisig with no timelock, anonymous team, and a ~90% TVL collapse place it in the high tier.",
  },
  "scallop-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Scallop is a solid Sui lender with three reputable audits and a bounty; an undisclosed multisig config and thinner Sui liquidity keep it at low-medium.",
  },
  "echelon-market": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Echelon is an overcollateralized Move lending venue with isolated markets and asset-specific oracle dependencies; listings and admin terms remain partly team-dependent or incompletely verified. 2026-11-07 re-review: nine scoped reports name OtterSec, Zellic, Quantstamp, Zenith and Plainshift, supporting audits 2; $5.39M DeFiLlama TVL replaces the prior hundreds-of-millions assumption and raises liquidity to 4, while the October 31 DNS compromise raises operational to 4; the issuer reported restoration that evening.",
  },
  "blend-pools-v2": {
    scores: { audits: 3, centralization: 2, fundsManagement: 4, liquidity: 4, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Blend V2 has immutable isolated Stellar lending pools, but its shared Comet backstop dependency was impaired; incumbent V2 and the separately deployed V2.1 recovery pools require distinct operational treatment. 2026-11-07 re-review: the protocol-repository recovery record describes unusable incumbent Comet backing, on-ice V2 pools and blocked LP operations; DeFiLlama's adapter still reads incumbent V2 addresses rather than V2.1, so audits rises to 3 and funds, liquidity and operational to 4 despite $117.65M aggregate Stellar TVL.",
  },
  "jupiter-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Jupiter Lend is an overcollateralized Solana lender with a shared Earn, Borrow and Multiply liquidity layer, timelocked market-admin parameters and withdrawals constrained by utilization and dynamic ceilings. 2026-11-07 re-review: developer docs list 2026 Certora/Code4rena core Lend work and separately scoped Lend AMM assessments; the issuer confirmed an October 30 USDC withdrawal liquidity crunch and recovery that evening, raising liquidity to 3 despite $928.21M Solana TVL; other sub-scores remain unchanged.",
  },
  "hyperlend-pooled": {
    scores: { audits: 3, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "HyperLend is an overcollateralized HyperEVM lender with Aave-derived pooled markets, documented audit and monitoring programs, and concentrated chain exposure; live governance quorum and effective timelock delays remain incompletely verified. 2026-11-07 re-review: the audit directory lists core and integration-specific Pashov, Cantina, Ackee, Nethermind and CD Security work through April 2026, and docs publish governance, emergency-admin and timelock addresses; $304.19M TVL remains on Hyperliquid L1, while live quorum and delays remain unverified, so sub-scores and partial confidence are unchanged.",
  },
  curvance: {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Curvance is a Monad lender with isolated market accounting, independently reviewed lending contracts and scoped governance/emergency controls; collateral-issuer failures, local liquidity and operational incident history remain material. 2026-11-07 re-review: six named public reports and documented delayed DAO/scoped emergency controls replace the unitemized-audit assessment, and $135.56M TVL replaces tiny-scale assumptions, moving audits, centralization and liquidity to 2/3/3; funds rises to 4 after the Echo collateral incident, eBTC/WBTC remains paused, and operational stays 4.",
  },
  "sovryn-dex": {
    scores: { audits: 5, centralization: 3, fundsManagement: 4, liquidity: 5, operational: 5 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Sovryn combines Rootstock lending and AMM exposure with prior exploit history and limited exit depth. 2026-11-07 re-review: the official 3 November report confirms new lending/margin and AMM attacks, paused lending withdrawals and unfinished loss reconciliation; SIP-0097 proposes further restrictions. Audits, funds management, liquidity and operational scores rise for the unresolved incident; DeFiLlama reports $5.74M on Rootstock and BOB.",
  },
  // ── FU3 Wave 2 venues (yield v8.292, reviewed 2026-06-15) ──────────────────
  truefi: {
    scores: { audits: 3, centralization: 3, fundsManagement: 5, liquidity: 5, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "TrueFi's legacy uncollateralized credit pools retain borrower-default and repayment-dependent exit exposure during the transition to Brila. 2026-11-07 re-review: current documentation redirects to Brila and TFIP-42 proposes replacing legacy Timelock control with a 4-of-7 Safe; execution was not established. DeFiLlama reports $21.7K remaining TVL on Ethereum and Arbitrum; liquidity and operational scores rise for the residual credit book and governance transition.",
  },
  "radiant-v2": {
    scores: { audits: 5, centralization: 5, fundsManagement: 4, liquidity: 5, operational: 5 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Radiant Capital retains unresolved losses from its October 2024 exploit and has ended active development in favor of maintenance and recovery. 2026-11-07 re-review: Radiant's 1 June sunset notice disables borrowing and emissions, ends active development and retains position management and recovery support; DeFiLlama reports $501K across four chains. Existing severe sub-scores remain unchanged.",
  },
  "wildcat-protocol": {
    scores: { audits: 3, centralization: 4, fundsManagement: 5, liquidity: 5, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Wildcat is undercollateralized credit with borrower-defined terms; borrower default and withdrawal restrictions dominate funds and liquidity risk. 2026-11-07 re-review: V2 reports itemize Code4rena and alpeh_v reviews, while SphereX documentation confirms team-controlled transaction filtering can freeze the protocol if compromised. Centralization rises to 4; other sub-scores remain unchanged, with $2.69M DeFiLlama TVL on Ethereum and Plasma.",
  },
  "gains-network": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Gains Network gToken vaults backstop leveraged-trader PnL and use timelocked upgrades and epoch-based withdrawal queues. 2026-11-07 re-review: v10 docs disclose a 10-hour emergency code/role timelock, lifting centralization to 3; the product changelog records a MegaETH new-position pause with closes available. Pashov's module report identifies reviewed and fixes commits; DeFiLlama reports $6.69M across five chains. Other sub-scores remain unchanged.",
  },
  "venus-core-pool": {
    scores: { audits: 3, centralization: 2, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Venus Core Pool is a governed Compound-derived money market with realized bad debt from collateral-accounting and price-manipulation failures. 2026-11-07 re-review: the documented March THE donation/cap bypass left about $2.15M bad debt; current documents add scoped September/October audits and 48h normal/6h fast governance routes, while DeFiLlama reports $1.08B TVL, predominantly BNB; audits, fundsManagement and operational rise to 3.",
  },
  "moonwell-lending": {
    scores: { audits: 4, centralization: 3, fundsManagement: 4, liquidity: 5, operational: 4 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Moonwell's Compound-derived core markets have repeated oracle/accounting failures and unresolved Base withdrawal impairment. 2026-11-07 re-review: August's MAMO donation/oracle exploit left about $9.13M residual debt at the incident cutoff; the November 6 market report still shows zero Base borrow caps and 100% utilization in USDC and EURC, so audits/fundsManagement/operational rise to 4 and liquidity to 5.",
  },
  "silo-v2": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Silo v2 is overcollateralized isolated-pair lending; permissionless market creation and market-specific collateral, oracle and liquidity exposure remain the main constraints. 2026-11-07 re-review: the audit index retains V2-specific Certora, Enigma Dark, Cantina and Sigma Prime reports separately from V3; V2 documentation retains permissionless deployment and oracle-specific isolated risk, with $3.92M DeFiLlama TVL across four chains; sub-scores unchanged.",
  },
  "sturdy-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Sturdy v2 combines isolated lending pairs with managed aggregation; external lender, allocation and privileged-control dependencies accompany thin residual liquidity. 2026-11-07 re-review: the V2 security index still lists 2023 Zellic, ChainSecurity and Spearbit reviews, with ChainSecurity excluding the vault and silo implementations; DeFiLlama TVL is $218K across six reported chains, so liquidity rises to 4 while current privileged controls remain partially verified.",
  },
  vesper: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Vesper aggregates external yield strategies; pool governance, keepers and underlying protocol or vault exit constraints remain material dependencies. 2026-11-07 re-review: September Quantstamp Concrete-strategy and October collaborative strategy reports add bounded audit coverage while retaining external-vault, keeper and withdrawal constraints; DeFiLlama parent TVL is $90.0M, and current multisig/deployed-version details remain partially verified; sub-scores unchanged.",
  },
  "convex-finance": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Convex stakes Curve/Frax LP positions and concentrates governance through its multisig; underlying pool and integration risk remains separate from contract immutability. 2026-11-07 re-review: the audit index separates core, wrapper and sidechain reports, and current docs retain a 3-of-5 multisig with fee, pool-manager and deposit-pause powers. DeFiLlama reports $505M across four chains; sub-scores unchanged.",
  },
  liqwid: {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Liqwid's Cardano markets depend on thin onchain liquidity, oracle controls and team-operated transaction batching. 2026-11-07 re-review: public audit evidence covers V1/Agora, while V2 source release and bounty cancellation remain governance proposals; team batching/guardian powers contradict the prior no-admin claim. The November NIGHT proposal recounts bridge-related emergency caps, and TVL is $8.73M; audits, centralization, funds management and operational scores rise to 3.",
  },
  "lista-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Lista's Moolah lending markets use collateral-specific and curator-set controls, with separately documented credit-broker contracts. 2026-11-07 re-review: October reports cover V3 collateral, market creation and liquidators, and vault timelocks vary by curator; Credit Phase 1 has concluded and public credit vaults remain planned. DeFiLlama reports $914M on BNB Chain and Ethereum; no reviewed evidence establishes unsecured exposure in the published lending sources, so sub-scores remain unchanged.",
  },
  loopscale: {
    scores: { audits: 4, centralization: 4, fundsManagement: 4, liquidity: 5, operational: 5 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Loopscale's Solana credit and vault infrastructure retains team-controlled upgrades, collateral-pricing and vault-accounting exposure after the recovered April 2025 exploit. 2026-11-07 re-review: Loopscale's November 6 statement confirms a new collateral-pricing attack and a vault-NAV attack, with vault withdrawals and USDC Genesis-funded repayments still restricted. Audits list later periphery reviews, but repeat accounting failures raise funds management to 4 and liquidity/operational to 5; DeFiLlama parent TVL is $89.0M, not available exit liquidity.",
  },
  "navi-lending": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "NAVI is the largest Sui lender with strong Move audits; team-retained mint/freeze controls and young-chain risk cap it at low.",
  },
  "zest-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Zest is the largest Stacks BTC lender with a timelocked multisig; novel unproven BitVM vaults and thin Bitcoin-L2 liquidity raise it to medium.",
  },
  resupply: {
    scores: { audits: 4, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Resupply (Convex/Yearn sub-DAO) recovered fully from a Jun-2025 ~$9.6M oracle exploit; composable stablecoin-CDP collateral and the preventable flaw keep it at medium.",
  },
  termmax: {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "TermMax is a well-audited 4-of-6-multisig fixed-rate isolated lender; tokenized-equity/RWA collateral and maturity lockups raise it to medium.",
  },
  upshift: {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Upshift is an institutional credit-vault provider lending to KYC'd market makers via a prime broker; a sub-4-signer multisig, no timelock, and offchain counterparty exposure put it high.",
  },
  tectonic: {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Tectonic is a mature audited Compound-fork on Cronos; overcollateralized but single-chain concentration and an opaque admin threshold keep it at medium.",
  },
  "openeden-usdo": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "OpenEden USDO is a regulated T-bill-backed stablecoin venue; strong ratings/custody are offset by offchain RWA dependency and centralized issuer mint/redeem control — medium.",
  },
} satisfies Record<string, YieldRiskConfigEntry>;

export type YieldRiskConfigProtocol = keyof typeof YIELD_RISK_CONFIG;

export const YIELD_RISK_CONFIG_PROTOCOLS = Object.keys(
  YIELD_RISK_CONFIG,
) as readonly YieldRiskConfigProtocol[];

const YIELD_RISK_CONFIG_PROTOCOL_ALIASES: Record<string, YieldRiskConfigProtocol> = {
  aave: "aave-v3",
  compound: "compound-v3",
  spark: "sparklend",
  "spark-lend": "sparklend",
  // Phase 2 venue slug variants → canonical reviewed key
  "clearpool-lending": "clearpool",
  sovryn: "sovryn-dex",
  fraxlend: "fraxlend-v2",
  // A8: DeFiLlama project slugs that name an already-reviewed venue, so the
  // auto-discovery `pool.project` slot resolves a tier instead of staying unknown.
  "pendle-v2": "pendle",
  sdai: "spark-savings",
};

/**
 * Venue protocol of every tracked variant child, keyed by the child's stablecoin
 * id (A8). Wrapper children publish their own `onchain:<childId>` /
 * `linked-variant:<childId>:...` rows, whose source keys carry no venue, so the
 * child id is the only stable identifier for the vault that generates the yield.
 *
 * Values are venue protocol slugs, not necessarily reviewed keys: a reviewed
 * slug resolves a venue-risk tier, an unreviewed one keeps the tier `unknown`
 * and is surfaced by the coverage-audit venue queue (A10) for review — never
 * backfill a guessed tier here.
 */
export const YIELD_VARIANT_CHILD_VENUE_PROTOCOLS: Readonly<Record<string, string>> = {
  // October 2026 addition wave: exact vault identities and lender adapters
  // reviewed in shared/data/coverage-dispositions/dependency-target-dispositions.ts.
  // The curator/brand is not the lending venue (including Pendle and Sky vaults).
  "senpyusdmain-sentora": "morpho-blue",
  "senpyusdprimev2-sentora": "morpho-blue",
  "senrlusdv2-sentora": "morpho-blue",
  "senpathusd-sentora": "morpho-blue",
  "senpyusdpst-sentora": "morpho-blue",
  "senpyusdmwin-sentora": "morpho-blue",
  "sxsrlusd-sentora": "morpho-blue",
  "krusdc-keyrock": "morpho-blue",
  "arcusdc-galaxy": "morpho-blue",
  "armusdcs-wintermute": "morpho-blue",
  "pendleusdc-pendle": "morpho-blue",
  "skymoneyusdsflagship-sky": "morpho-blue",
  "skymoneyusdtsavings-sky": "morpho-blue",
  "sirloinusdc-steakhouse": "morpho-blue",
  "steakusdg-steakhouse": "morpho-blue",
  "steakeurcv-steakhouse": "morpho-blue",
  "kpkusdcyield-kpk": "morpho-blue",
  "kpkusdcprime-kpk": "morpho-blue",
  "gusdcq-galaxy": "morpho-blue",
  "gusdtq-galaxy": "morpho-blue",
  "gtusdtp-gauntlet": "morpho-blue",
  "steakcusdc-steakhouse": "morpho-blue",
  "bbqusdc-steakhouse-v2": "morpho-blue",
  "cscbusdc-clearstar": "morpho-blue",
  "ethenausdc-steakhouse": "morpho-blue",
  "hyperusdca-hyperithm": "morpho-blue",
  "sparkusdc-spark": "morpho-blue",
  "sparkusdtbc-spark": "morpho-blue",
  "syrupusdg-maple": "maple",
  "bbqusdc-steakhouse": "morpho-blue",
  "gtusdc-gauntlet": "morpho-blue",
  "gtusdcp-gauntlet": "morpho-blue",
  "sdai-sky": "spark-savings",
  "sgho-aave": "aave-v3",
  "steakusdc-steakhouse": "morpho-blue",
  "steakusdt-steakhouse": "morpho-blue",
  "stkgho-umbrella-aave": "aave-v3",
  "susdc-spark": "spark-savings",
  "susdt-spark": "spark-savings",
  "syrupusdc-maple": "maple",
  "syrupusdt-maple": "maple",
  "ybold-yearn": "yearn",
  "yvusdc-yearn": "yearn",
  // Children whose wrapper venue is reviewed but was unpublished (A8): the Sky
  // savings-rate stack (sUSDS/stUSDS carry the reviewed Sky/Spark savings-rate
  // surface, same as the sDAI/Spark entries above), Cap's staked cUSD, and
  // Curve's crvUSD savings wrapper (crvUSD borrower interest = LlamaLend).
  "stusds-sky": "spark-savings",
  "susds-sky": "spark-savings",
  "stcusd-cap": "cap",
  "scrvusd-curve": "curve-llamalend",
  // Children whose wrapper venue is not yet reviewed: they publish the issuing
  // protocol so the row carries a real venue instead of `null`. Tier stays
  // `unknown` (PYS-neutral) until their review lands via the coverage queue.
  "savusd-avant": "avant",
  "sfrxusd-frax": "frax",
  "susn-noon": "noon-capital",
  "susde-ethena": "ethena",
  "wsrusd-reservoir": "reservoir-protocol",
};

function isYieldRiskConfigProtocol(value: string): value is YieldRiskConfigProtocol {
  return Object.prototype.hasOwnProperty.call(YIELD_RISK_CONFIG, value);
}

function normalizeYieldRiskConfigProtocol(venueProtocol: string | null | undefined): YieldRiskConfigProtocol | null {
  if (typeof venueProtocol !== "string") return null;
  const normalized = venueProtocol.trim().toLowerCase();
  if (!normalized) return null;
  if (isYieldRiskConfigProtocol(normalized)) return normalized;
  return YIELD_RISK_CONFIG_PROTOCOL_ALIASES[normalized] ?? null;
}

export function resolveReviewedYieldRiskConfig(venueProtocol: string | null | undefined): YieldRiskConfigEntry | null {
  const protocol = normalizeYieldRiskConfigProtocol(venueProtocol);
  return protocol == null ? null : YIELD_RISK_CONFIG[protocol];
}

/**
 * Reviewer-set cross-venue dependency concentration, keyed by stablecoin id
 * (yield v8.292). Captures the risk that per-venue tiering structurally misses —
 * e.g. a vault whose strategy legs all sit behind one governance ecosystem, the
 * single risk Yearn's own yvUSDC report flags as dominant. Not auto-derived:
 * only set where the concentration is documented, so missing entries stay
 * neutral. See the source-risk section of `docs/yield-intelligence.md`.
 */
const YIELD_DEPENDENCY_CONCENTRATION: Record<string, YieldDependencyConcentration> = {
  // Penalty-worthy: a LOW venue tier (yearn-finance) hides a real single-ecosystem
  // (Sky) coupling — the canonical case the signal exists for.
  "yvusdc-yearn": {
    ecosystem: "Sky",
    severity: "medium",
    note: "Funded debt sits almost entirely in Sky-governed venues (sUSDS savings plus Spark Lend); a Sky incident would affect both legs simultaneously. Matches Yearn's own risk report flagging ~100% Sky-governance coupling.",
    reviewedAt: "2026-06-15",
  },
  // Informational (severity low = no added penalty): single-curator MetaMorpho
  // vaults whose apparent market-level diversification is bounded by one curator +
  // the Morpho protocol. Morpho protocol risk is already priced by the medium
  // venue tier, so this surfaces the curator coupling without double-counting.
  "gtusdc-gauntlet": {
    ecosystem: "Morpho (Gauntlet)",
    severity: "low",
    note: "All exposure is Morpho Blue lending markets allocated by a single curator (Gauntlet); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty. 2026-09-23 re-review: the Morpho app still attributes the vault to Gauntlet (curator TVL about $945M) with the vault live at about $23M deposits.",
    reviewedAt: "2026-09-23",
  },
  "gtusdcp-gauntlet": {
    ecosystem: "Morpho (Gauntlet)",
    severity: "low",
    note: "All exposure is Morpho Blue lending markets allocated by a single curator (Gauntlet); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty. 2026-09-23 re-review: the Morpho app still attributes the vault to Gauntlet with the vault live at about $99M deposits.",
    reviewedAt: "2026-09-23",
  },
  "steakusdc-steakhouse": {
    ecosystem: "Morpho (Steakhouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by a single curator (Steakhouse); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty. 2026-09-23 re-review: the Morpho app still attributes the vault to Steakhouse Financial with the vault live at about $67M deposits.",
    reviewedAt: "2026-09-23",
  },
  "bbqusdc-steakhouse": {
    ecosystem: "Morpho (Steakhouse Smokehouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by Steakhouse's Smokehouse curator line; apparent market diversification is bounded by one curator. The higher-risk collateral mix is carried in stablecoin reserve metadata while Morpho protocol risk is already priced by the venue tier. 2026-09-23 re-review: the Morpho app still attributes the vault to the Smokehouse line with the vault live at about $14M deposits.",
    reviewedAt: "2026-09-23",
  },
  "steakusdt-steakhouse": {
    ecosystem: "Morpho (Steakhouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by a single curator (Steakhouse); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty. 2026-09-23 re-review: the Morpho app still attributes the vault to Steakhouse with the vault live at about $86M deposits.",
    reviewedAt: "2026-09-23",
  },
  // syrupUSDC/USDT yield is originated by a single off-chain Pool Delegate EOA
  // ("Maple Direct") controlling ~97% of AUM loan origination/impairments with no
  // on-chain governance gate. Surfaced at LOW severity (informational, no penalty)
  // because the `maple` venue tier already prices the credit/delegate risk — a HIGH
  // entry would double-count it. Matches the single-curator Morpho chips above.
  // Source: Yearn maple-syrupUSDC dependency graph (2026-07-01 cross-check).
  "syrupusdc-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDC's yield is originated by a single off-chain Pool Delegate EOA ('Maple Direct') that controls loan origination and impairments for ~97% of AUM with no on-chain governance gate. Surfaced without an added penalty because the medium `maple` venue tier already prices the credit/delegate risk.",
    reviewedAt: "2026-07-01",
  },
  "syrupusdt-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDT shares syrupUSDC's single off-chain Pool Delegate ('Maple Direct') for loan origination and impairments. Surfaced without an added penalty because the medium `maple` venue tier already prices the credit/delegate risk.",
    reviewedAt: "2026-07-01",
  },
};

export function resolveDependencyConcentration(
  stablecoinId: string | null | undefined,
): YieldDependencyConcentration | null {
  if (typeof stablecoinId !== "string") return null;
  return YIELD_DEPENDENCY_CONCENTRATION[stablecoinId] ?? null;
}

/** Quarterly review bound for venue-risk and dependency-concentration evidence (yield v8.292). */
const VENUE_RISK_SCORE_MAX_AGE_DAYS = 90;

export interface StaleVenueRiskScore<K extends string = string> {
  protocol: K;
  reviewedAt: string;
  ageDays: number;
  confidence: YieldRiskConfigEntry["confidence"];
}

/** Minimal reviewed-entry shape the staleness calculation reads. */
export interface ReviewedVenueRiskEntry {
  reviewedAt: string;
  confidence?: YieldRiskConfigEntry["confidence"];
}

/**
 * Pure staleness calculation over explicitly supplied entries: ages each
 * `reviewedAt` (a `YYYY-MM-DD` date parsed as UTC midnight) against `nowMs` and
 * returns the entries strictly older than `maxAgeDays`, most-stale first.
 * Unparseable dates are skipped.
 */
export function findStaleVenueRiskScoresByEntries<K extends string>(
  entries: Readonly<Record<K, ReviewedVenueRiskEntry>>,
  nowMs: number,
  maxAgeDays: number = VENUE_RISK_SCORE_MAX_AGE_DAYS,
): StaleVenueRiskScore<K>[] {
  const stale: StaleVenueRiskScore<K>[] = [];
  for (const protocol of Object.keys(entries) as K[]) {
    const entry = entries[protocol];
    const reviewedMs = Date.parse(`${entry.reviewedAt}T00:00:00Z`);
    if (!Number.isFinite(reviewedMs)) continue;
    const ageDays = Math.floor((nowMs - reviewedMs) / 86_400_000);
    if (ageDays > maxAgeDays) {
      stale.push({ protocol, reviewedAt: entry.reviewedAt, ageDays, confidence: entry.confidence });
    }
  }
  return stale.sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Venue-risk and dependency-concentration scores encode point-in-time facts
 * (audit counts, governance events, TVL) and rot. Returns entries whose
 * `reviewedAt` is older than `maxAgeDays` so the monthly yield-coverage audit
 * can queue them for quarterly re-verification.
 */
export function findStaleVenueRiskScores(
  nowMs: number,
  maxAgeDays: number = VENUE_RISK_SCORE_MAX_AGE_DAYS,
): StaleVenueRiskScore[] {
  return [
    ...findStaleVenueRiskScoresByEntries(YIELD_RISK_CONFIG, nowMs, maxAgeDays),
    ...findStaleVenueRiskScoresByEntries(YIELD_DEPENDENCY_CONCENTRATION, nowMs, maxAgeDays),
  ].sort((a, b) => b.ageDays - a.ageDays);
}
