# Stablecoin ID Disambiguation Research

Date: 2026-03-03
Status: Research only (no implementation in this phase)
Target change: canonical stablecoin IDs everywhere as `ticker-name` (for example `usdc-circle`, `usdf-falcon-finance`)

Companion checklist for iterative prep:
- `docs/plans/future/newid-migration-readiness-tasklist.md`

## Key Findings (Current)

1. The codebase still treats stablecoin IDs as DefiLlama-first identifiers in many critical places.
2. ID format assumptions are hardcoded in validator regexes, route handling, cron pipelines, static maps, and tests.
3. Symbol collisions are real today; some client-side symbol-to-ID code silently overwrites one coin with another.
4. D1 tables are mostly generic `TEXT stablecoin_id`, so schema shape is mostly compatible, but all row values and many docs/examples must be migrated.
5. There are many hardcoded numeric IDs in frontend and worker logic that must be replaced.

## Baseline: Current ID Landscape

### Registry and type assumptions

- `src/lib/stablecoins.ts:40-41` says tracked IDs are DefiLlama numeric IDs.
- `src/lib/types.ts:109` types `StablecoinMeta.id` as DefiLlama numeric ID (comment).
- `src/lib/types.ts:71` and `src/lib/types.ts:82` describe dependency/reserve links as DefiLlama IDs.
- `src/lib/stablecoins.ts:3729` and `src/lib/stablecoins.ts:3732` build global maps/sets keyed by `id`.

### Actual current ID mix (tracked)

`TRACKED_STABLECOINS` distribution:
- Total: 150
- Numeric: 130
- `cg-*`: 13
- `gold-*`: 6
- `silver-*`: 1

`SHADOW_STABLECOINS` distribution:
- Total: 2 (`3`, `iron-finance`)

### Static data keyspaces

- `data/logos.json`: 264 keys
  - numeric 243, `cg-*` 13, `gold-*` 7, `silver-*` 1
- `data/ai-summaries.json`: 153 keys
  - numeric 132, `cg-*` 13, `gold-*` 7, `silver-*` 1

## Collision Evidence (Why Disambiguation Is Needed)

Case-insensitive duplicate symbols in tracked coins:

- `usdf`: `246` Falcon USD, `219` Astherus
- `cusd`: `296` Cap cUSD, `24` Celo Dollar
- `usda`: `220` Avalon USDa, `245` Anzens USDA
- `gusd`: `306` Gate USD, `19` Gemini Dollar
- `pusd`: `341` Pleasing USD, `266` Plume USD
- `reusd`: `339` Re Protocol reUSD, `256` Resupply USD
- `usdu`: `283` Unitas, `304` USDU Finance
- `msusd`: `326` Metronome Synth USD, `297` Main Street USD
- `usdm`: `342` MegaUSD, `215` Moneta

### Live collision bug surface

- `src/hooks/use-portfolio.ts:59-71` builds `symbolToId` with lowercase symbol key.
- Duplicates overwrite previous entries silently; final mapping depends on array order.
- Result: URL/deeplink parsing by symbol can resolve to the wrong coin.

### Canonical candidate sanity check

- Generated candidate IDs using `slug(symbol)-slug(name)` across tracked + shadow coins produced:
  - 152 inputs
  - 152 generated IDs
  - 0 collisions
- This is a data-point only, not a final policy decision.

## Blast Radius Inventory

## 1) Core Metadata and Identity Layer

- `src/lib/stablecoins.ts`
  - IDs embedded in every coin entry.
  - Reserve/dependency `coinId` values include many numeric IDs.
- `src/lib/types.ts`
  - Comments and semantics assume DefiLlama IDs.
- `src/lib/shadow-stablecoins.ts:7-10`
  - Mixed style (`3`, `iron-finance`) already exists.
- `src/lib/psi-eligible.ts:5-7`
  - PSI identity joins tracked + shadow IDs.
- `src/lib/dead-stablecoins.ts` and `src/lib/types.ts:324`
  - Defunct dataset uses `llamaId` for identity fallback.
