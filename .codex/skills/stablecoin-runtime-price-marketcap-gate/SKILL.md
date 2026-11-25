---
name: stablecoin-runtime-price-marketcap-gate
description: Prove a proposed active stablecoin has a fetchable price and market-cap or supply path. Use before additions, promotions and re-admissions. Read-only; not for pre-launch drafts or listing class.
---

# Runtime Price + Market-Cap Gate

This skill executes the hard pre-edit gate in [Phase 1a](../../../docs/process/adding-a-stablecoin.md#1a-hard-runtime-data-gate-for-active-assets), which owns the acceptance criteria and the pre-launch exemption. It adds only fetch mechanics, rejection traps and source pointers.

For pinned RPC reads and provenance, follow [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence).

## Scope And Exclusions

- Read-only. A PASS does not authorize registry edits, and the gate regenerates nothing.
- It proves runtime fetchability for the exact asset, not scope: the instrument test and listing class are decided under [Listing Classes](../../../docs/listing-policy.md#listing-classes). A `tokenized-fund` still needs this gate; a PASS never makes a fund share a stablecoin.
- Also run it to re-check an incumbent whose runtime coverage is in doubt ([Ongoing Runtime Review](../../../docs/listing-policy.md#ongoing-runtime-review)) or before reactivating a quarantined row.
- Supply-gap reconciliation (`worker/src/cron/sync-stablecoins/supply-gap-reviewed-pairs.ts`) repairs one missing chain on an already DefiLlama-listed coin. It is never an admission path.

## Inputs

- Proposed canonical ID, name, and symbol
- Candidate `llamaId`, `geckoId`, `cmcSlug`, `detailProvider`, `protocolSlug`
- Candidate `contracts[]` with chain, address, decimals
- Peg currency and commodity metadata, if applicable

## Accepted Paths

### 1. DefiLlama stablecoins path

- Fetch `https://stablecoins.llama.fi/stablecoins?includePrices=true`; match by `llamaId`, then confirm name, symbol and issuer identity.
- Require a usable price field. Validate buckets with `getCirculatingRawOrNull()` in `shared/lib/supply.ts`; empty or invalid buckets are unavailable. List `circulating` is already USD.
- Fetch `https://stablecoins.llama.fi/stablecoin/<llamaId>` and reconcile its chains and contracts with the candidate deployments; a row that reads a retired contract or a recycled identity does not pass ([Reviewed DefiLlama bindings](../../../docs/supply-snapshot.md#reviewed-defillama-bindings)).

### 2. CoinGecko supplemental fiat path

- A verified `geckoId` is the primary route: confirm `https://api.coingecko.com/api/v3/coins/{geckoId}` resolves to the intended asset.
- With a `geckoId`: fetch the current USD price through the DefiLlama `coins.llama.fi` proxy or CoinGecko `/simple/price`, plus CoinGecko `usd_market_cap` or on-chain supply evidence. Record upstream observation timestamps and apply the freshness rules in `shared/lib/pricing-source-registry.ts`; `resolveSupplementalCoinGeckoMcap()` in `worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts` rejects a missing, stale or future `last_updated_at` even for a positive cap. `resolveLowVolumeCoinGeckoPrice()` in the same file is the supplemental low-volume fallback.
- Without a `geckoId`: `resolveSupplementalContractPrice()` in that file. It runs only while `geckoId` is absent, and requires a supported single canonical deployment, matching symbol, sufficient confidence, a current timestamp and peg-aware bounds. A positive supply packet alone fails this gate.
- On-chain supply route: verified `contracts[]` deployments admitted by `hasRuntimeOnchainSupplyPath()` in `shared/lib/onchain-supply-probe.ts`. One supported deployment needs no roster; a multi-deployment asset needs a reviewed plan in `REVIEWED_ONCHAIN_SUPPLY_PLANS` with whole-asset coverage or its explicit residual policy (the source file wins). Only plain non-NAV, non-yield-bearing fiat assets may value supply at the peg reference; NAV or yield-bearing assets need an observed price or a maintained authoritative NAV path. Supply valuation never proves an observed price, and a curated aggregate does not enable the single-contract price resolver.

### 3. Commodity supplemental path

- Fetch the verified `geckoId` price. `getCommodityOuncesIssue()` and `getCommodityProtocolSlugIssue()` in `scripts/ci/check-stablecoin-data.ts` enforce the commodity-ounce requirement and the dedicated gold slugs in `shared/lib/commodity-protocols.ts`; any other `protocolSlug` on a gold or silver token fails.
- Supply follows the commodity paths in Phase 1a, owned by the drivers in `worker/src/cron/sync-stablecoins/supplemental-assets/`. Silver has no protocol-mcap path.

### 4. Explicit runtime exception

Only for a maintained source-specific integration. Name the source and repo code path, and show separately how it returns price and how it returns circulating supply or market cap. The code-owned exception lists are `nativeWorkflow` and `preferMcap` in `REVIEWED_ONCHAIN_SUPPLY_PLANS`, `RESERVE_NAV_PRICE_SOURCES` in `worker/src/lib/reserve-nav-price.ts`, and `worker/src/lib/authoritative-price-sources/`; a candidate absent from them has no exception until its integration lands.

## Rejection Traps

A single positive quote is not a PASS. Runtime withholds these; check each before reporting the price path:

- DefiLlama exact-par and fill-default quotes: a list price exactly on the peg reference that many list rows share, or a `coins.llama.fi` contract quote whose value repeats across unrelated assets, is unavailable without independent corroboration (`detectDefiLlamaContractFillDefaultPrices()` in `shared/lib/pricing-source-policy.ts`; [Primary Consensus](../../../docs/pricing-pipeline.md#primary-consensus)). Fetch a few unrelated contract quotes and compare.
- CoinGecko micro-volume outliers: request `include_24hr_vol=true`; the thresholds beside `COINGECKO_MICRO_VOLUME_OUTLIER_REASON` in `shared/lib/pricing-source-policy.ts` own the rejection.
- No real market: inspect CoinGecko tickers for `is_stale`, identifiable venues and depth, and 14-day `market_chart` continuity. A high-confidence aggregator quote with no identifiable venue, or a history with multi-day gaps, fails the gate or is reported as a risk with the evidence.
- Identity: a symbol-level DEX search, an unmatched contract quote or a same-symbol asset fails ([Price And Exit Evidence](../../../docs/listing-policy.md#price-and-exit-evidence)).

## How Price Is Actually Established

Runtime fetches price providers in parallel and cross-validates them into a consensus (`worker/src/cron/sync-stablecoins/stages.ts`); this gate proves the asset is eligible for that set, not that one provider will be the source. The single accepted path applies to market-cap and supply admission. The provider inventories are code-owned, never a hand list: `enrich-prices-primary-provider-collection.ts`, `enrich-prices-fallback.ts` and `enrich-prices-coingecko-low-volume-pass.ts` in `worker/src/cron/sync-stablecoins/`, and `worker/src/lib/authoritative-price-sources/`.

## Output Format

Return the gate portion of the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet). The format also works standalone:

```text
Runtime gate: PASS/FAIL
Accepted path: DefiLlama | CoinGecko supplemental | Commodity | Explicit exception
Identity match: <evidence>
Price path: <source and field>
Market-cap path: <source and field>
Source observations: <URLs/fields, retrieval time, upstream observation times or document dates, on-chain pins if applicable>
Admission verdicts: <source-owned freshness/admission rule and result/reason for each price and supply source>
Rejection traps: <each trap above: checked and clear, or the finding>
Supply observation: circulating=<observed USD peg buckets> url=<source> field=<field> retrievedAtSec=<unix> observedAtSec=<unix | null>
Required metadata: <llamaId/geckoId/detailProvider/contracts/protocolSlug/etc.>
Risks or follow-ups: <CMC slug, contract ambiguity, thin market, backfill needs>
Verification: <source reads actually exercised and their results; catalog checks/runtime observations still unexercised>
```

`Supply observation` carries the fields `npm run safety-score-v9:admit-receipt` reads for a prospective receipt ([5j](../../../docs/process/adding-a-stablecoin.md#5j-safety-score-admission-receipt-new-asset-evidence-packet)); `observedAtSec` is `null` when the source has no observation clock.

On FAIL, follow Phase 1a: do not add the asset as active. Report the missing lane so a publicly issued coin can be held as [Launched, awaiting data](../../../docs/process/adding-a-stablecoin.md#launched-awaiting-data).
