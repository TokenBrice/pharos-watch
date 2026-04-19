import { BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG } from "../../shared/lib/blacklist-tracker-version";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG } from "../../shared/lib/chain-health-version";
import { DEPEG_DEWS_METHODOLOGY_CHANGELOG } from "../../shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_CHANGELOG } from "../../shared/lib/liquidity-score-version";
import type { MethodologyChangelogEntry } from "../../shared/lib/methodology-version";
import { MINT_BURN_FLOW_METHODOLOGY_CHANGELOG } from "../../shared/lib/mint-burn-flow-version";
import { PRICING_PIPELINE_CHANGELOG } from "../../shared/lib/pricing-pipeline-version";
import { SAFETY_SCORE_CHANGELOG } from "../../shared/lib/safety-score-version";
import { PSI_METHODOLOGY_CHANGELOG } from "../../shared/lib/stability-index-version";
import { YIELD_METHODOLOGY_CHANGELOG } from "../../shared/lib/yield-methodology-version";
import { frontMatterBlock } from "./markdown-renderers";

const PRICING_PIPELINE = `## Pricing Pipeline Methodology

Every score Pharos computes starts with a price. The pricing pipeline collects live quotes from aggregators, exchanges, oracles, on-chain pools, protocol redemption feeds, FX references, and enrichment fallbacks.

Pharos clusters sources by pairwise agreement, publishes the highest-confidence median, and keeps source provenance attached so downstream depeg, safety, liquidity, and PSI calculations can reason about data quality. Soft consensus can be challenged by large DEX pools, while protocol redemption prices override market data only for assets where the redemption path is the more authoritative mark.

Freshness is explicit. Upstream-observed timestamps are preferred over local collection time, stale sources are excluded or downgraded, and replay-safe cache continuity is used only when it preserves a confirmed signal without inventing a new one.

Fallback enrichment is bounded. CoinMarketCap, Jupiter, DexScreener, and other late-stage sources fill gaps for long-tail assets, but each pass has request budgets, circuit breakers, and plausibility checks so weak prices cannot silently become high-confidence consensus.
`;

const STABILITY_INDEX = `## Stability Index Methodology

The Pharos Stability Index (PSI) compresses market-wide stablecoin stress into a 0-100 condition score. It starts at 100, subtracts penalties for severity, breadth, stress breadth, and trend, then maps the result into condition bands from BEDROCK to MELTDOWN.

Severity captures how bad current deviations are. Breadth captures how many assets are involved. Stress breadth captures how many stablecoins are elevated in DEWS. Trend captures whether the system is getting better or worse over the current window.

PSI is deliberately conservative: one small depeg should not move the entire market condition, but simultaneous broad stress should pull the index down even if no single coin dominates the tape.
`;

const SAFETY_SCORES = `## Safety Scores Grading Methodology

Pharos synthesizes stablecoin risk into a single transparent grade. The score starts with weighted base dimensions for Liquidity / Exit, Resilience, Decentralization, and Dependency Risk, then applies a peg-stability multiplier.

Liquidity / Exit measures how much usable exit capacity exists across DEX depth and eligible redemption backstops. Resilience measures collateral quality, custody, deployment model, and chain security. Decentralization measures governance and operational control. Dependency Risk penalizes wrapper, collateral, and mechanism exposure to other assets.

The peg multiplier prevents a structurally strong asset with a bad peg from receiving an inflated grade. Severe active depegs, missing liquidity, stale redemption evidence, and high dependency concentration all cap or penalize the final result.
`;

const INFRASTRUCTURE = `## Infrastructure Tagging

Infrastructure tags identify stablecoins that share issuance frameworks, protocol mechanisms, or operational dependencies. Examples include Liquity v1, Liquity v2, and M0.

Tags help Pharos group related assets without pretending they are the same stablecoin. They support navigation, taxonomy pages, comparison context, and dependency-aware risk review.

Infrastructure tags do not override the underlying governance, backing, peg, collateral, or report-card inputs. They are descriptive metadata used to expose shared machinery.
`;

