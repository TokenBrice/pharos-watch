---
name: stablecoin-runtime-price-marketcap-gate
description: Prove that a proposed active stablecoin can enter Pharos runtime data with both a fetchable price and a fetchable market-cap/circulating-supply path. Use before active additions and pre-launch promotions.
user_invocable: true
---

# Runtime Price + Market-Cap Gate

This is a hard pre-edit gate for active stablecoin additions and pre-launch promotions. A metadata-complete JSON row is not enough: Pharos must be able to fetch both a current price and a market-cap / circulating-supply value. This skill is read-only preflight; a passing gate does not authorize registry edits.

Pre-launch entries are exempt until promotion.

Use `npm run research:dwellir-rpc --` for supplemental pinned on-chain evidence reads; see `docs/process/agent-artifacts.md#pinned-on-chain-evidence`.
Cite its provenance record (keyless URL, block, timestamp); never cite `latest` reads as evidence.

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
- Require positive observed `circulating` supply for admission, not merely a non-null object. Validate buckets with `getCirculatingRawOrNull()` in `shared/lib/supply.ts`; empty or invalid buckets are unavailable. DefiLlama list values are already USD-denominated; do not multiply by price.

### 2. CoinGecko supplemental fiat path

Use for non-DefiLlama fiat assets.

- Require `detailProvider: "coingecko"`. This is the hard gate. A verified `geckoId` is the primary route (confirm `https://api.coingecko.com/api/v3/coins/{geckoId}` resolves to the intended asset), but a coin without one can still be admitted via the on-chain supply route below.
- With a `geckoId`: require a positive current USD price through the DefiLlama `coins.llama.fi` proxy or CoinGecko `/simple/price`, and either positive CoinGecko `usd_market_cap` or the on-chain supply route. Record upstream observation timestamps and apply the source-owned freshness rules in `shared/lib/pricing-source-registry.ts`; `resolveSupplementalCoinGeckoMcap()` in the supplemental `shared.ts` rejects missing, stale, or future `last_updated_at`, even for a positive cap.
- Without a `geckoId`, independently prove a positive observed price. The existing DefiLlama contract-price resolver (`resolveSupplementalContractPrice()` in `worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts`) requires a supported single canonical deployment, matching symbol, sufficient confidence, current timestamp, and peg-aware price bounds. Record the actual response fields and observation time; a positive supply packet alone fails this gate.
- On-chain supply route: verified `contracts[]` deployments admitted by `hasRuntimeOnchainSupplyPath()` in `shared/lib/onchain-supply-probe.ts`. A single supported deployment needs no curated roster; multi-deployment assets need `CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS` with whole-asset coverage or the explicit residual policy (the source file wins). Runtime values supply at an observed price when available; only plain non-NAV/non-yield-bearing fiat assets may fall back to the peg reference. NAV/yield-bearing assets require an observed price or a maintained authoritative NAV supply path. Supply valuation never proves an observed price. A curated aggregate does not enable the single-contract price resolver; without CoinGecko, independently prove a maintained price integration.

### 3. Commodity supplemental path

Use for gold/silver and similar commodity tokens.

- Require verified `geckoId`.
- Require positive `commodityOunces` (troy ounces per token) for every active gold/silver asset, including 1-ounce tokens; `getCommodityOuncesIssue()` in `scripts/ci/check-stablecoin-data.ts` enforces it. This feeds peg references and price-validation bounds, not market cap.
- Require positive, fresh CoinGecko market cap, a reviewed curated aggregate on-chain supply path, or for gold a dedicated single-token `protocolSlug` accepted by `shared/lib/commodity-protocols.ts` whose DefiLlama data exposes positive `mcap`. Silver has no protocol-mcap path; it also supports fresh CoinGecko markets `circulating_supply` valued at the observed price. The commodity drivers in `worker/src/cron/sync-stablecoins/supplemental-assets/` own these paths.

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

Return the gate portion of the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet). The format below also works standalone:

```text
Runtime gate: PASS/FAIL
Accepted path: DefiLlama | CoinGecko supplemental | Commodity | Explicit exception
Identity match: <evidence>
Price path: <source and field>
Market-cap path: <source and field>
Source observations: <URLs/fields, retrieval time, upstream observation times or document dates, on-chain pins if applicable>
Admission verdicts: <source-owned freshness/admission rule and result/reason for each price and supply source>
Required metadata: <llamaId/geckoId/detailProvider/contracts/protocolSlug/etc.>
Risks or follow-ups: <CMC slug, contract ambiguity, low volume, backfill needs>
Verification: <source reads actually exercised and their results; catalog checks/runtime observations still unexercised>
```

If the gate fails, do not add the asset as active. Recommend pre-launch/watchlist tracking or a separate runtime-source integration.

Do not bootstrap shared artifacts or repeat catalog checks for this preflight. The addition orchestrator owns the integrated generation/check pass after authorized specialist source edits land; this gate must already have passed before those active-entry edits.