- `worker/src/api/report-cards.ts:195`
  - Defunct report-card IDs currently resolve via `dead.llamaId` fallback.
- `src/app/portfolio/client.tsx:29-35`
  - Live coin options exclude dead coins via `DEAD_STABLECOINS[].llamaId`.

### Observed reserve/dependency link usage

From tracked metadata:
- `dependencies[]`: 12 links, all numeric IDs.
- `reserves[].coinId`: 108 links, 106 numeric, 2 prefixed.

## 2) API Validation and Route Contracts

- `worker/src/lib/api-utils.ts:119-120`
  - `isValidStablecoinId()` only allows numeric or `gold|silver|cg-` prefixes.
- `worker/src/router.ts:213-223`
  - `/api/stablecoin/:id` enforces that validator.

Endpoints using stablecoin ID validation:
- `worker/src/api/depeg-events.ts`
- `worker/src/api/dex-liquidity-history.ts`
- `worker/src/api/supply-history.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/mint-burn-events.ts`
- `worker/src/api/stress-signals.ts`
- `worker/src/api/feedback.ts` (sanitizes invalid `stablecoinId`)

Backfill endpoints with stablecoin filters (map-based lookup rather than regex):
- `worker/src/api/backfill-cg-prices.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-depegs.ts`

## 3) Worker Pipelines with Hardcoded ID Assumptions

### Prefix/format assumptions

- `worker/src/api/stablecoin-detail.ts:223`
  - `id.startsWith("cg-")` branch.
- `worker/src/cron/sync-stablecoins.ts:24`
  - `FIAT_CG_METAS` filtered by `id.startsWith("cg-")`.
- `worker/src/api/backfill-supply-history.ts:226`
  - skips `gold-/silver-/cg-` IDs via regex.

### Hardcoded ID maps/sets

- `worker/src/lib/mint-burn-contracts.ts:121-219`
  - `MINT_BURN_CONFIGS` uses explicit numeric IDs.
  - `SAFE_HAVEN_IDS` derived from these IDs.
- `worker/src/cron/yield-config.ts`
  - `YIELD_VARIANT_MAP` keyed by old IDs.
  - `YIELD_POOL_MAP` keyed by old IDs.
  - `ON_CHAIN_RATE_CONFIGS` stores stablecoin IDs.
  - `PRICE_DERIVED_FALLBACK_IDS` set of IDs.
  - `AUTO_LENDING_POOL_MAP` and `AUTO_LENDING_SAFETY_BYPASS_IDS` keyed by IDs.
- `worker/src/lib/bluechip-slugs.ts:3-21`
  - Bluechip slug map points to old IDs.
- `worker/src/cron/compute-dews.ts:15-25`
  - `BLACKLIST_SYMBOL_TO_IDS` hardcodes old IDs.
- `worker/src/api/backfill-depegs.ts:42-46`
  - `OTHER_COIN_FX` keyed by old IDs.
- `worker/src/api/backfill-depegs.ts:432-435`
  - `CG_ABOVE_PEG_EXCLUSIONS` hardcodes coin `1`.
- `worker/src/cron/sync-stablecoins.ts:613-616`
  - `ADDRESS_OVERRIDES` keyed by old IDs (`213`, `67`).
- `src/lib/peg-rates.ts:9`
  - `COMMODITY_MEDIAN_EXCLUDES` hardcodes `gold-dgld`.

### Symbol-only side channel

- `worker/src/cron/sync-blacklist.ts` stores event `stablecoin` symbol in DB.
- `worker/src/api/blacklist.ts:20` allows only `USDC`, `USDT`, `PAXG`, `XAUT`.
- This pipeline is symbol-keyed, not ID-keyed.

## 4) Frontend Hardcoded IDs and URL/Identity Behavior

- `src/components/category-stats.tsx:41`
  - hardcoded exclusions for `"1"` and `"2"`.
- `src/components/market-pulse.tsx:185-186`
  - USDT/USDC dominance by `"1"` and `"2"`.
- `src/components/total-mcap-chart.tsx:37-40`
  - hardcoded `useSupplyHistory("1"|"2"|"209"|"5")`.
