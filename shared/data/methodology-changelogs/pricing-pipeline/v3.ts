import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V3: readonly MethodologyChangelogEntry[] = [
    {
      version: "3.99",
      title: "Native-peg live publication guard and fill lane for non-USD fiat assets",
      date: "2026-04-07",
      effectiveAt: 1775584200,
      summary:
        "Supported non-USD fiat assets can now use a fresh direct CoinGecko native quote plus fresh FX reference to correct weak live USD publications and fill missing live prices without turning that derived mark into replay-safe consensus state.",
      impact: [
        "Live post-enrichment validation now lets supported non-USD fiat assets replace materially divergent weak or mixed-source USD publications when a direct native quote implies a fresher peg-consistent USD mark",
        "The same native lane can now fill a missing live price for supported non-USD fiat assets when direct native CoinGecko pricing exists and the derived USD mark passes publication validation",
        "That native-implied mark remains a fresh fallback-validation lane rather than a replay-safe primary consensus source: it is not written into `price_cache`, and later replay cannot publish it as cached continuity",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.98",
      title: "Daily-confirmed native-peg replay for non-USD fiat backfills",
      date: "2026-04-07",
      effectiveAt: 1775578800,
      summary:
        "Historical non-USD fiat replay now treats CoinGecko native-fiat history as a day-scale corroboration lane rather than trusting thin hourly native prints on their own.",
      impact: [
        "Historical CoinGecko market-chart replay now passes the configured CoinGecko API key through the backfill/admin path so native-fiat history can use the authenticated transport consistently during broad repairs",
        "Supported non-USD fiat backfills now replay native-fiat history at daily cadence with a two-point confirmation window across a 36-hour gap tolerance instead of opening on isolated thin hourly prints",
        "Extreme single-point native crashes of 5,000 bps or more are still preserved even when the normal historical confirmation rule would otherwise suppress the event",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.97",
      title: "Generalized native-peg safeguards for non-USD fiat replay and routing",
      date: "2026-04-07",
      effectiveAt: 1775527200,
      summary:
        "Expanded the native-peg hardening lane from BRL-only handling to the wider supported non-USD fiat set, and historical backfill now prefers direct native CoinGecko fiat pairs before falling back to USD history.",
      impact: [
        "Supported non-USD fiat assets such as EUR, CHF, GBP, JPY, SGD, AUD, CAD, BRL, IDR, TRY, ZAR, PHP, MXN, RUB, and CNH/CNY can now consult fresh direct native-peg quotes before downstream depeg logic trusts a derived USD-versus-FX move",
        "Historical market replay now prefers direct CoinGecko native fiat pairs for those supported pegs and compares that native series directly to the `1.0` peg instead of replaying through `USD price / FX reference` when native history exists",
        "The published live USD price path still does not gain a second CoinGecko-derived consensus voice; this remains a downstream validation and historical-replay hardening change rather than a new cached live source",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.96",
      title: "Direct native-peg BRL corroboration for downstream depeg routing",
      date: "2026-04-07",
      effectiveAt: 1775523600,
      summary:
        "Supported non-USD fiat assets can now consult a fresh direct CoinGecko native-peg quote before downstream depeg logic trusts a USD price divided by an FX reference on its own.",
      impact: [
        "Live depeg detection now checks a fresh direct `coin/native-peg` quote for supported fiat pegs such as BRL before opening or extending downstream depeg state",
        "Pending depeg confirmation uses that same direct native quote first, reducing BRZ-style false positives caused by USD/FX reference drift",
        "The published live price remains the normal USD pipeline output; this change hardens downstream validation rather than introducing a new cached price source",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.95",
      title: "USDAI inherits PYUSD redemption pricing",
      date: "2026-04-06",
      effectiveAt: 1775433600,
      summary:
        "Moved base USDAI onto the authoritative redemption-price family by inheriting tracked PYUSD live pricing and historical replay, " +
        "so thin secondary-market USDAI prints no longer create synthetic peg damage for a wrapper-style redeemable token.",
      impact: [
        "Live pricing now treats `usdai-usd-ai` as a redeemable PYUSD wrapper and publishes it from the authoritative `protocol-redeem` lane when tracked PYUSD pricing is available",
        "Historical depeg backfills for `usdai-usd-ai` now replay the tracked PYUSD market series instead of trusting USDAI's own thin secondary-market history",
        "USDAI PegScore and depeg event history no longer inherit obvious false positives from wrapper-specific market dislocations that conflict with the token's instant-redemption semantics",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.94",
      title: "Blocked dead Bunni DEX inputs",
      date: "2026-04-03",
      effectiveAt: 1775242800,
      summary:
        "Explicitly blocked Bunni from the DEX bridge and pool-challenge surfaces after dead-venue rows kept contaminating retained-pool pricing inputs.",
      impact: [
        "Bunni slugs are now rejected during DEX crawl intake and DeFiLlama pool processing, so they no longer spend discovery or scoring budget",
        "Retained-pool filtering, challenger publication, and dex_prices publication all ignore Bunni even if stale or staged rows try to reintroduce it",
        "Pool-challenge replacement marks and promoted DEX bridge sources can no longer be pulled back toward peg by Bunni rows",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.93",
      title: "RedStone USR provider-config drift cleanup",
      date: "2026-04-03",
      effectiveAt: 1775221200,
      summary:
        "Removed stale RedStone provider config drift after the live API stopped returning USR, " +
        "so the tracked-symbol allowlist and validation gate match the provider's real coverage again.",
      impact: [
        "USR no longer sits in `REDSTONE_TRACKED_SYMBOL_ALLOWLIST` once the live RedStone API stopped serving that exact-case symbol",
        "The RedStone price lane no longer spends request budget batching and retrying a symbol the provider currently omits",
        "Pricing-provider audit and merge-gate validation now fail only on live coverage drift that still exists, not on a known stale allowlist entry",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.92",
      title: "Retained-pool DEX bridge publication",
      date: "2026-04-03",
      effectiveAt: 1775217600,
      summary:
        "The DEX bridge now publishes only from the final retained pool set, so raw discovery observations that fail dedupe or quality admission can no longer leak into primary-pricing DEX aggregates.",
      impact: [
        "dex_prices now rebuilds its aggregate and per-protocol bridge sources from retained priced pools after the full liquidity scoring filters run",
        "Promoted DEX bridge inputs and peg-summary dexPriceCheck now stay aligned with the same retained pool surface used by challenger publication and liquidity UI detail",
        "Skipped duplicate or low-quality discovery rows can no longer create synthetic near-peg DEX bridge marks for assets whose retained pools still show a depeg",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.91",
      title: "Protocol-level pool-challenge divergence gating",
      date: "2026-04-02",
      effectiveAt: 1775088000,
      summary:
        "Moved pool-challenge divergence evaluation to one TVL-weighted median per protocol, " +
        "so a single bad challenger pool can no longer make an otherwise agreeing protocol count as independent corroboration for replacement.",
      impact: [
        "Pool challenge still downgrades weak soft-source consensus when any qualifying challenger pool diverges beyond the peg-aware threshold",
        "Price replacement now requires at least two protocol-level challenger medians to diverge, rather than counting divergence from any one pool inside each protocol",
        "A rogue pool inside an otherwise agreeing protocol no longer drags severe depegs back toward peg on the published stablecoins snapshot",
        "The final replacement mark remains the TVL-weighted median across the corroborating divergent protocol groups",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.9",
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
      version: "3.8",
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
      version: "3.7",
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
      version: "3.6",
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
      version: "3.5",
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
      version: "3.4",
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
      version: "3.3",
      title: "Source-aware trust, observed-time freshness, and weak-price jump quarantine",
      date: "2026-03-22",
      effectiveAt: 1774137602,
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
      version: "3.2",
      title: "Identity-safe enrichment, severe-downside publication guards, and replay-safe DEX quote derivation",
      date: "2026-03-22",
      effectiveAt: 1774137601,
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
      version: "3.1",
      title: "Canonical DEX token identity and non-overlapping DEX consensus",
      date: "2026-03-22",
      effectiveAt: 1774137600,
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
      version: "3.0",
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
];
