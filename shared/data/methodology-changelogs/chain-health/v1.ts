import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const CHAIN_HEALTH_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.5",
    title: "Not-rated supply excluded from chain quality",
    date: "2026-08-10",
    effectiveAt: 1786320000,
    summary:
      "Chain Health quality now averages Safety Scores over rated supply only instead of imputing a 40 for not-rated supply, and the peg-stability factor derives deviation from the shared depeg-signal primitive rather than a local formula copy.",
    impact: [
      "Not-rated supply is excluded from both the numerator and the denominator of the `quality` factor; the 50% rated-supply coverage gate is now the only not-rated mechanism, and below it the whole composite stays `null`",
      "Removed the implicit `40` (the D-grade threshold) previously assigned to unrated coins, an imputed risk judgement Pharos had not made",
      "5 of 105 published chains move: manta 71 → 88, stacks 82 → 90, megaeth 50 → 54, metis 87 → 89, cardano 71 → 72 quality; health scores move by at most 5 points and no chain changes health band",
      "Peg stability now calls the shared `deriveDepegSignal(...)` used by the depeg pipeline; the derivation is numerically identical (unrounded bps) and no chain's `pegStability` changed",
      "Non-positive or non-finite prices now score neutral `50` like a missing price instead of scoring `0` or poisoning the chain average with `NaN`",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.4",
    title: "L2BEAT chain-risk environment scoring",
    date: "2026-06-12",
    effectiveAt: 1781222400,
    summary:
      "Matched L2BEAT scaling projects now score the Chain Environment factor from a static L2BEAT stage and risk snapshot before falling back to the legacy Pharos tier model for unmatched chains.",
    impact: [
      "Added explicit Pharos chain ID to L2BEAT project aliases and a static L2BEAT snapshot sourced from the scaling summary API",
      "Matched chains derive Chain Environment from L2BEAT stage plus Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure risk sentiments",
      "Unmatched chains continue to use the existing tier mapping: tier 1 = 100, tier 2 = 60, tier 3 = 20",
      "Safety Score chainTier and deploymentModel gain L2BEAT audit helpers only; live Safety Score outputs are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.3",
    title: "Active-only inputs and stale report-card dependency",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "Live Chain Health now uses the same active/non-archived input universe as the daily chain-supply snapshot and degrades its report-card dependency when cached Safety Scores were computed with stale report-card inputs.",
    impact: [
      "`GET /api/chains` excludes frozen, defunct, and non-active stablecoins before deriving peg rates or aggregating chain supply",
      "The report-card dependency now reports `degraded` when `report_card_cache.degradedInputs.inputsStale` is true, instead of marking stale-input scores as fresh",
      "Health scores can remain computed from the cached score map, but response freshness and headers now surface the degraded upstream report-card condition",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.2",
    title: "Two-bucket backing diversity after active taxonomy cleanup",
    date: "2026-04-07",
    effectiveAt: 1775520000,
    summary:
      "Removed the standalone algorithmic bucket from the active backing taxonomy after reclassifying the remaining reserve-backed cases. Chain Health backing diversity now measures only the live RWA-backed vs crypto-backed split.",
    impact: [
      "Reclassified FPI, cUSD, and CEUR out of the legacy algorithmic bucket based on their reserve backing",
      "Active backing filters and taxonomy pages now expose only RWA-backed and crypto-backed cohorts",
      "Backing diversity now normalizes across the two active backing types, so an even RWA/crypto split scores 100",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.1",
    title: "Chain environment factor and weight rebalance",
    date: "2026-03-16",
    effectiveAt: 1773619201,
    summary:
      "Added a fifth health factor, Chain Environment, which rates chain infrastructure quality via a resilience tier system. Rebalanced weights to reduce backing diversity influence and give chain quality 20% of the composite.",
    impact: [
      "New Chain Environment factor (20% weight): tier 1 = 100 (Ethereum), tier 2 = 60 (default), tier 3 = 20 (PulseChain, Harmony, etc.)",
      "Backing diversity weight reduced from 15% to 10%",
      "Quality weight reduced from 35% to 30%",
      "Concentration weight reduced from 25% to 20%",
      "Peg stability weight reduced from 25% to 20%",
      "Chains with poor infrastructure penalized: e.g. PulseChain dropped from #1 healthiest to mid-table",
    ],
    commits: ["f6978ec"],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial Chain Health Score release",
    date: "2026-03-16",
    effectiveAt: 1773619200,
    summary:
      "Launched per-chain health scoring with four factors: quality (35%), concentration (25%), peg stability (25%), and backing diversity (15%). Exposed via /api/chains and the /chains/ leaderboard.",
    impact: [
      "Introduced chain health score as a 0-100 composite across four factors",
      "Quality: supply-weighted average of Pharos Safety Scores (null if < 50% coverage)",
      "Concentration: HHI-based metric rewarding stablecoin diversity",
      "Peg stability: supply-weighted peg proximity across all chain stablecoins",
      "Backing diversity: Shannon entropy across the backing taxonomy active at the time",
      "Health bands: robust (80-100), healthy (60-79), mixed (40-59), fragile (20-39), concentrated (0-19)",
      "Added /api/chains endpoint, /chains/ leaderboard page, and /chains/[chain]/ detail pages",
    ],
    commits: ["003eafd"],
    reconstructed: true,
  },
];