- `src/hooks/use-endpoint-probes.ts:11,20,21`
  - probes hardcoded `/api/stablecoin/1`, `stablecoin=1`.
- `src/hooks/use-portfolio.ts:240-253`
  - `MAJOR_CENTRALIZED_IDS` hardcoded old IDs.
- `src/app/compare/client.tsx:71,156,187`
  - comments + behavior still treat numeric IDs as primary URL format.
- `src/app/stablecoin/[id]/page.tsx:13-15`
  - static params generated from current IDs.
- `src/app/sitemap.ts:157-164`
  - stablecoin URLs emitted directly from current IDs.

## 5) Database and Persistence Impact

All major analytics tables use `stablecoin_id` as TEXT and will need value migration.

Primary tables:
- `depeg_events` (`worker/migrations/0006_depeg_events.sql`)
- `depeg_pending` (`worker/migrations/0023_depeg_pending.sql`)
- `dex_liquidity` (`worker/migrations/0009_dex_liquidity.sql`)
- `dex_liquidity_history` (`worker/migrations/0010_dex_liquidity_history.sql`)
- `dex_prices` (`worker/migrations/0011_dex_prices.sql`)
- `onchain_supply` (`worker/migrations/0013_onchain_supply.sql`)
- `supply_history` (`worker/migrations/0015_supply_history.sql`)
- `yield_data` (`worker/migrations/0031_yield_data.sql`, `0041_yield_data_multi_source.sql`)
- `yield_history` (`worker/migrations/0031_yield_data.sql`)
- `stress_signals` and `stress_signal_history` (`worker/migrations/0032_stress_signals.sql`)
- `mint_burn_events` and `mint_burn_hourly` (`worker/migrations/0031a_mint_burn_v2.sql`)

Legacy/symbol tables:
- `blacklist_events.stablecoin` is symbol-based (`worker/migrations/0001_initial.sql`).
- old `mint_burn_events` schema (`worker/migrations/0019_mint_burn_events.sql`) is symbol-based.

Critical exception:
- `dex_liquidity` uses sentinel `__global__` row (`worker/src/cron/dex-liquidity/persistence.ts:77-99`, `src/lib/types.ts:518`).
- `__global__` is not a stablecoin ID and must never be remapped.

## 6) Cache Payloads and Data Artifacts Keyed by ID

- Per-coin detail cache key: `detail:${id}` in `worker/src/api/stablecoin-detail.ts:166`.
- `report_card_cache` stores `scores: Record<id, ...>` in `worker/src/cron/sync-yield-data.ts:181-188`.
- Bluechip ratings cache payload keyed by Pharos ID in `worker/src/cron/sync-bluechip.ts:94-109`.
- Frontend static JSON lookups are ID-keyed:
  - `data/logos.json`
  - `data/ai-summaries.json`
  - read in `src/app/stablecoin/[id]/page.tsx:8-12,97-100`.

## 7) Tests and Fixtures Impacted

Representative impacted test surfaces:

- Worker API tests with hardcoded `stablecoin=1` or IDs:
  - `worker/src/api/__tests__/supply-history.test.ts`
  - `worker/src/api/__tests__/dex-liquidity-history.test.ts`
  - `worker/src/api/__tests__/yield-history.test.ts`
  - `worker/src/api/__tests__/depeg-events.test.ts`
  - `worker/src/api/__tests__/mint-burn-events.test.ts`
  - `worker/src/api/__tests__/mint-burn-flows.test.ts`
  - `worker/src/api/__tests__/stress-signals.test.ts`
  - `worker/src/api/__tests__/feedback.test.ts`
