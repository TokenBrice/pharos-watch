import { createMethodologyVersion } from "./methodology-version";

const chainHealth = createMethodologyVersion({
  currentVersion: "1.2",
  changelogPath: "/methodology/chain-health-changelog/",
  changelog: [
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
        "Added a fifth health factor — Chain Environment — that rates chain infrastructure quality via a resilience tier system. Rebalanced weights to reduce backing diversity influence and give chain quality 20% of the composite.",
      impact: [
        "New Chain Environment factor (20% weight): tier 1 = 100 (Ethereum), tier 2 = 60 (default), tier 3 = 20 (PulseChain, Harmony, etc.)",
        "Backing diversity weight reduced from 15% to 10%",
        "Quality weight reduced from 35% to 30%",
        "Concentration weight reduced from 25% to 20%",
        "Peg stability weight reduced from 25% to 20%",
        "Chains with poor infrastructure penalized — e.g. PulseChain dropped from #1 healthiest to mid-table",
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
        "Introduced chain health score as a 0–100 composite across four factors",
        "Quality: supply-weighted average of Pharos Safety Scores (null if < 50% coverage)",
        "Concentration: HHI-based metric rewarding stablecoin diversity",
        "Peg stability: supply-weighted peg proximity across all chain stablecoins",
        "Backing diversity: Shannon entropy across the backing taxonomy active at the time",
        "Health bands: robust (80–100), healthy (60–79), mixed (40–59), fragile (20–39), concentrated (0–19)",
        "Added /api/chains endpoint, /chains/ leaderboard page, and /chains/[chain]/ detail pages",
      ],
      commits: ["003eafd"],
      reconstructed: true,
    },
  ],
});

/** Canonical Chain Health methodology version (no "v" prefix). */
export const CHAIN_HEALTH_METHODOLOGY_VERSION = chainHealth.currentVersion;

/** Display-ready Chain Health methodology version (with "v" prefix). */
export const CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL = chainHealth.versionLabel;

/** Public changelog route for Chain Health methodology history. */
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH = chainHealth.changelogPath;

/** Changelog data. */
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG = chainHealth.changelog;

/** Resolve Chain Health methodology version active at a given Unix timestamp (seconds). */
export const getChainHealthMethodologyVersionAt = chainHealth.getVersionAt;