const LIQUIDITY = `## Liquidity Score

The Liquidity Score measures how safely a stablecoin can exit through decentralized markets. It combines TVL depth, volume activity, pool quality, durability, and pair diversity into a 0-100 score.

TVL depth uses log-scale scoring so small assets can improve without requiring blue-chip depth, while very deep pools still receive credit. Volume rewards active markets. Pool quality adjusts for mechanism type, pool balance, pair quality, and risky counterparties. Durability measures persistence across observations, and pair diversity penalizes concentration in one venue or one unstable route.

Discovery is source-aware. Pharos stages pools from DefiLlama, direct protocol APIs, CoinGecko on-chain data, GeckoTerminal, DexScreener, and curated DEX sources, then deduplicates by exact pool identity or conservative derived identity. Thin, stale, or identity-poor pools remain visible for diagnostics but do not receive the same scoring weight as durable high-quality venues.
`;

const MINT_BURN_FLOW = `## Mint/Burn Flow Scoring

Mint/burn flow scoring tracks issuance and redemption pressure across supported token contracts. Pharos classifies transfers into mint, burn, bridge-mint, bridge-burn, atomic roundtrip, and ignored noise so the gauge reflects meaningful supply movement instead of mechanical churn.

The score compares recent net flow against trailing closed-day baselines, distinguishes canonical-chain activity from bridge effects, and flags pressure shifts when risky outflows and safer inflows diverge.

Coverage is intentionally explicit. Unsupported chains, deferred configs, null-price repair, and stale lanes are surfaced as metadata rather than hidden behind a clean-looking aggregate.
`;

const YIELD = `## Yield Intelligence

Yield Intelligence resolves stablecoin yield from direct on-chain reads, curated pools, protocol APIs, price-derived NAV movement, and rate-derived sources. The pipeline prefers precise sources and only uses fallback tiers when identity and exposure remain unambiguous.

Pharos computes effective yield by comparing APY against the relevant cash or peg benchmark, then combines yield efficiency with sustainability to produce a Pharos Yield Score (PYS). High APY is not automatically good: unstable rates, weak safety scores, low TVL, or ambiguous exposure reduce the recommendation quality.

Warnings explain why a venue is risky, missing, stale, or benchmark-adjusted so yield pages do not promote fragile opportunities as clean income.
`;

const PEGSCORE_DEWS = `## PegScore and Depeg Early Warning Score (DEWS)

PegScore measures historical peg quality from time-at-peg and event severity. The tracking window is capped by asset age and uses curated launch dates when available.

DEWS is a forward-looking stress score. It combines price deviation, source divergence, liquidity erosion, pool imbalance, supply velocity, blacklist activity, mint/burn pressure, and yield anomalies into a 0-100 warning signal.

Pending depegs require corroboration before promotion. Pharos treats contradictory evidence as a reason to hold or reject an event, not as weak support, and it records the source family behind every confirmed mutation.
`;

const CONTAGION = `## Contagion Stress Test

The contagion stress test models how failure in one stablecoin can propagate through collateral, wrapper, and mechanism dependencies. It asks which assets would inherit stress if a major stablecoin, reserve asset, or shared mechanism became impaired.

Dependency weights are curated from explicit metadata, reserve slices, wrapper relationships, and known mechanism links. The model distinguishes direct collateral exposure from looser operational dependency so a small wrapper link does not receive the same treatment as a majority reserve dependency.

The result is used in report cards, comparison context, and systemic-risk views to identify hidden concentration that is not visible from market capitalization alone.
`;

const BLACKLIST = `## Blacklist Tracker Methodology

The blacklist tracker monitors issuer-controlled freeze, blocklist, account-pause, and token-destruction events across supported centralized stablecoin contracts.

Events are normalized by chain, stablecoin, action type, native amount, USD amount, and amount-status provenance. Recoverable amount gaps are queued for repair, while permanently unavailable rows remain auditable without polluting public aggregates.

Blacklist exposure feeds report-card dependency and resilience review because the ability to freeze or destroy balances is a material operational risk even when the peg is stable.
`;

