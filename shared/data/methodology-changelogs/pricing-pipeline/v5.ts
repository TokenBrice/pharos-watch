import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versioning convention (see compareMethodologyVersions in
// @shared/lib/methodology-versions/base): each dotted segment is compared as an
// INTEGER, not a decimal fraction, so the minor segment is an open-ended integer
// counter within the v5 bucket, e.g. `5.0` ([5, 0]) < `5.09` ([5, 9]) < `5.91`
// ([5, 91]) < `5.99` ([5, 99]). Routine pricing-pipeline changes bump the minor
// counter (and may extend to `5.991`, `5.992`, … without ever needing v6) and
// stay in this file. Create a new `v6.ts` (and a sibling vN file array) only for a
// genuine major/breaking change to the pricing methodology, not merely to roll the
// counter over. Entries below are newest-first by version.
export const PRICING_PIPELINE_V5: readonly MethodologyChangelogEntry[] = [
    {
      version: "5.99",
      title: "Free exact-address price augmentation",
      date: "2026-05-12",
      effectiveAt: 1778625600,
      summary:
        "Targeted exact-address price providers now augment primary consensus for assets with missing prices or below-target source depth, using only free/no-payment lanes and canonical chain-address identity.",
      impact: [
        "DexScreener exact token endpoint, DexPaprika, GeckoTerminal simple token prices, Alchemy Prices, Moralis token prices, and Birdeye Solana prices can contribute weight-1 soft primary-consensus candidates",
        "Targets are built only from canonical `asset.address`, `contracts`, or `tradedContracts` metadata and require exact chain+address identity; symbol search remains confined to the existing final DexScreener fallback pass",
        "`ADDRESS_PRICE_PROVIDERS_ENABLED` can restrict or disable the provider set, while unset auto-enables no-key providers plus configured key-backed providers",
        "The new sources are non-replay-safe and non-depeg-authoritative on their own, so they improve source depth without weakening depeg confirmation rules",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.98",
      title: "Live-reserve NAV primary pricing",
      date: "2026-05-12",
      effectiveAt: 1778620267,
      summary:
        "Matched live-reserve NAV snapshots can now enter primary consensus as hard protocol price sources, Curve joins promoted DEX protocol lanes, and Binance stable-quoted BFUSD markets convert through tracked USD quote pairs.",
      impact: [
        "`chainlink-nav` and `superstate-liquidity` are registered primary-consensus sources that read authoritative reserve_composition rows matched to reserve_sync_state success timestamps",
        "USD-denominated NAV rows publish directly, while non-USD NAV rows such as EUTBL convert through fresh/static FX references before entering USD consensus",
        "`curve-dex` can now promote retained Curve DEX evidence from `dex_prices.price_sources_json`; the aggregate `dex-promoted` lane is still withheld whenever a promoted protocol lane exists",
        "Binance `BFUSDUSDT` and `BFUSDUSDC` markets convert through tracked USDT/USDC USD pairs, and Binance-derived DEX aggregate rows are suppressed when the direct Binance hard-market source is already present",
        "`usyc-hashnote` and `ustb-superstate` now carry verified Pyth feed metadata, and `syrupusdc-maple` includes Maple's verified Solana syrupUSDC mint for DEX discovery coverage",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.97",
      title: "Registry source-family normalization",
      date: "2026-05-12",
      effectiveAt: 1778612253,
      summary:
        "Pricing source registry entries now carry explicit depeg source-family metadata, composite source labels are normalized before downstream policy checks, and seven verified Pyth feed IDs expand coverage through the existing hard-oracle lane.",
      impact: [
        "Replay safety, pool-challenge eligibility, fallback-only classification, depeg authority, and severe-downside corroboration now expand composite labels such as `coingecko+geckoterminal` before applying source policy",
        "CoinGecko-family and DefiLlama-family variants collapse for independence checks, CoinMarketCap and DefiLlama contract fallback are treated as list aggregators, and fallback/search lanes remain non-authoritative",
        "Promoted DEX protocol lanes keep protocol-specific `dex:*` families instead of collapsing into one generic DEX family",
        "`susds-sky`, `susde-ethena`, `syrupusdt-maple`, `sdai-sky`, `thbill-theo`, `usdv-solomon`, and `usdxl-last` now have verified Pyth feed metadata for the existing Pyth Hermes source path",
        "The source-depth audit script measures candidate, agreeing, and depeg-authoritative source distributions without changing live pricing selection",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.96",
      title: "Yearn yBOLD NAV wrapper pricing",
      date: "2026-05-12",
      effectiveAt: 1778605200,
      summary:
        "Yearn yBOLD is now tracked as a first-class BOLD strategy-vault variant and prices through the existing guarded ERC-4626 NAV lane.",
      impact: [
        "`ybold-yearn` is admitted through Ethereum on-chain total supply and publishes `protocol-redeem` pricing from `convertToAssets(1 share)` multiplied by the tracked `bold-liquity` parent price",
        "`sbold-k3-capital` and `ybold-yearn` are both covered by regression tests for BOLD-derived ERC-4626 NAV pricing",
        "The parent-trust gate, parent provenance metadata, and 0.5-10.0 share-to-asset bounds remain unchanged",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.95",
      title: "Low-volume CoinGecko fallback for DL-listed gaps",
      date: "2026-05-12",
      effectiveAt: 1778601600,
      summary:
        "Selected DefiLlama-listed stablecoins with null DL prices can now recover through the existing relaxed CoinGecko low-volume lane while keeping DefiLlama as the supply source.",
      impact: [
        "`usp-pareto-credit` and `tryb-bilira` can use `coingecko-low-volume` fallback pricing when CoinGecko has a positive row inside the relaxed low-volume freshness window and all earlier missing-price passes fail",
        "The recovery is explicitly allowlisted, keeps `priceConfidence: fallback`, and does not change the strict primary CoinGecko freshness gate",
        "DefiLlama supply rows remain authoritative for these assets; the new pass only fills missing price provenance and cannot overwrite an already-published primary price",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.94",
      title: "Zephyr Scanner supplemental pricing",
      date: "2026-05-12",
      effectiveAt: 1778594800,
      summary:
        "ZSD and ZYS now use Zephyr Scanner live-stats telemetry for official native-chain supply, with ZYS also using the protocol-published NAV price because no CoinGecko or DefiLlama market row exists for the yield-share wrapper.",
      impact: [
        "`zsd-zephyr-protocol` keeps CoinGecko as the preferred market price when available, but its circulating supply is sourced from Zephyr's official `zsd_circ` value instead of CoinGecko market cap",
        "`zys-zephyr-protocol` is admitted through the supplemental Zephyr Scanner path using official ZYS circulation and share price, so the yield wrapper can appear in `/api/stablecoins` without a supported chain contract",
        "`zephyr-scanner` is registered as an explicit pricing source with no dedicated breaker; the fetch remains scoped to the supplemental Zephyr asset path",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.93",
      title: "Jupiter sparse response breaker accounting",
      date: "2026-05-12",
      effectiveAt: 1778592200,
      summary:
        "Jupiter V3 sparse no-quote rows now count as healthy empty coverage instead of malformed provider responses, preventing unsupported tracked Solana mints from opening the fallback breaker.",
      impact: [
        "`jupiter-prices` still records failures for non-OK responses and malformed envelopes, but decimals-only rows for unsupported mints no longer open the circuit",
        "Quoted rows still require `usdPrice`, `decimals`, fresh `blockId`, optional liquidity gating, and peg-aware validation before a price can be accepted",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.92",
      title: "Expanded NAV-wrapper authoritative pricing",
      date: "2026-05-12",
      effectiveAt: 1778590800,
      summary:
        "Expanded protocol-backed authoritative pricing to newly tracked NAV wrappers, added tracked-base inheritance for Initia iUSD and Movement USDCx, and admitted Spark Savings USDC through curated on-chain supplemental supply before pricing overrides run.",
      impact: [
        "`susdc-spark`, `gtusdcp-gauntlet`, `steakusdt-steakhouse`, `steakusdc-steakhouse`, `srusde-strata`, `savusd-avant`, `susn-noon`, and `syzusd-yuzu` now use guarded ERC-4626 `convertToAssets(1 share)` pricing when their tracked parent assets are fresh and replay-safe",
        "`iusd-initia` now inherits tracked `ausd-agora` pricing, `usdcx-movement` inherits tracked `usdc-circle` pricing, and `sgho-aave` uses a protocol-specific `previewRedeem(uint256)` quote against tracked `gho-aave`",
        "`susdc-spark` can now appear in the stablecoins sync even without a DefiLlama or CoinGecko market row by using curated Ethereum vault supply, after which the authoritative NAV override supplies the live price",
        "Existing parent-trust gates, parent provenance metadata, and NAV ratio bounds are unchanged",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.91",
      title: "Post-probe authoritative override refresh",
      date: "2026-05-12",
      effectiveAt: 1778587800,
      summary:
        "Recomputed protocol-backed authoritative price overrides after fallback enrichment and GeckoTerminal probing so newly trusted parent prices can unlock dependent wrapper prices in the same sync run.",
      impact: [
        "`usdk-kast` and `xo-exodus` can recover from `priceSource: missing` when `wm-m0` becomes a fresh high-confidence parent through primary consensus or GeckoTerminal probing during the same run",
        "The parent-trust guard remains unchanged: low-confidence, stale, cached, or non-replay-safe parent prices still cannot upgrade into `protocol-redeem` child prices",
        "The earlier pre-enrichment override pass is retained, but the final completion pass no longer reuses its stale override map after source enrichment has changed asset prices",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.09",
      title: "Addressless DexScreener exact fallback from tracked metadata",
      date: "2026-05-12",
      effectiveAt: 1778587200,
      summary:
        "Extended DexScreener exact fallback to use curated tracked contract metadata when an upstream stablecoin row has no address, while preserving exact-address pricing, liquidity floors, and peg-aware validation.",
      impact: [
        "`usx-dforce` can now recover from `priceSource: missing` through its tracked Base USX contract when DexScreener publishes a sufficiently liquid exact-address market",
        "The change does not use stale CoinGecko rows and does not enable symbol search when exact tracked contracts exist",
        "Metadata-derived DexScreener targets require the tracked-token symbol in the matched pool to equal the asset symbol, preventing wrapper quotes such as `cUSDO` from being accepted for `USDO`",
        "Existing upstream-provided addresses still take precedence; tracked metadata contracts are only used for addressless rows",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.08",
      title: "DefiLlama EVM contract fallback casing normalization",
      date: "2026-05-12",
      effectiveAt: 1778586100,
      summary:
        "Normalized EVM address casing before DefiLlama `/coins` contract fallback lookups so checksummed metadata addresses match lower-case upstream price keys without weakening token identity checks.",
      impact: [
        "`usg-tangent` can now recover from `priceSource: missing` when DefiLlama publishes the live USG contract quote under a lower-case EVM address",
        "The DefiLlama fallback still requires exact quote-symbol agreement, so unrelated symbols such as `stkGHO` are not accepted for `sgho-aave`",
        "Non-EVM identifiers, including Solana mints, keep their original case because those addresses are case-sensitive",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.07",
      title: "Idle CDO virtualPrice authoritative price provider",
      date: "2026-05-12",
      effectiveAt: 1778558000,
      summary:
        "Added an Idle Perpetual Yield Tranches authoritative price provider that reads `virtualPrice(address tranche)` on the CDO contract and multiplies the resulting underlying-denominated NAV by the tracked parent asset's live price.",
      impact: [
        "`aa-falconx-mev-capital` now publishes a `protocol-redeem` high-confidence NAV from the CDO `virtualPrice` reading and the tracked `usdc-circle` parent price, instead of staying at `priceSource: missing`",
        "The provider reuses the shared parent-trust gating, parent provenance metadata, and 0.5-10.0 NAV bound from the ERC-4626 NAV lane so untrusted, stale, or degenerate quotes cannot upgrade into a high-confidence child price",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.06",
      title: "ERC-4626 NAV authoritative price provider",
      date: "2026-05-12",
      effectiveAt: 1778556958,
      summary:
        "Added a generic ERC-4626 NAV authoritative price provider that prices wrapper vault tokens from on-chain `convertToAssets(1 share)` times the tracked parent's live price, replacing missing-price publication for navToken vaults whose parents already price through consensus.",
      impact: [
        "`susdt-spark`, `gtusdc-gauntlet`, `yvusdc-yearn`, `stkgho-umbrella-aave`, and `sbold-k3-capital` now publish a `protocol-redeem` high-confidence price derived from the standard ERC-4626 `convertToAssets(uint256)` selector and the tracked parent asset price",
        "Each vault override carries the parent provenance metadata (source, confidence, observed-at, replay-safety) the same way the inherited tracked-base lane already does",
        "The provider rejects on-chain quotes outside a 0.5-10.0 share-to-asset bound to prevent silent regressions if the vault contract migrates or returns degenerate data",
        "Parent-trust gating is shared with the existing inherited-base lane, so low-confidence, stale, cached, or fallback parents cannot upgrade into a high-confidence child vault price",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.05",
      title: "Authenticated Jupiter gateway support",
      date: "2026-05-11",
      effectiveAt: 1778495571,
      summary:
        "The Solana fallback pass can now send a configured Jupiter API key to the official Price API V3 gateway while preserving the same response validation and downstream peg checks.",
      impact: [
        "Operators can set `JUPITER_API_KEY` so Worker-side Jupiter fallback requests include the required `x-api-key` header for `api.jup.ag`",
        "The fallback still only applies to tracked Solana mints that remain missing after primary consensus, authoritative overrides, DefiLlama contract lookup, and CoinMarketCap enrichment",
        "Jupiter responses continue to require documented V3 quote fields, fresh block context, and peg-aware plausibility validation before a price is accepted",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.04",
      title: "Source freshness and independent corroboration hardening",
      date: "2026-05-10",
      effectiveAt: 1778451808,
      summary:
        "Centralized primary source freshness checks, made severe fixed-peg downside publication count independent source families, and hardened tracked-base authoritative inheritance so weak parent prices cannot become high-confidence protocol-redeem child prices.",
      impact: [
        "Bitstamp, Coinbase, oracle, Curve, CoinGecko-derived, and promoted DEX protocol candidates are rejected before primary admission when their timestamps are stale, invalid, missing where required, or future-skewed beyond the shared freshness ceiling",
        "Promoted DEX protocol lanes are freshness-checked per lane, so a fresh parent dex_prices row cannot carry stale protocol-level sources into consensus",
        "Severe fixed-peg downside publication now requires independent source-family corroboration; correlated CoinGecko plus DefiLlama-list evidence no longer satisfies the guardrail on its own",
        "Tracked-base authoritative inheritance now requires a fresh, replay-safe, high-confidence or explicitly authoritative parent and carries parent provenance through accepted overrides",
        "The methodology now documents the existing trust-tier-first low-confidence selector and midpoint-average median estimator for even-sized clusters",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.03",
      title: "DEX source telemetry and direct-API fetch hardening",
      date: "2026-05-05",
      effectiveAt: 1778010000,
      summary:
        "Added structured DEX source skip reasons, a compact DEX source-confidence profile on published stablecoin prices, bounded direct-API protocol fetch concurrency, shared timeout/pagination hard stops, and per-run source-summary dimensions for direct-API and staged-pool merge diagnostics.",
      impact: [
        "DEX bridge source drops are now explainable by stale row, malformed JSON, missing registry mapping, below-threshold TVL, or lack of corroboration without changing the existing admission gates",
        "DEX-inclusive stablecoin prices can carry active protocol-lane count, freshest DEX lane age, and aggregate-only reliance through priceSourceConfidenceProfile",
        "Direct DEX API fetches now share a 15-second request timeout, run independent protocol fetches with concurrency 2, and emit resume markers when deterministic page caps are reached",
        "Direct-API and staged-pool merge metadata now count accepted protocol-chain lanes and excluded rows by reason, protocol, chain, threshold, and identity conflict",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.02",
      title: "ARS, KGS, and NGN non-USD peg hardening",
      date: "2026-05-05",
      effectiveAt: 1777983570,
      summary:
        "Added the latest non-USD peg batch to the same guarded fiat pricing lanes as the earlier fiat expansion: ARS and NGN participate in direct CoinGecko native-peg corroboration where supported, KGS and NGN use secondary daily FX mirrors, and lower-nominal fiat pegs have explicit hardcoded validation bounds when no fresh FX reference is available.",
      impact: [
        "WARS (ARS) and cNGN (NGN) can validate weak live USD marks against direct native-peg and daily FX references, while KGST (KGS) uses daily FX references plus deterministic bounds because CoinGecko does not expose a native KGS quote",
        "KGS and NGN use the same fawazahmed0 secondary FX cadence semantics as CNH, RUB, UAH, and ARS for live sync and historical backfills",
        "MYR, KRW, KGS, and NGN now retain deterministic fallback price bounds even during no-reference validation paths",
        "Direct-API protocol DEX bridges (Meteora, PancakeSwap, Aerodrome Slipstream, Velodrome Slipstream) now register as first-class soft-DEX pricing families (`meteora-dex`, `pancakeswap-dex`, `aerodrome-dex`, `velodrome-dex`) so they can contribute directly to primary consensus when promoted",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.01",
      title: "MYR and KRW peg-currency support",
      date: "2026-04-29",
      effectiveAt: 1777464000,
      summary:
        "Added MYR (Malaysian Ringgit) and KRW (Korean Won) to the supported peg-currency set so MYRC and KRWQ can be tracked through the existing Frankfurter / fawazahmed0 / ExchangeRate-API FX lane and the CoinGecko native-peg corroboration lane.",
      impact: [
        "FX cron requests MYR and KRW from Frankfurter and validates them against per-peg bounds",
        "Native-peg implied-price lane corroborates MYR / KRW depegs via direct CoinGecko myr / krw quotes",
        "Stablecoin charts reconciliation, price-validation classifyPegClass, and FX cadence metadata cover the new pegs",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.0",
      title: "Pricing pipeline comprehensive hardening",
      date: "2026-04-17",
      effectiveAt: 1776442299,
      summary:
        "Closed consistency gaps in pool-challenge replacement, tightened breaker discipline across all pricing fetchers, promoted Bitstamp/Coinbase/Curve to upstream-timestamped freshness, and exposed provider diagnostics on the operator status surface.",
      impact: [
        "Pool challenge replacement now updates allPrices so severe-downside corroboration carry-through uses the replacement source",
        "curve-oracle now enforces a 5-minute on-chain staleness guard using block timestamp and has its own circuit breaker",
        "curve-onchain and Bitstamp / Coinbase now publish upstream-observed freshness instead of local-fetch",
        "NAV tokens are no longer subject to pool-challenge downgrade / replacement",
        "Cluster tiebreak now prefers hard-tier clusters over equal-weight soft-tier clusters before spread / peg proximity",
        "Two-source clusters composed only of list-style aggregators (coingecko, defillama, defillama-list) are now downgraded to single-source regardless of which two combine, closing the CG+defillama-detail tautology",
        "Replay cache enforces per-source max trusted age in addition to the composite 6-hour cap",
        "DefiLlama /coins contract-price fallback and DexScreener dex-liquidity / dex-discovery fallbacks now gate on and record against their own circuit breakers",
        "A lone promoted DEX protocol is admitted only when no non-DEX source exists, or when a hard market/oracle/protocol source agrees within threshold; two or more promoted DEX protocols are admitted as candidate sources before consensus determines agreement",
        "Binance short-circuits to the secondary host on HTTP 5xx / 429 instead of retrying the first host",
        "RedStone solo-retry is bounded to 5 requests per run and spaced to respect Worker connection budget",
        "GT-probe evidence rejection downgrades the pre-GT primary to low-confidence when divergence was significant",
        "Provider diagnostics and GT-probe statistics are now surfaced on /api/status for operator visibility",
      ],
      commits: [],
      reconstructed: false,
    },
];
