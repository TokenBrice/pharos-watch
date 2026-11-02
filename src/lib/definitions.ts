/**
 * Single source of truth for Pharos term definitions.
 *
 * Every entry carries a short tooltip text (`short`, optional `detail`) and,
 * when it belongs in the A–Z Definitions section of `/methodology/#definitions`,
 * a citation-ready `long` text (`listed: true`). Consumers:
 * - `METHODOLOGY_CONTEXT` (`./methodology-context`) projects entries with a
 *   `methodologyPath` for `MethodologyHint` / `MethodologyLabel` / `<Term>`.
 * - `GLOSSARY` (`./glossary`) projects the DeFi-jargon entries (no
 *   `methodologyPath`) for the `<Term>` popover.
 * - `getListedDefinitions()` feeds the methodology Definitions section, its
 *   DefinedTermSet JSON-LD, and llms.txt.
 *
 * Numbers in definition text are derived from the owning constants wherever a
 * runtime constant exists, so a methodology change cannot leave this copy stale.
 */
import { DEWS_SIGNAL_LABELS, DEWS_THREAT_BANDS } from "@shared/lib/dews-config";
import { DEPEG_PENDING_MIN_AGE_SEC, DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { DEPEG_ARCHIVE_EPOCH_DATE, MIN_DEPEG_PAGE_DEVIATION_BPS } from "@/lib/depeg-event-config";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import { GAUGE_BAND_RANGES } from "@shared/lib/mint-burn-gauge-bands";
import { V9_GRADE_THRESHOLDS, V9_PILLAR_WEIGHTS } from "@shared/types/safety-score-v9-grade";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  MINT_AUTHORITY_METHODOLOGY_PATH,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const NEUTRAL_GAUGE_RANGE = GAUGE_BAND_RANGES.find(({ band }) => band === "NEUTRAL")!;

export interface Definition {
  /** Display label used in tooltips and popovers. */
  label: string;
  /** A–Z heading when it differs from the tooltip label. */
  term?: string;
  /** 1-2 sentence tooltip text. */
  short: string;
  /** Optional second tooltip paragraph. */
  detail?: string;
  /** Citation-ready definition for the A–Z section; falls back to `short`. */
  long?: string;
  /** Listed in the A–Z Definitions section on /methodology/. */
  listed?: true;
  /** Methodology deep link. Present for Pharos metrics, absent for DeFi jargon. */
  methodologyPath?: string;
  versionLabel?: string;
  changelogPath?: string;
  /** Other definition keys worth pairing with this one (listed entries only). */
  seeAlso?: readonly string[];
}

const PSI_PATH = "/methodology/#stability-index-methodology";
const SAFETY_PATH = "/methodology/#safety-scores-methodology";
const PEG_PATH = "/methodology/#pegscore-dews-methodology";
const LIQUIDITY_PATH = "/methodology/#liquidity-methodology";
const MINT_BURN_PATH = "/methodology/#mint-burn-flow-methodology";
const YIELD_PATH = "/methodology/#yield-intelligence-methodology";
const CHAIN_HEALTH_PATH = "/methodology/#chain-health-score";
const DDR_PATH = "/methodology/#depeg-resolver-methodology";
const PRICING_PATH = "/methodology/#pricing-pipeline-methodology";

const PSI = { methodologyPath: PSI_PATH, versionLabel: PSI_METHODOLOGY_VERSION_LABEL, changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH };
const SAFETY = { methodologyPath: SAFETY_PATH, versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL, changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH };
const PEG = { methodologyPath: PEG_PATH, versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH };
const LIQUIDITY = { methodologyPath: LIQUIDITY_PATH, versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL, changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH };
const MINT_BURN = { methodologyPath: MINT_BURN_PATH, versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL, changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH };
const YIELD = { methodologyPath: YIELD_PATH, versionLabel: YIELD_METHODOLOGY_VERSION_LABEL, changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH };
const CHAIN_HEALTH = { methodologyPath: CHAIN_HEALTH_PATH, versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL, changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH };
const DDR = { methodologyPath: DDR_PATH, versionLabel: DDR_METHODOLOGY_VERSION_LABEL, changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH };
const REDEMPTION = {
  methodologyPath: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  versionLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
};

const pct = (weight: number) => `${Math.round(weight * 100)}%`;
const titleCase = (band: string) => band.charAt(0) + band.slice(1).toLowerCase();

const DEWS_BAND_TEXT = DEWS_THREAT_BANDS.map((band, index) =>
  index === DEWS_THREAT_BANDS.length - 1
    ? `${titleCase(band.band)} above ${DEWS_THREAT_BANDS[index - 1]!.upper}`
    : `${titleCase(band.band)} up to ${band.upper}`,
).join("; ");
const PSI_FIRST_BAND = PSI_CONDITION_BANDS[0]!.band;
const PSI_LAST_BAND = PSI_CONDITION_BANDS[PSI_CONDITION_BANDS.length - 1]!.band;
const LIQUIDITY_WEIGHT_TEXT = LIQUIDITY_SCORE_WEIGHTS.map((w) => `${w.label} (${w.displayWeight})`).join(", ");
const TOP_GRADE = V9_GRADE_THRESHOLDS[0]!;
const LOWEST_PASSING_GRADE = V9_GRADE_THRESHOLDS[V9_GRADE_THRESHOLDS.length - 2]!;

export const DEFINITIONS = {
  psi: {
    label: "PSI",
    term: "PSI (Pharos Stability Index)",
    short:
      "Pharos Stability Index: a 0-100 ecosystem health score combining active depeg damage, breadth, DEWS stress breadth, and market-cap trend.",
    detail: "Higher is calmer. It updates every 30 minutes and maps into condition bands from BEDROCK to MELTDOWN.",
    long: `An ecosystem-wide condition score from 0 to 100, recomputed every 30 minutes. It subtracts penalties for active depeg severity, depeg breadth, and DEWS stress breadth, then adds a bounded market-cap trend term. The result maps into ${PSI_CONDITION_BANDS.length} condition bands from ${PSI_FIRST_BAND} to ${PSI_LAST_BAND}. PSI is conservative by design: one small depeg should not move the index, but broad simultaneous stress should.`,
    listed: true,
    seeAlso: ["dews", "depeg"],
    ...PSI,
  },
  psiSeverity: {
    label: "Severity",
    short: "Magnitude-weighted depeg damage, amplified for large-cap stablecoins that matter systemically.",
    ...PSI,
  },
  psiBreadth: {
    label: "Breadth",
    short: "How widely active depegs are spreading across unique coins, with micro-caps intentionally damped.",
    ...PSI,
  },
  psiStressBreadth: {
    label: "Stress Breadth",
    short: "Early-warning breadth from DEWS pre-price and live-market stress signals.",
    ...PSI,
  },
  psiTrend: {
    label: "Trend",
    short: "7-day total stablecoin market-cap momentum. It can offset or worsen the depeg penalties in PSI.",
    ...PSI,
  },
  safetyScore: {
    label: "Safety Score",
    short:
      "Three-pillar assessment of backing, exit quality, and economic control, with peg, deployment, dependency, and policy-limit effects applied explicitly.",
    detail:
      "The published score follows the bounded-headroom pillar aggregate through peg and deployment adjustments, then applies any binding caps. Insufficient required evidence produces NR.",
    long: `Pharos's V10 risk grade for a stablecoin. It evaluates Backing (${pct(V9_PILLAR_WEIGHTS.backing)}), Exit (${pct(V9_PILLAR_WEIGHTS.exit)}), and Economic Control (${pct(V9_PILLAR_WEIGHTS.control)}) with bounded aggregation, so a strong pillar cannot average away a weak material path. Peg behavior, dependencies, wrappers, evidence quality, track record, and structural caps can then only constrain the result. Grades run from ${TOP_GRADE.grade} (${TOP_GRADE.min}+) to F (below ${LOWEST_PASSING_GRADE.min}); NR means required evidence is insufficient.`,
    listed: true,
    seeAlso: ["pegScore", "dependencyRisk", "mintAuthorityScore"],
    // The active Safety Score methodology is identity-based: no inline version chip.
    methodologyPath: SAFETY_PATH,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  controlPosture: {
    label: "Control posture",
    short:
      "A descriptive classification of where operational authority sits. It preserves a legacy metadata field for context and does not enter Safety Score V10.",
    detail: "V10 Economic Control uses reviewed mint, oracle, and bridge evidence instead of this classification.",
    methodologyPath: SAFETY_PATH,
  },
  resilience: {
    label: "Resilience",
    short: "Historical V8 context for collateral quality, custody model, and blacklist capability.",
    detail:
      "V9 replaced this dimension with Backing Quality, Exit Strength, and Economic Control; current scores do not consume the retired Resilience dimension.",
    ...SAFETY,
  },
  freezable: {
    label: "Freezable",
    short:
      "The issuer or protocol admin can freeze, block, seize, or destroy user balances through resolved on-chain controls. This is a trust/centralization risk, not an instant harm.",
    long:
      "A stablecoin is freezable when its issuer or protocol admin can freeze, block, seize, or destroy user balances through resolved on-chain controls. Pharos also distinguishes upstream exposure (a collateral or parent asset can be frozen) and possible exposure (mutable or pause-capable admin surfaces without confirmed address-level freezing). Freezability is a trust and centralization risk, not an instant harm.",
    listed: true,
    seeAlso: ["blacklistTracker"],
    ...SAFETY,
  },
  freezableUpstream: {
    label: "Freezable",
    short:
      "No direct holder freeze is resolved for this stablecoin, but an upstream collateral or parent asset can be frozen. Protocol-held balances may be exposed even when individual holders are not directly blocked.",
    ...SAFETY,
  },
  freezableNo: {
    label: "Freezable",
    short:
      "No direct, upstream, or possible freeze exposure is resolved in the current model. This does not prove the asset is risk-free.",
    ...SAFETY,
  },
  freezablePossible: {
    label: "Freezable",
    short:
      "Mutable, pause-capable, or similar admin surfaces could enable freezing, seizure, or destruction, but active address-level freezing is not confirmed.",
    ...SAFETY,
  },
  dependencyRisk: {
    label: "Dependency Risk",
    short:
      "Models reserve and mechanism exposure to upstream stablecoins rather than treating each coin as fully standalone.",
    detail:
      "Wrapper and mechanism-critical dependencies can ceiling the final score to the upstream asset when that dependency is fundamental.",
    long:
      "How a stablecoin's reserves or mechanism rely on other stablecoins. Dependencies are causal inputs to the Safety Score rather than a standalone score: a serial wrapper cannot score above its parent, and basket exposure is weighted and bounded by reviewed materiality.",
    listed: true,
    seeAlso: ["safetyScore"],
    ...SAFETY,
  },
  redemptionBackstop: {
    label: "Redemption Route",
    term: "Redemption Route Score",
    short:
      "Standalone issuer or protocol route scored across access, settlement, execution certainty, capacity, output quality, and cost.",
    detail:
      "This route score is separate from Safety Score V10 Exit, which re-evaluates exact same-notional route evidence under the V10 policy.",
    long:
      "A standalone score for a stablecoin's issuer or protocol redemption route, rated on access, settlement, execution certainty, capacity, output quality, and cost. It is a diagnostic: the Safety Score Exit pillar separately re-evaluates exact same-notional route evidence under its own policy.",
    listed: true,
    seeAlso: ["safetyScore", "liquidityScore"],
    ...REDEMPTION,
  },
  effectiveExit: {
    label: "Historical Effective Exit",
    short: "Retired pre-V9 blend that compared the best redemption and DEX exit paths.",
    detail:
      "Redemption v4.3 removed this combined score. Current publication keeps standalone route diagnostics while Safety Score V10 evaluates exact same-notional evidence inside its Exit pillar.",
    ...REDEMPTION,
  },
  mintAuthorityScore: {
    label: "Mint Authority Score",
    short: "The Safety Score V10 mint component: how much durable, unbacked supply privileged mint paths can create.",
    detail:
      "Higher is better. Since safety 9.1 mint risk is graded once, inside the V9 Economic Control pillar. The component starts from a derived posture (cap semantics, claim impairment, reconciliation, supervision), then applies resolved-incident age decay, a key-custody penalty that an admitted MPC or HSM attestation under a complete, current control review waives, a multisig quorum ladder, and a small Safe module modifier. Route family is deliberately not priced separately. Missing or unresolved review data stays NR and never implies safety.",
    long:
      "The 0-100 mint component inside the Safety Score's Economic Control pillar: how much durable, unbacked supply privileged mint paths can create. Higher is better. Since methodology v9.1 mint risk is graded once, inside Economic Control; the former standalone score is retired. Missing or unresolved review data stays NR and never implies safety.",
    listed: true,
    seeAlso: ["safetyScore"],
    methodologyPath: MINT_AUTHORITY_METHODOLOGY_PATH,
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  depeg: {
    label: "Depeg",
    short: `A confirmed deviation from peg beyond the detection threshold: ${DEPEG_THRESHOLD_BPS} bps for USD pegs, ${DEPEG_THRESHOLD_BPS_NON_USD} bps for other pegs.`,
    long: `A deviation from peg that crosses the detection threshold (${DEPEG_THRESHOLD_BPS} bps for USD pegs, ${DEPEG_THRESHOLD_BPS_NON_USD} bps for other pegs) and passes multi-source confirmation. Contradictory secondary evidence is treated as contradiction, not weak support. Events from ${DEPEG_ARCHIVE_EPOCH_DATE} onward whose absolute peak deviation is ${MIN_DEPEG_PAGE_DEVIATION_BPS} bps or more, plus pinned earlier incidents, get a dedicated incident page.`,
    listed: true,
    seeAlso: ["depegBps", "dews", "ddr"],
    ...PEG,
  },
  activeDepegs: {
    label: "Active Depegs",
    short: "Open depeg events that have crossed Pharos thresholds and passed the live confirmation rules.",
    detail:
      `Every new depeg must hold for at least ${DEPEG_PENDING_MIN_AGE_SEC / 60} minutes and pass source-trust checks before it counts as live.`,
    ...PEG,
  },
  coinsAtPeg: {
    label: "Coins at Peg",
    short: "Peg-monitored coins currently inside their peg threshold rather than in an active depeg state.",
    ...PEG,
  },
  medianDeviation: {
    label: "Median Deviation",
    short:
      "Median current deviation in basis points across peg-monitored coins, used as a market-noise read rather than a score.",
    ...PEG,
  },
  worstCurrentDeviation: {
    label: "Worst Current",
    short: "Largest current live deviation among tracked coins, shown in basis points rather than as a normalized score.",
    ...PEG,
  },
  pegScore: {
    label: "Peg Score",
    short: "Historical 0-100 peg-behavior score built from time-at-peg, event severity, and active-depeg penalties.",
    detail:
      "Requires at least 7 tracking days. NAV tokens return NR because they are not meant to hold a fixed price.",
    long:
      "A 0-100 score for a stablecoin's historical peg behavior, combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. It needs at least 7 days of tracking. NAV tokens return NR because they are not meant to hold a fixed price. Peg Score enters the Safety Score as a multiplier.",
    listed: true,
    seeAlso: ["depeg", "dews", "safetyScore"],
    ...PEG,
  },
  priceTransparency: {
    label: "Price Transparency",
    short: "The current USD price with its confidence, candidate source depth and, where available, a DEX check.",
    methodologyPath: PRICING_PATH,
  },
  pegStatus: {
    label: "Peg Status",
    short: "Coins currently within peg band ÷ coins with a live peg check. DEWS risk counts shown below.",
    ...PEG,
  },
  dews: {
    label: "DEWS",
    term: "DEWS (Depeg Early Warning System)",
    short:
      "Forward-looking 0-100 stress score built from up to 8 signals and amplified when system-wide PSI is weak.",
    detail: "It is designed to warn before full depegs, not just describe the current price deviation.",
    long: `A forward-looking per-coin stress score from 0 to 100, recomputed every 30 minutes from ${Object.keys(DEWS_SIGNAL_LABELS).length} weighted sub-signals: ${Object.values(DEWS_SIGNAL_LABELS).join(", ")}. Weak PSI and same-peg contagion can amplify the score before it lands in a band. It is a normalized stress score, not a calibrated probability.`,
    listed: true,
    seeAlso: ["dewsBand", "psi", "depeg"],
    ...PEG,
  },
  dewsBand: {
    label: "DEWS Band",
    term: "DEWS bands",
    short:
      "DEWS (Depeg Early Warning System) band. The numeric value is a normalized stress score, not a calibrated probability; the band labels the zone (Calm < Watch < Alert < Warning < Danger).",
    long: `The five DEWS zones, from cool to hot: ${DEWS_BAND_TEXT}. Band names are proper nouns in Pharos copy; lowercase “calm” or “watch” is ordinary English and never names a band.`,
    listed: true,
    seeAlso: ["dews"],
    ...PEG,
  },
  depegBps: {
    label: "Basis-Point Deviation",
    term: "Basis points (bps)",
    short:
      "bps = basis points. 100 bps = 1%. Values are the peak signed deviation from the target peg during the window.",
    long:
      "The unit Pharos uses for peg deviation: 100 basis points (bps) equal 1%. Depeg values are the peak signed deviation from the target peg during the event window.",
    listed: true,
    seeAlso: ["depeg"],
    ...PEG,
  },
  ddr: {
    label: "DDR",
    term: "DDR (Depeg Duration Resolver)",
    short:
      "Depeg Duration Resolver: for each confirmed depeg, a sealed verdict on whether the peg will come back and, if so, a typical recovery window.",
    long:
      "For each confirmed depeg incident, DDR publishes a Resolution Outlook (No break signals, Stress signals, Terminal evidence, or Insufficient Signal) from transparent mechanistic rules and, when recovery is plausible, recovery odds and an Expected Duration band from comparable past depegs, counting those that never recovered. Each incident gets one immutable prediction, sealed at forecast readiness or the 72-hour backstop. Predictions sealed before v5 keep their original Recovery Likely / At Risk / Recovery Unlikely labels. The verdict is a structural read, not a probability or investment advice.",
    listed: true,
    seeAlso: ["ddrr", "depeg"],
    ...DDR,
  },
  ddrr: {
    label: "DDRR",
    term: "DDRR (Depeg Duration Resolver Reviewer)",
    short:
      "Depeg Duration Resolver Reviewer: grades each sealed DDR prediction against the incident's actual outcome, reporting coverage separately from accuracy.",
    long:
      "The audit companion to DDR. It compares each sealed, first-published DDR prediction with the incident's later canonical outcome, and reports coverage (how many incidents received a call) separately from accuracy (recovery-call accuracy against a constant \"will recover\" baseline, duration error, and horizon calibration and skill). Deaths already settled before the lock count as curation debt, not forecast misses. It never re-runs today's resolver over old events.",
    listed: true,
    seeAlso: ["ddr"],
    ...DDR,
  },
  ddrPredictionFrozen: {
    label: "Prediction Frozen",
    short:
      "DDR publishes one immutable verdict per depeg incident, sealed at its public lock. Frozen means this is that sealed call — it is never revised while the event plays out.",
    detail:
      "Live facts (current price, elapsed time) keep updating below the forecast. Keeping the prediction itself fixed is what lets the Reviewer (DDRR) grade it honestly after resolution.",
    ...DDR,
  },
  liquidityScore: {
    label: "DEX Market Liquidity",
    term: "Liquidity Score",
    short:
      "0-100 DEX liquidity composite built from effective TVL, volume activity, pool quality, durability, and pair diversity.",
    detail:
      "This aggregate market score is not a single-route execution test. Safety Score V10 Exit separately evaluates exact same-notional routes and independent backup credit.",
    long: `A 0-100 score for how easily a stablecoin can be exited through DEX markets, combining ${LIQUIDITY_WEIGHT_TEXT}. Thin, stale, or identity-poor pools stay visible for diagnostics but receive no scoring weight. It is an aggregate market score, not a single-route execution test.`,
    listed: true,
    seeAlso: ["effectiveTvl", "redemptionBackstop"],
    ...LIQUIDITY,
  },
  effectiveTvl: {
    label: "Effective TVL",
    short:
      "TVL adjusted for mechanism quality, balance health, and pair quality to estimate usable exit depth under stress.",
    listed: true,
    seeAlso: ["liquidityScore"],
    ...LIQUIDITY,
  },
  dexVolVsAvg: {
    label: "DEX Volume vs 7-Day Average",
    short: "24h DEX volume vs trailing 7-day average.",
    ...LIQUIDITY,
  },
  turnover: {
    label: "Turnover",
    short: "Daily DEX volume ÷ total tracked market cap.",
    ...LIQUIDITY,
  },
  totalStablecoinMcap: {
    label: "Total Stablecoin Market Cap",
    short: "Sum of circulating supply × peg-reference price across all tracked coins. Updates every 15 minutes.",
    methodologyPath: "/methodology/",
  },
  trackedDexVol: {
    label: "Tracked 24h DEX Volume",
    short: "Sum of AMM volume across tracked coins, restricted to the pool set Pharos covers for liquidity scoring.",
    ...LIQUIDITY,
  },
  netMintBurnFlow: {
    label: "Net Mint/Burn Flow",
    short:
      "Net on-chain mint/burn across tracked coins in the last 24h. Positive = expansion, negative = contraction. Excludes atomic round-trips.",
    methodologyPath: MINT_BURN_PATH,
  },
  pys: {
    label: "PYS",
    term: "PYS (Pharos Yield Score)",
    short:
      "Asks one question: is this APY paying enough for the risk you take? Yield per unit of risk, 0-100. Starts from APY, adds a weighted slice of benchmark spread, re-bases the local hurdle onto the USD risk-free rate, then discounts by source risk, stablecoin safety, and yield consistency.",
    detail:
      "Not a recommendation or a safety verdict: a D-grade coin can top PYS because it pays a lot for a lot of risk. Read it next to the Safety grade and the row's zone. Source-risk and safety penalties are deliberately steep, and excess over the local hurdle is scored on a USD footing, so a peg's policy-rate compensation is never credited as yield.",
    long:
      "Yield per unit of risk, from 0 to 100. It starts from APY, adds a weighted slice of benchmark spread, re-bases the local hurdle onto the USD risk-free rate, then discounts by source risk, stablecoin safety, and yield consistency. It is not a recommendation or a safety verdict: a low-grade coin can rank high because it pays a lot for a lot of risk.",
    listed: true,
    seeAlso: ["yieldStability", "safetyScore"],
    ...YIELD,
  },
  excessYield: {
    label: "Excess yield",
    short: "30-day average APY minus its benchmark rate.",
    methodologyPath: YIELD_PATH,
  },
  yieldStability: {
    label: "Yield Stability",
    short:
      "30-day APY consistency metric. Higher means steadier yield, not higher yield. Published at two-decimal precision and reused by the PYS consistency multiplier.",
    detail:
      "Fewer than two observations, a near-zero mean, or non-finite variation make stability and variance unavailable; PYS is NR (null with missing-inputs), not neutral or measured zero. Measured zero variance with a nonzero mean gives stability 1.00 and full consistency credit.",
    ...YIELD,
  },
  yieldWarnings: {
    label: "Yield Warning Signals",
    short:
      "Anomaly flags from the yield pipeline such as spikes, divergence, TVL outflow, negative trend, and reward-heavy behavior, plus read-time freshness flags (data-stale, aging, freshness unknown) and benchmark/reference degradation signals. A row serving a null PYS always carries an explicit reason.",
    ...YIELD,
  },
  mintBurnFlows: {
    label: "Mint/Burn Flows",
    short: "Configured issuance-chain monitoring that pairs raw net flow with baseline-relative pressure signals.",
    detail: "Current direction and pressure-versus-baseline are related, but they are not the same metric.",
    long:
      "Net mint-versus-burn flow on a stablecoin's supported issuance-chain contracts. Transfers are classified into mint, burn, bridge-mint, bridge-burn, atomic round-trip, and ignored noise, so the flow reflects meaningful supply movement rather than mechanical churn. Raw direction and pressure versus the coin's own baseline are related but separate metrics.",
    listed: true,
    seeAlso: ["pressureShift", "bankRunGauge"],
    ...MINT_BURN,
  },
  pressureShift: {
    label: "Pressure Shift vs 30D",
    term: "Pressure Shift",
    short:
      "Signed score comparing current 24h mint/burn pressure against the coin's last 30 fully closed daily baselines.",
    detail:
      "Positive means stronger-than-normal mint pressure. Negative means stronger-than-normal redemption pressure.",
    long:
      "A signed score comparing a stablecoin's current 24-hour mint/burn pressure with its last 30 fully closed daily baselines. Positive means stronger-than-normal mint pressure; negative means stronger-than-normal redemption pressure.",
    listed: true,
    seeAlso: ["mintBurnFlows", "bankRunGauge"],
    ...MINT_BURN,
  },
  bankRunGauge: {
    label: "Bank Run Gauge",
    short:
      "Market-cap-weighted aggregate of per-coin pressure shift. It measures unusual redemption pressure, not literal net direction.",
    long:
      `A market-cap-weighted composite of each tracked stablecoin's Pressure Shift: a signed ${GAUGE_BAND_RANGES[0].min} to +${GAUGE_BAND_RANGES[GAUGE_BAND_RANGES.length - 1].max} signal. Scores below ${NEUTRAL_GAUGE_RANGE.min} indicate worsening redemption pressure; scores ≥ +${NEUTRAL_GAUGE_RANGE.max} indicate improving issuance pressure. It measures unusual redemption pressure, not literal net direction, and is unavailable when data is insufficient.`,
    listed: true,
    seeAlso: ["pressureShift", "mintBurnFlows"],
    ...MINT_BURN,
  },
  chainHealth: {
    label: "Chain Health Score",
    short: "Composite 0-100 score rating a blockchain's stablecoin ecosystem quality across five weighted factors.",
    detail:
      "Health bands: robust (80-100), healthy (60-79), mixed (40-59), fragile (20-39), concentrated (0-19). Chains with concentrated supply in few assets score lower.",
    long:
      "A 0-100 score for the quality of a blockchain's stablecoin ecosystem, weighting five factors: supply-weighted Safety Score quality, chain environment, supply concentration, peg stability, and backing diversity. Chains whose supply is concentrated in few assets score lower.",
    listed: true,
    ...CHAIN_HEALTH,
  },
  chainHealthQuality: {
    label: "Quality",
    short: "Supply-weighted average of Pharos Safety Scores for stablecoins on this chain.",
    detail: "Unrated supply is excluded and the average renormalizes over rated supply. Below 50% rated supply coverage, Quality and the composite are NR; missing scores are not a numeric penalty.",
    ...CHAIN_HEALTH,
  },
  chainHealthEnvironment: {
    label: "Chain Environment",
    short: "Infrastructure quality rating using L2BEAT stage and risk evidence first for matched chains.",
    detail:
      "Matched chains combine L2BEAT stage and sequencer failure, state validation, data availability, exit window, and proposer failure risks. Only unmatched chains fall back to Pharos resilience tiers: Tier 1 = 100, Tier 2 = 60, Tier 3 = 20.",
    ...CHAIN_HEALTH,
  },
  chainHealthConcentration: {
    label: "Concentration",
    short: "HHI-based metric measuring stablecoin supply diversity on the chain.",
    detail: "100 = perfectly distributed, 0 = single coin dominates. Prevents unhealthy over-concentration in one stablecoin.",
    ...CHAIN_HEALTH,
  },
  supplyByChain: {
    label: "Supply by Chain",
    short: "Current circulating supply of this stablecoin on each chain, in USD.",
    methodologyPath: PRICING_PATH,
  },
  chainHealthPegStability: {
    label: "Peg Stability",
    short: "Supply-weighted average of peg proximity for all stablecoins on this chain.",
    detail: "Coins further from their peg drag this score down. Real-time price vs reference peg.",
    ...CHAIN_HEALTH,
  },
  chainHealthBackingDiversity: {
    label: "Backing Diversity",
    short: "Shannon entropy across the active backing split: RWA-backed vs crypto-backed.",
    detail: "Rewards chains with diverse collateral approaches. Concentrated in one backing type scores lower.",
    ...CHAIN_HEALTH,
  },
  blacklistTracker: {
    label: "Blacklist Tracker",
    short:
      "Per-coin record of issuer-led freezes, releases, and destroys, drawn from on-chain freeze-ledger events on supported assets.",
    detail:
      "Centralized stablecoins with admin freeze functions are tracked; events outside the supported asset set are excluded.",
    long:
      "Pharos's record of issuer interventions (freeze, unfreeze, pause, block, destroy) drawn from on-chain freeze-ledger events on supported centralized stablecoin contracts, normalized by chain, action, native amount, and USD amount. Published as FreezeWatch and on each coin's page; events outside the supported asset set are excluded.",
    listed: true,
    seeAlso: ["freezable"],
    methodologyPath: "/methodology/#blacklist-tracker-methodology",
  },
  bluechip: {
    label: "Bluechip Rating",
    term: "Bluechip",
    short:
      "Pharos editorial roster of stablecoins rated A-tier by both the external Bluechip rating and the Pharos Safety Score.",
    long:
      "Pharos's editorial roster of stablecoins that are A-tier in both the external Bluechip reference rating and the Pharos Safety Score. It is an intersection of two current feeds, not an average or a separate floor model: if either input stops clearing A-tier, the asset leaves the roster.",
    listed: true,
    seeAlso: ["safetyScore"],
    methodologyPath: SAFETY_PATH,
  },
  proofOfReserves: {
    label: "Proof of Reserves",
    short:
      "Issuer-published evidence — independent audit, real-time on-chain feed, or self-reported attestation — that circulating supply is matched by reserve assets.",
    detail:
      "Tier reflects attestor quality (Big-4 / regional CPA / niche / self / none) and cadence (daily-NAV / real-time / daily / weekly / monthly / quarterly / semi-annual / annual / ad-hoc).",
    listed: true,
    seeAlso: ["attestation"],
    methodologyPath: SAFETY_PATH,
  },

  // DeFi jargon: no methodology path; rendered by the <Term> popover.
  cdp: {
    label: "CDP (Collateralized Debt Position)",
    short:
      "A vault that mints stablecoins against locked crypto collateral, liquidated if collateral value falls below a threshold.",
    listed: true,
  },
  amo: {
    label: "AMO (Algorithmic Market Operations)",
    short:
      "Smart contracts that programmatically mint or burn stablecoins to manage the peg without direct user redemption.",
    listed: true,
  },
  "basis-trade": {
    label: "Basis Trade",
    short:
      "Capturing the spread between spot and futures, typically by holding spot and shorting perps. Yield = the funding rate paid by perp longs.",
    listed: true,
  },
  "delta-neutral": {
    label: "Delta-Neutral",
    short:
      "A position constructed so small price moves in the underlying don't change its value. Synthetic-dollar stablecoins like USDe use this design.",
    listed: true,
  },
  psm: {
    label: "PSM (Peg Stability Module)",
    short:
      "A protocol module that lets users swap one stablecoin for another at a fixed rate, defending the peg through arbitrage.",
    listed: true,
  },
  attestation: {
    label: "Attestation",
    short:
      "A periodic statement, typically by an audit firm, that the issuer's reserves match circulating supply at a point in time. Weaker than a full audit.",
    listed: true,
  },
  redemption: {
    label: "Redemption",
    short:
      "Exchanging stablecoin tokens for the underlying asset (e.g., 1 USDC -> $1 USD wired to your bank) directly with the issuer.",
    listed: true,
  },
  "yield-bearing": {
    label: "Yield-Bearing Stablecoin",
    short:
      "A stablecoin whose units accrue value over time rather than always trading at the peg. Examples: sUSDe, sUSDS, USDM.",
    listed: true,
  },
  overcollateralization: {
    label: "Overcollateralization",
    short:
      "Holding more collateral than the value of stablecoins issued, so a price drop in collateral doesn't immediately undercollateralize the system.",
    listed: true,
  },
  rwa: {
    label: "RWA (Real-World Asset)",
    short:
      "Off-chain assets — typically U.S. Treasuries, repos, or bank deposits — held as backing for an on-chain stablecoin.",
    listed: true,
  },
  perpetual: {
    label: "Perpetual Future",
    short:
      "A derivatives contract with no expiry, kept aligned to spot via a periodic funding-rate payment between longs and shorts.",
    listed: true,
  },
  custody: {
    label: "Custody",
    short:
      "Who physically holds the backing assets. Institutional custodians (BNY Mellon, BlackRock, Copper, Ceffu) carry different counterparty risk profiles.",
    listed: true,
  },
  "funding-rate": {
    label: "Funding Rate",
    short:
      "Periodic payment between perpetual-futures longs and shorts that keeps the perp price tracking spot. Positive = longs pay shorts.",
    listed: true,
  },
  liquidation: {
    label: "Liquidation",
    short:
      "Forced closure of an overleveraged CDP or perp position when collateral falls below the safety threshold. Common in CDP-backed stablecoins.",
    listed: true,
  },
  bridge: {
    label: "Bridge",
    short:
      "Infrastructure that lets a stablecoin move between chains. Carries smart-contract and validator risk that the issuer often doesn't control.",
    listed: true,
  },
  "money-market-fund": {
    label: "Money-Market Fund (MMF)",
    short:
      "A SEC-registered short-duration fund holding T-bills, repos, and cash. Used as the reserve vehicle for several major fiat-backed stablecoins.",
    listed: true,
  },
  treasury: {
    label: "U.S. Treasury",
    short:
      "Short-dated U.S. government debt — the lowest-credit-risk USD-denominated reserve asset, used as the dominant backing for fiat-pegged stablecoins.",
    listed: true,
  },
  algorithmic: {
    label: "Algorithmic Stablecoin",
    short:
      "A stablecoin that uses on-chain mint/burn rules (not 1:1 backing) to defend its peg. Generally riskier; UST/Terra was the canonical failure.",
    listed: true,
  },
} as const satisfies Record<string, Definition>;

/** One header tooltip for the Peg Score column on every stablecoin table. */
export const PEG_SCORE_HEADER_TITLE = `${DEFINITIONS.pegScore.label}: ${DEFINITIONS.pegScore.short}`;

export type DefinitionKey = keyof typeof DEFINITIONS;

type Defs = typeof DEFINITIONS;
/** Keys of Pharos metric definitions (carry a methodology deep link). */
export type MethodologyDefinitionKey = {
  [K in DefinitionKey]: Defs[K] extends { methodologyPath: string } ? K : never;
}[DefinitionKey];
/** Keys of DeFi-jargon definitions (no methodology deep link). */
export type JargonDefinitionKey = Exclude<DefinitionKey, MethodologyDefinitionKey>;

export const DEFINITIONS_SECTION_ID = "definitions";
export const DEFINITIONS_PATH = `/methodology/#${DEFINITIONS_SECTION_ID}`;

export interface ListedDefinition {
  key: DefinitionKey;
  /** On-page anchor on /methodology/. */
  anchorId: string;
  term: string;
  text: string;
  methodologyPath?: string;
  versionLabel?: string;
  seeAlso: readonly DefinitionKey[];
}

/** `pegScore` -> `def-peg-score`; `basis-trade` -> `def-basis-trade`. */
function definitionAnchorId(key: string): string {
  return `def-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/** Listed definitions sorted A–Z by their display term. */
export function getListedDefinitions(): readonly ListedDefinition[] {
  return (Object.entries(DEFINITIONS) as [DefinitionKey, Definition][])
    .filter(([, def]) => def.listed)
    .map(([key, def]) => ({
      key,
      anchorId: definitionAnchorId(key),
      term: def.term ?? def.label,
      text: def.long ?? def.short,
      methodologyPath: def.methodologyPath,
      versionLabel: def.versionLabel,
      seeAlso: (def.seeAlso ?? []).filter(
        (related): related is DefinitionKey => (DEFINITIONS as Record<string, Definition>)[related]?.listed === true,
      ),
    }))
    .sort((a, b) => a.term.localeCompare(b.term, "en"));
}