- Worker cron tests:
  - `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `worker/src/cron/__tests__/sync-mint-burn.test.ts`
  - `worker/src/cron/__tests__/compute-dews.test.ts`
  - `worker/src/cron/__tests__/detect-depegs.test.ts`
- Frontend/library tests:
  - `src/lib/__tests__/critical-invariants.test.ts`
  - `src/lib/__tests__/reserve-coinid-validation.test.ts`
  - `src/lib/__tests__/reserve-templates.test.ts`
  - `src/__tests__/portfolio-categorize.test.ts`

Fixture defaults hardcode old IDs:
- `worker/src/api/__tests__/helpers/fixtures.ts` defaults many fields to `"1"`.

## 8) Documentation and Process Docs That Must Be Updated

High-priority docs with old ID conventions:
- `docs/api-reference.md:11-21` (ID formats section).
- `docs/process/adding-a-stablecoin.md:22-35` (ID decision tree still numeric/cg/custom integer).
- `docs/cemetery-and-compare.md:47-55` (compare says numeric primary IDs).
- `docs/supply-snapshot.md:61` (describes `stablecoin_id` as DefiLlama numeric).
- `docs/classification.md:71` (synthetic ID examples still prefix-based).

Existing related plan:
- `docs/plans/future/coin-id-disambiguation.md` exists but is not exhaustive across all concrete file-level blast radius.

## 9) Operational Scripts/Runbooks Also Impacted

- `scripts/backfill-gold-depegs.sh`
  - hardcoded list of `gold-*` IDs sent to `?stablecoin=`.
- `scripts/fetch-logos.ts`
  - explicitly maps CoinGecko IDs to internal IDs (`EXTRA_GECKO_IDS` contains `gold-*` keys).
- Any local/admin curl snippets using numeric IDs in docs and notes must be updated.

## 10) Additional Inconsistencies Found During Audit

1. `shadow` ID `iron-finance` is not accepted by `isValidStablecoinId()` today.
2. Symbol-based parsing in portfolio and compare fallback can be ambiguous under collisions.
3. Multiple places still semantically conflate internal ID with DefiLlama ID.
4. Defunct/cemetery identity currently depends on `llamaId` in both API and frontend filtering.

## 11) External Service Coupling (Critical)

Several worker paths currently pass internal `id` directly to external provider endpoints that expect provider-native IDs.

- `worker/src/api/stablecoin-detail.ts:289`
  - Calls DefiLlama detail endpoint using incoming internal ID:
  - `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(id)}`
- `worker/src/api/backfill-supply-history.ts:239`
  - Backfill calls DefiLlama detail endpoint with `meta.id`.
- `worker/src/api/backfill-depegs.ts:316`
  - Backfill calls DefiLlama detail endpoint with `meta.id`.

Implication:
- After moving to canonical `ticker-name` internal IDs, these calls must use a separate `llamaId` mapping field, not internal ID.
- Same principle applies to all CoinGecko/Bluechip/Protocol lookups: internal ID must be decoupled from provider IDs.

## 12) Routing, Static Generation, and SEO Compatibility

Stablecoin IDs are currently embedded directly into static routes and SEO metadata.

- `src/app/stablecoin/[id]/page.tsx:13-15`
  - `generateStaticParams()` emits tracked IDs.
- `src/app/stablecoin/[id]/page.tsx:37-44,118,127`
  - canonical URL, OG URL, JSON-LD URL, breadcrumb path all include current ID.
- `src/app/sitemap.ts:157-164`
  - sitemap emits `https://pharos.watch/stablecoin/${coin.id}/`.
- `src/app/stablecoins/[peg]/page.tsx:79,115`
  - links to stablecoin detail pages via `coin.id`.

Implication:
- Canonical ID rollout changes all detail URLs.
- A redirect/alias layer is required for old numeric and legacy prefixed IDs to preserve indexed pages and shared links.

## 13) Observability and Analytics Surfaces

GA-style tracking payloads include per-coin identifiers; changing ID format affects downstream analytics continuity.

- `src/lib/analytics.ts:23-27`
  - event payload contracts include `coin_id` and `coin_ids` fields.
- `src/app/portfolio/client.tsx:400-411`
  - emits `portfolio_coin_removed` / `portfolio_coin_added` with `coin_id`.
- `src/app/compare/client.tsx:366-369`
  - emits `comparison_created` with comma-joined `coin_ids`.
- `src/components/key-info-card.tsx:199`
  - emits `contract_copied` with `coin_id`.

