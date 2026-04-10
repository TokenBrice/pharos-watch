# Investigation: `usdk-kast` / `xo-exodus` missing price, DEX, and liquidity history

## Scope

Investigate why `usdk-kast` and `xo-exodus` currently show:

- no price
- no DEX liquidity
- no liquidity history on the detail page

The comparison set from the same batch was:

- working: `wm-m0`, `usdat-saturn`, `usdnr-nerona`
- broken: `usdk-kast`, `xo-exodus`

## Current live state

### 1. The main stablecoin payload publishes both assets, but both are still unpriced

Live `/_site-data/stablecoins` currently returns:

- `usdk-kast`
  - `price: null`
  - `priceSource: "missing"`
  - `priceConfidence: null`
  - `supplySource: "onchain-total-supply"`
- `xo-exodus`
  - `price: null`
  - `priceSource: "missing"`
  - `priceConfidence: null`
  - `supplySource: "onchain-total-supply"`

The same batch contains working controls:

- `wm-m0`
  - `price: 1`
  - `priceSource: "coingecko+raydium-dex"`
- `usdat-saturn`
  - `price: 1.001`
  - `priceSource: "coingecko+defillama-list+dex-promoted"`
- `usdnr-nerona`
  - `price: 1.0034`
  - `priceSource: "dexscreener"`

### 2. Peg summary confirms there is no admitted price evidence for either asset

Live `/_site-data/peg-summary` currently returns:

- `usdk-kast`
  - `consensusSources: []`
  - `dexPriceCheck: null`
  - `priceSource: "missing"`
- `xo-exodus`
  - `consensusSources: []`
  - `dexPriceCheck: null`
  - `priceSource: "missing"`

That rules out a frontend formatting problem. The pricing pipeline is publishing no usable price evidence for either coin.

### 3. Liquidity history API is not empty; it is placeholder-only

Live `/_site-data/dex-liquidity-history?stablecoin=...&days=3` returns rows for both assets, for example:

- `tvl: 0`
- `volume24h: 0`
- `score: null`
- `coverageClass: "unobserved"`
- `liquidityEvidenceClass: "unobserved"`
- `trendworthy: false`

So the page’s “no history” state is not caused by a missing API payload. The stored history exists, but it is an explicit unobserved placeholder series.

## Metadata and cohort comparison

Relevant metadata entries:

- `shared/data/stablecoins/usd-minor.json:9791` `wm-m0`
- `shared/data/stablecoins/usd-minor.json:9915` `usdk-kast`
- `shared/data/stablecoins/usd-minor.json:9976` `xo-exodus`

Key differences:

- `wm-m0`
  - has `geckoId: "wrappedm-by-m0"`
  - has a Solana contract
  - depends on `m-m0` with dependency type `wrapper`
- `usdk-kast`
  - Solana-only contract
  - no `geckoId`
  - depends on `m-m0` with dependency type `wrapper`
- `xo-exodus`
  - Solana-only contract
  - has `geckoId: "xo-cash"`
  - depends on `m-m0` with dependency type `mechanism`

All three sit in the `m0` infrastructure cohort, but only `wm-m0` currently has admitted trusted market evidence on the exact tracked mint.

## Root cause 1: missing price

### How the pipeline decides whether to price a coin

`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:133` only sends assets into primary consensus when they have at least one eligible primary pricing surface, such as:

- `geckoId`
- DefiLlama list quote
- configured oracle / hard source
- usable DEX rows

`usdk-kast` has none of those today:

- no `geckoId`
- no DefiLlama list price
- no trusted DEX rows
- no configured authoritative override

`xo-exodus` enters through `geckoId`, but its `geckoId` does not resolve to a usable price.

### Upstream checks show the trusted sources are actually empty

#### Jupiter exact-mint pricing

`https://lite-api.jup.ag/price/v3?...`

- `wm-m0`: returns `usdPrice` and `liquidity`
- `xo-exodus`: only `createdAt` and `decimals`
- `usdk-kast`: absent entirely

That matters because `worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts:74` only accepts Jupiter rows when both:

- `usdPrice` is present
- `liquidity >= 50_000`

Neither broken asset clears that gate.

#### DexScreener exact token lookup

`https://api.dexscreener.com/latest/dex/tokens/{mint}`

- `usdk-kast`: `pairCount = 0`
- `xo-exodus`: `pairCount = 0`
- `wm-m0`: `pairCount = 1` on Raydium with real liquidity and price

That aligns with the later DexScreener fallback logic in `worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts`.

#### CoinGecko

Public CoinGecko spot checks currently show:

- `wrappedm-by-m0`: has USD price
- `saturn-dollar`: has USD price
- `xo-cash`: empty result object
- CoinGecko search for `KAST Dollar`: no listing
- `xo-cash` tickers endpoint: zero tickers

### Pricing conclusion

The repo is not dropping an available price for either coin. The exact tracked mints currently lack usable trusted market inputs across the pricing surfaces the worker admits.

This is therefore not a “fallback bug” in the current price passes. It is an asset-coverage gap.

### What can fix price honestly

There is already a repo pattern for authoritative inherited pricing in `worker/src/lib/authoritative-price-sources.ts:336`:

- `usdai-usd-ai` inherits `pyusd-paypal`

That is the closest existing mechanism for these assets:

- `wm-m0` already has admitted market evidence
- `usdk-kast` and `xo-exodus` are M0 extension assets whose executable value is described by the product as 1:1 with the same underlying M0 reserve unit

Among tracked parents, `wm-m0` is the stronger candidate over `m-m0` because live data currently shows:

- `m-m0`
  - `priceSource: "defillama-contract"`
  - `priceConfidence: "single-source"`
- `wm-m0`
  - `priceSource: "coingecko+raydium-dex"`
  - `priceConfidence: "high"`

## Root cause 2: no DEX liquidity

### The worker is intentionally publishing these assets as unobserved

`worker/src/cron/dex-liquidity/persistence.ts:109` writes placeholder rows for tracked assets with no DEX metrics:

- `liquidity_score = NULL`
- `coverage_class = "unobserved"`
- TVL / volume / counts all zeroed

`worker/src/cron/dex-liquidity/persistence.ts:284` does the same for daily history rows in `dex_liquidity_history`.

That is exactly what live API responses show for both assets.

### Upstream market checks show no direct pools for the exact mints

The useful exact-mint checks all agree:

- DexScreener exact token query: no pairs
- Jupiter exact mint query: no usable market quote for either mint
- CoinGecko:
  - `xo-cash` has zero tickers
  - `usdk-kast` has no listing

No evidence was found that the current pipeline is missing a real direct DEX pool for either exact mint.

### DEX/liquidity conclusion

For canonical Liquidity Score purposes, the current `unobserved` state is accurate under the existing methodology.

There is no honest bugfix that turns these assets into directly traded DEX assets unless a new trusted direct market source starts returning real pools for their exact mints.

Any attempt to alias their liquidity to `wm-m0` or `m-m0` inside the liquidity scorer would be a methodology change that fabricates direct-market evidence for a different token.

## Root cause 3: no liquidity history on the detail page

### The history exists, but the card hides it

The detail card currently derives:

- `const isRated = liq.liquidityScore != null`

in `src/components/dex-liquidity-card.tsx:454`.

It then gates the history rendering behind:

- `src/components/dex-liquidity-card.tsx:628`
  - `{isRated && <TvlTrendChart stablecoinId={stablecoinId} />}`

That means:

- rated assets get the chart
- explicitly unobserved assets do not, even though history rows exist and the API already classifies them

### History conclusion

This is a real frontend behavior bug:

- backend: working as designed
- API: returning useful placeholder semantics
- frontend: suppressing that state entirely

## Constraints for remediation

### Safe and honest

- price may be inherited only through an explicit authoritative-provider rule
- DEX/liquidity must remain specific to the tracked mint
- unobserved liquidity must remain unrated

### Unsafe and should not be done

- do not alias `tradedContracts` for `usdk-kast` / `xo-exodus` to `wm-m0`
- do not inject coin-specific manual prices
- do not synthesize fake DEX pools or fake liquidity history

## Recommended remediation direction

### 1. Price

Add an explicit authoritative inherited-price provider for:

- `usdk-kast -> wm-m0`
- `xo-exodus -> wm-m0`

Use the same live + historical replay pattern already used for `usdai-usd-ai -> pyusd-paypal`.

### 2. DEX/liquidity

Keep canonical DEX/liquidity unrated for the exact mints unless a direct market actually appears in trusted sources.

If product wants these pages to feel less broken, solve that in the detail-page presentation:

- explain that no direct DEX market is currently observed
- keep related-market navigation separate from canonical liquidity metrics

### 3. Liquidity history

Show an explicit unobserved-history state on the detail page instead of hiding the history section entirely when `liquidityScore` is null.

## Bottom line

These three symptoms do not share one cause:

- missing price: lack of admitted trusted market sources for the two exact assets
- missing DEX/liquidity: accurate `unobserved` state because no direct pools are currently found
- missing liquidity history on-page: frontend gating bug hiding placeholder history that already exists

That split should drive the remediation plan: fix price with an explicit inherited-authoritative path, leave canonical liquidity honest, and repair the detail-page history presentation.
