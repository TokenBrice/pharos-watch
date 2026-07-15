import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.192",
    title: "Independent-source consensus and missing-price scheduling",
    date: "2026-07-15",
    effectiveAt: 1784073600,
    summary:
      "Pricing now counts independent provider families once, gives missing assets fair access to bounded recovery lanes, and re-resolves local dependency chains after fallback enrichment.",
    impact: [
      "Repeated chain or contract quotes from one provider are collapsed before consensus, and correlated source labels sharing one registered family contribute only one independent voice",
      "Authoritative live candidates prioritize missing prices globally and round-robin provider families so one large ERC-4626 cohort cannot consume the full shared wall-clock budget",
      "Registry-derived sGHO and sAID vault configs recover current ERC-4626 NAV prices without duplicating contract addresses in pricing code",
      "A cheap local-only post-fallback authoritative pass lets dependent assets such as Noble USDN inherit a parent repaired during the same sync without repeating RPC-backed probes",
      "DexScreener exact fallback rotates candidates and deployments while attempting one deployment per asset before second deployments, and unusable final prices publish only explicit `missing` provenance",
      "Status diagnostics warn when DEX observations cross the 35-minute pricing-admission limit even if the longer-lived public DEX cache remains display-healthy",
      "Post-enrichment validation retains same-run primary quote evidence when fallback recovery replaces the selected price, so independently corroborated severe depegs publish while single-source and list-only evidence remains withheld",
    ],
    commits: [],
    reconstructed: false,
  },
    {
      version: "6.191",
      title: "Missing-price recovery for audited low-volume and NAV assets",
      date: "2026-06-27",
      effectiveAt: 1782518400,
      summary:
        "Expanded targeted missing-price recovery without relaxing global freshness or depeg guardrails.",
      impact: [
        "`autoUSD` and `sYUSD` now use authoritative ERC-4626 `convertToAssets(1 share)` NAV pricing against their trusted parent assets",
        "ERC-4626 NAV overrides run before lower-priority RPC-backed override families so missing wrapper prices are less likely to be skipped by the shared live override budget",
        "`usdn-noble` now inherits fresh replay-safe tracked `m-m0` pricing as an M0-backed rebasing Noble unit",
        "`usdk-kast` and `xo-exodus` can inherit a fresh replay-safe single-source `wm-m0` parent price while still rejecting cached, stale, fallback, and untrusted parents",
        "`usdn-smardex` and `cadm-mento` join the scoped `coingecko-low-volume` fallback allowlist when CoinGecko has a near-peg quote inside the relaxed low-volume freshness window",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.19",
      title: "Authoritative override budget prioritization",
      date: "2026-06-24",
      effectiveAt: 1782259200,
      summary:
        "Live authoritative protocol overrides now attempt cache/local repairs before RPC-backed probes and prioritize still-missing prices within each provider tier.",
      impact: [
        "Local protocol-par and inherited tracked-base overrides can no longer be skipped behind slower ERC-4626 or redeem-preview RPC calls when the 10-second live override budget is exhausted",
        "RPC-backed override candidates that are still missing a price are attempted before already-priced wrapper candidates in the same cost tier",
        "The override registry remains stable for ties, preserving existing provider order when priority and missing-price state are equal",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.18",
      title: "Fiat FX upside validation parity",
      date: "2026-06-23",
      effectiveAt: 1782172800,
      summary:
        "Fresh or static fiat FX peg references now use the same upside tolerance ratio as USD pegs, while commodity references keep their broader 2x validation band.",
      impact: [
        "EUR, JPY, GBP, and other fiat FX pegs now reject reference-backed upside prints at the USD-band ratio instead of allowing prices up to 2x the FX reference",
        "Gold and silver commodity pegs retain the existing 2x reference band because their token prices scale with volatile metal spot references and `commodityOunces`",
        "Authoritative downside modes remain unchanged, so protocol redemption and historical backfill paths can still admit deep downside when that mode explicitly allows it",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.17",
      title: "DEX aggregate and high-TVL outlier guards",
      date: "2026-06-19",
      effectiveAt: 1781861094,
      summary:
        "Primary pricing now withholds the aggregate `dex-promoted` fallback whenever a promoted protocol DEX candidate exists, and the high-TVL pool challenge can ignore incoherent same-direction outliers when a coherent multi-protocol subset still corroborates the depeg.",
      impact: [
        "`dex-promoted` can no longer re-enter consensus as an aggregate fallback after the same bridge row produced a promoted protocol candidate that was rejected for registry, freshness, TVL, or corroboration reasons",
        "The aggregate DEX fallback remains available only when no promoted protocol candidate exists for the asset and the Binance overlap guard is clear",
        "High-TVL directional pool challenge now selects the largest coherent same-direction protocol subset, so one incoherent outlier no longer vetoes otherwise corroborated DEX replacement evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.16",
      title: "DEX pool replacement price validation",
      date: "2026-06-14",
      effectiveAt: 1781465182,
      summary:
        "Pool-challenge protocol medians must now pass the same peg-aware DEX observation validation used by DEX liquidity before they can downgrade or replace a primary price.",
      impact: [
        "Inverse or otherwise implausible commodity pool marks are ignored before pool-challenge divergence and replacement checks",
        "`pool-tvl-weighted` can still publish corroborated DEX replacements when the protocol medians are plausible for the asset's peg and denomination",
        "Commodity tokens such as one-ounce gold assets can no longer be published at near-zero inverse prices from malformed challenger rows",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.15",
      title: "DexScreener liquidity breaker isolation",
      date: "2026-06-07",
      effectiveAt: 1780825118,
      summary:
        "Optional DexScreener liquidity and discovery pool lookups now use their own circuit breaker, preserving the exact-address stablecoin price fallback when liquidity recovery is slow or unavailable.",
      impact: [
        "`dexscreener-prices` now protects only the exact token-address stablecoin pricing fallback",
        "`dexscreener-liquidity` protects optional DEX liquidity and discovery pool lookups and is excluded from public-impact breaker counts",
        "`sync-dex-liquidity` records one aggregate DexScreener fallback outcome per run, so target-level failures or budget exhaustion cannot trip a source breaker multiple times in one run",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.14",
      title: "Depeg-sized hard-corroborated DEX replacement",
      date: "2026-06-06",
      effectiveAt: 1780763002,
      summary:
        "Pool challenge can now replace a depeg-sized soft consensus price when a high-TVL DEX protocol median agrees with a hard primary candidate.",
      impact: [
        "The single-protocol replacement exception no longer requires the published soft result itself to be inside the peg depeg threshold",
        "The replacement still requires at least $5M of protocol-level DEX TVL, depeg-sized DEX evidence, material divergence from the published soft result, and hard market/oracle/protocol candidate agreement",
        "Uncorroborated single-protocol divergence, same-protocol noisy pools, and incoherent cross-protocol DEX prices still preserve the original price while downgrading confidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.13",
      title: "RedStone stablecoin-id attribution",
      date: "2026-06-06",
      effectiveAt: 1780752518,
      summary:
        "RedStone oracle quotes are now attributed by configured canonical stablecoin id before primary consensus, preventing same-symbol assets from sharing one hard-oracle feed.",
      impact: [
        "Each `REDSTONE_SYMBOL_CONFIG` entry declares the stablecoin id that may consume that feed",
        "Consensus looks up RedStone quotes by stablecoin id, not by bare asset symbol",
        "The live RedStone `USDH` feed is pinned to Native Markets USDH because its source set is Hyperliquid/HypEVM-specific, so Hubble USDH no longer receives that quote",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.12",
      title: "High-TVL directional DEX pool challenge",
      date: "2026-06-05",
      effectiveAt: 1780693172,
      summary:
        "Pool challenge can now replace a recovered soft consensus price when multiple high-TVL DEX protocol medians coherently show the same depeg direction.",
      impact: [
        "The standard replacement path still replaces when at least two protocol medians diverge beyond the peg-aware pool threshold",
        "A high-TVL multi-protocol path now also replaces a near-peg soft result when at least two protocol medians each carry at least $5M TVL, cross the peg depeg threshold in the same direction, diverge from the soft result by at least the depeg threshold, and agree with each other inside the existing pool-challenge bps band",
        "The single-protocol exception remains hard-corroborated only; same-protocol noisy-pool protection and incoherent cross-protocol prices still preserve the original price while downgrading confidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.11",
      title: "High-TVL hard-corroborated pool challenge",
      date: "2026-06-05",
      effectiveAt: 1780643100,
      summary:
        "Pool challenge can now replace a recovered soft consensus price when a high-TVL DEX protocol median is depeg-sized and agrees with a hard primary candidate.",
      impact: [
        "The standard replacement path still requires at least two independent diverging DEX protocols",
        "A single-protocol replacement is now allowed only when the protocol median carries at least the existing $5M high-TVL threshold, the published price is still inside the peg depeg threshold, and a hard market/oracle/protocol candidate agrees with that DEX mark",
        "This keeps same-protocol noisy-pool protection while allowing APXUSD-style Curve on-chain plus Curve DEX evidence to override a near-peg soft cluster",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.1",
      title: "DEX pricing source utilization expansion",
      date: "2026-05-24",
      effectiveAt: 1779648809,
      summary:
        "Primary pricing now uses more of the existing DEX surface through additional hard Curve routes, Uniswap V3/V4 protocol lanes, restored aggregate fallback behavior, and low-depth exact-address/Jupiter augmentation.",
      impact: [
        "Hard Curve on-chain coverage now includes audited direct pools plus explicit opt-in one-hop and chained-hop routes that fail closed on missing dependencies or cycles",
        "`uniswap-v3-dex` and `uniswap-v4-dex` can enter consensus as soft DEX lanes when `dex_prices.price_sources_json` publishes corroborated protocol evidence",
        "At v6.1, `dex-promoted` was withheld only when a promoted protocol DEX lane was actually admitted, so rejected lone protocol candidates did not suppress the aggregate DEX voice",
        "Exact-address providers prioritize missing and low-depth priced assets, report request-cap skips, and Jupiter can append bounded soft evidence to agreeing low-depth Solana prices without replacing the primary price",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.09",
    title: "Weak address-provider depeg withholding",
      date: "2026-05-24",
      effectiveAt: 1779645688,
      summary:
        "Single-source fallback/search-family address quotes can no longer publish fixed-peg depeg-sized prices without corroboration.",
      impact: [
        "Exact-address augmentation can still fill or corroborate near-peg prices for thin assets",
        "A fallback/search-family source such as CoinGecko Onchain address pricing is rejected when it is at least 500 bps from a fixed peg and no stronger source corroborates the move",
        "Rejected weak address-provider candidates fall through to later enrichment, allowing exact DefiLlama contract fallback to repair assets such as Tangent USG when that contract quote remains near peg",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.08",
      title: "Scoped live-parent wrapper price repair",
      date: "2026-05-24",
      effectiveAt: 1779616228,
      summary:
        "Audited wrapper assets can use fresh high-confidence live parent prices even when the parent consensus includes address-derived providers.",
      impact: [
        "sBOLD and yBOLD can publish ERC-4626 NAV prices from BOLD when BOLD's same-run consensus is fresh and high-confidence",
        "KAST USDK and XO Cash can inherit fresh high-confidence wM pricing as scoped M0 extension units",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.07",
      title: "Curated production price-gap closure",
      date: "2026-05-24",
      effectiveAt: 1779608084,
      summary:
        "Audited production gaps now recover through scoped CoinGecko, FX-par, and curated on-chain repair paths.",
      impact: [
        "MNEE and VEUR join the allowlisted `coingecko-low-volume` fallback",
        "CADD and Mento JPY/ZAR/XOF stables can use FX-par `protocol-redeem` pricing plus fail-closed on-chain zero-supply repair",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.06",
      title: "DexScreener symbol-search retirement",
      date: "2026-05-22",
      effectiveAt: 1779438171,
      summary:
        "The last-resort DexScreener symbol-search fallback is retired after production probes showed Worker-side upstream refusals and no live price recoveries.",
      impact: [
        "`dexscreener-search` remains visible as a legacy circuit key, but new stablecoin sync runs no longer call `/latest/dex/search`",
        "DexScreener exact-address fallback remains available through the separate `dexscreener-prices` lane",
        "Addressless assets that cannot resolve through DefiLlama, CoinMarketCap, Jupiter, CoinGecko low-volume recovery, or an exact tracked deployment now remain explicitly missing instead of probing noisy symbol search",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.05",
      title: "DexScreener address breaker hardening",
      date: "2026-05-20",
      effectiveAt: 1779262200,
      summary:
        "DexScreener exact-address primary augmentation is now explicit opt-in, and address-provider circuit accounting ignores blocked or locally skipped runs.",
      impact: [
        "`dexscreener-address` remains available as a weight-1 soft primary-consensus source when operators explicitly include it in `ADDRESS_PRICE_PROVIDERS_ENABLED`",
        "Unset address-provider configuration now defaults to DexPaprika plus configured key-backed providers, avoiding quarter-hourly calls to DexScreener's Cloudflare/WAF-protected public token endpoint",
        "Open address-provider circuits no longer accumulate additional failures from skipped blocked runs; only actual upstream attempts can fail the provider breaker",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.04",
      title: "DexScreener address augmentation throttle",
      date: "2026-05-18",
      effectiveAt: 1779134950,
      summary:
        "DexScreener exact-address primary augmentation now limits itself to one token batch per stablecoin sync and stops immediately on hard upstream refusal.",
      impact: [
        "`dexscreener-address` remains a weight-1 soft primary-consensus source, but its public `/tokens/v1/{chain}/{addresses}` lane is now explicitly opportunistic under the 15-minute sync cadence",
        "A DexScreener `429` / Cloudflare 1015 response no longer causes the same sync run to send the remaining address batches, reducing repeated source-wide breaker opens",
        "Valid empty DexScreener token-batch responses still count as healthy coverage misses, so thin or unindexed addresses do not poison breaker state",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.03",
      title: "XOF secondary FX peg support",
      date: "2026-05-14",
      effectiveAt: 1778769294,
      summary:
        "West African CFA franc pegs now have explicit XOF metadata, secondary daily FX references, chart reconciliation, and deterministic validation bounds.",
      impact: [
        "`xofm-mento` can be tracked as an active XOF-pegged stablecoin instead of being forced into OTHER or rejected by peg metadata validation",
        "`peggedXOF` uses the same dated `fawazahmed0/currency-api` secondary FX cadence as CNH, RUB, UAH, ARS, KGS, NGN, and VND for live sync, realtime fallbacks, and historical backfills",
        "Price validation now classifies XOF as `fiat_fx` with explicit USD/XOF hardcoded bounds for no-reference guardrails",
        "The CoinGecko native-peg lane remains disabled for XOF because CoinGecko does not currently expose a usable `xof` simple-price quote",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.02",
      title: "Derivative and redemption-par gap closure",
      date: "2026-05-13",
      effectiveAt: 1778684601,
      summary:
        "Active assets with observable supply but missing market prices can now resolve through guarded parent inheritance, fee-adjusted redemption inheritance, or scoped redemption-par references.",
      impact: [
        "`m-m0` inherits the tracked `wm-m0` live price through the same trusted-parent gate used by downstream M0 extension units",
        "`weusd-picwe` inherits tracked `usdc-circle` pricing with the documented 1% redemption-fee haircut, so market cap reflects the bounded USDC exit rather than a missing secondary-market quote",
        "`sofid-sofi`, `usbd-bima`, and `usdq-quill` can publish nominal `protocol-redeem` USD parity when active supply is observable and the redemption path is already source-reviewed in the backstop registry",
        "`chfau-allunity` can publish `protocol-redeem` CHF parity only when the current CHF/USD FX reference is fresh or static; stale or absent FX data fails closed",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.01",
      title: "Composite-parent NAV inheritance freshness",
      date: "2026-05-13",
      effectiveAt: 1778684217,
      summary:
        "Protocol-backed NAV wrappers can now inherit from fresh same-run high-confidence composite parent prices even when the composite's oldest component timestamp is older than one short-window source.",
      impact: [
        "`gtusdc-gauntlet` recovers its ERC-4626 `protocol-redeem` price from on-chain `convertToAssets(1 share)` times the tracked `usdc-circle` parent instead of publishing a weak DEX/GeckoTerminal market price",
        "The fallback applies only to replay-safe composite parents with a fresh `priceSyncedAt`; low-confidence, stale-sync, cached, single-source, or non-replay-safe parent prices still cannot upgrade into child `protocol-redeem` prices",
        "The CoinGecko drift status comparison explicitly ignores frozen archive rows, so discontinued assets such as BUCK do not dominate the active price-drift watchlist",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.0",
      title: "Moralis quota-bounded exact-address augmentation",
      date: "2026-05-13",
      effectiveAt: 1778674334,
      summary:
        "Moralis exact-address augmentation now uses the documented 100-token batch size and a smaller per-run request cap so the 15-minute sync cadence stays inside the provider's free daily compute-unit envelope.",
      impact: [
        "`moralis-address` remains a weight-1 soft primary-consensus candidate and is still optional through `ADDRESS_PRICE_PROVIDERS_ENABLED`",
        "The Moralis pass is capped at 3 batch requests per sync, down from 10 smaller batches, reducing worst-case daily usage from about 96k CUs/day to about 28.8k CUs/day at the current 15-minute cadence",
        "CoinGecko-only detail pages now record circuit health from upstream transport success instead of stale or empty per-asset history, so expected history gaps fall back to local supply history without opening the source-wide breaker",
      ],
      commits: [],
      reconstructed: false,
    },
];