Implication:
- Historical analytics uses old IDs, new events will use canonical IDs unless translated.
- If analytics dashboards expect numeric IDs, reporting and cohorts break unless migration mapping is applied in BI.

## 14) Additional Future-Scope Storage Contracts

Future-plan docs already define more `stablecoin_id` keyed tables; if implemented later, they should adopt canonical IDs from day one.

- `docs/plans/future/2026-03-01-grade-history.md`
  - proposes `grade_history(stablecoin_id, ...)`.
- `docs/plans/future/2026-03-03-telegram-bot-alert-subscriptions-mvp-reference.md`
  - proposes subscription keys with `stablecoin_id`.

Implication:
- Avoid adding new numeric-ID debt in upcoming features.
- Canonical migration should be resolved before introducing new persisted ID-keyed features where possible.

## 15) Symbol-Encoded URL State (Collision-Prone Entry Points)

Several frontend flows still encode coin identity in URL symbols, not IDs.

- `src/app/stablecoin/[id]/client.tsx:222`
  - Compare CTA links with `?coins=${coin.symbol.toLowerCase()}`.
- `src/app/compare/client.tsx:63-69,155-169`
  - Compare accepts `coins=` values as either IDs or lowercased symbols.
  - Presets are symbol-based (`usdt`, `usdc`, etc.).
- `src/hooks/use-portfolio.ts:59-107`
  - Portfolio URL parser/encoder is symbol-based (`?p=symbol:amount,...`).
- `src/app/portfolio/client.tsx:226-234`
  - Portfolio writes symbol-based URL state.
- `src/hooks/use-stress-test.ts:59-65,111-120`
  - Stress test parses `?stress=` via symbol lookup.
- `src/app/safety-scores/client.tsx:142-145`
  - Stress test writes `stress=<symbol>` to URL.
- `scripts/screenshot-og.mjs:28`
  - Portfolio OG capture uses `?p=USDT:10000,...` symbol-based query.

Implication:
- Canonical `ticker-name` IDs alone do not remove ambiguity if symbol-encoded URL state remains.
- For colliding symbols (`usdf`, `cusd`, `usdm`, etc.), symbol URLs can still resolve to the wrong coin unless query contracts migrate to IDs.

## 16) Live DEWS Blacklist Mapping Drift (Critical Finding)

`worker/src/cron/compute-dews.ts` contains stale hardcoded ID mappings for blacklist signal attribution:

- `worker/src/cron/compute-dews.ts:15-20`
  - `USDC -> ["5"]` (but `5` is DAI in tracked metadata).
  - `PAXG -> ["49"]` and `XAUT -> ["87"]` (tracked IDs are `gold-paxg` and `gold-xaut`).
- `worker/src/cron/compute-dews.ts:268-312`
  - These IDs drive `blacklistEvents24h/7d` assignment per coin.
- `src/lib/stablecoins.ts:112,295,3180,3199`
  - Confirms current tracked IDs: USDC=`2`, DAI=`5`, XAUT=`gold-xaut`, PAXG=`gold-paxg`.

Implication:
- This is an existing production fragility signal: hardcoded ID maps already drifted and can misattribute risk.
- Migration scope must include all hardcoded map rewrites + validation checks, not just central metadata replacement.

## 17) Status/Health Monitoring Also Depends on ID Joins

The operational status endpoint computes data quality via ID joins between D1 and cached assets.

- `worker/src/api/status.ts:279-330`
  - Reads `onchain_supply.stablecoin_id`.
  - Joins by `asset.id` from cached `stablecoins` payload for divergence checks.

Implication:
- Partial remaps (DB updated but cache not, or vice versa) can produce false divergence/staleness metrics and mislead ops.
- Migration plan must include synchronized cache invalidation/rebuild and not only table row rewrites.

## 18) DEX Liquidity Pipeline Still Uses Symbol Fallback

- `worker/src/cron/dex-liquidity/fetch-primary.ts:230-239`
  - Resolution path is address-first, then symbol fallback.

