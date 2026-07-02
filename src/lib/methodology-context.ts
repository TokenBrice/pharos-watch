import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  MINT_AUTHORITY_METHODOLOGY_PATH,
  MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

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
  | "freezable"
  | "freezableUpstream"
  | "freezableNo"
  | "freezablePossible"
  | "dependencyRisk"
  | "redemptionBackstop"
  | "effectiveExit"
  | "mintAuthorityScore"
  | "activeDepegs"
  | "coinsAtPeg"
  | "medianDeviation"
  | "worstCurrentDeviation"
  | "pegScore"
  | "pegStatus"
  | "dews"
  | "dewsBand"
  | "depegBps"
  | "ddrPredictionFrozen"
  | "liquidityScore"
  | "effectiveTvl"
  | "dexVolVsAvg"
  | "turnover"
  | "totalStablecoinMcap"
  | "trackedDexVol"
  | "netMintBurnFlow"
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
  | "chainHealthBackingDiversity"
  | "blacklistTracker"
  | "bluechip"
  | "proofOfReserves";

export const METHODOLOGY_CONTEXT: Record<MethodologyContextKey, MethodologyContextItem> = {
  psi: {
    title: "PSI",
    summary:
      "Pharos Stability Index: a 0-100 ecosystem health score combining active depeg damage, breadth, DEWS stress breadth, and market-cap trend.",
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
    summary: "Early-warning breadth from DEWS pre-price and live-market stress signals.",
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
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  resilience: {
    title: "Resilience",
    summary: "Three-factor score for collateral quality, custody model, and blacklist capability.",
    detail: "Chain infrastructure is not scored here. It now lives in Decentralization to avoid double-counting.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  freezable: {
    title: "Freezable",
    summary:
      "The issuer or protocol admin can freeze, block, seize, or destroy user balances through resolved on-chain controls. This is a trust/centralization risk, not an instant harm.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  freezableUpstream: {
    title: "Freezable",
    summary:
      "No direct holder freeze is resolved for this stablecoin, but an upstream collateral or parent asset can be frozen. Protocol-held balances may be exposed even when individual holders are not directly blocked.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  freezableNo: {
    title: "Freezable",
    summary:
      "No direct, upstream, or possible freeze exposure is resolved in the current model. This does not prove the asset is risk-free.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  freezablePossible: {
    title: "Freezable",
    summary:
      "Mutable, pause-capable, or similar admin surfaces could enable freezing, seizure, or destruction, but active address-level freezing is not confirmed.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  dependencyRisk: {
    title: "Dependency Risk",
    summary:
      "Models reserve and mechanism exposure to upstream stablecoins rather than treating each coin as fully standalone.",
    detail:
      "Wrapper and mechanism-critical dependencies can ceiling the final score to the upstream asset when that dependency is fundamental.",
    methodologyPath: "/methodology/#safety-scores-methodology",
    versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  },
  redemptionBackstop: {
    title: "Redemption Backstop",
    summary:
      "Modeled issuer or protocol exit path scored across access, settlement, execution certainty, capacity, output quality, and cost.",
    detail:
      "This is currently documented under the Safety Scores methodology because it feeds the Liquidity / Exit dimension rather than having a standalone public section.",
    methodologyPath: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
    versionLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  },
  effectiveExit: {
    title: "Effective Exit",
    summary:
      "Best-path exit score that preserves the strongest exit path while giving modest credit for a second viable route.",
    detail:
      "The route score is first capped by route family and current capacity, then the effective-exit model applies freshness gates, the model-confidence discount, and the independent-route diversification bonus before comparing against DEX liquidity.",
    methodologyPath: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
    versionLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  },
  mintAuthorityScore: {
    title: "Mint Authority Score",
    summary:
      "Standalone 0-100 score for the risk that privileged routes can create durable, unbacked stablecoin supply.",
    detail:
      "Higher is better. The model scores route type, weakest mint-capable controller, quantitative bounds, and reviewer posture, then applies incident, unbounded, EOA, and confidence caps. Since Safety Score v8.0 it feeds the Decentralization dimension through a penalty-only blend.",
    methodologyPath: MINT_AUTHORITY_METHODOLOGY_PATH,
    versionLabel: MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL,
  },
  activeDepegs: {
    title: "Active Depegs",
    summary: "Open depeg events that have crossed Pharos thresholds and passed the live confirmation rules.",
    detail:
      "Large-cap, low-confidence, and extreme moves can require secondary confirmation before they count as live events.",
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
    summary:
      "Median current deviation in basis points across peg-monitored coins, used as a market-noise read rather than a score.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  worstCurrentDeviation: {
    title: "Worst Current",
    summary:
      "Largest current live deviation among tracked coins, shown in basis points rather than as a normalized score.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  pegScore: {
    title: "Peg Score",
    summary: "Historical 0-100 peg-behavior score built from time-at-peg, event severity, and active-depeg penalties.",
    detail:
      "Requires at least 7 tracking days; 7-30 day scores are marked early. NAV tokens return NR because they are not meant to hold a fixed price.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  pegStatus: {
    title: "Peg Status",
    summary: "Coins currently within peg band ÷ coins with a live peg check. DEWS risk counts shown below.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  dews: {
    title: "DEWS",
    summary:
      "Forward-looking 0-100 stress score built from up to 8 signals and amplified when system-wide PSI is weak.",
    detail: "It is designed to warn before full depegs, not just describe the current price deviation.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  dewsBand: {
    title: "DEWS Band",
    summary:
      "DEWS (Depeg Early Warning System) band. The numeric value is a normalized stress score, not a calibrated probability; the band labels the zone (Calm < Watch < Alert < Warning < Danger).",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  depegBps: {
    title: "Basis-Point Deviation",
    summary:
      "bps = basis points. 100 bps = 1%. Values are the peak signed deviation from the target peg during the window.",
    methodologyPath: "/methodology/#pegscore-dews-methodology",
    versionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  },
  ddrPredictionFrozen: {
    title: "Prediction Frozen",
    summary:
      "DDR publishes one immutable verdict per depeg incident, sealed at its public lock. Frozen means this is that sealed call — it is never revised while the event plays out.",
    detail:
      "Live facts (current price, elapsed time) keep updating below the forecast. Keeping the prediction itself fixed is what lets the Reviewer (DDRR) grade it honestly after resolution.",
    methodologyPath: "/methodology/#depeg-resolver-methodology",
    versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
  },
  liquidityScore: {
    title: "Liquidity Score",
    summary:
      "0-100 DEX liquidity composite built from effective TVL, volume activity, pool quality, durability, and pair diversity.",
    detail:
      "This score stays purely market-based. Safety Scores use a separate exit-liquidity blend that can also incorporate redemption backstops.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  effectiveTvl: {
    title: "Effective TVL",
    summary:
      "TVL adjusted for mechanism quality, balance health, and pair quality to estimate usable exit depth under stress.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  dexVolVsAvg: {
    title: "DEX Volume vs 7-Day Average",
    summary: "24h DEX volume vs trailing 7-day average.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  turnover: {
    title: "Turnover",
    summary: "Daily DEX volume ÷ total tracked market cap.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  totalStablecoinMcap: {
    title: "Total Stablecoin Market Cap",
    summary: "Sum of circulating supply × peg-reference price across all tracked coins. Updates every 15 minutes.",
    methodologyPath: "/methodology/",
  },
  trackedDexVol: {
    title: "Tracked 24h DEX Volume",
    summary: "Sum of AMM volume across tracked coins, restricted to the pool set Pharos covers for liquidity scoring.",
    methodologyPath: "/methodology/#liquidity-methodology",
    versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  },
  netMintBurnFlow: {
    title: "Net Mint/Burn Flow",
    summary:
      "Net on-chain mint/burn across tracked coins in the last 24h. Positive = expansion, negative = contraction. Excludes atomic round-trips.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
  },
  pys: {
    title: "PYS",
    summary:
      "Benchmark-aware risk-adjusted yield score that starts from APY, adds a weighted slice of benchmark spread, then discounts by source risk, stablecoin safety, and yield consistency.",
    detail:
      "High APY on weak safety or thin source evidence still needs an exceptional edge because source-risk and safety penalties are deliberately steep, while stronger local-currency benchmark outperformance now gets explicit credit.",
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
    summary:
      "Anomaly flags from the yield pipeline such as spikes, divergence, TVL outflow, negative trend, and reward-heavy behavior.",
    methodologyPath: "/methodology/#yield-intelligence-methodology",
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
  },
  mintBurnFlows: {
    title: "Mint/Burn Flows",
    summary: "Configured issuance-chain monitoring that pairs raw net flow with baseline-relative pressure signals.",
    detail: "Current direction and pressure-versus-baseline are related, but they are not the same metric.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  pressureShift: {
    title: "Pressure Shift vs 30D",
    summary:
      "Signed score comparing current 24h mint/burn pressure against the coin's last 30 fully closed daily baselines.",
    detail:
      "Positive means stronger-than-normal mint pressure. Negative means stronger-than-normal redemption pressure.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  bankRunGauge: {
    title: "Bank Run Gauge",
    summary:
      "Market-cap-weighted aggregate of per-coin pressure shift. It measures unusual redemption pressure, not literal net direction.",
    methodologyPath: "/methodology/#mint-burn-flow-methodology",
    versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealth: {
    title: "Chain Health Score",
    summary: "Composite 0-100 score rating a blockchain's stablecoin ecosystem quality across five weighted factors.",
    detail:
      "Health bands: robust (80-100), healthy (60-79), mixed (40-59), fragile (20-39), concentrated (0-19). Chains with concentrated supply in few assets score lower.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthQuality: {
    title: "Quality",
    summary: "Supply-weighted average of Pharos Safety Scores for stablecoins on this chain.",
    detail:
      "Requires ≥50% of supply to have safety score coverage. Missing data penalizes the score rather than ignoring it.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthEnvironment: {
    title: "Chain Environment",
    summary: "Infrastructure quality rating based on chain resilience tier.",
    detail:
      "Tier 1 (e.g., Ethereum) = 100, Tier 2 = 60, Tier 3 = 20. Factors decentralization, uptime history, and economic security.",
    methodologyPath: "/methodology/#chain-health-score",
    versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
    changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  },
  chainHealthConcentration: {
    title: "Concentration",
    summary: "HHI-based metric measuring stablecoin supply diversity on the chain.",
    detail:
      "100 = perfectly distributed, 0 = single coin dominates. Prevents unhealthy over-concentration in one stablecoin.",
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
  blacklistTracker: {
    title: "Blacklist Tracker",
    summary:
      "Per-coin record of issuer-led freezes, releases, and destroys, drawn from on-chain freeze-ledger events on supported assets.",
    detail:
      "Centralized stablecoins with admin freeze functions are tracked; events outside the supported asset set are excluded.",
    methodologyPath: "/methodology/#blacklist-tracker",
  },
  bluechip: {
    title: "Bluechip Rating",
    summary:
      "Top-tier classification for stablecoins meeting Pharos's strictest safety, liquidity, and resilience thresholds.",
    methodologyPath: "/methodology/#bluechip",
  },
  proofOfReserves: {
    title: "Proof of Reserves",
    summary:
      "Issuer-published evidence — independent audit, real-time on-chain feed, or self-reported attestation — that circulating supply is matched by reserve assets.",
    detail:
      "Tier reflects attestor quality (Big-4 / regional CPA / niche / self / none) and cadence (daily-NAV / real-time / daily / weekly / monthly / quarterly / semi-annual / annual / ad-hoc).",
    methodologyPath: "/methodology/#proof-of-reserves",
  },
};
