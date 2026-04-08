import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";

export interface MethodologyContextItem {
  title: string;
  summary: string;
  detail?: string;
  methodologyPath: string;
  versionLabel?: string;
  changelogPath?: string;
}

export type MethodologyContextKey =
  | "psi"
  | "psiSeverity"
  | "psiBreadth"
  | "psiStressBreadth"
  | "psiTrend"
  | "safetyScore"
  | "resilience"
  | "dependencyRisk"
  | "redemptionBackstop"
  | "effectiveExit"
  | "activeDepegs"
  | "coinsAtPeg"
  | "medianDeviation"
  | "worstCurrentDeviation"
  | "pegScore"
  | "dews"
  | "liquidityScore"
  | "effectiveTvl"
  | "pys"
  | "yieldStability"
  | "yieldWarnings"
  | "mintBurnFlows"
  | "pressureShift"
  | "bankRunGauge"
  | "chainHealth"
  | "chainHealthQuality"
  | "chainHealthEnvironment"
  | "chainHealthConcentration"
  | "chainHealthPegStability"
  | "chainHealthBackingDiversity";

export const METHODOLOGY_CONTEXT: Record<MethodologyContextKey, MethodologyContextItem> = {
  psi: {
    title: "PSI",
    summary: "Pharos Stability Index: a 0-100 ecosystem health score combining active depeg damage, breadth, DEWS stress breadth, and market-cap trend.",
    detail: "Higher is calmer. It updates every 30 minutes and maps into condition bands from BEDROCK to MELTDOWN.",
    methodologyPath: "/methodology/#stability-index-methodology",
    versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  },
  psiSeverity: {
    title: "Severity",
    summary: "Magnitude-weighted depeg damage, amplified for large-cap stablecoins that matter systemically.",
    methodologyPath: "/methodology/#stability-index-methodology",
    versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  },
  psiBreadth: {
    title: "Breadth",
    summary: "How widely active depegs are spreading across unique coins, with micro-caps intentionally damped.",
    methodologyPath: "/methodology/#stability-index-methodology",
    versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  },
  psiStressBreadth: {
    title: "Stress Breadth",
    summary: "Early-warning breadth from DEWS stress signals before those coins become full depegs.",
    methodologyPath: "/methodology/#stability-index-methodology",
    versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  },
  psiTrend: {
    title: "Trend",
    summary: "7-day total stablecoin market-cap momentum. It can offset or worsen the depeg penalties in PSI.",
    methodologyPath: "/methodology/#stability-index-methodology",
    versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
    changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  },
  safetyScore: {
    title: "Safety Score",
    summary:
      "Composite grade from exit liquidity, resilience, decentralization, and dependency risk, then adjusted by peg stability.",
    detail:
      "Missing exit data applies a 10% penalty instead of redistributing weight. Overall grade is NR when too few base dimensions are rated.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  resilience: {
    title: "Resilience",
    summary: "Three-factor score for collateral quality, custody model, and blacklist capability.",
    detail: "Chain infrastructure is not scored here. It now lives in Decentralization to avoid double-counting.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  dependencyRisk: {
    title: "Dependency Risk",
    summary: "Models reserve and mechanism exposure to upstream stablecoins rather than treating each coin as fully standalone.",
    detail:
      "Wrapper and mechanism-critical dependencies can ceiling the final score to the upstream asset when that dependency is fundamental.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  redemptionBackstop: {
    title: "Redemption Backstop",
    summary: "Modeled issuer or protocol exit path scored across access, settlement, execution certainty, capacity, output quality, and cost.",
    detail:
      "This is currently documented under the Safety Scores methodology because it feeds the Liquidity / Exit dimension rather than having a standalone public section.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_VERSION_LABEL,
  },
  effectiveExit: {
    title: "Effective Exit",
    summary: "Blended exit score that preserves DEX liquidity as the floor while allowing credible redemption quality to lift the Liquidity / Exit dimension.",
    detail:
      "When both exist, report cards use max(liquidity, liquidity*0.55 + redemption*0.45). Redemption-only paths are capped more conservatively.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_VERSION_LABEL,
  },
  activeDepegs: {
    title: "Active Depegs",
    summary: "Open depeg events that have crossed Pharos thresholds and passed the live confirmation rules.",
    detail: "Large-cap, low-confidence, and extreme moves can require secondary confirmation before they count as live events.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  coinsAtPeg: {
    title: "Coins at Peg",
    summary: "Peg-monitored coins currently inside their peg threshold rather than in an active depeg state.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  medianDeviation: {
    title: "Median Deviation",
    summary: "Median current deviation in basis points across peg-monitored coins, used as a market-noise read rather than a score.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  worstCurrentDeviation: {
    title: "Worst Current",
    summary: "Largest current live deviation among tracked coins, shown in basis points rather than as a normalized score.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  pegScore: {
    title: "Peg Score",
    summary: "Historical 0-100 peg-behavior score built from time-at-peg, event severity, and active-depeg penalties.",
    detail: "Requires at least 30 tracking days. NAV tokens return NR because they are not meant to hold a fixed price.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  dews: {
    title: "DEWS",
    summary: "Forward-looking 0-100 stress score built from up to 8 signals and amplified when system-wide PSI is weak.",
    detail: "It is designed to warn before full depegs, not just describe the current price deviation.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  liquidityScore: {
    title: "Liquidity Score",
    summary: "0-100 DEX liquidity composite built from effective TVL, volume activity, pool quality, durability, and pair diversity.",
    detail:
      "This score stays purely market-based. Safety Scores use a separate exit-liquidity blend that can also incorporate redemption backstops.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  effectiveTvl: {
    title: "Effective TVL",
    summary: "TVL adjusted for mechanism quality, balance health, and pair quality to estimate usable exit depth under stress.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  pys: {
    title: "PYS",
    summary: "Benchmark-aware risk-adjusted yield score that starts from APY, adds a weighted slice of benchmark spread, then discounts by stablecoin safety and yield consistency.",
    detail: "High APY on weak safety still needs an exceptional edge because the safety penalty curve is deliberately steep, while stronger local-currency benchmark outperformance now gets explicit credit.",
    methodologyPath: "/methodology/#yield-intelligence-methodology",
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
  },
  yieldStability: {
    title: "Yield Stability",
    summary: "30-day APY consistency metric. Higher means the yield series is steadier, not necessarily higher.",
    methodologyPath: "/methodology/#yield-intelligence-methodology",
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
  },
  yieldWarnings: {
    title: "Yield Warning Signals",
    summary: "Anomaly flags from the yield pipeline such as spikes, divergence, TVL outflow, negative trend, and reward-heavy behavior.",
    methodologyPath: "/methodology/#yield-intelligence-methodology",
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
  },
  mintBurnFlows: {
    title: "Mint/Burn Flows",
    summary: "Ethereum-only issuance and redemption monitoring that pairs raw net flow with baseline-relative pressure signals.",
    detail: "Current direction and pressure-versus-baseline are related, but they are not the same metric.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  pressureShift: {
    title: "Pressure Shift vs 30D",
    summary: "Signed score comparing current 24h mint/burn pressure against the coin's last 30 fully closed daily baselines.",
    detail: "Positive means stronger-than-normal mint pressure. Negative means stronger-than-normal redemption pressure.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  bankRunGauge: {
    title: "Bank Run Gauge",
    summary: "Market-cap-weighted aggregate of per-coin pressure shift. It measures unusual redemption pressure, not literal net direction.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealth: {
    title: "Chain Health Score",
    summary: "Composite 0-100 score rating a blockchain's stablecoin ecosystem quality across five weighted factors.",
    detail: "Health bands: robust (80-100), healthy (60-79), mixed (40-59), fragile (20-39), concentrated (0-19). Chains with concentrated supply in few assets score lower.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthQuality: {
    title: "Quality",
    summary: "Supply-weighted average of Pharos Safety Scores for stablecoins on this chain.",
    detail: "Requires ≥50% of supply to have safety score coverage. Missing data penalizes the score rather than ignoring it.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthEnvironment: {
    title: "Chain Environment",
    summary: "Infrastructure quality rating based on chain resilience tier.",
    detail: "Tier 1 (e.g., Ethereum) = 100, Tier 2 = 60, Tier 3 = 20. Factors decentralization, uptime history, and economic security.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthConcentration: {
    title: "Concentration",
    summary: "HHI-based metric measuring stablecoin supply diversity on the chain.",
    detail: "100 = perfectly distributed, 0 = single coin dominates. Prevents unhealthy over-concentration in one stablecoin.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthPegStability: {
    title: "Peg Stability",
    summary: "Supply-weighted average of peg proximity for all stablecoins on this chain.",
    detail: "Coins further from their peg drag this score down. Real-time price vs reference peg.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthBackingDiversity: {
    title: "Backing Diversity",
    summary: "Shannon entropy across the active backing split: RWA-backed vs crypto-backed.",
    detail: "Rewards chains with diverse collateral approaches. Concentrated in one backing type scores lower.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
};
