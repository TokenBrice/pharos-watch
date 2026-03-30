import {
  createMethodologyVersion,
} from "./methodology-version";

const pricing = createMethodologyVersion({
  currentVersion: "2.19",
  changelogPath: "/methodology/pricing-pipeline-changelog/",
  changelog: [
    {
      version: "2.19",
      title: "Explicit source semantics, cluster-median publication, and fallback identity hardening",
      date: "2026-03-30",
      effectiveAt: 1774832400,
      summary:
        "Made source freshness and trust semantics explicit, changed high-confidence consensus to publish the agreeing cluster median instead of a single member price, " +
        "and hardened fallback identity/order handling for DefiLlama and DexScreener.",
      impact: [
        "Pricing sources now carry explicit freshness kind, max trusted age, upstream-timestamp support, single-source authority, and market-capability metadata in the canonical registry",
        "High-confidence consensus now publishes the winning cluster median while preserving the internally selected cluster member for provenance and downstream policy",
        "DefiLlama list quotes now enter primary pricing as typed inputs with explicit observed-time provenance instead of inheriting mutable asset-state timestamps",
        "DEX bridge source freshness now preserves per-source timestamps from `price_sources_json` instead of flattening everything to the row write time",
        "DefiLlama contract fallback now prefers canonical tracked deployment identities, validates each quote before claiming the asset, and can probe multiple exact tracked coin ids when needed",
        "DexScreener fallback now prioritizes exact-target assets under the request cap and keeps symbol search reserved for addressless assets only",
        "Pyth confidence weighting is now smoother across medium-confidence prints, and RedStone requires at least 60% venue agreement before entering primary consensus",
        "The provider-config pricing audit is now part of CI validation instead of remaining a local-only check",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.18",
      title: "Validated DefiLlama fallback admission and exact-target DexScreener gating",
      date: "2026-03-30",
      effectiveAt: 1774828800,
      summary:
        "Hardened late-stage price enrichment so unreasonable DefiLlama contract quotes can no longer claim an asset before validation, " +
        "and DexScreener symbol search no longer runs for assets that already have canonical exact token-address targets.",
      impact: [
        "DefiLlama pass 1 and pass 1b now validate quotes against the shared peg-aware bounds before marking an asset as resolved",
        "A bad DL contract response can no longer block later CoinMarketCap, Jupiter, or DexScreener fallback passes in the same run",
        "DexScreener symbol search now stays disabled whenever the asset already has a canonical chain+address lookup path; only addressless assets can use the unique-symbol search fallback",
        "This reduces wrong-identity recovery risk while preserving the exact-address DexScreener recovery path for assets with tracked deployments",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.17",
      title: "Protocol-aware DEX hardening estimators and provider-config cleanup",
      date: "2026-03-24",
      effectiveAt: 1774353600,
      summary:
        "Made the GeckoTerminal probe and pool-challenge replacement estimators protocol-aware, " +
        "so repeated same-protocol pools no longer dominate soft-source hardening marks, and cleaned stale provider configuration drift in the RedStone tracked-symbol allowlist.",
      impact: [
        "GeckoTerminal probing now collapses pools to one TVL-weighted-median price per protocol before injecting a cross-protocol weighted-median mark",
        "Pool challenge replacement now uses corroborating divergent protocol groups rather than a raw all-pool weighted mean, making replacement marks less sensitive to repeated same-protocol pools",
        "Provider-config audit tests now guard CEX and RedStone coverage allowlists against duplicate or stale untracked entries",
        "The stale untracked `sUSDe` RedStone allowlist entry was removed so the runtime config matches the tracked registry again",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.16",
      title: "Explicit source freshness provenance for live prices",
      date: "2026-03-24",
      effectiveAt: 1774350000,
      summary:
        "Made source freshness provenance explicit in live-price payloads and replay metadata, " +
        "so Pharos can distinguish true upstream observation time from locally stamped fetch time without overstating downstream authority.",
      impact: [
        "Stablecoin payloads, peg-summary outputs, and `price_cache` rows now preserve `priceObservedAtMode` alongside `priceObservedAt`",
        "Primary consensus now carries freshness provenance per source and resolves a conservative effective mode for the selected price",
        "Hard single-source prices remain depeg-authoritative only when they retain source-native freshness provenance; local-fetch hard single-source prices now stay `confirm_required`",
        "Older rows remain backward-compatible: cached data that predates explicit freshness-mode storage does not automatically lose authority just because the mode is absent",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.15",
      title: "Independent FX recovery during cached fallback",
      date: "2026-03-23",
      effectiveAt: 1774279800,
      summary:
        "Kept the independent FX recovery paths alive even after the full-set fiat stack drops into cached fallback, " +
        "so Open Exchange Rates, Chainlink overlays, and metals probes can still refresh stale pegs and promote the run back to live once fresh full-set coverage is restored.",
      impact: [
        "Cached-fallback FX runs now keep probing Open Exchange Rates, Chainlink reference feeds, and gold-api.com instead of freezing their last known state until Frankfurter recovers",
        "A single stale intraday peg can no longer pin the whole FX lane in repeated cached fallback when OXR or Chainlink can refresh that subset independently",
        "If those independent probes restore fresh coverage for the expected fiat reference set, the run now exits cached fallback immediately and resets the fallback streak",
        "Operator metadata remains explicit about the failed Frankfurter / mirror path while no longer overstating the duration of an otherwise recovered FX incident",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.14",
      title: "Replay-safe trusted-price continuity for confirmed depegs",
      date: "2026-03-23",
      effectiveAt: 1774267200,
      summary:
        "Extended previous-trusted severe-depeg continuity to reuse fresh replay-safe price-cache rows, " +
        "so a transient low or unusable stablecoins publication cannot make the next validation pass forget a recently corroborated open depeg.",
      impact: [
        "Previous-trusted price lookup now merges the last authoritative stablecoins publication with fresh replay-safe `price_cache` metadata",
        "Cached replay can keep publishing the last fresh corroborated depeg price through brief single-run corroboration gaps instead of dropping the asset to `N/A`",
        "Confirmed severe depegs no longer lose continuity just because an intervening stablecoins run published a `low` or unusable price state",
        "This closes the intermittent USR-style divergence where PSI could still explain the open depeg while detail surfaces lost the current price",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.13",
      title: "Source-aware trust, observed-time freshness, and weak-price jump quarantine",
      date: "2026-03-22",
      effectiveAt: 1774230000,
      summary:
        "Centralized pricing-source trust policy, preserved true source-observation timestamps through consensus and replay, " +
        "and hardened publication/depeg behavior so weak soft-source moves cannot silently become downstream-authoritative or self-reinforce through the DEX bridge.",
      impact: [
        "Pricing source capabilities now come from one canonical registry shared by consensus, replay safety, pool challenge, GT probing, status health, and depeg trust classification",
        "Cached stablecoin payloads now preserve `priceObservedAt` and `priceSyncedAt`; compatibility `priceUpdatedAt` now reflects the true observation timestamp rather than the sync write time",
        "Soft single-source prices and soft-only high-confidence consensus can no longer mutate live depeg state directly; hard single-source sources such as Pyth, CEX, Curve, and protocol-redemption can still be authoritative",
        "Weak fixed-peg price jumps versus the previous trusted price now require corroboration before publication, closing the USR-style wrong-price path",
        "Pool challenge now uses the live $100K threshold in its published challenger snapshots and can harden weak soft-source outcomes, not only pre-downgrade high-confidence clusters",
        "GeckoTerminal probing now revisits weak CoinGecko / DL-list soft outcomes rather than only strict one-source cases",
        "Direct-API DEX quote conversion now reuses only authoritative tracked stablecoin prices; weak or stale tracked prices fall back to peg references instead of feeding the bridge loop",
        "Replay cache rows now keep source, confidence, observation time, sync time, and source lists; RedStone now derives its price from the venue median instead of the provider aggregate",
        "CoinMarketCap, Jupiter, and DexScreener enrichment passes now fail independently instead of aborting the whole late-enrichment block",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.12",
      title: "Identity-safe enrichment, severe-downside publication guards, and replay-safe DEX quote derivation",
      date: "2026-03-22",
      effectiveAt: 1774195200,
      summary:
        "Closed the main pricing-integrity gaps by constraining fallback identity to tracked deployments, " +
        "requiring corroboration for severe fixed-peg downside publication, promoting only replay-safe cached prices, " +
        "and deriving DEX quote USD values from tracked live stablecoin prices instead of unconditional `$1` symbol assumptions.",
      impact: [
        "Primary pricing candidates are no longer gated on `geckoId`; tracked assets can still enter consensus through Pyth, CEX, RedStone, Curve, DL-list, or DEX bridge inputs",
        "DefiLlama pass 1b now probes only tracked alternate deployments instead of synthesizing same-address identities across chains",
        "CoinMarketCap and DexScreener symbol fallbacks now require uniqueness within the tracked registry, reducing symbol-collision poisoning",
        "RedStone prices now require at least two corroborating venues before entering primary consensus",
        "Pool challenge now applies to DEX-inclusive soft consensus clusters unless an exempt hard source is present",
        "GeckoTerminal probing now cross-checks eligible single-source DL-list results in addition to single-source CoinGecko results",
        "Direct-API DEX pair conversion now prefers tracked cached stablecoin prices for quote legs and will not treat unknown addressed `USDC`/`USDT`-style symbols as automatic `$1` references",
        "Price-cache replay now stores only replay-safe non-low, non-fallback prices and the replay window is shortened from 24h to 6h",
        "Severe fixed-peg downside publication now requires corroboration unless the source is an explicit protocol-redemption or pool-challenge replacement mark",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.11",
      title: "Canonical DEX token identity and non-overlapping DEX consensus",
      date: "2026-03-22",
      effectiveAt: 1774180800,
      summary:
        "Hardened DEX price intake so runtime pool parsing can no longer learn new token identities, " +
        "unknown addressed tokens cannot fall back to symbol matches in price-bearing paths, and promoted DEX bridge sources cannot self-confirm inside primary consensus.",
      impact: [
        "DEX identity is now canonical-only at runtime: DeFiLlama and subgraph parsing no longer mutate chain-aware token ownership",
        "Symbol fallback remains available only for addressless tokens; addressed unknown tokens are dropped instead of being reinterpreted by symbol",
        "DeFiLlama pools with `underlyingTokens` now match tracked assets by canonical addresses only, preventing positional symbol/address poisoning",
        "Promoted per-protocol DEX bridge sources are admitted into primary consensus only when corroborated or when no non-DEX voices exist",
        "The overlapping `dex-promoted` aggregate is withheld whenever promoted per-protocol DEX bridge data exists for the same asset",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "2.10",
      title: "Cadence-valid FX carry-forward semantics",
      date: "2026-03-20",
      effectiveAt: 1774014900,
      summary:
        "Adjusted FX refresh semantics so previously published daily references are treated as a successful live carry-forward when they are still within their expected freshness cadence, instead of automatically incrementing cached-fallback status.",
      impact: [
        "Quarter-hour FX runs no longer poison status simply because Frankfurter and mirror transports failed to re-deliver an already-current daily source snapshot",
        "Carry-forward runs preserve per-peg source dates and cadence metadata, so status still degrades normally once the underlying daily references actually age out",
        "Operator metadata still records the failed live transport path, but public health now aligns with source freshness rather than transport availability alone",
      ],
      commits: [],
      reconstructed: false,
    },
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
    effectiveAt: 1773897600,
    summary:
      "Fixed critical depeg detection gap where pool-challenge-driven depegs could never be confirmed. " +
      "Made pool challenge threshold peg-type-aware. Added Pyth confidence and RedStone venue agreement gating. " +
      "Downgraded CG+DL-only consensus to single-source.",
    impact: [
      "Pool-level individual prices added as fourth depeg confirmation source — fixes dUSD-like depegs going undetected",
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
    title: "Consensus honesty — independent DL list price, GeckoTerminal probe, pool challenge",
    date: "2026-03-16",
    effectiveAt: 1773811200,
    summary:
      "Replaced the DL coins API (which mirrored CoinGecko data, creating illusory 2-source agreement) with the independent DL stablecoins list price. Added GeckoTerminal pool-level cross-check for single-source CG-only assets. Added pool challenge guard that downgrades confidence and replaces price with TVL-weighted pool average when large DEX pools diverge from soft-only consensus.",
    impact: [
      "Dropped DL coins API from primary consensus — it returned CG-sourced data, making CG+DL agreement tautological",
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
export const PRICING_PIPELINE_VERSION = pricing.currentVersion;

/** Display-ready Pricing Pipeline methodology version (with "v" prefix). */
export const PRICING_PIPELINE_VERSION_LABEL = pricing.versionLabel;

/** Public changelog route for Pricing Pipeline methodology history. */
export const PRICING_PIPELINE_CHANGELOG_PATH = pricing.changelogPath;

/** Reconstructed changelog data. */
export const PRICING_PIPELINE_CHANGELOG = pricing.changelog;

/** Resolve Pricing Pipeline methodology version active at a given Unix timestamp (seconds). */
export const getPricingPipelineVersionAt = pricing.getVersionAt;
