import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V6: readonly MethodologyChangelogEntry[] = [
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
