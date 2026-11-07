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
    reviewedAt: "2026-06-15",
    rationale:
      "Flux Finance is a Compound V2 fork lending against tokenized Treasuries; overcollateralized but admin-upgradeable with permissioned liquidations.",
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
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-11-07",
    rationale:
      "Fluid's shared liquidity layer combines cross-module, collateral-oracle and withdrawal-limit risk. 2026-11-07 re-review: current calls confirm a one-day timelock, 6-of-12 guardian and single capped-rate sUSDai/USDC oracle source; Yearn's September 29 report identifies about $214M debt behind USDai peg assumptions. Short-delay controls, issuer-dependent collateral valuation and bounded exits raise centralization, funds management and liquidity to 3. Current audits include Sui components; DeFiLlama reports $618.5M lending TVL across six chains, including a $47 Sui deployment.",
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
