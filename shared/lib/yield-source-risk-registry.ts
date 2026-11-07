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
    reviewedAt: "2026-11-07",
    rationale:
      "SparkLend is an Aave V3 fork operated by the Sky (formerly MakerDAO) ecosystem; it inherits the upstream Aave V3 audit surface, runs significant TVL, and is governed through the Sky framework. 2026-11-07 re-review: the core repository retains eight upstream reports plus ChainSecurity's Spark-specific review; DeFiLlama reports $5.03B TVL, almost entirely on Ethereum, with residual balances on the September-deprecated, withdraw-only Gnosis deployment. Spark's August removal of its Risk Council leaves facilitator review, SPK voting and Sky spell execution; sub-scores unchanged.",
  },
  "spark-savings": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Spark Savings wrappers inherit Sky governance, issuer-level rate setting, and Spark operational controls; the family includes distinct savings, lending and liquidity-layer mechanisms. 2026-11-07 re-review: Spark lists Cantina and ChainSecurity reports for Vaults V2 and sUSDS, and DeFiLlama reports $1.25B across eight chains. V1 sUSDC is legacy, V2 uses approved strategies, and stUSDS backs SKY-collateralized borrowing; these are distinct from the plain Sky savings rate. Sub-scores unchanged.",
  },
  maple: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Maple is an institutional credit venue whose lender pools depend on delegate underwriting, borrower performance, and loan recovery mechanics. 2026-11-07 re-review: Maple lists September Sherlock and October Cantina audits for its November shared-strategy release; its trust assumptions retain delegate-controlled redemptions and discretionary loss recognition despite Governor timelocks. DeFiLlama reports $2.36B TVL including published borrower collateral, separately from $1.80B outstanding loans; sub-scores unchanged.",
  },
  yearn: {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Yearn is a mature strategy-vault venue with long production history and repeated audits; vault strategy risk remains, but the reviewed stablecoin vault surface is operationally established. 2026-11-07 re-review: the security repository includes June 2026 V3.1 vault and TokenizedStrategy reports; October's yvUSDC report documents a 6-of-9 ySafe and seven-day strategy-addition timelock. DeFiLlama reports $148.9M across seven chains; shared venue sub-scores unchanged.",
  },
  "yearn-finance": {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Yearn Finance maps to the same mature strategy-vault family as Yearn. 2026-11-07 re-review: the security repository includes June 2026 V3.1 vault and TokenizedStrategy reports; October's yvUSDC report documents a 6-of-9 ySafe and seven-day strategy-addition timelock. DeFiLlama reports $148.9M across seven chains; both venue aliases retain the shared sub-scores.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "3Jane makes unsecured credit decisions against offchain financial evidence with legal recovery; anonymous multisig control and offchain underwriting retain substantial venue risk despite dedicated audits. 2026-11-07 re-review: official audits add Guardian LCC reviews dated August 27 and October 27; Yearn's September 5 review distinguishes seven-day upgrades from 24-hour configuration changes and records summer reserve compression. DeFiLlama reports $11.11M idle TVL separately from $103.89M active loans on Ethereum; sub-scores unchanged.",
  },
  centrifuge: {
    scores: { audits: 1, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Centrifuge's RWA tokenization exposes lenders to offchain asset performance and redemption/epoch gating. 2026-11-07 re-review: V3.3 has July-September BurraSec and Sherlock reviews plus core formal verification; guardian privilege escalation retains a 48-hour timelock and separate protocol/operations Safes. The issuer's September 29 FAQ still describes CP172 restructuring as proposed. DeFiLlama reports $669.77M RWA active AUM and fees across six chains, without a current TVL series; sub-scores unchanged.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "Cap routes stablecoin reserves into restaking-backed institutional credit; reserve accounting includes operator principal rather than entirely liquid assets. 2026-11-07 re-review: the repository adds September's Octane upgrade audit; one-day timelocked multisig administration retains direct risk powers outside the delay. October's Yearn report records a new 3-of-6 cancellation Safe and 24.8% of USDC reserves outside operator principal. DeFiLlama's $183.1M Ethereum TVL includes restaker collateral, not just redemption liquidity; sub-scores unchanged.",
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
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Fluid's shared liquidity layer combines cross-module, collateral-oracle and withdrawal-limit risk. 2026-11-07 re-review: current calls confirm a one-day timelock, 6-of-12 guardian and single capped-rate sUSDai/USDC oracle source; Yearn's September 29 report identifies about $214M debt behind USDai peg assumptions. Short-delay controls, issuer-dependent collateral valuation and bounded exits raise centralization, funds management and liquidity to 3. Current audits include Sui components; DeFiLlama reports $618.5M lending TVL across six chains, including a $47 Sui deployment.",
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
    reviewedAt: "2026-11-07",
    rationale:
      "NAVI is an overcollateralized Sui lender with independent Move audits and capability-controlled pause, reserve and risk parameters. 2026-11-07 re-review: the audit index includes 2026 MoveBit and Veridise E-Mode reviews and MoveBit's Pyth Pro oracle review; published code retains OwnerCap controls, and DeFiLlama reports $126.8M TVL on Sui. The issuer status archive reports no August-October incidents; sub-scores unchanged.",
  },
  "zest-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Zest V2 is a Stacks overcollateralized lending market with multisig control, thin single-chain liquidity and a prior V1 exploit. 2026-11-07 re-review: V2 docs list Clarity Alliance and Greybeard reviews, a one-day proposal delay with an urgent bypass and seven-day implementation updates; token-holder governance remains planned. DeFiLlama reports $44.4M TVL on Stacks. September's Bitcoin Collateral Vault audit covers a separate Ethereum demo; sub-scores and partial confidence remain.",
  },
  resupply: {
    scores: { audits: 4, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Resupply's June 2025 oracle exploit and its use of other lending protocols' collateral receipts retain contract and composability risk after recovery. 2026-11-07 re-review: the official repository publishes eight reports covering the core, inflation fixes, savings reUSD and CurveLend operators; DeFiLlama reports $47.87M TVL on Ethereum. The post-exploit review record does not remove the prior oracle failure or external-market exposure, so sub-scores are unchanged.",
  },
  termmax: {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "TermMax uses fixed-term isolated markets, curator-managed vaults and documented 4-of-6 administrative control. 2026-11-07 re-review: the official repository lists four ABDK reports and a March 2025 Cantina competition; docs retain a one-day default vault timelock. Reported TVL is about $687K, but October's $25.78M USPC collateral reduction coincided with almost unchanged $21.05M active loans. The TVL decline does not establish a proportionate change in lending or exit liquidity; sub-scores remain and confidence is partial pending collateral reconciliation.",
  },
  upshift: {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Upshift combines curator-directed DeFi and institutional-credit strategies with operator-reported NAV and queued redemptions. 2026-11-07 re-review: official docs list 11 audits through April 2026, generally 4-of-6 ProxyAdmin control and timelocks on selected parameters; upgrades and owner emergency asset transfers remain untimelocked. DeFiLlama reports $460.65M TVL across 15 listed chains, 12 with nonzero balances. These controls retain substantial centralization and counterparty risk; sub-scores unchanged.",
  },
  tectonic: {
    scores: { audits: 4, centralization: 3, fundsManagement: 4, liquidity: 4, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "Tectonic is a Compound-derived Cronos lender whose August 2026 TONIC collateral manipulation drained markets and prompted a network halt and rollback. 2026-11-07 re-review: Bitquery's archived-chain reconstruction measures about $120.4M gross market outflows before the rollback; this is not the final net loss. DeFiLlama now reports $18.15M TVL on Cronos versus $121.58M before the attack. The realized valuation failure and liquidity contraction raise audits, funds management, liquidity and operational risk; admin and remediation evidence remains partial.",
  },
  "openeden-usdo": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "OpenEden USDO is a centrally issued Treasury-backed yield venue with offchain reserve dependency, issuer blocklisting and eligibility-gated primary redemptions. 2026-11-07 re-review: ChainSecurity publishes September 2024 USDO and March 2025 Express reviews; instant redemptions remain liquidity-bounded and manual exits take up to two business days. DeFiLlama reports $12.72M RWA active AUM, while its API has no current TVL series; these distinct measures do not establish a change to the sub-scores.",
  },
  // Venue reviews from the November 2026 coverage-audit queue.
  "sky-lending": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 3, operational: 2 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Sky Lending combines audited sDAI/sUSDS savings modules with stUSDS risk capital for SKY-backed borrowing. Delayed SKY governance and repeated module reviews reduce control and contract risk, while upgrades, appointed rate setters, governance slashing, endogenous-collateral bad debt and utilization-dependent withdrawals keep the family in the medium venue tier. This review covers the broader family rather than treating stUSDS as equivalent to savings.",
  },
  "ethena": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 2 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Ethena USDe/sUSDe has repeated minting and staking audits and a live bug bounty. Centralized hedge execution, OES/exchange counterparties and a backing mix that now includes DeFi, institutional lending and RWA exposure remain material; multisig/admin powers, whitelisted direct redemption and adjustable sUSDe cooldowns keep the current ethena and ethena-usde attribution paths in the medium venue tier. This product review does not equate standalone USDtb, tsUSDe, Ethena Pay or whitelabel venues.",
  },
  "ondo-yield-assets": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Ondo combines audited RWA contracts with issuer-controlled minting, pricing, freezes and eligibility. OUSG holds several offchain-managed funds, while USDY now spans legacy LLC obligations and Ondo Global Markets issuance; capped instant exits, issuer-dependent settlement and recent migrations support a medium venue assessment.",
  },
  "ethena-usde": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 2 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Ethena USDe/sUSDe has repeated minting and staking audits and a live bug bounty. Centralized hedge execution, OES/exchange counterparties and a backing mix that now includes DeFi, institutional lending and RWA exposure remain material; multisig/admin powers, whitelisted direct redemption and adjustable sUSDe cooldowns keep the current ethena and ethena-usde attribution paths in the medium venue tier. This product review does not equate standalone USDtb, tsUSDe, Ethena Pay or whitelabel venues.",
  },
  "justlend-v1": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: JustLend V1 is the established Compound-V2-style jToken lending market, governed through a documented 48-hour timelock. CertiK reviewed the lending code; pooled collateral, oracle dependencies and cash-dependent withdrawals remain. V1 continues alongside V2, while individual legacy markets and the announced USD1 offboarding require separate eligibility checks.",
  },
  "usual-usd0": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: The active bUSD0 source locks RWA-backed USD0 until June 2028, with early par exit requiring a separate redemption-right token. Repeated audits and 8-of-15 admin Safes support the contract/control assessment, while RWA custody, adjustable exit terms and the January 2025 redemption episode keep venue risk medium under the five-category methodology.",
  },
  "usd-ai": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: The active sUSDai vault earns from GPU-backed credit and idle USDai reserves. Core audit coverage and the canonical 3-of-3 Safe with a 48-hour upgrade timelock reduce contract/control risk, while offchain escrow and enforcement, physical collateral and cash-limited 30-day redemption cycles remain material. Base USDai's liquid PYUSD backing does not make the sUSDai investment instantly redeemable.",
  },
  "invesco-ustb": {
    scores: { audits: 2, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: USTB is Invesco's short-duration Treasury fund on Superstate's upgradeable, permissioned token infrastructure. Public token and redemption audits support technical assurance, while centralized administration, offchain custody and NAV, liquidity-dependent USDC exits, and 2026 manager and infrastructure changes retain medium venue risk.",
  },
  "pareto-credit": {
    scores: { audits: 2, centralization: 3, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Pareto Credit lends directly to individual institutional borrowers through manager-operated credit vaults. Repeated scoped audits and published governance roles mitigate contract and administration risk, while borrower default exposure and epoch-based repayment determine principal recovery and withdrawals. Live administrator thresholds and borrower recovery terms were not independently reconciled.",
  },
  "avant": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Avant is the local attribution key for the same avUSD/savUSD senior savings venue reviewed under avant-avusd. Avant USD is an actively managed strategy venue with team-controlled minting and MPC custody. Independent contract reviews, transaction policies and a junior loss buffer mitigate some exposure, while leveraged arbitrage, external protocols and private liquidity deals retain strategy and counterparty risk. savUSD unstaking and base-token redemption have separate waiting periods; live admin thresholds, allocation limits and buffer sufficiency were not independently verified.",
  },
  "reservoir-protocol": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Reservoir allocates stablecoin reserves across governed external asset adapters and exposes savings holders to strategy, counterparty and available-PSM-liquidity risk. Halborn reviews and contract solvency checks provide controls, but managers can change ratio thresholds and asset destinations, while older legal disclosures describe unsecured fund exposure. Live role holders, reserve allocation and cross-chain audit coverage remain unverified.",
  },
  "avant-avusd": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Avant USD is an actively managed strategy venue with team-controlled minting and MPC custody. Independent contract reviews, transaction policies and a junior loss buffer mitigate some exposure, while leveraged arbitrage, external protocols and private liquidity deals retain strategy and counterparty risk. savUSD unstaking and base-token redemption have separate waiting periods; live admin thresholds, allocation limits and buffer sufficiency were not independently verified.",
  },
  "noon-capital": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Noon combines governed DeFi and off-chain reserve strategies, including private credit and leveraged yield. Repeated scoped audits, multisig administration and documented timelocks mitigate contract and control risk. Seven-day unstaking, verified-user direct redemption and a confidential liquidity arrangement for private credit leave material exit and counterparty dependence; live controls and redemption capacity were not independently verified.",
  },
  "zerobase-cedefi": {
    scores: { audits: 3, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: ZEROBASE uses custodial hedge-fund strategies with privileged vault fund movement and liquidity-dependent exits. Published 2024 audits cover the vault code; current implementation matching and a complete operating history remain incomplete.",
  },
  "falcon-finance": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Falcon combines exchange and off-exchange trading with team-run custody and a KYC-gated seven-day redemption process. Its contract audit trail is documented; token-holder governance remains pending and strategy/custody execution remains centralized.",
  },
  "yuzu-money": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Yuzu Alpha deploys stablecoin backing into leveraged curated strategies under team-managed MPC controls. Senior wrapper unstaking is liquid, while underlying redemption is screened and delayed. Published contract reviews do not validate portfolio choices or establish complete current control and operating evidence.",
  },
  "inverse-finance-firm": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: FiRM and sDOLA have independent audit coverage and segregated collateral custody; sDOLA principal is not lent out and can be unwrapped to DOLA without a waiting period. Governor Mills and working-group multisigs still control parameters, supply operations, and emergency actions, and an executed January 2026 proposal introduced discretionary oracle switching with an initial zero delay. DOLA backing, integrated collateral and oracle dependencies, the predecessor lending venue's 2022 losses, and subsequent market and bridge shutdowns support a medium venue tier.",
  },
  "bitwise-uscc": {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: USCC combines Superstate's audited but centrally administered share-token infrastructure with Bitwise-managed crypto basis trades, staking and futures-venue exposure. Offchain custody, margin and valuation dependencies, plus T+1/T+2 redemptions, support medium venue risk above the simpler Treasury-only USTB fund.",
  },
  "liquity-v2": {
    scores: { audits: 2, centralization: 1, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Liquity V2 has immutable core contracts, multiple independent audits and formal verification. Stability Pool deposits absorb liquidated debt in exchange for ETH or liquid-staking collateral, retaining oracle and collateral-loss exposure. The February 2025 Stability Pool issue required a patched May 2025 redeployment; deposits have no contractual lock, but liquidation proceeds are in-kind. DeFiLlama reports $87.2M protocol TVL on Ethereum.",
  },
  "crvusd": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: the published scrvUSD source uses an audited Yearn V3 vault holding idle crvUSD without lending deposited assets. Borrower fees fund rewards and native Ethereum redemptions have no lock. Curve governance controls the fee distribution, while crvUSD retains collateral, oracle and LLAMMA liquidation risk. ChainSecurity reviewed scrvUSD in December 2024; current role-holder verification remains incomplete.",
  },
  "yo-protocol": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: YO's EVM vaults have several independent audit scopes, and its V2 framework constrains allocations through immutable adapters, allowlisted routes, timelocked approval limits and a 4-of-6 multisig with a 48-hour upgrade delay. The team still selects integrations and runs allocation operations; exits can require unwinding positions. A January 2026 harvesting error created a $3.7M shortfall and temporarily paused yoUSD; YO reports full treasury reimbursement that day. Strategy dependencies, execution risk and conditional withdrawal liquidity support a medium venue tier despite the controls.",
  },
  "liquity-v1": {
    scores: { audits: 1, centralization: 1, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: Liquity V1 has immutable contracts without admin keys, two Trail of Bits reviews and a Coinspect audit. Stability Pool depositors exchange LUSD for liquidated ETH, retaining flash-crash and oracle exposure. Withdrawals have no lock but stop while liquidatable troves remain. V1 continues alongside V2; DeFiLlama reports $156.5M protocol TVL on Ethereum.",
  },
  "origin-dollar": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-11-07",
    rationale:
      "2026-11-07 review: OUSD routes USDC through Morpho on Ethereum, Base and Hyperliquid plus a Curve liquidity strategy. Yearn manages allocations within Origin's limits; current rebalancing is manual. Governance upgrades have a two-day timelock, but two-signature guardians can rebalance and pause capital. Redemptions take ten minutes to 24 hours and depend on strategy liquidity. Repeated audits follow the $7M November 2020 exploit; current cross-chain audit-scope verification remains incomplete.",
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
  // Issuer-wrapper identities resolve against the independent venue reviews
  // above; protocols without a review retain an unknown tier.
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
  // The former near-total Sky allocation has diversified; retain its identity
  // as the largest ecosystem without a concentration penalty.
  "yvusdc-yearn": {
    ecosystem: "Sky",
    severity: "low",
    note: "Sky remains the largest funded ecosystem but no longer dominates the vault. 2026-11-07 re-review: Yearn's API reports about $18.38M funded debt split 34.7% Sky, 33.0% Cap-backed Pawn Broker and 32.3% Yearn-curated Morpho. October's risk report identifies the Pawn Broker's exclusion from the default withdrawal queue and a seven-day debt-call repayment window; the former near-total Sky concentration no longer applies.",
    reviewedAt: "2026-11-07",
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
  // Maple-managed delegate/strategy concentration is already priced by the venue
  // score; keep it informational rather than charging the same exposure twice.
  "syrupusdc-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDC depends on Maple-managed delegates for underwriting, allocations and redemption processing; the medium maple venue tier already prices that control. 2026-11-07 re-review: Maple's shared-strategy documentation adds Strategy Delegates and an Operational Admin alongside Pool Delegates, with discretionary impairment and redemption processing. Concentration remains informational without an added penalty.",
    reviewedAt: "2026-11-07",
  },
  "syrupusdt-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDT shares Maple-managed delegate, underwriting and redemption infrastructure with syrupUSDC; the medium maple venue tier already prices that control. 2026-11-07 re-review: shared strategies add Strategy Delegates and an Operational Admin, while Pool Delegates retain redemption discretion. Separate loan books do not diversify Maple's operational control; concentration remains informational without an added penalty.",
    reviewedAt: "2026-11-07",
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