Implication:
- Canonical IDs reduce many problems, but symbol-collision risk remains wherever fallback-to-symbol is still active and address coverage is incomplete.
- Post-migration hardening should minimize symbol fallback or gate it with stronger disambiguation.

## 19) Semi-Structured Persisted Payloads Carry IDs Too

Not all persisted identity appears in `stablecoin_id` SQL columns.

- `worker/src/api/digest-snapshot.ts:4-15`
  - `daily_digest.input_data` schema includes `biggestSupplyChange.id`.
- `worker/src/api/digest-snapshot.ts:50-57`
  - Historical depeg event payloads expose `stablecoin_id` -> `stablecoinId`.

Implication:
- Historical API payloads may still surface old IDs after table migrations.
- Decide whether to remap historical JSON blobs offline or translate at read-time.

## 20) Process/Docs Encode Numeric-First Mental Model

- `docs/api-reference.md:13-20`
  - API docs define ID forms with numeric DefiLlama IDs as primary.
- `docs/process/adding-a-stablecoin.md:171`
  - Logos workflow says keys are ordered numeric first.
- `docs/process/adding-a-stablecoin.md:204-220`
  - Backfill guidance is explicitly split by numeric vs `cg-`.

Implication:
- Canonical-ID migration requires process migration, not only code migration.
- Without doc/runbook updates, operators will keep reintroducing old patterns.

## 21) Quantified Footprint Snapshot (Repo Scan)

Pattern-based file counts from current repo scan:

- Files mentioning `stablecoin=` query usage: 46
- Files mentioning `stablecoin_id` (SQL/persistence surfaces): 92
- Files using `llamaId`: 14
- Files with symbol-to-ID URL/state surfaces (`symbolToId`, `?p=`, `stress=`): 13
- Non-test files with representative hardcoded numeric IDs: 33
- Tests containing `stablecoin=1`/`stablecoinId: "1"`/`/stablecoin/1`: 18
- Docs with numeric-ID examples or wording: 20
- App/component/hook files with route or payload `stablecoinId` coupling: 23

These counts are not exact migration task counts, but they quantify that the blast radius is broad and cross-layer.

## 22) Additional Concrete File Index (Newly Surfaced)

ID/validator boundary:
- `worker/src/lib/api-utils.ts:118-120`
- `worker/src/router.ts:213-223`

Symbol-based URL entry points:
- `src/app/stablecoin/[id]/client.tsx:222`
- `src/app/compare/client.tsx:63-69,155-169`
- `src/hooks/use-portfolio.ts:59-107`
- `src/app/portfolio/client.tsx:226-234`
- `src/hooks/use-stress-test.ts:59-65,111-120`
- `src/app/safety-scores/client.tsx:142-145`

Ops/status joins:
- `worker/src/api/status.ts:279-330`

Hardcoded map drift:
- `worker/src/cron/compute-dews.ts:15-20,268-312`
- `src/lib/stablecoins.ts:112,295,3180,3199`

Symbol fallback in data pipelines:
- `worker/src/cron/dex-liquidity/fetch-primary.ts:230-239`

Static routing/SEO URL emission:
- `src/app/stablecoin/[id]/page.tsx:13-15,37-44,118,127`
- `src/app/stablecoins/[peg]/page.tsx:75-80`
- `src/app/sitemap.ts:157-164`

Runbooks/scripts:
- `scripts/fetch-logos.ts:10-13,37-46`
- `scripts/backfill-gold-depegs.sh:19-37`
- `scripts/screenshot-og.mjs:28`
- `src/hooks/use-endpoint-probes.ts:11,20,21`

## 23) Expanded Canonical-ID Sanity Check (Live + Dead Datasets)

Expanded `slug(symbol)-slug(name)` candidate generation across tracked + shadow + dead datasets:

- Inputs total (live + dead): 230
- Inputs live only (tracked + shadow): 152
- Candidate collisions, live only: 0
- Candidate collisions, live + dead: 2

The 2 collisions are duplicate historical entities appearing in both live-shadow and dead datasets:

- `ust-terrausd`
  - live shadow: `id=3`, `UST`, `TerraUSD`
  - dead set: `llamaId=3`, `UST`, `TerraUSD`
