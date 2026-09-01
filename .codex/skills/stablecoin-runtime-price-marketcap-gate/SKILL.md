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

- Require `detailProvider: "coingecko"`. This is the hard gate. A verified `geckoId` is the primary route (confirm `https://api.coingecko.com/api/v3/coins/{geckoId}` resolves to the intended asset), but a coin without one can still be admitted via the on-chain supply route below.
- With a `geckoId`: require a positive current USD price through the DefiLlama `coins.llama.fi` proxy or CoinGecko `/simple/price`, and either positive CoinGecko `usd_market_cap` or the on-chain supply route.
- On-chain supply route: verified `contracts[]` deployments whose total supply is valued at the peg reference price. A single supported deployment works out of the box; multi-deployment assets are admissible too but need a curated entry in `CURATED_ONCHAIN_SUPPLY_CONTRACTS` / `CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS` (`shared/lib/onchain-supply-probe.ts`; the source file wins on what is supported).

### 3. Commodity supplemental path

Use for gold/silver and similar commodity tokens.

- Require verified `geckoId`.
- Require commodity-specific metadata such as `commodityOunces` when fractionalized (it feeds peg-aware price-validation bounds, not market cap).
- Require positive CoinGecko market cap, or for gold protocol-backed assets a `protocolSlug` whose DefiLlama protocol data exposes usable `mcap`. Silver has no `protocolSlug` path. It resolves via CoinGecko markets plus circulating supply.

### 4. Explicit runtime exception

Use only for maintained source-specific integrations.

- Name the source and repo code path.
- Show how it returns price.
- Show how it returns circulating supply or market cap.

Existing integrations of this kind include Zephyr Scanner, parent-derived pricing for inherited tracked assets (`worker/src/lib/authoritative-price-sources/`), reserve-NAV oracle pricing gated on `liveReservesConfig.adapter`, and supply-gap reconciliation for DefiLlama-listed coins. Name the specific code path when invoking this route.

## How Price Is Actually Established

At runtime, price providers are fetched in parallel and cross-validated into a consensus (`worker/src/cron/sync-stablecoins/stages.ts`); this gate proves the asset is *eligible* for that consensus set, not that one provider will be "the" price source. The single accepted-path framing applies to market-cap/supply admission, which genuinely is path-based.

Additional providers strengthen price reliability but do not by themselves prove market-cap admission. The provider inventories are code-owned. Never trust a hand-list: primary collection in `worker/src/cron/sync-stablecoins/enrich-prices-primary-provider-collection.ts`, ordered fallbacks in `enrich-prices-fallback.ts`, the CoinGecko low-volume allowlist in `enrich-prices-coingecko-low-volume-pass.ts`, and authoritative protocol overrides in `worker/src/lib/authoritative-price-sources/`.

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

