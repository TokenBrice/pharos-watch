import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V2: readonly MethodologyChangelogEntry[] = [
    {
      version: "2.9",
      title: "Jupiter V3 freshness fix and exact DexScreener address fallback",
      date: "2026-03-20",
      effectiveAt: 1774013540,
      summary:
        "Stopped rejecting Jupiter V3 fallback quotes based on optional createdAt metadata and upgraded DexScreener enrichment to prefer exact token-address pool lookups before symbol search.",
      impact: [
        "Jupiter fallback now relies on V3 liquidity gates and peg-aware validation instead of treating optional `createdAt` metadata as a hard freshness cutoff",
        "Tracked Solana assets can recover through Jupiter even when V3 responses include old createdAt values alongside current block-level pricing",
        "DexScreener fallback now prefers exact chain+address pool lookups when an asset has a resolvable token address, reducing dependence on noisy symbol search results",
        "DexScreener search remains as the last fallback path, still capped by the shared request budget and liquidity sanity gates",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.8",
      title: "Tertiary full-set FX fallback for multi-source outages",
      date: "2026-03-20",
      effectiveAt: 1774013100,
      summary:
        "Added ExchangeRate-API as a tertiary live full-set FX fallback so production can keep publishing dated fiat references when both Frankfurter and the existing secondary mirrors are unavailable.",
      impact: [
        "Frankfurter remains the preferred ECB-backed business-day source for the core fiat set",
        "The existing `fawazahmed0/currency-api` mirrors still serve CNH/RUB/UAH/ARS and can backstop the wider fiat set when Frankfurter is unavailable",
        "When both current FX paths fail, ExchangeRate-API can now publish a daily full-set fiat snapshot instead of forcing an immediate cached-fallback run",
        "The About page and pricing methodology now disclose ExchangeRate-API as an externally visible FX reference source",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.7",
      title: "Secondary FX full-set live fallback for Frankfurter outages",
      date: "2026-03-20",
      effectiveAt: 1774011900,
      summary:
        "Expanded the existing dated secondary FX mirror path so it can temporarily backstop the wider fiat reference set when Frankfurter is unavailable, preventing repeated cached-only FX runs.",
      impact: [
        "CNH/RUB/UAH/ARS still use the secondary daily feed as their normal source path",
        "When Frankfurter fails, the fresher `fawazahmed0/currency-api` mirror can now populate the broader fiat FX set instead of forcing an immediate cached-fallback run",
        "Per-peg FX metadata preserves calendar-daily cadence and source-date semantics during this live fallback path",
        "Public health no longer needs to report long consecutive cached-fallback FX runs for a Frankfurter-only outage when the secondary feed is healthy",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.6",
      title: "Published DEX challenger snapshots and durable FX freshness metadata",
      date: "2026-03-19",
      effectiveAt: 1773961394,
      summary:
        "Pool challenge and depeg confirmation now read dedicated challenger snapshots built from the full retained DEX pool set, while FX reference freshness is tracked separately from usable cached-fallback freshness.",
      impact: [
        "Pool challenge no longer depends on dex_liquidity.top_pools_json, so display truncation cannot hide a large challenger pool",
        "Published challenger snapshots are coverage-gated per stablecoin and fall back safely during migration gaps",
        "Cached FX fallback runs preserve per-peg source timestamps and source modes instead of refreshing them implicitly",
        "Health and status now report usable FX freshness, underlying source freshness, and consecutive fallback runs separately",
        "Non-USD and commodity validation consumers now read shared FX state instead of inferring freshness from cache updated_at alone",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.5",
      title: "Kraken and Bitstamp primary pricing, Jupiter Solana fallback, Chainlink reference overlays",
      date: "2026-03-19",
      effectiveAt: 1773958123,
      summary:
        "Added Kraken and Bitstamp as additional direct venue voices in primary consensus, introduced a Jupiter Price API fallback pass for unresolved Solana assets, and overlaid curated Chainlink reference feeds onto supported FX and commodity validation rates.",
      impact: [
        "Kraken joins primary consensus at weight 2 for supported USD pairs",
        "Bitstamp joins primary consensus at weight 1 as a lower-weight corroborating CEX venue",
        "Primary CEX fetches remain grouped so the quarter-hour pricing lane does not add new peak connection fan-out",
        "Missing Solana prices can now resolve through Jupiter before DexScreener, gated by liquidity and peg-aware plausibility checks",
        "Curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD feeds can now refresh the FX/reference cache when fresh and aligned",
        "Status source distribution now reports Kraken, Bitstamp, and Jupiter participation explicitly",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.4",
      title: "Pairwise consensus hardening, RedStone freshness gate, authoritative override ordering",
      date: "2026-03-19",
      effectiveAt: 1773878400,
      summary:
        "Hardened primary price selection so agreement requires full pairwise clustering, fixed pegs stay on fixed-peg rules when references are temporarily unavailable, RedStone requires fresh timestamped venue breakdowns, and protocol-redeem overrides remain final after GeckoTerminal probing.",
      impact: [
        "Transitive source chains can no longer create fake multi-source high confidence",
        "Equal-size cluster ties now resolve deterministically by weight, spread, peg proximity, then label",
        "Fixed-peg assets no longer silently fall back into NAV-style 500 bps clustering when peg references are missing",
        "Stale or aggregate-only RedStone entries are excluded before consensus",
        "Protocol-backed redemption prices can no longer be overwritten by the GeckoTerminal probe",
        "Direct-API pools must pass shared TVL sanity gates before they suppress overlapping DeFiLlama pools",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.3",
      title: "Per-protocol DEX bridge aggregation and top-pool challenge source split",
      date: "2026-03-18",
      effectiveAt: 1773875700,
      summary:
        "The DEX bridge now persists one aggregated price entry per protocol instead of re-injecting individual top pools as repeated consensus sources. " +
        "Pool challenge reads large current pools from dex_liquidity.top_pools_json, separating consensus promotion from individual-pool depeg challenge inputs.",
      impact: [
        "Fluid, Balancer, Raydium, and Orca now contribute at most one promoted consensus source each",
        "Repeated high-TVL pools from the same protocol can no longer overweight primary consensus by appearing multiple times",
        "dex_prices.price_sources_json now stores per-protocol aggregates for the pricing bridge",
        "Pool challenge no longer depends on dex_prices.price_sources_json; it reads current top pools from dex_liquidity instead",
        "Non-USD tracked stablecoin pairs use peg-reference-aware conversion when deriving direct-API DEX prices",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.2",
      title: "Pool confirmation fix, peg-type-aware challenge, source quality gating",
      date: "2026-03-17",
      effectiveAt: 1773705600,
      summary:
        "Fixed critical depeg detection gap where pool-challenge-driven depegs could never be confirmed. " +
        "Made pool challenge threshold peg-type-aware. Added Pyth confidence and RedStone venue agreement gating. " +
        "Downgraded CG+DL-only consensus to single-source.",
      impact: [
        "Pool-level individual prices added as fourth depeg confirmation source, fixing dUSD-like depegs going undetected",
        "Pool challenge threshold now peg-type-aware: 300 bps for non-USD (was 500 bps for all)",
        "Pyth feeds with >200 bps confidence excluded from consensus; 100-200 bps downweighted",
        "RedStone excluded when internal venue agreement < 50%",
        "CG+DL-only consensus downgraded from high to single-source (illusory agreement)",
        "NAV tokens (FPI) now visible in peg-summary API with null deviation",
        "Full source list preserved in consensus label (no more truncation)",
        "Protocol override divergence warnings logged when >100 bps from consensus",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.1",
      title: "Consensus honesty: independent DL list price, GeckoTerminal probe, pool challenge",
      date: "2026-03-16",
      effectiveAt: 1773619200,
      summary:
        "Replaced the DL coins API (which mirrored CoinGecko data, creating illusory 2-source agreement) with the independent DL stablecoins list price. Added GeckoTerminal pool-level cross-check for single-source CG-only assets. Added pool challenge guard that downgrades confidence and replaces price with TVL-weighted pool average when large DEX pools diverge from soft-only consensus.",
      impact: [
        "Dropped DL coins API from primary consensus: it returned CG-sourced data, making CG+DL agreement tautological",
        "Added DefiLlama stablecoins list price (weight 1) as a genuinely independent aggregator voice",
        "Added GeckoTerminal pool probe (weight 1) for single-source CG-only assets with $10K TVL gate",
        "Pool challenge guard: downgrades soft-only high confidence to 'low' when any $100K+ TVL DEX pool diverges ≥500 bps",
        "Pool challenge price correction: replaces soft consensus price with TVL-weighted mean of all qualifying individual pool prices",
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
      effectiveAt: 1773446400,
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
];