const CHAIN_HEALTH = `## Chain Health Score

Chain Health Score evaluates how healthy each chain's stablecoin stack is. It combines stablecoin supply, diversification, safety-grade mix, dependency concentration, issuer concentration, and stress signals.

The score is computed from current stablecoin and report-card data rather than a separate opaque dataset. A chain with large supply but one dominant issuer, weak collateral quality, or broad stress can score below a smaller but more diversified chain.

Chain Health is intended as market-structure context: it helps users understand whether a chain's stablecoin liquidity is deep, resilient, and diversified enough to support activity during stress.
`;

const SECTIONS = [
  PRICING_PIPELINE,
  STABILITY_INDEX,
  SAFETY_SCORES,
  INFRASTRUCTURE,
  LIQUIDITY,
  MINT_BURN_FLOW,
  YIELD,
  PEGSCORE_DEWS,
  CONTAGION,
  BLACKLIST,
  CHAIN_HEALTH,
];

const CHANGELOG_REGISTRY = {
  scoring: {
    title: "Safety Scores Changelog",
    path: "/methodology/scoring-changelog/",
    entries: SAFETY_SCORE_CHANGELOG,
  },
  depeg: {
    title: "Depeg Tracker and DEWS Changelog",
    path: "/methodology/depeg-changelog/",
    entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  },
  "blacklist-tracker": {
    title: "Blacklist Tracker Changelog",
    path: "/methodology/blacklist-tracker-changelog/",
    entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  },
  "liquidity-score": {
    title: "Liquidity Score Changelog",
    path: "/methodology/liquidity-score-changelog/",
    entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
  },
  "stability-index": {
    title: "Stability Index Changelog",
    path: "/methodology/stability-index-changelog/",
    entries: PSI_METHODOLOGY_CHANGELOG,
  },
  "mint-burn-flow": {
    title: "Mint/Burn Flow Changelog",
    path: "/methodology/mint-burn-flow-changelog/",
    entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  },
  yield: {
    title: "Yield Intelligence Changelog",
    path: "/methodology/yield-changelog/",
    entries: YIELD_METHODOLOGY_CHANGELOG,
  },
  "pricing-pipeline": {
    title: "Pricing Pipeline Changelog",
    path: "/methodology/pricing-pipeline-changelog/",
    entries: PRICING_PIPELINE_CHANGELOG,
  },
  "chain-health": {
    title: "Chain Health Changelog",
    path: "/methodology/chain-health-changelog/",
    entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  },
} as const satisfies Record<string, {
  title: string;
  path: string;
  entries: readonly MethodologyChangelogEntry[];
}>;

export type MethodologyChangelogKey = keyof typeof CHANGELOG_REGISTRY;

export const METHODOLOGY_CHANGELOG_KEYS = Object.keys(CHANGELOG_REGISTRY) as MethodologyChangelogKey[];

export function buildMethodologyIndexMarkdown(): string {
  return (
    frontMatterBlock({
      title: "Methodology: How Pharos Grades Stablecoins",
      canonical: "https://pharos.watch/methodology/",
      description:
        "Full methodology behind Pharos safety grades, peg scores, liquidity scores, PSI, DEWS, yield intelligence, and contagion tests.",
    }) +
    `# Methodology\n\n${SECTIONS.join("\n\n")}\n`
  );
}

export function buildMethodologyChangelogMarkdown(key: MethodologyChangelogKey): string {
  const config = CHANGELOG_REGISTRY[key];
  const sections = config.entries
    .map((entry) => {
      const impact = entry.impact.map((line) => `- ${line}`).join("\n");
      const commitLine = entry.commits.length > 0
        ? `\n\nCommits: ${entry.commits.map((sha) => `\`${sha}\``).join(", ")}`
        : "";
      return `## v${entry.version} - ${entry.title}\n\n**Effective:** ${entry.date}\n\n${entry.summary}\n\n${impact}${commitLine}`;
    })
    .join("\n\n");

  return (
    frontMatterBlock({
      title: config.title,
      canonical: `https://pharos.watch${config.path}`,
      description: `${config.title} - Pharos methodology version history.`,
    }) +
    `# ${config.title}\n\n${sections}\n`
  );
}
