---
name: stablecoin-runtime-price-marketcap-gate
description: Prove that a proposed active stablecoin can enter Pharos runtime data with both a fetchable price and a fetchable market-cap/circulating-supply path. Use before active additions and pre-launch promotions.
user_invocable: true
---

# Runtime Price + Market-Cap Gate

This is a hard gate for active stablecoin additions and pre-launch promotions. A metadata-complete JSON row is not enough: Pharos must be able to fetch both a current price and a market-cap / circulating-supply value.

Pre-launch entries are exempt until promotion.

## Inputs

- Proposed canonical ID, name, and symbol
- Candidate `llamaId`, `geckoId`, `cmcSlug`, `detailProvider`, `protocolSlug`
- Candidate `contracts[]` with chain, address, decimals
- Peg currency and commodity metadata, if applicable

## Accepted Paths

### 1. DefiLlama stablecoins path

Use for normal DefiLlama-tracked active stablecoins.

- Fetch `https://stablecoins.llama.fi/stablecoins?includePrices=true`.
- Match by `llamaId`, then confirm name/symbol/issuer identity.
- Require a usable price field.
- Require non-null `circulating` data from the list response. DefiLlama list `circulating` values are already USD-denominated; do not multiply by price.

### 2. CoinGecko supplemental fiat path

Use for non-DefiLlama fiat assets.

- Require `detailProvider: "coingecko"` and a verified `geckoId`.
- Confirm `https://api.coingecko.com/api/v3/coins/{geckoId}` resolves to the intended asset.
- Require a positive current USD price through DefiLlama `coins.llama.fi` proxy or CoinGecko `/simple/price`.
- Require either positive CoinGecko `usd_market_cap`, or exactly one supported verified `contracts[]` deployment that can support on-chain total-supply fallback.

### 3. Commodity supplemental path

Use for gold/silver and similar commodity tokens.

- Require verified `geckoId`.
- Require commodity-specific metadata such as `commodityOunces` when fractionalized.
- Require positive CoinGecko market cap, or for gold/protocol-backed assets a `protocolSlug` whose DefiLlama protocol data exposes usable `mcap`.

### 4. Explicit runtime exception

Use only for maintained source-specific integrations such as Zephyr Scanner or an audited low-volume allowlist.

- Name the source and repo code path.
- Show how it returns price.
- Show how it returns circulating supply or market cap.

## Optional Corroboration

These strengthen price reliability but do not by themselves prove market-cap admission:

- `pythFeedId`
- `cmcSlug`
- verified CEX ticker coverage
- RedStone / Curve / protocol redeem path
- DexScreener or Jupiter exact contract coverage
- CoinGecko low-volume allowlist

## Output Format

Report:

```text
Runtime gate: PASS/FAIL
Accepted path: DefiLlama | CoinGecko supplemental | Commodity | Explicit exception
Identity match: <evidence>
Price path: <source and field>
Market-cap path: <source and field>
Required metadata: <llamaId/geckoId/detailProvider/contracts/protocolSlug/etc.>
Risks or follow-ups: <CMC slug, contract ambiguity, low volume, backfill needs>
```

If the gate fails, do not add the asset as active. Recommend pre-launch/watchlist tracking or a separate runtime-source integration.

