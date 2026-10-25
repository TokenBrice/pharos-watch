# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures non-restored cached `peggedAssets` whose IDs are PSI-eligible, stores their circulating supply (in USD) in D1, and uses that history for charting and replay.

PSI historical assets are eligible, but this cron reads only non-restored rows present in the cached `stablecoins` payload. Their source/history coverage remains unavailable unless observed in that cache or supplied by a separately evidenced historical backfill.

The snapshot does **not** call upstream APIs or on-chain RPCs. DefiLlama remains the primary source for regular assets, but the cached payload can include bounded CoinGecko aggregate gap-fill with matching missing-chain remainder attribution, DefiLlama history gap-fill rows, commodity/CoinGecko supplemental rows, on-chain-total-supply supplemental rows, and configured on-chain-circulating-supply rows assembled by the 15-minute `syncStablecoins()` cron. ADR-8 explicitly permits these documented, fail-closed, double-count-safe supplemental paths; they do not change the USD units of DefiLlama list supply.

The generic single-contract on-chain fallback in `fiat-cg.ts` preserves its successful probe's chain label and canonical chain ID as one public `chainCirculating` row. CoinGecko-detail caps may also receive the bounded share partition described in [Supply Pipeline](#supply-pipeline). Current-only rows omit unobserved historical amounts.

> **Agent navigation** — Grep `^## ` for Cron Schedule · Algorithm · Database Schema · Supply Data Source · API Endpoints · Frontend · Error Handling · Key Constraints · Supply Pipeline · Chain Dropout Guard. Within Supply Pipeline, grep `^### ` for CoinGecko aggregate gap-fill limits, circuit breakers and nullable chain-history contracts.

When DefiLlama publishes a tracked zero-supply row for an asset that also has positive supplemental coverage, `syncStablecoins()` keeps the positive supplemental row. This prevents a zero-valued primary duplicate from suppressing current CoinGecko or commodity supply before the snapshot publication-gap check runs.

---

## Cron Schedule

- **Primary schedule:** chained after each `*/15 * * * *` `sync-stablecoins` run (same-day upsert path after a safe stablecoins-cache write)
- **Safety-net fallback:** `0 8 * * *` (daily at 08:00 UTC)
- **Function:** `snapshotSupply(db: D1Database, signal?: AbortSignal, options?: SnapshotSupplyOptions): Promise<CronResult>`
- **File:** `worker/src/cron/snapshot-supply.ts`
- **Registration:** declared in `worker/wrangler.toml`; executed from both `worker/src/handlers/scheduled/quarter-hourly.ts` and `worker/src/handlers/scheduled/daily-0800.ts`

---

## Algorithm

1. Fetch, parse, and validate the object-shaped cached "stablecoins" payload via `loadStablecoinsCache(db, { mode: "strict" })`
2. For the 08:00 UTC safety-net fallback, require the `stablecoins` cache row to have `updated_at >= slotStartedAt`; if it still reflects the previous 07:45 run, return `status: "degraded"` with `reason: "stablecoins_cache_before_slot"` without consuming the marker — unless the day already has an identity-verified write, the current gap is non-systemic, and no required coin recovered since that write. That exception returns `ok` with `reason: "already_written_today_before_freshness_gate"`; an elevated gap adds the `upstream_publication_gap_elevated` quality finding. This bypasses only the slot-start gate: shared preflight rejects cache age > 1800 seconds before reading the marker.
3. Verify cache freshness (both snapshot crons derive these gates from the `sync-stablecoins` producer cadence — 900 s via the shared cache-freshness lane — instead of unanchored literals):
   - Cache age > 1800 seconds (two producer intervals): skip snapshot and return cron `status: "degraded"` with `reason: "cache_stale"`
   - Cache age > 900 seconds (one producer interval): `snapshot-supply` logs a degraded-freshness warning but proceeds; `snapshot-chain-supply` has no separate one-interval warning
4. Filter to `PSI_ELIGIBLE_STABLECOINS`; the eligibility registry owns the active and PSI historical-assets composition
5. Floor current date/time to UTC midnight:
   ```typescript
   const snapshotDate = Math.floor(
     Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
   );
   ```
6. Build the coverage identity and check the once-per-UTC-date guard:
   - read cache key `snapshot-supply:last-write`
   - coverage-version 2 markers bind the UTC date to a SHA-256 digest of the sorted required active IDs plus the exact applied waiver IDs, owners, and expiries; count-only version 1 markers remain readable but cannot authorize a writer skip. Partial version 2 markers retain truthful `accountedActiveCount < expectedActiveCount`, canonical `missingActiveIds`, and sorted `ownedRowIds`; identity verification is distinct from exact coverage. No version bump is needed: the prior Worker still requires count equality and refuses to skip a partial marker, while existing exact version 2 markers remain valid.
   - when the marker date/digest match, the current gap is non-systemic, and no required active ID recovered outside the marker's `ownedRowIds`, conditionally repair only same-day rows whose stored `price` is still `null` and whose current non-restored cache row now has a positive observed price (written with its observation clock); otherwise skip with `reason: "already_written_today"`. An unchanged partial day is not rewritten every 15 minutes. The skip/repair path stays `ok`; an elevated gap adds the `upstream_publication_gap_elevated` quality finding.
   - a required active ID that recovered since the last write (present now, absent from the prior `ownedRowIds`) bypasses the price-only repair and falls through to the full atomic date replacement in steps 9–11, so every cron-owned row for that date — including already-written circulating values and prices — is rewritten from the current observations
   - same-day repair never overwrites a non-null historical price, circulating supply, or rows outside cron ownership
7. For each PSI-eligible cached asset:
   - Skip rows marked `supplyRestored === true`; carried-forward supply is not a fresh daily observation
   - Read admitted circulating supply via `getCirculatingRawOrNull(asset)` --- already in USD
   - Skip unavailable supply; retain explicit observed zero
   - Extract price (must be a number > 0 and an actual observation per `isObservedPrice`, so a nominal par reference is `null`) with its observation clock `priceObservedAt` (`null` when absent or invalid)
   - Build `INSERT OR REPLACE` statement
8. Banded data-quality check: classify unwaived `missingActiveIds` as a share of `expectedActiveCount` using `classifyStablecoinPublicationGap()`: no gap preserves normal behavior; below 1% is routine (`ok`, no gap warning); 1–10% is elevated (write rows and marker; report `ok` with the `quality` finding `upstream_publication_gap_elevated`, because sync-stablecoins already degrades for the same gap and owns that verdict); above 10% is systemic (retain `partial_snapshot_blocked`, no write). Missing cache IDs and invalid non-restored supply get no daily row, never zero or carried-forward supply. Routine/elevated metadata exposes `publicationGap.band`, `missingActiveCount`, and the first 20 missing IDs; the marker retains all missing IDs. Restored-only active IDs count as accounted exclusions, not gaps: write fresh rows and retain `quality: { reason: "snapshot_written_restored_skipped", restoredOnlyIds }`, combined with gap metadata when applicable (both findings then appear in `quality.reasons`, the gap first). Non-restored PSI historical assets are written when present but do not block active-universe completion. Same-day recovery of a missing or restored required ID triggers atomic date replacement.
9. Atomically replace the cron-owned rows for the UTC date and write the completion marker in one bounded D1 batch. Multi-row inserts stay below the 100-bind limit. Supply-row deletion is restricted to the union of current PSI-eligible IDs and the prior structurally valid version 2 marker's sorted `ownedRowIds` (including partial markers), so same-day admin-backfill rows outside snapshot ownership are preserved. The marker certifies a committed observation set, not observation of every active coin.
10. If zero rows were prepared after passing the systemic-gap guard (for example, all eligible cached rows are restored and remaining required IDs are waived), return cron `status: "degraded"` with `reason: "all_coins_zero_supply"` without replacing rows or writing a marker. Despite the legacy reason name, observed zero supply is writable.
11. The same transaction updates cache key `snapshot-supply:last-write`; any statement failure rolls back the row replacement and marker together
12. Log item count and date

`snapshotSupply` also materializes the coverage-admitted daily basis for `/api/non-usd-share` after a committed full replacement. Already-written invocations bootstrap or repair a missing/mismatched basis without repeating the aggregation for an unchanged generation. Both aggregate/gap reads share one D1 transaction; publication compares the exact completion-marker bytes and original `updated_at` before writing `non-usd-share:daily:v1`. Full writes add a generation token so equal-second same-day replacements cannot share an identity. The projection retains the original source clock, not its computation time.

Readers fetch the projection and completion marker together, validate the cohort identity and point schema, then apply the requested window and existing daily/weekly/monthly sampling. Only an absent projection uses request-time aggregation as a rollout fallback, preserving the previous response and original snapshot clock (or latest sampled-point clock when no valid marker exists), without writing a publication or renewing timestamps. Present invalid or mismatched publication evidence returns `503`, no-store, with reason `non-usd-share-publication-unavailable`; it cannot be hidden by recomputation. The fast cache-only path applies as soon as the existing snapshot producer publishes. Projection failure reports `non_usd_share_publication_failed` while preserving the already committed supply rows/marker.

Historical backfills revise `historyRevision` inside the completion marker atomically with each bounded write chunk, without changing its observation clock. This invalidates any older derived basis and fences concurrent publishers; the next existing snapshot invocation rebuilds it. Price-only repairs do not invalidate supply aggregates. No cron schedule, external fetch or connection reservation is added.

---

## Database Schema

### supply_history

```sql
CREATE TABLE IF NOT EXISTS supply_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  circulating_usd REAL NOT NULL,
  price REAL,
  price_observed_at INTEGER,       -- 0253: actual observation clock of price (NULL = unknown)
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX idx_supply_hist_date ON supply_history(snapshot_date DESC);
```