- `iron-iron`
  - live shadow: `id=iron-finance`, `IRON`, `IRON`
  - dead set: `dead-iron`, `IRON`, `IRON`

Implication:
- `ticker-name` remains collision-free for live tracked identity.
- Dead/shadow overlap needs an explicit policy (single canonical identity vs dual records with aliasing) before finalizing full-universe ID migration.

## 24) Raw File Checklist (Machine-Generated Buckets)

These lists are grep-generated to reduce rediscovery during implementation. They are intentionally broad and include some adjacent files that need manual triage.

### API query surfaces (`stablecoin=`)

```text
src/hooks/use-depeg-events.ts
src/hooks/use-dex-liquidity-history.ts
src/hooks/use-endpoint-probes.ts
src/hooks/use-prefetch-stablecoin.ts
src/hooks/use-stress-signals.ts
src/hooks/use-yield-history.ts
worker/src/api/dex-liquidity-history.ts
worker/src/api/supply-history.ts
worker/src/api/yield-history.ts
worker/src/api/__tests__/blacklist.test.ts
worker/src/api/__tests__/depeg-events.test.ts
worker/src/api/__tests__/dex-liquidity-history.test.ts
worker/src/api/__tests__/mint-burn-events.test.ts
worker/src/api/__tests__/mint-burn-flows.test.ts
worker/src/api/__tests__/stress-signals.test.ts
worker/src/api/__tests__/supply-history.test.ts
worker/src/api/__tests__/yield-history.test.ts
```

### Validator/route boundary

```text
worker/src/lib/api-utils.ts
worker/src/router.ts
src/hooks/use-prefetch-stablecoin.ts
src/hooks/use-endpoint-probes.ts
```

### Symbol-URL state surfaces

```text
scripts/screenshot-og.mjs
src/app/compare/client.tsx
src/app/portfolio/client.tsx
src/app/safety-scores/client.tsx
src/app/stablecoin/[id]/client.tsx
src/hooks/use-portfolio.ts
src/hooks/use-stress-test.ts
src/components/coin-selector.tsx
```

### Hardcoded map/set hotspots

```text
worker/src/cron/compute-dews.ts
worker/src/api/backfill-depegs.ts
worker/src/cron/sync-stablecoins.ts
worker/src/cron/yield-config.ts
worker/src/lib/mint-burn-contracts.ts
worker/src/api/mint-burn-flows.ts
worker/src/cron/sync-mint-burn.ts
worker/src/cron/sync-yield-data.ts
worker/src/cron/yield-helpers.ts
```

### Migrations and persisted schemas with coin identity fields

```text
worker/migrations/0001_initial.sql
worker/migrations/0006_depeg_events.sql
worker/migrations/0008_depeg_dedup.sql
worker/migrations/0009_dex_liquidity.sql
worker/migrations/0010_dex_liquidity_history.sql
worker/migrations/0011_dex_prices.sql
worker/migrations/0013_onchain_supply.sql
worker/migrations/0015_supply_history.sql
worker/migrations/0017_dex_history_unique.sql
worker/migrations/0018_daily_digest.sql
worker/migrations/0019_mint_burn_events.sql
worker/migrations/0023_depeg_pending.sql
worker/migrations/0031_yield_data.sql
worker/migrations/0031a_mint_burn_v2.sql
worker/migrations/0032_stress_signals.sql
worker/migrations/0041_yield_data_multi_source.sql
```

### Test suites with hardcoded legacy IDs

```text
src/lib/__tests__/critical-invariants.test.ts
worker/src/api/__tests__/backfill-dews.test.ts
worker/src/api/__tests__/backfill-mint-burn-prices.test.ts
worker/src/api/__tests__/dex-liquidity-history.test.ts
worker/src/api/__tests__/feedback.test.ts
worker/src/api/__tests__/mint-burn-events.test.ts
worker/src/api/__tests__/mint-burn-flows.test.ts
worker/src/api/__tests__/stress-signals.test.ts
worker/src/api/__tests__/supply-history.test.ts
worker/src/api/__tests__/yield-history.test.ts
worker/src/cron/__tests__/compute-dews.test.ts
worker/src/cron/__tests__/detect-depegs.test.ts
worker/src/cron/__tests__/sync-mint-burn.test.ts
worker/src/cron/__tests__/sync-stablecoins.test.ts
```

