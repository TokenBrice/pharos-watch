import {
  createMethodologyVersion,
} from "./methodology-version";

const pricing = createMethodologyVersion({
  currentVersion: "2.1",
  changelogPath: "/methodology/pricing-pipeline-changelog/",
  changelog: [
  {
    version: "2.1",
    title: "Consensus honesty — independent DL list price, GeckoTerminal probe, pool challenge",
    date: "2026-03-16",
    effectiveAt: 1773811200,
    summary:
      "Replaced the DL coins API (which mirrored CoinGecko data, creating illusory 2-source agreement) with the independent DL stablecoins list price. Added GeckoTerminal pool-level cross-check for single-source CG-only assets. Added pool challenge guard that downgrades confidence when a large DEX pool diverges from soft-only consensus.",
    impact: [
      "Dropped DL coins API from primary consensus — it returned CG-sourced data, making CG+DL agreement tautological",
      "Added DefiLlama stablecoins list price (weight 1) as a genuinely independent aggregator voice",
      "Added GeckoTerminal pool probe (weight 1) for single-source CG-only assets with $10K TVL gate",
      "Pool challenge guard: downgrades soft-only high confidence to 'low' when any $100K+ TVL DEX pool diverges ≥500 bps",
      "DEWS scoring suppresses degradation bonus for high→single-source transitions to prevent alert spikes",
      "~130 assets retain genuine high confidence via CG+DL-list agreement; ~27 gain GT cross-check",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "2.0",
    title: "Multi-source consensus with oracle, CEX, and on-chain pricing",
    date: "2026-03-14",
    effectiveAt: 1773619200,
    summary:
      "Upgraded from 2-source cross-validation (CG+DL) to an 8-source weighted consensus system. Added Pyth, Binance, Coinbase, RedStone oracles, Curve on-chain pricing, and promoted DEX price observations to primary voices. N-source clustering replaces simple comparison.",
    impact: [
      "8 independent price sources with per-source circuit breakers and configurable weights",
      "Consensus algorithm clusters sources within 50 bps, picks highest-weight in largest cluster",
      "Authoritative protocol-redemption overrides for wrapper assets (cUSD, iUSD, crvUSD)",
      "4-pass enrichment pipeline for assets still missing prices after primary consensus",
      "Price confidence tagging: high (2+ agree), single-source, low (disagree), fallback",
      "CoinMarketCap enrichment optimized from per-slug to batch listings endpoint",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial 2-source price cross-validation",
    date: "2026-02-01",
    effectiveAt: 1769904000,
    summary:
      "Launched baseline pricing with CoinGecko as primary and DefiLlama as cross-validation source. Simple comparison logic with single enrichment pass.",
    impact: [
      "CoinGecko primary prices with DefiLlama cross-validation",
      "Basic price reasonableness checks against peg references",
      "DexScreener enrichment for assets missing from aggregators",
    ],
    commits: [],
    reconstructed: true,
  },
  ],
});

/** Canonical Pricing Pipeline methodology version (no "v" prefix). */
const PRICING_PIPELINE_VERSION = pricing.currentVersion;

/** Display-ready Pricing Pipeline methodology version (with "v" prefix). */
export const PRICING_PIPELINE_VERSION_LABEL = pricing.versionLabel;

/** Public changelog route for Pricing Pipeline methodology history. */
export const PRICING_PIPELINE_CHANGELOG_PATH = pricing.changelogPath;

/** Reconstructed changelog data. */
export const PRICING_PIPELINE_CHANGELOG = pricing.changelog;

/** Resolve Pricing Pipeline methodology version active at a given Unix timestamp (seconds). */
const getPricingPipelineVersionAt = pricing.getVersionAt;