| Column | Type | Description |
|--------|------|-------------|
| `stablecoin_id` | TEXT | Canonical ticker-issuer ID (e.g. `usdt-tether`) |
| `snapshot_date` | INTEGER | Unix seconds floored to UTC midnight |
| `circulating_usd` | REAL | Total market cap in USD |
| `price` | REAL | USD price at snapshot time (may be `null`). Since mint-burn-flow v6.23 the cron writes it only when the published price is an actual observation (`isObservedPrice`); a nominal par reference is stored as `null`. Rows written earlier can hold nominal par |
| `price_observed_at` | INTEGER | Actual observation time of `price` (the asset's `priceObservedAt`), migration `0253`. `null` when unknown: rows written before `0253` or by a prior Worker, admin backfill rows, and prices without an observation clock. Mint/burn event-time valuation admits a snapshot price only through this clock (±24h of the event), never through `snapshot_date` |

The primary key `(stablecoin_id, snapshot_date)` enforces one row per coin per UTC day. [Algorithm](#algorithm) owns first-write, null-price repair, recovered-required-ID replacement and atomic marker semantics. The table lives in `worker/migrations/0000_baseline.sql`, with `price_observed_at` added by `0253_supply_history_price_observed_at.sql`.

### onchain_supply

```sql
CREATE TABLE IF NOT EXISTS onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);
```

Per-chain supply cache. Not actively used by the current snapshot pipeline.

`sync-kinesis-supply` maintains KAU/KAG verification stock here. A declared Horizon `history_latest_ledger_closed_at` must be an ISO timestamp with valid Gregorian calendar and time components, not future-dated, and within `STATUS_ONCHAIN_FRESH_WINDOW_SEC` (the shared status freshness authority). Impossible dates and rollover times such as February 30 or `24:00:00` are malformed rather than normalized; valid explicit offsets and fractional seconds remain supported. Accepted rows retain that ledger observation time in `updated_at`, not the local write clock. `records[].date` selects the latest supply change but does not establish ledger freshness: an unchanged supply can have an old final change beside a fresh ledger.

Malformed, future or stale declared clocks return `ledger-clock-malformed`, `ledger-clock-future` or `ledger-clock-stale` and leave the last accepted stock and its clock untouched. Legacy objects, raw arrays and envelopes with no declared ledger clock explicitly retain local-fetch timestamps; a present but unusable clock never falls back to that policy. Numeric zero remains an admitted observation.

### chain_supply_history

```sql
CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `chain_id` | TEXT | Canonical chain identifier after shared resolver normalization (e.g. `ethereum`, `bsc`, `citrea`) |
| `snapshot_date` | INTEGER | Unix seconds floored to UTC midnight |
| `total_usd` | REAL | Total stablecoin supply on this chain in USD |
| `stablecoin_count` | INTEGER | Number of core-aggregate active stablecoins (`CORE_AGGREGATE_ACTIVE_IDS`) with positive supply on this chain |

- **Populated by:** `snapshot-chain-supply` cron stage (`worker/src/cron/snapshot-chain-supply.ts`) running in the `*/15 * * * *` quarter-hourly slot, chained after `snapshot-supply`.
- **Cache admission gate:** `snapshot-chain-supply` applies the same producer-cadence freshness gate as `snapshot-supply` — it skips with `status: "degraded"` and `reason: "cache_stale"` once the stablecoins cache is older than two `sync-stablecoins` intervals (> 1800 s).
- **Observation admission:** cache freshness alone does not prove chain supply freshness. A known-chain contribution marked `supplyRestored`, observed more than 1800 seconds ago, or carrying an unavailable canonical `current` defers only that entire chain row; unaffected chains still publish. Never subtract the unavailable contributor to publish a smaller subtotal. Missing cache coins defer their known deployment chains: the runtime registry's reviewed `contracts` and `tradedContracts` pass through the same `resolveChainId()` and `CHAIN_META` filter as `canonicalizeChainCirculating()`. Deployments are possible-contributor evidence, not supply values. This source remains available after cache omission; prior chain-history totals have no per-coin membership and cannot recover the missing coin's partition.
  Metadata records sorted `restoredOnlyIds`, `staleSupplyIds`, `missingSupplyIds`, `absentActiveIds`, `absentUnmappedIds`, `deferredChainIds`, and `deferredChains` mapping each affected chain to blocking asset IDs. An absent coin with no known supported-chain deployment is named in `absentUnmappedIds` and defers no unrelated chains; no partition is invented. HBD is native to Hive, has no runtime reviewed deployments, and has an empty chain partition in the snapshot fixtures; Hive is not in `CHAIN_META`, so absent `hbd-hive` defers none of the tracked chains. Legacy non-restored rows without `supplyObservedAt` inherit the admitted cache timestamp. Explicit zero remains observed zero.
- **Publication gaps and partial-run status (R4):** use the same none/routine/elevated/systemic share bands as supply snapshots. Routine and elevated gaps publish `ok` (an elevated gap adds `metadata.quality.reason: "upstream_publication_gap_elevated"`; sync-stablecoins owns the degraded verdict); systemic gaps retain `partial_snapshot_blocked` without writing. Gap metadata is bounded to the first 20 IDs plus its count. Independently, deferred observations retain `metadata.quality.coverage: "partial"` (otherwise `"complete"`) and `chain_observations_partially_deferred`. There is no contribution materiality threshold: even a small known unavailable contribution defers its entire chain. A fully deferred run with no previously admitted rows remains degraded `chain_observations_unavailable`. Input-quality metadata never certifies freshness of deferred rows.
- **Normalization:** the cron preserves upstream/display labels as `chainCirculating` object keys for compatibility, while producers attach an optional canonical `chainId`; the shared resolver uses that explicit ID first and falls back to the label for older or malformed rows before writing `chain_id`.
- **Write/recovery pattern:** each chain keeps its first admitted observation for the UTC day and unchanged coverage identity. The atomic batch preserves the partial marker's admitted `ownedRowIds` plus currently deferred rows, inserts only newly admitted chains, and writes a truthful coverage-version 2 marker with missing IDs/counts. `chainObservationProgressVersion: 1` certifies owned rows passed chain admission; legacy markers without this proof require replacement. An unchanged partial-day rerun returns `ok` with `already_written_today` (plus any gap quality finding) without replacing rows or advancing the marker. Deferred legacy rows are preserved until fresh admission replaces them; absent deferred rows stay absent. Same-day recovery admits missing chains without rewriting earlier admitted peers, and refreshes the marker even if the recovered coin has no chain partition. `chainObservationAdmissionVersion: 1` is written only when no deferrals or absent required IDs remain. Once exact coverage and complete admission are proven, later restored/stale/unavailable contributions preserve the sealed observations; current publication gaps still remain visible. Coverage-identity changes recompute and remove disappeared chains. Supply snapshots differ: a recovered required ID outside prior ownership replaces the full owned daily set.
- **Volume:** one row per admitted active chain per UTC day; derive current chain coverage from the registry and admitted cache rather than a fixed catalog count.
- **Primary use:** keep collecting the forward baseline for future chain-profile trend charts (`/chains/[chain]/`); no current reader is permission to cancel it. Live `/api/chains` aggregates the stablecoins cache, not this table. Public history/chart activation requires product scope, provenance and bounded reader-capacity approval; interim D1 cost is unmeasured.
- **Recoverability / public baseline:** rows written before the 2026-04-08 resolver fix are not approved for public charting. Retained D1 data has no archived historical `stablecoins` payloads, so those splits cannot be reconstructed exactly. Any approved reader must use an explicit UTC baseline strictly after 2026-04-08 and review producer-era/coverage limitations; a post-fix date alone does not certify quality. The overwritten completion marker qualifies only its own date and owned chains, not the whole archive. If retained coarse provenance is unacceptable, use an evidenced prospective baseline. Preserve older rows internally; missing days stay absent/null, never zero or interpolated. A rejected reader rolls back the reader, not collection.
- **Publication guard:** if a fresh stablecoins cache produces zero valid per-chain rows and no admitted rows belong to the same-day coverage identity, the cron returns `status: "degraded"` with `reason: "no-valid-chain-rows"` (or `chain_observations_unavailable` for deferred inputs) and skips the write instead of overwriting the historical series with an empty snapshot.
- **Current migration note:** this table is part of `worker/migrations/0000_baseline.sql` in the post-squash migration tree.

---

## Supply Data Source

**Primary source:** DefiLlama list API (`stablecoins.llama.fi/stablecoins`), cached every 15 minutes by `syncStablecoins()`.

The intake loader owns the initial FX read and intake progress/abort boundaries, returning main, fallback or withheld outcomes without a transport-only stage wrapper. The outer sync retains the insufficient-fallback error decision.

**Tracked gap-fill exceptions:** `syncStablecoins()` now has four supply-reconciliation lanes for tracked DefiLlama-backed assets:

- For exactly one missing metadata chain identity (contract entries are deduplicated by chain), the explicit CoinGecko aggregate gap-fill lane can raise the aggregate and attribute only the admitted increase to that chain. This is not a chain-only attribution that leaves the aggregate unchanged. The current-cap candidate and published chart point have distinct admission clocks, described below; stale or ambiguous attribution fails closed. The bounded contract requires coherent buckets and no duplicate native/bridge/custody amount.
- If the DefiLlama live list collapses a tracked asset to zero supply, current history repair first selects the latest validly dated chart point, independently of whether its supply is admissible. That point itself must have a fresh positive total of at least $1M; an explicit zero or invalid latest value never permits walking back to an older positive point, even within 48 hours or in an unsorted chart. Historical 1d/7d/30d lookbacks still use separate nearest-point matching. Complete admitted history repairs all four buckets and tags the asset `supplySource = "defillama-history-gap-fill"`.
- If a tracked asset collapses to zero supply and DefiLlama chart history is missing, stale, incomplete, invalid, explicit zero, or below the $1M current-point floor, the separately reviewed curated on-chain aggregate read (`applyCuratedOnChainSupplyGap`) remains eligible. A successful read republishes the asset as `supplySource = "onchain-total-supply"`, rewriting `chainCirculating` and clearing the 1d/7d/30d buckets; an unreadable leg fails closed and leaves the zero row untouched. The latest-zero veto blocks history resurrection, not this reviewed fallback.
- If a DefiLlama row with an observed aggregate (including explicit zero) reports one chain's current supply at zero, `null`, or at most half of that chain's vetted baseline, or omits a known material or quarantined chain identity, the [chain-dropout guard](#chain-dropout-guard) treats the chain observation as unavailable rather than as a redemption. It repairs from a reviewed on-chain read or DefiLlama's per-chain daily chart when possible; unresolved material deficits quarantine the asset, while immaterial dropouts publish a `null` chain current without a restored flag. Repaired rows publish `supplySource = "defillama-chain-repair"`; every guarded row carries `supplyChainGuard` provenance, with repair clock kinds distinguished.

Reviewed zero-list repair rosters live in `CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS` in `shared/lib/onchain-supply-probe.ts`. Open USD's issuer-bound EVM/Solana native liabilities are summed only when every configured leg succeeds; the repair cannot override a positive DefiLlama total or restore a row absent from its list.

The snapshot cron records the admitted cached USD aggregate, including an accepted supplemental aggregate raise, without fetching or applying another reconciliation. The producer owns the aggregate/chain packet and its provenance. Synthetic and supplemental rows keep their display-label keys and carry `chainId` when the producer knows the canonical identity, so downstream aggregation does not need to infer identity from presentation text.

**Per-asset admission vs whole-cohort holds (DEC-03):** `syncStablecoins()` quarantines per asset and publishes healthy peers. Intake first requires a JSON object envelope with an array `peggedAssets`; anything else is a global schema failure that records the DefiLlama circuit outcome and takes the whole-list CoinGecko fallback. Before the frozen-snapshot merge or any field access, null, primitive and array rows are quarantined by index (`admitPeggedAssetRows`); `filterStructurallyValidAssets` then quarantines rows without an id or string name/symbol and rows whose current `circulating` buckets are absent (`{}`), non-finite, negative or overflow on summation. An explicit `{peggedUSD: 0}` is observed zero supply and is admitted. Invalid historical aggregate buckets drop to absence (`null`) without quarantining the asset. Reasons are logged on `malformed-assets-dropped` and counted in `rowsDropped`; a quarantined tracked coin then takes the normal tracked-coverage restore path. At publication each normalized row is validated on its own against the published row schema (aggregate buckets finite and nonnegative); a schema-invalid row is quarantined, logged, recorded in `stablecoins:invalid-last`, and removed from the run's downstream cohort. The whole list is held only for an invalid envelope, a duplicate published id, or a quarantine that leaves fewer than `MIN_VALID_ASSET_COUNT` rows. The daily snapshot's exact-coverage rule is unchanged by this: a quarantined or restored active ID still holds or annotates the daily write exactly as described in the Algorithm and Error Handling sections.

`canonicalizeChainCirculating()` retains the label fallback for legacy or upstream rows that have no usable `chainId`. That tolerance is intentional: the Safety Score V9 supply extension still receives raw upstream labels and pools unrecognized labels into its reviewed uncanonicalized-chain-label control path rather than silently assigning them to a different chain.

**Supplemental on-chain exceptions:** CoinGecko-detail assets may use a reviewed complete aggregate (`fetchCuratedAggregateOnChainMcap`) or one unambiguous deployment's `totalSupply()`, labeled `onchain-total-supply`. Protocol-inventory exclusions publish `onchain-circulating-supply`. Joined EVM total/exclusion/escrow reads share one canonical EIP-1898 hash pin per chain: the block must be non-future and at most five minutes old, headers are rechecked, and its timestamp supplies `observedAt`. Any failed balance, hash drift or unsupported pin withholds the fallback; escrow allocation conserves canonical supply. Snapshotting consumes the cached USD result, never repeats RPC reads.

Movement USDCx admits only pinned-ledger `ConcurrentSupply` and `Metadata` with resource decimals matching its tracked identity, reconciled against Ethereum Circle xReserve `balanceOfNativeCollateral(USDC, 10005)`. The reserve must cover the Movement stock and differ by no more than one basis point. Either provider unavailable, malformed ledger/resources, decimals mismatch or reserve deficit/wider divergence withholds the entire repair, never a partial or inferred observation.

The registry owns exact deployments, decimals, explicit-zero allowances and pinned RPC profiles; prose distinguishes the accounting:

- **Conserved native totals:** syrupUSDC, syrupUSDG, strUSD, sUSDat and syzUSD reallocate representations from the canonical native-chain bucket, never add them to aggregate liabilities. strUSD's explicit Ethereum CCIP escrow residual keeps unprobed representations unattributed rather than assigning their custody to Ethereum free float. Migrated token identities and adapters are not extra native deployments. Aptos reads pin supply/decimals to one ledger version; missing observations or mismatched decimals withhold the entire aggregate. Movement's xReserve reconciliation remains a distinct dispatch family.
- **Independent liabilities:** issuer-native or burn/reissue stock, including USYC Teller shares, Centrifuge JTRSY, Nest nOPAL, Securitize ACRED/BRSRV, spUSDT's independently deposit-backed vaults, USCC's public token shares (not book-entry shares), PYUSDx's Portal burn/mint stock, FIUSD fund units and legacy sUSDC's independently backed local vaults, is summed. Extension-held PYUSDx is already included and cannot be counted again as CUSD/ConcUSD. These partitions do not establish bridge escrow, beneficial-custody or executable-recovery proof.
- **Complete census:** every configured leg must be observed, even where zero is explicitly allowed. An omitted catalog deployment rejects unless a reviewed escrow-residual policy conserves it. Reads remain sequential; product-chain/supply-profile registration grants no archive or log-scan capability. Single-deployment reads retain Worker registry routing and reviewed one-leg pinned-profile priority.
  The verified Base syzUSD representation is included in that complete read census and reallocates the conserved Plasma total; it is not an independently issued Base liability. Supply-roster inclusion does not clear its separately unresolved bridge-control review.
  Known missing native stock or conflicting live token identities prevent roster admission even when a partial sum happens to agree with an upstream cap. A ratio match alone does not establish complete issuance accounting.
- **FIUSD preference:** `PREFER_ONCHAIN_SUPPLY_MCAP_IDS` in `worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts` selects complete native stock over a contradictory positive CoinGecko cap. An unreadable native leg cannot fall back to that cap. Assets whose fresh cap is already unavailable use the ordinary fallback; no redundant preference or aggregate entry is needed for a single deployment.

`CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS`, `CURATED_AGGREGATE_ESCROW_RESIDUALS` and `SUPPLY_RPC_DEFAULTS` own deployment/accounting/transport configuration. Native shares are valued at admitted market/NAV prices, not assumed dollar par.

**Reviewed current-token-stock perimeter (R4):** sFRAX uses `SFRAX_STOCK_PERIMETER` and the dedicated `sfrax-current-token-stock-v1` producer, not the removed nine-EVM native-minus-remote allocation. Its float follows the same current-token convention as other multichain assets:

`Ethereum totalSupply − migrated Fraxtal StandardBridge custody − native OFT adapter custody − all six native Fraxferry custody balances + active remote stocks net of their reciprocal ferry prefunded inventories + Solana minted stock`.

The four active reciprocal ferries are Arbitrum, Avalanche, BSC and Optimism. The historical Fraxtal ferry and retired Polygon zkEVM ferry remain measured native custody exclusions; the halted zkEVM destination is not invented as an observed-zero active deployment. Base, Blast, Metis and legacy Fraxtal OFT minted stocks are included without inventing holder exclusions. The migrated StandardBridge balance must equal its exact legacy `(sFRAX, fc08)` deposits ledger, and fc08 must identify the migrated sfrxUSD L1 token. Every ferry binds its token, counterpart and source/destination chain IDs. The Solana9-decimal mint, mint authority and legacy OFT program/configuration are verified at a finalized slot, including Native mode and local/shared conversion; its one-raw seed remains part of minted stock. Compound-holder shares are included: ordinary protocol ownership does not itself make tokens noncirculating, and no sFRAX-specific exclusion definition was established.

This is **current token stock**, not an economic-claims, backing or bridge-recovery certificate. Unminted/in-flight LayerZero messages and migrated holders' financial claim extinguishment remain diagnostics outside the float; no zero-pending or extinguished-claim assertion is made. Lock/mint inventories are de-duplicated by excluding measured native custody and reciprocal prefunding, not by adding unminted claims. Quantities are valued at the independently admitted market/NAV price, never assumed dollar par.

Every one of ten deployment stocks, eight native custody exclusions and four remote prefunded balances is required in the same producer run. EVM calls use explicit canonical block hashes and closing header checks, with batches of at most ten; Solana accounts share one finalized context and its original slot time. The packet retains original per-chain clocks and raw quantities. Missing/malformed or unbound components, changed headers, custody/deposits disagreement, negative arithmetic, future or older-than-five-minute components, and missing valuation all fail closed. No subtotal, clamped negative, guessed zero or positive CoinGecko cap can substitute. The shared main/fallback publication fence recomputes and matches the exact aggregate and ten-chain partition, requires a fresh packet started in that run, and rejects prior-cycle carry or restored/provider quantities.

Until that complete packet succeeds, `getOnchainSupplyHoldReason()` keeps `economic-float-unreconciled` as the machine-readable R4 refusal. The public row has `supplySource: "onchain-supply-withheld"`, empty current/historical aggregate buckets and explicit null current values for known deployment chains, without a supply clock or restored/gap-fill provenance; independent prices and dated provider history are not fabricated or erased. The explicit runtime path keeps verified deployments registered without pretending their supply was measured. A successful same-run packet publishes `onchain-circulating-supply` and its oldest actual component clock; the final publication fence rejects restoration without a valid same-run packet.

Supplemental intake forwards its configured Worker `chainRpcs` map into both `resolveVaultNavSupplyPrice` and unpinned EVM `totalSupply` probes, preserving registry-first ordering and existing budget/circuit gates; reviewed curated supply pins retain their original route. Both NAV valuation and supply observation therefore have access to the configured keyed Dwellir route required for Steakhouse USDG on Robinhood. No new RPC endpoint is introduced; without a usable configured route and trusted parent, NAV valuation remains fail-closed.
Pre-resolved primary/fallback URL slices exclude Dwellir to preserve incumbent-only behavior when no run map is passed; normal map-aware EVM probes still resolve admitted Dwellir placement with auth, credit metering and run-local demotion. The chain-dropout guard's independent on-chain corroboration likewise uses only incumbent registry URLs.

The pre-intake NAV supply fallback also invokes the registered Idle CDO tranche route for `aa-falconx-mev-capital`: exact old Ethereum CDO `virtualPrice(AA tranche)` is valued against the previously published, still-trusted USDC/USD observation. It reuses the existing protocol circuit, bounded rate cache, parent freshness and live override implementation; no par valuation, newer facility substitution or manual supply override is admitted. A missing NAV or unreadable deployment stays unavailable with a named source subreason.

JLTXX remains quarantined under its `listingStatusReview` in `shared/data/stablecoins/coins/jltxx-jpmorgan.json`; configured readers and staged evidence do not authorize active publication. Its reviewed supply reader binds the Ethereum FactTokenDiamond deployment `0x09864f52b035ae22ee739dfa5c748fa080d07bd8` and 2 decimals, with native shares valued at observed market price or official `jpmorgan-nav` NAV. Re-admission requires the legal/native-share perimeter, hash-pinned quantity/decimals, reviewed NAV/block skew, matched reserve attempt, runtime price/market-cap gate and explicit admission. A funded issuer-bound deployment or material class-assets/native-supply divergence requires roster review; neither an invented mint nor a whole-class issuer-assets substitution is permitted.

JLTXX's supplemental supply admission is fail-closed on class scope: `abs(nativeSupply × issuerNAV - classAssetsUsd) / classAssetsUsd` must be **≤0.5%**, including the boundary. This allowance accommodates rounded class assets and reviewed cross-observation dealing-date drift, not same-time ledger completeness. The comparison always uses issuer NAV, even when an observed market quote supplies the published valuation. The reserve snapshot must be within the 48-hour fetch budget, match the current configuration and latest completed attempt with no pending attempt, and contain verified class identity and a matching class-assets/NAV dealing date within the five-day source-age budget. A dated `supplyAdmissionReview` must also authorize the NAV/native observation skew. Missing, invalid, incoherent or stale evidence withholds admission, including when CoinGecko has a positive cap: class assets and CoinGecko cap never replace native supply. The structured `reserve-nav-supply-withheld` event carries `rule: "R4"`, the reason returned by `reserveNavSupplyScopeReason()` in `worker/src/lib/reserve-nav-price.ts`, and available fetch/source clocks. Ordinary bounded stale-supply restoration remains separate and cannot label a withheld observation fresh.

**CETES admission hold:** `cetes-etherfuse` remains quarantined, reviewed October 8 with operational review due **2026-11-07**, despite positive secondary CoinGecko price/cap data. The [official attestation index](https://api.etherfuse.com/statement/attestation), accessed October 7, identifies the [September 29 14:36 UTC PDF](https://api.etherfuse.com/statement/attestation/3aa2426c-c3a8-4cf5-be60-a34c69be02e9.pdf), exact Solana mint `CETES7CKqqKQizuSN6iWQwmTeFRjbJR6Vw2XRKfEDR8f` and issuance 129: `amountOfNetTokens = 71270557.788820`, `tokenPrice = 1.183195`, `valueOfNetTokens = 84326988.829258`, `attestedValue = 88187545.85`. These are issuer field names/values with unresolved denomination and liability/circulation scope, not asserted USD supply or market cap. The old no-positive-data rationale is obsolete, but MXN/USD and native/represented/circulating perimeter remain unreconciled. Require fresh identity-bound pricing and a complete double-count-safe multichain circulating census before re-admission; do not invent units/chains, substitute issuer totals, override supply or promote a route.

**RPC authority:** `shared/lib/chain-rpc-registry.ts` owns public, curated-supply and attribution endpoint profiles. `shared/lib/onchain-supply-probe.ts` selects reviewed deployments and per-asset overrides before runtime fallbacks. Source-owned order, primary-only overrides and exclusions remain deliberate; consolidation adds no provider or retry. In particular, `polygon-rpc.com` is excluded for zero-valued call responses, and syzUSD's Pharos supply leg remains ZAN-primary without fallback because the alternative dRPC route does not support the required `eth_call`.

**Key gotcha:** The list endpoint returns `circulating` values already in USD for all peg types. Do **not** multiply by price --- that double-converts. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs, but the list endpoint is already converted.

Supplemental on-chain supply failures identify asset, chain, contract and machine-readable subreason in `onchain-supply-contract-withheld` events. Unreadable `totalSupply`, nonpositive reads and unsupported encodings are distinct. Missing admitted NAV emits `supplemental-supply-withheld` / `nav-price-unavailable` before probing supply. Complete native aggregates still reject unreadable legs and preserve same-run zero-supply guards. Caller cancellation propagates, never a completed unavailable observation; diagnostics neither change admission nor refresh carried clocks.

### Supply admission and nullable helpers

**File:** `shared/lib/supply.ts`

`admitSupplyBuckets()` is the current/history bucket authority: an explicit finite nonnegative record is observed (including zero), `{}`/null/undefined is absent, and a negative, nonfinite or overflowing record is invalid. No invalid bucket is discarded into a partial numeric total. `sumPegBucketsOrNull()` returns only an admitted total; otherwise it returns null. Publication's `fillMissingSupplyHistory()` uses the shared historical nullable helpers for ordinary rows, so empty records also qualify for existing exact-day D1 history fallback. It preserves observed values (including zero), requires one current peg bucket and an observed 1d/7d/30d row within 30% of positive current supply, and never synthesizes missing dates.

Intake admits primary current supply before merging supplemental coverage. An admitted positive or explicit-zero primary row keeps precedence over a duplicate supplemental row. Absent or invalid primary supply is quarantined first, so supplemental admission uses the ordinary missing-ID merge with its own source and observation clock, not a primary replacement pass. Existing reviewed gap repair and carry-forward rules are unchanged.

The shared live-summary projection applies this admission to selected historical USD checkpoints and legacy/direct previous-day inputs before output. Day/week/month selection first chooses the newest sample at or before the target within one day, then admits that sample; an invalid selected record remains `{}`, never an older valid measurement or an invented zero. Current USD buckets use the same admission, native checkpoints use nullable admitted totals, and measured zero survives both contracts.

Producer-owned history is not generic missing data: fresh or carried `coingecko-gap-fill`, `defillama-history-gap-fill`, `onchain-total-supply`, and `onchain-circulating-supply` packets, or packets carrying `supplyGapFill` provenance independently of their source label, bypass D1 hydration. Their deliberately absent buckets remain unavailable through publication; the producer's current aggregate, source clock, chain packet and per-bucket withholding reasons remain authoritative. The current DefiLlama history-repair builder requires all four values; this packet guard does not imply that builder emits withheld nulls. Ordinary supplemental rows without packet ownership retain the admitted D1 fallback above.

| Helper | Description |
|--------|-------------|
| `getCirculatingRawOrNull(c)` | Current USD supply, null for an absent asset or unavailable buckets |
| `getPrevDayRawOrNull(c)` | Previous-day supply, null when unavailable |
| `getPrevWeekRawOrNull(c)` | Previous-week supply, null when unavailable |
| `getPrevMonthRawOrNull(c)` | Previous-month supply, null when unavailable |

The zero-default helper variants have been removed and ESLint rejects their identifiers, aliases and namespace property reads across all source roots. Filters admit observed members explicitly; rankings place unavailable last, exports retain null/blank values plus reasons, and aggregates publish known subtotals with completeness/member counts. Daily snapshots retain genuine observed zero, never missing-as-zero; supply and price observations remain independent.

---


### Decimal handling

Do not assume `18` decimals, or even one fixed decimal count per token across all chains. The authoritative source is `contracts[].decimals` in the per-coin metadata assets under `shared/data/stablecoins/coins/*.json`, loaded via `shared/lib/stablecoins/registry.ts`. The exact exception set changes as metadata evolves; use the live metadata, not hardcoded examples.

### Reviewed supply contract hardening

Economic accounting rejects duplicate exclusion balances and exclusion/escrow overlap. All joined EVM chain-state quantities on a chain require one block-number/hash/time tuple; reviewed state and identity reads, including no-Multicall3 fallback, require EIP-1898 `requireCanonical` hash pins without numbered-state fallback. Eligible provider aliases sum canonically before reconciliation; negative/nonfinite amounts reject. Plan evidence admits per asset behind attributable quarantine; registry envelopes stay globally strict. Solana economic mint chronology requires a produced block at the exact account context slot, never an earlier timestamp proxy.

Economic plans and provider-row exclusion evidence/key collisions admit per asset with exact-field quarantine paths: malformed attributable evidence cannot abort module import. Native single-route tables consume the admitted registry envelope without revalidating unrelated economic plans. Healthy assets and valid registry digests are preserved.

---

## API Endpoints

### GET /api/supply-history

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `stablecoin` | Yes | --- | Canonical Pharos stablecoin ID |
| `days` | No | 365 | Min 1, max 5000. Older dates depend on how much archival history has been ingested into `supply_history` through the cron plus admin backfills. |

```sql
SELECT snapshot_date, circulating_usd, price
FROM supply_history
WHERE stablecoin_id = ? AND snapshot_date >= ?
  AND snapshot_date <= ? -- when snapshot-supply:last-write exists
ORDER BY snapshot_date ASC
```

**Response:** array of `{ date, circulatingUsd, price }`

**Cache profile:** slow (`s-maxage=3600`, `max-age=300`). Responses include `X-Data-Age` from the `snapshot-supply:last-write` marker's `updated_at` when available, falling back to the latest served snapshot row only when the marker is absent. Rows newer than the completed daily snapshot marker are hidden so a failed chunked write cannot expose a partial latest day.

### GET /api/stablecoin/{id} (detail --- supply_history fallback)

For CoinGecko-only coins and commodity tokens (gold/silver), empty or stale external detail history falls back to the `supply_history` table and reconstructs the `DetailToken` format. DefiLlama-backed detail falls back to `supply_history` on upstream failure, circuit-open, parse-error, or exception paths; it does not currently use the empty/stale-history fallback unless the DefiLlama handler is extended. CoinGecko-derived history is treated as stale when its newest point is more than 72 hours behind wall clock time, which prevents per-coin charts from freezing on an old market-cap series when D1 already has fresher daily snapshots.

Fallback availability never renews freshness: detail responses preserve the newest returned history
point's clock in headers and `_meta`, mark the fallback stale, disable caching, and skip detail-cache
publication. This also applies when stale upstream history survives because no D1 rescue exists.
Supply-history responses without a completed marker use their newest served row's admitted clock;
empty or invalid-clock responses explicitly expose unknown freshness and unavailable age with `no-store`.

Detail history preserves day-specific valuations: commodity CoinGecko `market_chart` caps are not repaired with current circulating supply. For non-USD DefiLlama rows, observed historical USD buckets and native buckets are preserved independently; a missing side stays unavailable instead of being reconstructed with the current top-level quote.

### Historical supply operator CLI

Operator CLI `npx tsx worker/scripts/one-shot-backfill.ts backfill-supply-history --execute --query 'stablecoin=<id>'` (Wrangler-authenticated remote D1; no HTTP action). Backfills `supply_history` from:

- **Commodity tokens:** CoinGecko `market_chart` market caps; when those caps are missing, historical EVM `totalSupply()` at each UTC day close for single-deployment assets; protocol TVL fallback only after those sources fail
- **CoinGecko-only and commodity detail providers:** CoinGecko `market_chart`
- **Reviewed single-contract USD supplemental assets:** historical EVM `totalSupply()` at each UTC day close, requiring a historical USD price unless the asset is in the explicit code-owned par-policy allowlist (currently BD, whose documented direct redemption supports price `1`)
- **Configured protocol-inventory on-chain assets:** historical EVM `totalSupply()` minus configured holder balances
- **DefiLlama-backed regular coins:** DefiLlama detail API

On-chain `totalSupply()` and configured inventory-exclusion backfills persist a historical `supply_history.price` on every written row and skip days without one, except for the explicit Base Dollar par-policy price of `1`. Historical PSI replay relies on that field to prefer day-level deviation over blunt `peak_deviation_bps` fallback.

The operator backfill also supports `detailProvider === "coingecko"` and `"commodity"`. CoinGecko history selects the first valid exact-timestamp price/cap pair per UTC day; unmatched prices do not borrow another intraday cap. Non-USD regular coins fetch historical prices for native-to-USD conversion by default. Explicit `allow-constant-price-fallback=true` permits a current-price emergency fallback only for missing historical prices on entries within the preceding seven days. Historical `totalSupply()` replay requires exactly one deployment in the **complete** metadata roster and canonical EVM probe eligibility; mixed-family or other unsupported rosters return `unsupported-complete-roster`, never one-chain global supply. Batch processing uses `stablecoin`, `batch`, and `batchSize`; `startDay` / `endDay` bound daily writes, with future `endDay` clamped to the last completed UTC day.

The prices-only CoinGecko backfill transport shares request/validation handling, not history policy: daily requests keep `days=max` or explicit ranges; hourly requests retain the 2018-01-30 epoch, serial 89-day chunks, per-request pacing and later-point overlap precedence. Only an entirely empty hourly result triggers daily fallback; native-peg currencies and the recycled Solomon identity exclusion remain unchanged. This path does not fetch coin details.

---

## Frontend

### Hook: useSupplyHistory(id)

**File:** `src/hooks/use-stablecoins.ts`

- Fetches `/api/supply-history?stablecoin=<id>&days=<days>`
- Returns the response typed as `SupplyHistoryPoint[]`; the runtime query registry used by this hook attaches `SupplyHistoryResponseSchema` (`z.array(SupplyHistoryPointSchema)`), so the payload is runtime-validated in strict mode
- Returns normalized `{ date, circulatingUsd, price }` points directly; there is no detail-endpoint transform in the hook anymore
- TanStack Query: `staleTime = 24 hours`, `refetchInterval = 48 hours` (derived from the `CRON_SUPPLY_SNAPSHOT` producer interval, i.e. `CRON_INTERVALS["snapshot-supply"]` = one day)

### McapChart

**File:** `src/components/mcap-chart.tsx`

Individual stablecoin market cap history. Area chart with time range filtering (7d, 30d, 90d, 1y, all). Observed zero remains visible. The header labels a change `24h` only with the previous UTC-day observation inside the visible/brush window; sparse pairs and zero baselines withhold that percentage.

### HomeAltHero Market-Cap Chart

**File:** `src/components/home-alt-hero.tsx`

Aggregated homepage market-cap breakdown. `GET /api/stablecoin-charts` serves cached DefiLlama aggregate history plus structural supplemental D1 `supply_history`, without a live trailing point; its last point can trail the KPI until `sync-stablecoin-charts` runs. Provider buckets retain malformed values as `null`; omission is not observed zero. The hero reads the site-only `GET /api/homepage-history` joined view; its Worker-side `buildTotalMcapChartRows(...)` authority lives in `shared/lib/total-mcap-chart.ts`. Cohorts and supplemental overlays use shared `findAsOfSnapshot` semantics with `MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC` (14 days): no future rows or unbounded carry. Only nonempty observed history plus an authored launch date establishes pre-existence zero; an archive start alone does not. An unobserved/over-budget structural contributor withholds its peg bucket; missing cohort history withholds dependent `USDS + DAI` and `Others`. Unavailable aggregate buckets withhold total/residual and affected non-USD values. The chart shows gaps and an unavailable-history notice, with a gray total envelope, zero-baselined USDT area (not stacked), and USDC, Sky, Others and dashed non-USD lines. [Homepage](./homepage.md#loading-strategy) owns the one-read transport and bounded dated preview.

### Compare page

The producer-side `/api/non-usd-share` gap scan includes the last per-coin observation before its retained history cutoff when available. Coverage admission precedes request-window filtering and sampling, so a short `days` window cannot turn omitted dominant supply into an apparently complete denominator. The prior row is only gap evidence, not a newly published history point.

**File:** `src/app/compare/page.tsx` (lazily loads `src/components/compare/compare-client.tsx`)

The compare data model fetches per-coin `/api/supply-history` series directly through `useQueries()` in `src/hooks/use-compare-data-model.ts`. Side-by-side comparison charts do not depend on `GET /api/stablecoin/:id`.

---

## Error Handling

The [Algorithm](#algorithm) is the sole snapshot state-transition contract. This table indexes diagnostics, not alternative admission rules:

| Diagnostic | Meaning |
| --- | --- |
| Loader reason | Strict cache unavailable/invalid: `missing-cache`, `json-parse-failed`, `invalid-payload-shape`, `missing-pegged-assets`, `filtered-malformed-entries`, `published-contract-invalid`, `cache-read-failed` |
| `cache_stale` / `stablecoins_cache_before_slot` | Producer-age / safety-net slot-start gate |
| `already_written_today` / `already_written_today_before_freshness_gate` | Existing identity-verified day; no required ID recovered |
| `repaired_missing_prices_today` / `same_day_price_repair_failed` | Null-price repair succeeded / failed |
| `partial_snapshot_blocked` | Systemic hold |
| `upstream_publication_gap_elevated` (quality finding) | Elevated non-systemic gap inherited from sync-stablecoins; the run stays `ok` |
| `all_coins_zero_supply` | Legacy name for no prepared rows, not rejection of observed zero |
| `snapshot_written_restored_skipped` | Fresh rows written with restored-only exclusions |
| `db_write_failed` | Atomic replacement failed; `recordCronFailure()` records the failure and prior rows/marker survive |

Abort errors propagate through `rethrowIfAborted`. Cron logging/retention is owned by Worker infrastructure.

---

## Key Constraints

The [Algorithm](#algorithm) owns cache, marker, row ownership and recovery rules. The job has no upstream/RPC reads. Nullable historical prices and bounded non-USD emergency valuation are governed by Backfill Supply History; `supply_history` remains an archive for charting and PSI replay.

## Supply Pipeline

Bounded supplemental/repair lanes below follow the source rules above.

- **DefiLlama** — primary for stablecoins tracked by its stablecoin API
- **CoinGecko market cap** — supplemental commodity and CoinGecko-detail assets. During DefiLlama outages, `syncViaCoingeckoFallback()` uses the already-fetched commodity/CoinGecko-detail cap feed, not a new whole-cohort request. Missing fresh caps are omitted from intake; fewer than `MIN_VALID_ASSET_COUNT` admitted rows blocks publication before continuity restoration.

Main/fallback share post-intake publication. Only their context sets operational labels/DefiLlama circuit bookkeeping; admission, aggregate/chain/history packets and clocks stay source-owned. Completion metadata omits intake payloads and guard persistence state.

Supply policy and prohibited overrides are governed by [ADR-8](./architecture.md#adr-8); [Supply Data Source](#supply-data-source) owns runtime admission.

Supplemental fiat/commodity/outage supply uses the winning market-cap `last_updated_at` or reader `observedAt`, never price/NAV time. Silver units-times-price keeps `coins/markets.last_updated`; winning CoinGecko cap keeps its own timestamp. Undated DefiLlama protocol caps stay undated.

Score-only economic deployment attribution, XAUT lock/mint groups, native-single-route reviews, observer pins and authenticated bridge in-flight accounting belong to [Safety Score attribution](process/report-cards-appendix.md#supply-attribution-and-in-flight-accounting) and [bridge accounting](process/report-cards-appendix.md#bridge-in-flight-accounting). They never change aggregate supply; this document owns the shared registry, clocks and publication gates.

For tracked supplemental assets outside DefiLlama's stablecoin list, the worker prefers DefiLlama's `coins.llama.fi` price proxy (`coingecko:{id}` or an exact single-deployment `chain:contract`), then CoinGecko price lanes. Contract quotes require a matching symbol, confidence ≥`0.8`, a fresh upstream timestamp and shared peg-aware reasonableness bounds. Gold/silver CoinGecko caps require their own current `last_updated_at`, independently of spot-price acceptance; silver `/coins/markets` supply requires fresh `last_updated` before units × price. A fresh independently observed cap may publish with null price. Protocol mcap is eligible only for the dedicated gold slugs `tether-gold` and `paxos-gold`, not issuer-umbrella slugs. CoinGecko-detail fiat assets normally prefer CoinGecko cap; code-owned preference and class-scope gates can require on-chain supply instead. On-chain fallback needs an unambiguous supported deployment, a complete curated aggregate, or the Zephyr Scanner exception. Plain par-redeemable assets may use a peg reference; NAV/yield-bearing assets require observed market/NAV valuation, never an assumed `$1`. `shared/lib/onchain-supply-probe.ts` owns the current roster, zero allowances and eligibility: `selectCuratedAggregateOnchainSupplyProbeContracts()` rejects omitted catalog deployments unless an explicit escrow-residual policy conserves them. Every configured leg must be readable. `CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS` distinguishes conserved canonical totals with remote reallocation from independent native/burn-mint sums; `CURATED_AGGREGATE_ESCROW_RESIDUALS` separates canonical free float from unattributed custody instead of assigning unprobed destinations to the source chain. Consult those registries rather than a copied deployment count or asset list (including syzUSD's current Aptos leg). `worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts` applies these policies. Its eEARN Sui reader validates the pinned receipt TreasuryCap, exact type/metadata and fresh checkpoint; null coin metadata supply is not zero. DefiLlama zero-list repair uses the curated DefiLlama-detail subset and a fresh/static FX reference; it never overrides a positive list total. `CURATED_ONCHAIN_SUPPLY_EXCLUSIONS` in `worker/src/lib/onchain-supply-exclusions.ts` owns inventory subtraction and fails closed on unreadable balances; historical operator replay applies the same exclusion rule. Zephyr native circulation and ZYS's protocol share price come from the same Zephyr Scanner live-stats observation.

**CoinGecko share partitions (ADR-8(d)).** For a CoinGecko-detail asset with an admitted cap and a reviewed aggregate or eligible single deployment, a complete same-run read may attach `chainCirculating` without changing aggregate buckets, `supplySource`, `supplyObservedAt` or CoinGecko history. The on-chain total uses the admitted `priceForSupply`; `ratio = onchainUsd / CoinGecko total` must pass the calibrated `ONCHAIN_PARTITION_POLICY` entry/retain band. Only previous `chainPartition.admission` of `entered` or `retained` grants the retain band; a read following `carried` evidence must pass entry again. Canonical/escrow accounting is reused before scaling every row to the CoinGecko total; custody residuals retain no chain ID. Current-only rows have no invented historical chain amounts.

No admitted price, any unreadable leg, an out-of-band ratio or the partition stage deadline withholds a fresh partition, preserving the cap. Unreadable legs and deadline-skipped reads may rescale previously admitted shares onto the fresh total within `SUPPLEMENTAL_RESTORE_MAX_AGE_SEC`, preserving original partition `observedAt`, `onchainUsd` and `ratio`; expiry, invalid evidence and ratio rejection cannot carry. `chainPartition` publishes `basis: "onchain-share"`, those observation fields and `admission: "entered" | "retained" | "carried"`. Whole-supply restoration also relabels an admitted partition `carried`; expired or obsolete partitions are removed without discarding otherwise restorable CoinGecko supply. `ONCHAIN_PARTITION_STAGE_BUDGET_MS` starts at the first added read and bounds the stage to 20 seconds, below existing 25-second fallback-refresh passes. The first candidate rotates by the run's canonical `sync-stablecoins` cadence slot modulo candidate count, so later candidates receive subsequent read opportunities. Token concurrency two and connection declarations are unchanged; added reads exclude Dwellir routes/native capability. Structured logs retain `onchain-partition-divergence`; the bounded per-run admission/failure summary persists as ops-only `onchainPartition` [cron metadata](./status-dashboard.md#per-job-cron-metadata), without reader notices or Telegram alerts. Preferred on-chain replacement, absent-cap fallback and class-scoped NAV admission retain their existing rules.

On supplemental CoinGecko cap failure, `syncStablecoins()` retains eligible cached supply for every tracked `detailProvider === "coingecko"` asset, including on-chain fallbacks without `geckoId`. Fresh CoinGecko-detail partitions use only the explicit share admission/carry above. Other supplemental paths retain legacy exact-total restoration of prior `onchain-total-supply` chain rows: labels must exactly match current deployments (no derived residual), one finite positive bucket must match the fallback peg, copied fields must be finite/nonnegative, and chain sum must match the fresh aggregate within `max(0.01, aggregate * 1e-9)`. Only chains restore; aggregate/source/clock stay fresh, with no `supplyRestored`. This follows primary-ID deduplication. Fresh DefiLlama `coins.llama.fi` price may merge onto restored supply. Full supply restores keep original `supplyObservedAt`, a safe integer ≤60 seconds in the future and ≤7 days old (`SUPPLEMENTAL_RESTORE_MAX_AGE_SEC`). Undated rows get one restore; later cache loading dates them from publication. Expiry publishes real current fallback supply (empty if absent) and logs expired IDs. `supplyRestored`/observation provenance drive the detail hero's "Stale supply · as of {date}" note.

Supply-gap reconciliation (`worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts`) raises DefiLlama aggregates from CoinGecko only under DEC-01. Exactly one tracked chain must be missing; its `coingecko-gap-fill` row gets the nonnegative CoinGecko-minus-DefiLlama remainder, with chain sum = `getCirculatingRawOrNull(asset)`. Unavailable aggregates reject repair. NAV/yield-bearing assets cannot use par-valued on-chain repair.

Ordinary DefiLlama-outage CoinGecko fallback keeps the fresh CoinGecko aggregate and its actual observation clock. Prior aggregate/chain historical buckets may remain, but copied chain current values become `null`, never same-generation observations under the fresh clock. A complete curated on-chain overlay may replace this packet; a failed overlay keeps the fresh aggregate with unavailable chains. Bounded `coingecko-gap-fill` carry (below) is a distinct coherent restored packet.

### CoinGecko aggregate gap-fill limits (DEC-01)

DEC-01 (2026-09-27) retains this explicit, fail-closed, double-count-safe raise. Ratio bands live in `COINGECKO_GAP_FILL_POLICY`; chart-distance, workload and carry bounds are separate constants in `worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts`. **The owner reviews the numbers at the implementing PR.**

| Rule | Contract |
|---|---|
| Ratio | `ratio = CoinGecko market cap / DefiLlama list total`. Candidate admission requires a timestamped simple-price cap within CoinGecko's 15-minute budget; the band is re-checked on the chart cap actually published. Its current point may be up to two days old (and at most 60 seconds future-dated); 1d/7d/30d points may be within three days of their targets. Published `supplyObservedAt` comes from the chart current point, not the simple-price candidate clock. |
| Entry (not gap-filled last publication) | `1.05 < ratio <= 1.45` |
| Hysteresis retain (previous published row had `supplySource = "coingecko-gap-fill"`) | `1.02 < ratio <= 1.50`; at or below `1.02` the row returns to DefiLlama and must clear `1.05` again to re-enter |
| No decision | Simple-price/history failures, candidate-cap deferrals and outage fallback carry one coherent prior packet for at most two publications. A valid-JSON non-object simple-price root (including `null`, an array, or a primitive) is unavailable supplemental evidence, not an error that aborts the supply attempt; it takes this same no-decision path. Dated originals require the shared seven-day ceiling and 60-second future-skew bound; undated originals get one carry, then age from the publication clock on cache loading. `carryForwardRuns` counts carries; `supplyRestored = true` excludes fresh daily observations. Fill resets the counter; expiry preserves the current provider row |
| Hard ceiling | `maxRatio = 1.50` at current and at every compared historical bucket DefiLlama also observed; above it the contribution never enters the aggregate |
| Coherent history | Current, 1d, 7d and 30d use one CoinGecko market-chart series, never per-bucket `max(DL, CG)`. Missing CG points reject the fill (`history-incomplete`); unobserved DefiLlama buckets stay absent because their contributions cannot be bounded. Generic D1 hydration cannot refill these source-owned absences in either fresh or bounded carried packets. |
| Attribution | Exactly one missing unique metadata chain ID (`multiple-missing-chains` otherwise), not one contract entry; existing DL current rows must all be observed and reconcile to the current aggregate within `max(0.01, total × 1e-6)` (`baseline-mismatch` for null current or dropped rows). Only the nonnegative remainder goes to the missing chain; historical attribution also requires the per-bucket conservation rule below. CG history below DL rejects before mutation (`history-below-baseline`). |
| Historical chain conservation | Check `day`, `week`, and `month` independently (`circulatingPrevDay`, `circulatingPrevWeek`, `circulatingPrevMonth`). If every existing canonical chain has an observed bucket and their sum equals the DefiLlama aggregate within `max($0.01, DL bucket × 1e-6)`, the missing chain receives `CG − DL`. Otherwise its bucket is explicitly `null`, and `withheldHistoricalBuckets` names that bucket. Never scale observed chain values or reject an otherwise admitted aggregate for this chain-history gap: the aggregate retains the admitted CoinGecko series value. If DefiLlama did not observe the aggregate bucket, both that aggregate bucket and the missing-chain bucket stay unavailable, and the bucket is named as withheld. |
| Provenance | Every admitted row carries `supplyGapFill` (`method`, `admission: entered/retained`, `missingChainId`, the retained DefiLlama `canonicalCurrentUsd`, `supplementalCurrentUsd`, `ratio`, `maxRatio`, `observedAt`) beside `supplySource = "coingecko-gap-fill"`. Optional `withheldHistoricalBuckets` is a non-empty array of `"day"`, `"week"`, and/or `"month"` naming unavailable missing-chain historical buckets. `withheldHistoricalBucketReasons` is present exactly when that array is present, with one entry per withheld bucket and no other keys: `"history-unobserved"` means the DefiLlama aggregate bucket or any existing chain's bucket is unobserved; `"nonconserving"` means all values were observed but the existing chains' sum differs from that aggregate beyond tolerance. Both fields are omitted when none are withheld. |
| Rejection | Unproven contributions leave the DefiLlama row untouched and appear in `supplyGapReconciliation.gapFillRejections`: `ratio-out-of-band`, `multiple-missing-chains`, `baseline-mismatch`, `history-incomplete`, `history-ratio-above-bound`, `history-below-baseline`, `current-observation-future`. Current chart clocks admit at most 60 seconds beyond the run clock independently of historical matching; admitted skew retains signed age, never zero-clamping |

**Calibration/replay (2026-09-27):** large DefiLlama/CoinGecko ratios can reflect methodology despite complete chain coverage. `1.50` sits above p90 and the retained single-missing-chain cluster, below the first divergent cluster. Council replay rejected feUSD, USDXL, scUSD and BtcUSD; wCOP failed `history-ratio-above-bound`; reUSD retained by hysteresis.

**History discontinuity and live-depeg impact:** rejected fills revert to canonical DefiLlama totals, so published supply and the next daily `supply_history` observation step down once: a methodology change, not a redemption; prior rows are not rewritten. USDXL and scUSD fall below the **$1M live-depeg floor**, lose live detection, and open events close as `coverage-lost-supply`. The bound (delegated DEC-01, 2026-09-27) remains subject to owner review.

NAV/yield-bearing supplemental assets are never par-valued for supply. When every market price lane fails (e.g. a CoinGecko delisting), an asset with a registered vault NAV route values its on-chain total supply through the pre-intake `resolveVaultNavSupplyPrice` protocol-redeem reuse described in [pricing-pipeline.md](process/pricing-pipeline-appendix.md#coingecko-low-volume-lane); without a trusted NAV the asset stays out and eventually reports as dropped in `trackedCoverage`.

Cached `onchain-total-supply` rows must also satisfy the current curated deployment roster and reconcile their chain packet before any supplemental or missing-tracked carry-forward. Removed/incomplete aggregates and packets missing newly required legs cannot be restored; reviewed canonical escrow residual labels remain allowed. Single-deployment totals retain their existing eligibility, and other upstream supply sources keep the ordinary age ceiling.

`restoreMissingTrackedAssets()` applies the same restore-or-degrade rule to the main DefiLlama list's tracked-id coverage: an active tracked coin the list omits but last cycle published is re-published from its previous row (`supplyRestored`, same 7-day ceiling) rather than silently dropped, and cron metadata records restored/dropped IDs (`trackedCoverage`). Past the ceiling, or without usable previous supply, it stays out and is reported dropped. Absent supplemental tracked IDs use this same backstop; the supplemental merge resolves only current-run rows and performs no second restoration pass.

Per-asset admission, quarantine and identity decisions live in [Coverage Decisions](#coverage-decisions). Zero-collapse candidates precede nonblocking chain gaps so the 15-candidate cap cannot starve repair.

`syncStablecoinCharts()` reads `stablecoincharts/all`, repairs FX, then overlays D1 `supply_history` for tracked non-DefiLlama assets without `llamaId` before downsampling/publication. BRZ alone is excepted: its legacy DefiLlama ID has no chart rows. CoinGecko-admitted rows with DefiLlama chart identities are not double-counted. `GET /api/stablecoin-charts` serves that cache without a trailing live `stablecoins` aggregate point.

Aggregate supply charts and non-USD share history share chronological spacing: daily from the inclusive 90-day boundary, weekly from the inclusive two-year boundary, and 30-day spacing earlier. Selection measures elapsed seconds from the last retained point, without calendar alignment or a forced latest point. Chart sorting/projection and minimum-point admission remain producer-owned; non-USD window cutoff and coverage admission happen before sampling, preserving admitted null/zero payloads.

Producer intake quarantines empty/all-invalid base buckets with `invalid-chart-base-buckets-dropped` before repair, overlays or sampling; genuine observed zero remains admitted. Overlay rows never fabricate points for rejected base dates. The final payload must satisfy `normalizeStablecoinChartPoints()` before persistence.

Charts have no live-current-point composer; live aggregate publication enforces aggregate-universe compatibility before historical-cache consumption.

### Circuit Breakers

Per-source circuit breakers protect most high-risk external integrations. The open threshold, probe interval, alert behavior, public-health impact, and the public-impact exclusion list are owned by [Worker Infrastructure: Circuit Breakers](process/worker-infrastructure-appendix.md#circuit-breakers); the exclusion predicate is `isPublicImpactCircuitKey()` in `shared/lib/public-health.ts` and the key registry is `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`.

`npm run check:provider-resilience` backs this posture with a registry in `scripts/lib/provider-resilience-registry.mjs`. It records the expected timeout, response-body handling, circuit source where applicable, and regression tests for external provider/fetcher surfaces, and it fails when a new production Worker file adds raw `fetch(...)` without a registry entry.

### DefiLlama list vs detail API

The list-supply policy is [ADR-8](./architecture.md#adr-8); [Supply Data Source](#supply-data-source) states its units.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) can supply native `totalCirculating`/`circulating` buckets and day-specific `totalCirculatingUSD`. For non-USD pegs, `normalizeDefiLlamaDetailBody()` in `worker/src/api/stablecoin-detail/defillama.ts` preserves these independently: a missing historical USD or native side stays unavailable, never revalued with the current `parsed.price`.


### Supplemental chain history

Current-only on-chain supply packets omit per-chain `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth`; zero is reserved for an observed zero baseline. Publication and bounded packet restoration accept missing histories while validating any supplied values. Previous-cache loading removes synthetic chain history from legacy current-only on-chain packets before carry-forward. Chain alias normalization preserves unknown history, and chain summaries exclude missing historical pairs rather than counting the whole current balance as new supply. Mint/burn reconciliation leaves these rows `insufficient-source` until a real baseline is available.

### Chain observation absence

Intake (`normalizeChainCirculating`) collapses every provider chain bucket — `current`, `circulatingPrevDay`, `circulatingPrevWeek`, `circulatingPrevMonth` — with an absence-preserving sum: an empty or invalid bucket becomes `null`, an explicit `{peggedUSD: 0}` stays `0`, and a chain row without any `current` keeps the row (the chain is known) with `current: null`. `canonicalizeChainCirculating()` carries `current: null`, and alias merges leave a key unavailable whenever any alias lacks it, so a partial sum never pairs against a complete baseline. `aggregateChains()` skips an unavailable current entirely and pairs a historical window only when both sides are observed: an empty 1d baseline cannot manufacture a mint and an empty current cannot manufacture a redemption, while a numeric zero current is still a real redemption.

Release B (2026-09-28) activates these nullable values in `/api/stablecoins`: canonical `stablecoins` cache writes, the response-ready companion and public dataset snapshots carry unavailable chain observations as `null`, never `0`. The frontend chain distribution renders unavailable when a chain current is unknown rather than normalizing a partial denominator to 100%; report-card DEX deployment supply coverage likewise withholds its ratio when any chain current is unobserved. The daily chain snapshot's separate fresh-coverage contract defers affected writes with unavailable observations.

The response-ready schema marker is `StablecoinListResponseSchema:v2`; retained Release A `v1` companions are ignored and the canonical nullable cache is read with its original generation clock, so a failed or delayed companion refresh cannot revive the zero projection. Served responses may stay cached for the producer-backed profile's 300-second shared max-age plus 300-second stale-while-revalidate (browser max-age 60 seconds); observe a new sync generation before declaring cutover. Release B deployed only after Release A Worker and Pages readiness; roll back only to those nullable-compatible readers. Legacy stored numeric observations are not retrospectively converted without provenance.

## Coverage Decisions

`rusd-royal-dollar` uses DefiLlama Royal Dollar (`llamaId = 415`). After `sofid-sofi` re-admission on September 29, eight no-positive-market-cap assets remain quarantined without waivers: `benji-franklin-templeton`, `wtgxx-wisdomtree`, `busd0-usual`, `tbill-openeden`, `jusd-jusd-stable-token`, `vndc-jade-labs`, `gramg-token-teknoloji`, `grams-token-teknoloji`. CETES remains separately quarantined for denomination and circulating/native/represented-scope reconciliation, not absent positive CoinGecko data; see [CETES admission hold](#supply-data-source). AUDm/CADm/CHFm/COPm/GBPm/ZARm use CoinGecko detail admission after explicit-zero DefiLlama and positive permitted fallback; ZARm may retain curated on-chain supply. XOFm remains DefiLlama-backed with curated Celo repair.

Four records are quarantined (`changedAt: 2026-09-24`, `reviewBy: 2026-10-24`): `hlusd-hela` (no supported tracked contract; CoinGecko stale since Biconomy's 2026-08-14 trading suspension), `vusd-virtue` (unprobeable IOTA Move issuance makes partial IOTA EVM raw supply inadmissible), `luausd-lumi-finance` (no CoinGecko/DefiLlama price; only an imbalanced zero-volume Arbitrum Curve pool, ~$3.4K effective TVL) and `bib01-backed` (issuer wind-down; CoinGecko frozen since 2026-09-17 and DefiLlama re-stamping 121.86, so its seven-chain aggregate cannot be valued). `vcred-vcred` was owner-approved for scope delisting on 2026-10-22: the exact Hemi contract shows owner minting, not collateral or a stable-value redemption claim; CoinGecko's last quote is September 7 with no tickers, and its only material pool (~$16K liquidity) is below the $50K observation floor. Its profile and historical research stay read-only, neither frozen nor in the cemetery; the prior September 24 treasury-excluded 12,600,000-unit observation neither values it now nor authorizes continued collection. `usda-avalon` stays active with a dated price-gap acknowledgement: supply is sound, but its sole DefiLlama per-deployment quote (e.g. `nibiru` 0xf4e0…2003) is intermittently re-stamped, not absent.

`usdv-solomon-v2` is a separate active CoinGecko supplemental asset valued on the new six-decimal Chancery mint. DefiLlama re-pointed asset 261 to it on 2026-09-24; the legacy `usdv-solomon` left that lane on 2026-09-27, and its 2026-09-23–26 `supply_history` rows containing replacement supply await reviewed repair. Legacy publication uses supplemental `supplySource = "onchain-total-supply"` via `getTokenSupply` on its exact mint (≈1.51M; unreadable fails closed). Untracked list row 261 is ignored, counting replacement supply only on v2 and preventing its smaller market cap from becoming legacy fallback. Neither generation imports historical price/market-cap series from recycled CoinGecko ID `solomon-usdv`; detail charts use forward local supply history/cache and preserve existing legacy history.

savUSD's curated aggregate reads Avalanche CCIP LockRelease escrow `0x8fcc42c414e29e8e3dbfa1628cf45e8ed80c999d`: canonical free float, measured remote deployments and `savUSD unattributed CCIP escrow`. The residual covers unprobed Base/Arbitrum/Movement custody, not Avalanche. Reject unreadable escrow or a value above canonical supply/below measured representations.

## Chain Dropout Guard

The guard closes a specific blind spot: a chain can collapse or disappear while the asset aggregate stays positive, so whole-asset zero repair and absent-chain gap-fill alone do not detect it. This section owns detection and release; structured Pricing history retains the original regression chronology.

`guardChainDropouts()` (`worker/src/cron/sync-stablecoins/chain-dropout-guard.ts`) runs in intake after `reconcileTrackedSupplyGaps()`. It evaluates only active tracked `detailProvider === "defillama"` rows that are not frozen, not `supplyRestored`, and not already handled by another reconciliation lane. Thresholds live only in `CHAIN_DROPOUT_POLICY`:

The guard evaluates the union of present chain identities and known material/quarantined identities, including
recoverable identities in the last accepted publication. An omitted row (even an empty current chain map) is reintroduced
with `current: null` and passes through the same repair, attribution-ambiguity and carry-ceiling rules. Provider omission
never releases a quarantine or advances its first-detection clock.

An explicit zero aggregate is an observed value, not an admission failure. It can reach this guard when earlier zero-row reconciliation did not resolve it; known collapsed or omitted chain identities still undergo repair, ambiguity checks and materiality handling. An unresolved material dropout conservatively carries the vetted baseline with `supplyRestored` and `supplyChainGuard` provenance inside the carry ceiling, then becomes unavailable. This is intended continuity behavior, not authority to publish a fresh positive observation from the zero list row.

| Rule | Contract |
|---|---|
| Baseline | The persisted per-pair baseline (cache key `sync-stablecoins:chain-dropout-state`, version 1). If there is none, use the reviewed incident seed (`chain-dropout-seed.ts`: 39 pairs at DefiLlama's 2026-10-08 per-chain daily values, USDG X Layer/Ink cross-checked on-chain, valid until 2026-11-09). Otherwise use this payload's chain `circulatingPrevDay`. |
| Flag | Baseline `>= $1M` (`minBaselineUsd`) and current `null` or `<= 0.5 × baseline` (`collapseRatio`). A healthy chain moves the baseline to its current value. |
| Stickiness | While a pair is flagged, its baseline is frozen. Detection always compares against the persisted baseline, never only against the incoming `circulatingPrevDay`, so a continuing bad zero that ages into `prevDay = 0` stays flagged. Elapsed time never releases a pair. |
| Complete reviewed replacement | Before additive repairs, a flagged non-NAV/non-yield asset with an existing complete `CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS` roster can recover through a fresh whole-roster native/canonical observation. Every configured chain must be measured, all rows must conserve the aggregate, and the oldest native read must be within two `sync-stablecoins` intervals (plus the shared future-clock allowance). This replaces the whole current generation as `onchain-total-supply`, including healthy legs, rather than adding a missing chain to a possibly reattributed DefiLlama total. It clears the old ambiguity hold only on complete success; failed, partial, stale or nonconserving reads preserve quarantine. Unobserved historical buckets become null. |
| Repair 1: reviewed on-chain | `CHAIN_DROPOUT_ONCHAIN_ROSTER` lists issuer-native deployments only (currently USDG on X Layer and Ink). The lane reads catalog-contract `totalSupply()` through the registry RPCs and values it at the USD peg reference; NAV and yield-bearing assets have no on-chain lane. A read above `0.5 × baseline` repairs the chain. A read at or below it corroborates a real collapse: the native amount (not the list value it may contradict) is published as the chain current, with the aggregate adjusted by `native − list current`, and the pair is released at that confirmed baseline. |
| Repair 2: DefiLlama per-chain chart | `GET /stablecoincharts/{chainLabel}?stablecoin={llamaId}`. The latest daily point must be at most 48h old and above `0.5 × baseline`. A low chart value is the same provider, so it never releases a material quarantine. Fetches are strictly sequential with bodies consumed, capped at 8 per run (largest deficit first), and refetched at most hourly per pair, failed attempts included. |
| Repaired chain | The chain `current` becomes the repaired value. The aggregate gains only `repaired − list current`. Without a quarantine, the row publishes `supplySource = "defillama-chain-repair"`. Aggregate `supplyObservedAt` uses the oldest admitted upstream DefiLlama chart repair point; native-only repairs preserve the incoming list clock or its absence, and mixed repairs use only chart clocks. Native local-read times never become upstream aggregate observation times. |
| Unrepaired chain | The chain `current` becomes `null` (R1: unavailable, never zero). |
| Quarantine | Applies when the unrepaired deficit (`baseline − list current`) is at least 2% (`quarantineDeficitRatio`) of the repaired aggregate plus that deficit. The row is published `supplyRestored = true`. Within the existing 7-day `SUPPLEMENTAL_RESTORE_MAX_AGE_SEC` ceiling, measured from `quarantinedSince`, the aggregate carries the frozen vetted baselines and `supplyObservedAt` is the oldest carried baseline. Past the ceiling, `circulating` becomes `{}` (unavailable) and the asset stays quarantined; it is never accepted automatically. |
| Partial coverage | Past the ceiling, an unrepaired deficit of at most 5% (`partialCoverageMaxDeficitRatio`) of the vetted whole-asset total (repaired aggregate plus deficit) does not blank the asset. The row publishes the observed aggregate plus any admitted repairs, with its own list clock and no `supplyRestored`, and `supplyChainGuard` `status: "chains-unavailable"`, `partialCoverage: true` and the original `quarantinedSince`. The status vocabulary is unchanged, so readers deployed before the Worker still parse the row. Excluded chains stay `current: null` with `resolution: "unavailable"`. Nothing is carried or added, so this holds under attribution ambiguity too: reattributed supply is counted once, by its new chain. The pairs stay quarantined and release only through the material-release paths; run metadata keeps listing the asset under quarantined IDs. A larger deficit remains unavailable. |
| Immaterial dropout | Below the 2% materiality bound, unrepaired chains publish `null` and the aggregate keeps the DefiLlama value, without a restored flag. The pair releases only when list current is observed and a fresh per-chain daily chart point dated after first detection is also at or below `0.5 × baseline`; omission/null current does not release it. |
| Material release | List recovery above `0.5 × baseline`, reviewed on-chain corroboration of the collapse, a complete reviewed replacement described above, or a dated entry in `REVIEWED_CHAIN_SUPPLY_COLLAPSES` can release a material quarantine. Dated releases require `reviewedAt >= quarantinedSince`, no future review date, and an observed list current; they never accept an omitted chain or authorize incidents first detected after the review. |
| Attribution ambiguity | Any same-run gain on the same asset's healthy chains may be the dropped supply reattributed by DefiLlama (for example a bridge representation such as USDG0 on Hyperliquid moved back to its source chain), and a concurrent mint cannot be told apart from that move. Because a gain of any size bounds the possible double count (for example $80M/$20M becoming $85M/$0 would publish $105M after a $20M destination repair), every additive repair and carry is withheld: no scaled or clamped value is published (R7), the dropped chains publish `null`, and a material drop holds the vetted whole-asset total from before the gain (each chain at its pre-run reference). If any chain has neither a reference nor a current observation, that total is unknown (`heldTotalUsd: null`) and a material drop publishes unavailable supply, never a partial sum (R1). A native confirmation at or below the list value is non-additive and cannot double count, so it stands as a confirmed redemption and leaves the unresolved deficit. In a total summed in the same run, the confirmed chain's reference is replaced by its native amount. A persisted packet never recorded that chain's frozen contribution, so it becomes unknown rather than being adjusted by a later, independently moved baseline, and a negative remainder is never clamped to zero. The ambiguity and held total persist on the flagged pairs (`ambiguousSince`, `heldTotalUsd`) until the chains recover, so later runs cannot re-repair once the inflated source has become its own baseline. Rows carry `supplyChainGuard.concurrentGainUsd`. Only reviewed bridge-aware accounting could lift this. |
| Provenance | `supplyChainGuard`: `reason: "supply-chain-dropout"`, `status` (`repaired`, `quarantined`, `unavailable`, or `chains-unavailable`), optional `quarantinedSince`, optional `partialCoverage: true`, and per chain `chainId`, `chainLabel`, `listCurrentUsd`, `baselineUsd`, `baselineObservedAt`, `baselineSource` (`state`, `seed`, or `list-prev-day`), `resolution` (`onchain-total-supply`, `defillama-chain-history`, `carried-baseline`, or `unavailable`), and `repairedCurrentUsd` / `observedAt` when repaired. Optional `observedAtKind` labels native issuer reads `"local-read"` (the sync-start run clock) and DefiLlama chart points `"upstream"` (the point date). Withheld repairs discard both repair clock fields; older provenance without a kind remains readable but does not establish an upstream clock. |
| State persistence | Pairs with baseline `>= $1M`, plus any quarantined pair, are persisted only after `validateAndWriteStablecoinsCache()` reports an actual write. Pairs released at a confirmed level (on-chain corroboration, reviewed release or immaterial chart release) carry `releasedAt` and are never pruned, and pairs covered by the unexpired incident seed are retained; a confirmed low or zero baseline therefore survives later read failures instead of rebooting from the stale seed or an aged `prevDay`. A blocked or CAS-skipped publication does not advance the state. A failed or schema-invalid state read skips persistence for that run, so it never clobbers stored quarantines. It also never releases them (R2): pairs are rebuilt from the last accepted publication before evaluation. Guarded chains take their frozen baseline, first-detection clock and any held ambiguous total from `supplyChainGuard`; a native-low corroboration is recovered at its confirmed native amount and release clock. Every other published chain current becomes that chain's accepted level, including a confirmed low or zero whose guard sidecar disappeared once the chain stopped being flagged. Only chains absent from the publication fall back to seed/`prevDay` bootstrap. If the previous publication is unreadable too (`error` or `malformed`, as opposed to a genuinely `missing` first run), a quarantined collapse whose `prevDay` has aged to zero is indistinguishable from a first run. That generation is withheld: no cache write, and the run returns `degraded` with `reason: "supply-chain-guard-baselines-unavailable"`. |
| Status | Run metadata `supplyChainGuard` records `flagged`, `repaired`, bounded quarantined/unavailable ID lists with full counts, `historyFetches` and `stateReadFailed`. Any quarantined or unavailable asset adds `metadata.quality` (`reason: "supply-chain-dropout-quarantine"` with quarantined/unavailable counts). Quarantine alone does not degrade a completed publication (R4); an otherwise successful run remains `ok`, shown as “Succeeded with findings”. Other conditions still return `degraded` and name one driver in both `reason` and `quality.reason`, in precedence order: a depeg hold reason, `stablecoin-publication-gap-elevated`/`-systemic`, `depeg-pipeline-errors`, `price-staleness-check-failed`. A degraded run with quarantine lists both in `quality.reasons`, driver first. |

**Reviewed lower-chain observations (2026-10-16 06:18:46 UTC):** The existing dated-release mechanism accepts two independently corroborated reductions, without overriding the DefiLlama aggregate or adding any supply:

- **satUSD / Arbitrum:** [Arbitrum contract](https://arbiscan.io/token/0xb4818bb69478730ef4e33cc068dd94278e2766cb) `totalSupply()` at [block 515293481](https://arbiscan.io/block/515293481), hash `0x0626a76752b878e21a4839228e2133752edabaffe1fe7abea94c0feefe03a0f3`, was **1,155,833.488355934 satUSD** (18 decimals). The [DefiLlama detail history](https://stablecoins.llama.fi/stablecoin/218) reports the same native stock, down from 10,801,662 on October 11 to 1,155,833 on October 12; aggregate native stock fell by the same 9,645,829 while Ethereum, BSC and Base stayed unchanged on those daily points. This corroborates a real lower chain stock, not a missing read; it does not assert the economic reason for the burn. The list's USD chain amount is already price-adjusted and is accepted unchanged.
- **EURS / Polygon:** At [Polygon block 95617466](https://polygonscan.com/block/95617466), hash `0x13a11cd1607fb4f5ed2eeb601ef0081b0cbc685d9827df5fe608a9c4410aaee2`, [the bridged token](https://polygonscan.com/token/0xe111178a87a3bff0c8d18decba5798827539ae99) had **533,719.13 EURS** total supply and **100,000 EURS** at issuer inventory `0x1bee4f735062cd00841d6997964f187f5f5f5ac9`, leaving **433,719.13 EURS** circulating. This independently matches [DefiLlama's existing supply-minus-inventory accounting](https://github.com/DefiLlama/peggedassets-server/blob/master/src/adapters/peggedAssets/stasis-eurs/index.ts). Its [October 15–16 native detail history](https://stablecoins.llama.fi/stablecoin/51) moves Polygon 1,945,168 → 433,719.13 and Ethereum 3,861,635 → 5,373,084.06 while aggregate EURS remains 6,852,620 → 6,852,619.64 (daily integer rounding). The lower Polygon stock is corroborated, and the conserved aggregate is consistent with a bridge unwind, not aggregate redemption; adding the old Polygon baseline would double count.

The same review does **not** release omitted Solana rows for apxUSD/USDON or the omitted HyperEVM row for frxUSD. DefiLlama's detail histories omit these identities too; the HyperEVM chart is empty, and the two Solana chart reads returned non-JSON bodies. Native Solana reads still showed 5,901,994.395883 apxUSD and 13,499,316.712050509 USDON, so omission is not evidence of zero. DefiLlama's frxUSD adapter labels an EVM contract under `hyperliquid`, and the current “Hyperliquid L1” amount matches a native HyperEVM read of 43,067.502661 frxUSD; neither that label nor a shared token address proves continuity with the quarantined $3.749M HyperEVM baseline. All three have persisted concurrent-gain ambiguity and remain quarantined pending recovered observations or reviewed complete bridge-aware accounting. From Pricing v6.55, frxUSD's expired HyperEVM quarantine ($3.749M, about 3.7% of the vetted total) publishes as partial coverage instead of unavailable supply. The quarantine itself is unchanged. No global HyperEVM/Hyperliquid L1 alias or additive repair is justified.
The later USDon recovery roster explicitly covers its separately issued native Ethereum, BSC and Solana stocks, consistent with the reviewed issuer-native deployment map. Recovery requires a fresh observation of all three, not the old Solana quantity added to today's two-chain DefiLlama aggregate. Its source clock is the oldest actual native read, not a renewed provider timestamp. The earlier omitted-chain observations remain historical evidence and do not themselves release the quarantine. apxUSD and frxUSD have no new complete-roster admission from this change.


Downstream consumers: `snapshot-supply` skips `supplyRestored` rows but still counts them as accounted coverage, so a quarantined asset neither writes a polluted daily row nor blocks the day. `snapshot-chain-supply` defers any chain with a `null` contributor instead of publishing a smaller subtotal. Per-pair repairs do not modify historical aggregate buckets (`circulatingPrevDay/Week/Month`); a complete reviewed native replacement withholds those unobserved buckets as null.

Past the carry ceiling, `GET /api/stablecoin/:id` sets `currentSupplyUnavailableReason: "supply-chain-dropout"` from the canonical row and strips any provider-supplied copy, as it does for `currentSupplyRestored`. `projectStablecoinLiveSummary()` then publishes empty `circulating`, a `null` native current sample and `supplyRestored`, never substituting the provider's dated history for current supply. The detail hero's market cap, supply and supply trend therefore read unavailable rather than a provider-history value. A `partialCoverage` row instead keeps its current overlay and adds `currentSupplyExcludedChains`, the excluded chain labels, taken only from the canonical row; a provider-supplied copy is stripped. The live summary's `supplyExcludedChains` makes the hero label market cap "Partial supply · excludes …". The chain distribution card already reads unavailable while any chain current is `null`.


A generic `totalSupply()` sum is not circulating supply (bridged lock-and-mint double counting, issuer treasury inventory), and catalog coverage does not imply runtime probe support. Compare `contracts[]` in `shared/data/stablecoins/coins/*.json` with `onchainSupplyProbeFamily()` in `shared/lib/onchain-supply-probe.ts` rather than using a fixed catalog/reader count. On-chain reads are admitted only through reviewed per-pair corroboration or the complete reviewed native/canonical recovery roster above; there is no arbitrary positive-supply override.