### Core operator docs with legacy ID assumptions

```text
docs/api-reference.md
docs/architecture.md
docs/cemetery-and-compare.md
docs/process/adding-a-stablecoin.md
docs/scripts.md
docs/supply-snapshot.md
```

## Exhaustive Change Implications (What Will Need To Change)

1. A canonical ID generation rule and immutable mapping policy must be defined.
2. A global old-ID -> new-ID mapping must be created and versioned.
3. All stablecoin metadata IDs and all intra-metadata links (`dependencies`, `reserves[].coinId`) must be migrated.
4. Validator logic and route parameter expectations must be updated for the new canonical format.
5. Every hardcoded ID map/set in worker and frontend must be rekeyed.
6. Static ID-keyed artifacts (`logos`, `ai-summaries`, cache maps) must be rekeyed.
7. D1 row values for all `stablecoin_id` tables must be rewritten using the mapping.
8. Legacy numeric URLs and query params need backward compatibility handling during transition.
9. Test fixtures and assertions must be updated to canonical IDs.
10. Documentation, runbooks, and operational scripts must be updated to the new format.
11. External provider identifiers (DefiLlama numeric, CoinGecko IDs, Bluechip slugs) must remain separate fields and must not be used as internal primary keys.
12. Sentinel and non-coin keys (for example `__global__`) must be explicitly excluded from remapping.
13. Symbol-based URL/query contracts (`compare`, `portfolio`, `safety-scores`) must migrate to unambiguous ID encoding or keep a collision-safe translation layer.
14. All hardcoded symbol->ID and ID->provider maps (for example DEWS blacklist map, DEX helper maps) must be audited for stale/wrong mappings and revalidated after rekeying.
15. Monitoring/ops calculations that join cached payload IDs with table IDs (for example `/api/status` divergence checks) must be rolled out atomically with cache rebuild.
16. Semi-structured persisted payloads containing IDs (for example `daily_digest.input_data`) need a policy: historical rewrite vs read-time alias translation.

## Practical Migration Risks To Plan Around

- Cache fragmentation during rollout if old/new IDs both circulate.
- Partial DB remap can break joins across tables and produce silent analytics drift.
- Symbol collisions will keep causing ambiguity unless all symbol-based URL fallbacks are de-prioritized or removed.
- Historical/defunct coin references (`llamaId`) need a clear strategy so cemetery/report-card behavior stays stable.
- External API calls will silently fail if internal IDs are switched without provider-ID mapping separation.
- SEO regressions are likely without explicit 301 redirects from old detail routes.
- Ops dashboards can show false health regressions if `stablecoins` cache IDs and `onchain_supply` table IDs are briefly out of sync.
- Hardcoded map drift is already present (DEWS blacklist ID map), so migration without systematic map auditing risks shipping hidden misattribution bugs.

## Open Questions To Resolve Before Implementation

1. Canonical format details:
   - exact slug rules for symbols with punctuation (`USD+`, dots, mixed case).
2. Stability policy:
   - whether canonical IDs are immutable across rebrands/issuer changes.
3. Defunct/cemetery policy:
   - whether to keep `llamaId` as historical metadata only, and what `ReportCard.id` should be for dead coins.
4. Backward compatibility window:
   - how long old IDs remain accepted in API/query params and routes.
5. Analytics migration:
   - whether BI pipelines will remap historical IDs or split pre/post dimensions.
6. URL contract policy:
   - whether symbol-based URL state (`?coins=`, `?p=`, `?stress=`) is fully deprecated in favor of IDs.
7. Historical blob policy:
   - whether `daily_digest.input_data` and similar JSON blobs are rewritten or remapped at read time.

## Notes

- This document is research output only.
- No implementation changes were made in this phase.
