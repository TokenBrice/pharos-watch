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
    reviewedAt: "2026-11-07",
    rationale:
      "Pendle is a mature yield-tokenization venue with isolated markets and a long audit trail; reviewed stablecoin principal/yield markets are low venue risk when market and maturity data remain observable. 2026-11-07 re-review: the public audit repository includes PT-looping, Market V7 and sPENDLE reviews alongside the V2 core reports; DeFiLlama reports $1.00B TVL across 13 funded chains. PPP voting uses sPENDLE, while market and underlying-asset risks remain distinct; sub-scores unchanged.",
  },
  beefy: {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Beefy is a multi-chain strategy-vault aggregator; reviewed yield rows inherit additional strategy, chain, bridge, and integration risk beyond canonical lending venues. 2026-11-07 re-review: the audit repository retains wrapper, Zap and CLM reports; current controls are a 3-of-6 developer multisig and six-hour strategy timelock. DeFiLlama reports $97.1M TVL across 22 funded chains; October notices retire Sonic products and describe ongoing Stream recovery and Aero migration, supporting unchanged strategy and operational sub-scores.",
  },
  // ── Phase 2 long-tail venues (yield v8.292, reviewed 2026-06-15) ──────────────
  // Uncollateralized / RWA credit (high tier — where `unknown`=0 was most wrong)
  clearpool: {
    scores: { audits: 3, centralization: 5, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Clearpool is uncollateralized institutional credit; upgradeable admin controls and direct lender default exposure place it in the high venue-risk tier. 2026-11-07 re-review: the current catalog separates Dynamic, Prime, Credit Vault and T-Pool audits, and the Prime review documents owner-controlled upgrades and membership parameters. DeFiLlama reports $18.0M TVL across seven funded chains, concentrated on Flare; Dynamic lender withdrawals still depend on utilization. Sub-scores remain conservative; current signer and timelock configuration was not independently confirmed.",
  },
  goldfinch: {
    scores: { audits: 2, centralization: 4, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Goldfinch is uncollateralized RWA credit with realized multi-million-dollar loan losses; strong audits do not offset offchain borrower-default exposure. 2026-11-07 re-review: CertiK and Trail of Bits coverage and the 6-of-10 Council remain documented; DeFiLlama reports $2.07M on Ethereum. GIP-85 records a $330K December 2025 exploit of an unaudited pre-launch test contract, separate from the lending contracts; legacy credit-recovery and liquidity risks support unchanged sub-scores.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "Flux Finance is a Compound V2 fork lending against tokenized Treasuries; overcollateralized but admin-upgradeable with permissioned liquidations. 2026-11-07 re-review: official security docs date the dedicated Code4rena audit to January 2023, and ONDO governance documents a three-day vote with a one-day timelock plus delegated emergency controls. DeFiLlama reports $43.6M TVL on Ethereum; OUSG liquidations remain permissioned, supporting unchanged sub-scores.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "Avantis, renamed Veranta, is a perp-DEX LP vault where depositors backstop leveraged traders' PnL; upgradeable contracts and trusted keepers add control risk. 2026-11-07 re-review: Guardian's October V2 report covers tranche, vault and trading contracts, with all four critical findings resolved but four high findings acknowledged; DeFiLlama reports $10.6M TVL on Base, and the market-risk and control sub-scores remain unchanged.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "Gearbox is a well-audited leverage/credit-account protocol; the leverage and curator-credit model lifts funds and liquidity risk above plain money markets. 2026-11-07 re-review: the security repository includes ChainSecurity's 2025 V3.1, permissionless and account-migration reports; current curator docs require at least a 24-hour timelock, and DeFiLlama reports $22.1M TVL across 11 listed chains, 92% on Ethereum; sub-scores unchanged.",
  },
  "curve-llamalend": {
    scores: { audits: 3, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Curve LlamaLend combines V1 and V2 lending markets with LLAMMA soft liquidations; complex accounting, collateral-specific oracle risk and impaired legacy markets constrain its venue scores. 2026-11-07 re-review: live Llamalend V2 rewrites the lending contracts, while Curve's developer docs still report no public final audits; audits rises from 2 to 3. DeFiLlama reports $96.1M across four listed chains, and legacy CRV-long withdrawal impairment remains documented.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "Dolomite's audited lending core uses evolving modules; concentrated admin authority, emergency bypasses and broad collateral support keep venue risk medium. 2026-11-07 re-review: core and module audit scopes remain distinct; the issuer's November 2 notice keeps Ethereum borrowing disabled after the Binance incident while deposits, withdrawals and repayments remain available; this does not establish a Dolomite exploit or blocked withdrawals. DeFiLlama reports $142.2M across seven listed chains; sub-scores unchanged.",
  },
  exactly: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Exactly is a multiply-audited fixed+variable-rate lender with timelocked governance; smaller scale and maturity-pool fragmentation keep it at low. 2026-11-07 re-review: the audit repository adds ABDK reviews of 2026 cross-chain EXA, non-collateral markets and flash-loan/oracle adapters; access-control docs retain a 24-hour timelock and 3-of-6 executor. DeFiLlama reports $12.2M across three listed chains, concentrated on Base and Optimism; sub-scores unchanged.",
  },
  "fraxlend-v2": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Fraxlend v2 uses isolated lending pairs; collateral and oracle selection plus pair utilization constrain liquidations and lender exits. 2026-11-07 re-review: the Frax audit index retains the 2022-2023 Fraxlend reports; DeFiLlama records $20.65M across Ethereum, Fraxtal and Arbitrum, versus $20.10M on June 15, and a September IRM proposal remains pair-specific; sub-scores unchanged.",
  },
  "aave-v4": {
    scores: { audits: 1, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Aave v4 combines hub-and-spoke lending with DAO upgrades, delegated stewards and guardian emergency controls; its younger architecture retains operational risk. 2026-11-07 re-review: the security index adds tokenization-spoke verification and a May Sherlock report; DeFiLlama records $809.66M across four chains, versus $119.39M on June 15. The October 29 precautionary reserve freeze was reversed by October 31; the reported exploit position was on V3, and sub-scores remain unchanged.",
  },
  "compound-v2": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Compound v2 is a mature lending venue with two-day-timelock governance; its live legacy Ethereum deployment and older codebase retain operational risk. 2026-11-07 re-review: current V2 docs retain Trail of Bits/OpenZeppelin audits, Certora verification and Governor Bravo's two-day timelock; DeFiLlama records $95.04M on Ethereum versus $92.08M on June 15, and the current app still links V2 markets; sub-scores unchanged.",
  },
  "felix-cdp": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Felix is an audited Liquity-v2 fork on Hyperliquid; youth, single-chain concentration, and HYPE/LST collateral with USDC oracle dependency place it at medium. 2026-11-07 re-review: issuer docs and Dedaub retain upgradeable contracts, a three-day upgrade timelock and admin-controlled temporary shutdown; DeFiLlama CDP TVL is $20.85M on Hyperliquid versus $41.87M on June 15. The existing medium liquidity and operational scores continue to reflect the limited scale and controls; sub-scores unchanged.",
  },
  frankencoin: {
    scores: { audits: 2, centralization: 1, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Frankencoin's immutable, oracle-free core and modular veto governance support its low venue tier; multi-day auctions retain volatile-collateral liquidation risk. 2026-11-07 re-review: issuer docs identify the July ChainSecurity FCS/FPS2 review and a subsequently unified >1% voting quorum; modular veto governance and multi-day auctions remain, with CCIP and voting-snapshot dependencies. DeFiLlama records $59.39M on Ethereum versus $64.20M on June 15; sub-scores unchanged.",
  },
  // App-chain / non-EVM lenders
  "kamino-lend": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Kamino is an audited Solana lender with formal verification; market-level oracle, curator and supplier concentrations remain material. 2026-11-07 re-review: the audit repository includes lending reviews through versions 1.16/1.17; June opsec docs specify 5-of-10 upgrades with a 24-hour delay and a 2-of-7 emergency council without delay. DeFiLlama reports $1.19B on Solana, versus $1.10B on June 15. The issuer reported a precautionary SOL/BTC borrowing pause on October 29 and resumption October 30; sub-scores unchanged.",
  },
  justlend: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "JustLend is a mature Tron lender with a timelocked DAO; concentrated voting power and Tron/USDD ecosystem exposure temper but do not lift it above low. 2026-11-07 re-review: current docs retain the Supply/Borrow audit and document Governor Bravo with a 48-hour timelock, distinguishing the new V2 market surface. DeFiLlama reports $6.58B TVL on Tron versus $3.07B on June 15; concentrated voting and ecosystem exposures still support the existing sub-scores.",
  },
  "benqi-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "BENQI is an established overcollateralized Avalanche lender; multisig upgrades and emergency controls remain residual risks within its low venue tier. 2026-11-07 re-review: official docs separate Halborn lending coverage from staking, Ignite and isolated-market reports, and retain multisig upgrades and emergency pause powers. DeFiLlama lending TVL is $99.5M on Avalanche versus $87.4M on June 15; sub-scores unchanged.",
  },
  "aries-markets": {
    scores: { audits: 3, centralization: 5, fundsManagement: 3, liquidity: 5, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Aries Markets is an Aptos lending and margin venue; limited current admin disclosure and a reduced operating footprint keep venue risk high. 2026-11-07 re-review: the issuer still links its November 2022 OtterSec audit of lending, borrowing and leveraged swaps, without a current signer/timelock disclosure. DeFiLlama reports $71K TVL on Aptos versus $5.67M on June 15 and $55K on August 9; sustained minimal depth raises liquidity from 3 to 5, with partial confidence retained.",
  },
  "scallop-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Scallop is an audited Sui money market with a bug bounty; limited admin disclosure, smaller liquidity and legacy-contract incident history constrain its venue scores. 2026-11-07 re-review: the audit catalog separates lending-core, sCoin and veSCA reports, including Asymptotic alongside Zellic, OtterSec and MoveBit. The issuer reported a 150K SUI sSUI rewards-side-contract exploit on April 26, separate from the lending core; DeFiLlama TVL is $8.98M on Sui versus $15.6M on June 15. Existing sub-scores and partial confidence remain.",
  },
  "echelon-market": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Echelon is a fast-growing Aptos lender with isolated markets and Chainlink oracles; a very young DAO and unitemized audits keep it at medium.",
  },
  "blend-pools-v2": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Blend is an immutable, governance-minimized Stellar lending primitive with backstop insurance; thin-chain liquidity is the main residual risk, keeping it at low.",
  },
  "jupiter-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Jupiter Lend is a deep, well-audited Solana lender but young, with rehypothecation undercutting isolation claims; timelocked admin keeps it at low-medium.",
  },
  "hyperlend-pooled": {
    scores: { audits: 3, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "HyperLend is a well-audited but young Aave-fork on the thin, exploit-prone HyperEVM; admin opacity and kHYPE concentration place it at medium.",
  },
  curvance: {
    scores: { audits: 4, centralization: 4, fundsManagement: 3, liquidity: 4, operational: 4 },
    confidence: "low",
    reviewedAt: "2026-06-15",
    rationale:
      "Curvance is a brand-new Monad lender with tiny TVL and unitemized audits; scored conservatively across the board for lack of track record, placing it high.",
  },
  "sovryn-dex": {
    scores: { audits: 4, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Sovryn is a mature Bitcoin-DeFi lender, but a prior partially-unrecovered lending exploit and thin Rootstock liquidity place it at medium.",
  },
  // ── FU3 Wave 2 venues (yield v8.292, reviewed 2026-06-15) ──────────────────
  truefi: {
    scores: { audits: 3, centralization: 3, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "TrueFi is uncollateralized DeFi credit; trust-based borrower accounting and realized default history put it in the high tier despite a DAO-timelocked admin.",
  },
  "radiant-v2": {
    scores: { audits: 5, centralization: 5, fundsManagement: 4, liquidity: 5, operational: 5 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Radiant Capital suffered a ~$50M unrecovered Oct-2024 exploit and is in wind-down; it scores near-worst across audits, centralization, liquidity, and operational.",
  },
  "wildcat-protocol": {
    scores: { audits: 3, centralization: 2, fundsManagement: 5, liquidity: 5, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    rationale:
      "Wildcat is undercollateralized credit with borrower-defined terms; its low protocol-admin surface is outweighed by maximal funds/liquidity trust risk, placing it high.",
  },
  "gains-network": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Gains Network (gTrade) is a leveraged-perps vault, not a money market; a 14-day timelock and overcollateralization buffer keep it at low-medium.",
  },
  "venus-core-pool": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Venus Core Pool is an established overcollateralized BNB-chain money market; its 2025 $27M incident was user phishing (fully recovered), not a contract flaw — low venue risk.",
  },
  "moonwell-lending": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Moonwell is an overcollateralized multichain Compound-fork; a Mar-2026 governance-attack vector lifts centralization to 3, keeping it at low.",
  },
  "silo-v2": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Silo v2 is overcollateralized isolated-pair lending with immutable per-market silos; permissionless market creation and thin newer markets raise funds/liquidity risk to medium.",
  },
  "sturdy-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Sturdy v2 is an overcollateralized two-tier silo + aggregator design; a v1 hack history, manager trust, and no bad-debt reserves keep it at medium.",
  },
  vesper: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Vesper is a yield aggregator (not a money market) routing into external protocols; composed strategy risk and a 2021 oracle-hack history put it at medium.",
  },
  "convex-finance": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Convex is a Curve LP-boosting / veCRV staking layer (NOT a lending/credit venue); immutable contracts, never exploited, with blue-chip Curve LP underlying — low venue risk.",
  },
  liqwid: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 4, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Liqwid is the mature Cardano lending leader with a no-admin DAO design; thin eUTXO liquidity and LQ-heavy collateral are the main residual risks, keeping it at low.",
  },
  "lista-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Lista Lending is a well-audited Binance-adjacent BNB-chain CDP/isolated lender with a documented timelock and deep liquidity — the lowest-risk venue in the Wave 2 set.",
  },
  loopscale: {
    scores: { audits: 4, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    rationale:
      "Loopscale recovered fully from an Apr-2025 ~$5.8M oracle exploit but remains young, tokenless, and team-controlled with exotic collateral — high tier.",
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
