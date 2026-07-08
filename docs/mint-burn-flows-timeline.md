# Mint/Burn Flow Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Mint/Burn Flow `v1.0` through `v6.18` (2026-03-01 -> 2026-07-03).

---

## v6.18 - Runtime coverage count reconciliation (July 3, 2026)

- Current runtime scope is 135 contract configs across 135 stablecoin IDs: 7 critical-lane configs (implicit `tier: "critical"`) and 128 explicit `extended` configs.
- Tracked registry count is 410 metadata entries, so DDR and mint/burn docs now report mint/burn coverage as 135 of 410 tracked coins instead of the stale 137 of 407 figure.

---

## v6.17 - Tx-context shortfall exclusion recovery (June 7, 2026)

- Bridge-enabled configs now handle residual transaction-context shortfalls at the row level instead of withholding every parsed row in the config window.
- Rows whose tx or receipt context was unavailable were persisted as `flow_type='bridge_transfer'`, with unresolved burns marked `review_required` / `tx-context-unavailable`, so they remained excluded from counted economic-flow aggregates. (Superseded 2026-06-19 by `cae9f4df9`: deferred shortfall rows are now filtered out of persistence entirely and retried on a later run once the sync frontier catches up past their block; the then-dead `bridge_transfer` row mutation was removed 2026-07-02 in `2ba8a6811`.)
- Resolved rows in the same scan window are persisted normally and the sync frontier can advance when event and timestamp coverage are otherwise complete; cron metadata still exposes `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows` as unavailable-context diagnostics rather than provider-error counts.

---

## v6.16 - Bridge context budget recovery (June 7, 2026)

- Bridge-aware transaction context now resolves transaction and receipt data through one batched Alchemy JSON-RPC call per transaction instead of two separate calls.
- Bridge-aware critical configs may use up to 150 requests within the unchanged 200-request cron-wide budget, allowing high-volume USDC windows to catch up without repeatedly deferring every parsed row under the old 60-request cap.
- The v6.15 fail-closed guard remains intact for `standard` flow: unavailable tx-context rows are not counted as economic mints or burns.

---

## v6.15 - Bridge tx-context shortfall guard (June 6, 2026)

- Bridge-enabled configs now require transaction and receipt context before parsed rows are persisted.
- If tx context is unavailable under budget pressure or RPC failure, parsed rows for that config are deferred instead of defaulting bridge candidates to `standard` flow.
- The config remains unsatisfied, the sync frontier does not advance, and cron metadata exposes `bridgeClassification.txContextShortfalls` plus `bridgeClassification.deferredRows`.

---

## v6.14 - Bridge config validation fail-closed (June 6, 2026)

- Bridge-detection configs now abort module load when an address, topic, or selector is malformed instead of logging and continuing.
- Mint/burn runs publish `bridgeValidationErrors: 0` in cron metadata on healthy configs so status diagnostics expose the validation surface.
- Checked-in bridge configs are covered by a validation collector regression before deploy.

---

## v6.13 - USD-valued largest-event guard (June 6, 2026)

- Aggregate `/api/mint-burn-flows` now excludes `amount_usd IS NULL` rows from the 24-hour largest-event selector.
- Largest-event ranking uses resolved USD amount only and no longer falls back to raw native token amount.
- Unpriced mint/burn rows remain available for event-ledger diagnostics and remediation, but they do not populate the USD largest-event table column.

---

## v6.12 - Cadence-based coverage lag classification (June 6, 2026)

- Established per-coin coverage now turns `lagging` once measured block progress falls beyond the public freshness cadence for that chain, capped at the historical 10K-block ceiling.
- Coins with missing current chain-head metadata now report `unknown` coverage instead of staying `full` from historical sync state alone.
- The public flows table, flow receipt, API schema, and coverage matrix all expose the new `unknown` state so frozen or unverifiable configured-chain coverage is visible.

---

## v6.11 - yBOLD extended transfer coverage (May 12, 2026)

- Added Yearn BOLD (`ybold-yearn`) to the extended Ethereum mint/burn registry.
- The config uses the checked-in yBOLD Ethereum ERC-20 vault-share contract metadata and standard zero-address `Transfer` events.
- yBOLD share issuance/redemption is tracked separately from base BOLD flow because the wrapper has distinct vault-share supply dynamics.
- No bridge classifier was added: Pharos tracks the single Ethereum yBOLD vault-share deployment.

---

## v6.1 - USG extended transfer coverage (May 8, 2026)

- Added Tangent USD (`usg-tangent`) to the extended Ethereum mint/burn registry.
- The config uses the verified USG ERC-20 contract's standard zero-address `Transfer` events from reviewed deployment block `24,442,033`.
- An RPC log review from deployment through the current head found three zero-address mint events totaling 40.02M USG, matching the contract's current `totalSupply`.
- No bridge classifier was added: only the Ethereum token contract is currently tracked, and public Tangent docs do not publish a separate bridge route.

---

## v6.0 - Comprehensive mint/burn remediation (Apr 17, 2026)

**Effective:** 2026-04-17 (effectiveAt `1776425040`). Shipped via merge of branch `mint-burn-remediation-2026-04-17`. Historical rows are reclassified progressively via the operator playbook (`/api/reclassify-atomic-roundtrips?stablecoinId=<id>` for partition-scoped reverse flips, `/api/backfill-mint-burn` for chunked bridge-mint replay).

**Bridge classification**

- CCIP/CCTP classifier now tags bridge **mints** as `flow_type='bridge_transfer'` (previously only burns were tagged). Affects USDO, USD1, avUSD, ZCHF (CCIP) and USDC, EURC (CCTP).
- LayerZero OFT classifier now accepts an endpoint-only signal (`fingerprintC`: `hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0`), catching LayerZero-Executor-only mints that previously slipped through. Known shared-endpoint false-positive risk is accepted.
- Removed the `bridge-signal-with-unknown-pool` review path: rows with a bridge signal are now tagged `bridge_transfer` regardless of whether the pool address is known.
- Bridge-detection configs are validated at module load (`validateMintBurnBridgeDetection`); v6.14 escalated malformed bridge config metadata to fail-closed module-load errors.
- Classifier module split: dispatcher in `mint-burn-bridge-classifier.ts`, per-protocol helpers in `mint-burn-bridge-classifier-protocols.ts`, shared types in `mint-burn-bridge-classifier-types.ts` (leaf module, breaks import cycle).

**Counterparty extraction**

- `MintBurnEventDef` gained a `counterpartyEncoding` override supporting unindexed `data` slots and non-default topic slots via the new `readDataWord` helper in `worker/src/lib/evm-logs.ts`.
- reUSD `Deposited` events (all params unindexed) now correctly populate counterparty via `{ source: "data", slot: 0 }`; they previously resolved to `null`.

**Atomic roundtrip detection**

- Added 0.5% amount tolerance (`ROUNDTRIP_AMOUNT_TOLERANCE = 0.005`): a group only tags as `atomic_roundtrip` when `|sum(mint) - sum(burn)| ≤ 0.005 × max(mintSum, burnSum)`. Partial same-tx groups (e.g. mint 100 / burn 50) are no longer mis-tagged.
- In-memory detector defensively skips rows with an empty `tx_hash`.
- Cross-run sweep HAVING clause mirrors the tolerance using the `CASE WHEN a >= b THEN a ELSE b END` pattern (SQLite has no two-arg `MAX`).
- Drift-guard unit test asserts `ROUNDTRIP_AMOUNT_TOLERANCE === 0.005` so TS/SQL literal drift is caught.

**Bank Run Gauge (mcap weighting)**

- Coin weight is now the coin's canonical tracked-chain circulating supply, sourced from `chainCirculating[chainId].current` and normalized by `canonicalizeChainCirculating` (handles DefiLlama's capitalized keys).
- New helpers: `getMintBurnTrackedChains(stablecoinId)` and `sumMcapForTrackedChains(...)` in `worker/src/lib/mint-burn-mcap-weighting.ts`.
- Fallback to `sumPegBuckets(circulating)` preserved for coins with no tracked chains, empty `chainCirculating`, or missing tracked-chain entries (CG-fallback assets remain represented).

**Ingestion orchestrator**

- Config deferral: configs that exit a run with `apiErrors > 5` AND (`coverage < 0.8` or coverage is unavailable) are inserted into `mint_burn_config_deferral` with a 1-hour grace period; subsequent runs skip them (protects healthy configs from budget starvation).
- Recalc-failure propagation: `recalcAffectedHours` failures now downgrade the critical lane `ok → degraded` and surface `recalcFailed` + `recalcError` in cron metadata (previously silently logged).
- Cache invalidation: on successful runs (`ok` / `degraded`), `mint-burn-flows:*` rows are purged from the shared `cache` table via a PK-range predicate.
- Bounded-concurrency tx-context fetch: local `mapWithConcurrency(..., 4, ...)` replaces the serial `resolveTxContext` loop. Each worker fetches transaction and receipt context together, so this is a bounded best-effort speedup rather than a fixed connection-headroom guarantee.

**Admin endpoints**

- `/api/backfill-mint-burn` response now exposes `reclassified: { flowTypeChanges, burnTypeChanges }` deltas; the legacy `rowsReclassified` scalar is retained as the exact count of unique rows whose classification columns were rewritten in the chunk.
- `/api/reclassify-atomic-roundtrips` now runs a reverse pass: groups tagged `atomic_roundtrip` that fail the 0.5% tolerance flip back to `flow_type='standard'`. Response exposes `toRoundtrip` (forward) and `toStandard` (reverse); `updated` remains as `toRoundtrip + toStandard` for back-compat.

**Cron metadata observability**

- New fields: `recalcFailed`, `recalcError`, `nullPriceBacklogRecent`, `nullPriceBacklogHistorical`, `roundtripsBacklogSaturated`. Subrequest budget is exposed as `budgetUsed` / `budgetLimit` via the shared `withBudgetMetadata` helper (same names every other cron already uses).

**Migrations**

- `0096_mint_burn_config_deferral.sql` — deferral table plus `idx_mbcd_until` index.
- `0097_mbe_flow_type_ts_index.sql` — composite `idx_mbe_flow_type_ts` index on `mint_burn_events(flow_type, timestamp DESC)` to speed up the roundtrip sweep and future flow_type-filtered queries.

**Multi-chain invariants**

- Added `worker/src/cron/__tests__/sync-mint-burn-multichain.test.ts` to lock the post-Arbitrum chain-generic ingestion path. No source-level ETH/Arb hardcodes remain in orchestration; legitimate hardcodes (USDT Issue/Redeem, reUSD events, back-compat shims) are documented inline.

---

## v5.2 - GYD retirement from active mint/burn coverage (Apr 14, 2026)

- GYD mint/burn tracking was removed after the cross-chain contract incident moved the asset out of the active stablecoin registry and into the cemetery dataset
- Current public flow scope now excludes GYD from active config selection; historical rows remain in D1 if previously ingested
- Registry counts and flow documentation now reflect the active config surface after the GYD retirement

---

## v5.1 - Canonical-chain mint/burn scope for native issuance tracking (Apr 8, 2026)

- USDai mint/burn tracking now runs on native Arbitrum instead of treating Ethereum-side LayerZero bridge flow as primary issuance/redemption
- Aggregate and per-coin public APIs now read only configured `(stablecoin_id, chain_id)` pairs, so stale non-canonical historical rows no longer leak into counted flow metrics
- Cron metadata, coverage helpers, status reconciliation, DEWS inputs, and daily digest mint/burn reads now honor chain-aware issuance scope
- Admin backfill auto-selection and explicit config replay now work across the tracked issuance-chain set instead of Ethereum-only

---

## v5.0 - Bridge-transfer flow exclusion for omnichain tokens (Apr 8, 2026)

- Bridge-aware classification now excludes mint-side bridge transfers as well as burn-side bridge transfers from counted economic-flow aggregates
- USDai's Ethereum tracker now recognizes its documented LayerZero OFT / OAdapter path instead of treating equal bridge mints and burns as economic issuance/redemption
- Bridge classification now runs after all parsed rows for the config chunk are assembled, so the classifier can see bridge mints and burns together
- Backfill and replay persistence now updates `flow_type` on existing rows, allowing post-deploy repair of previously inserted bridge-transfer noise

---

## v4.9 - Deterministic repair loops and adapter provenance disclosures (Mar 24, 2026)

- Historical price repair now values unpriced rows from event-day `supply_history` instead of reusing current `price_cache` snapshots
- NULL-price healing and atomic-roundtrip sweeping now process deterministic ordered backlogs instead of relying on implicit D1 row order
- Daily digest FTQ classification now matches the public mint/burn API by using report-card score buckets instead of a separate hardcoded safe-haven list
- Coin `coverage` metadata now exposes adapter kinds plus `startBlockSource` and `startBlockConfidence` so blanket start-block defaults are visible to users

---

## v4.8 - Ethereum coverage wave for long-tail mint/burn tracking (Mar 24, 2026)

- Added 40 new Ethereum transfer-based contract configs for tracked assets that already had shared Ethereum metadata
- Restored several previously removed long-tail assets now judged worth tracking again given current market-cap and product relevance
- Expanded potential public `/flows` coverage from the low 80s into the low 120s once the extended lane backfills the added assets

---

## v4.7 - Closed-day baseline, fixed aggregate 24h semantics, and coverage disclosures (Mar 10, 2026)

- Pressure Shift now compares live 24-hour flows against the last 30 fully closed UTC-day baselines instead of mixing the active day into the baseline
- Aggregate `GET /api/mint-burn-flows?hours=N` keeps per-coin 24h fields fixed to the canonical 24-hour window while only `hourly[]` respects `hours`
- Aggregate flow responses now expose `scope`, `sync`, `windowHours`, and per-coin `coverage` metadata
- The public `/flows` page now labels the feature as Ethereum-only and visibly marks partial-history or lagging-coverage states
- Flow freshness is keyed to successful sync timestamps instead of latest event timestamps, avoiding false stale warnings during quiet periods

---

## v4.6 - Safe-frontier ingestion and counted event-history alignment (Mar 9, 2026)

- Sync-state advancement now stops at the shared safe coverage frontier when any event definition is only partially scanned
- Missing block timestamps now cap advancement at the earliest unresolved block instead of silently skipping rows forever
- `GET /api/mint-burn-events` now exposes `flowType` and supports `scope=counted` for rows that participate in aggregates
- Stablecoin detail event-history views now default to counted economic-flow rows, excluding bridge burns, review-required burns, and atomic roundtrips
- Event rows with missing USD prices now render native token amounts instead of misleading dollar values

---

## v4.5 - Data quality: noise filtering, auto-heal, and activity gating (Mar 9, 2026)

- Same-transaction mint+burn pairs for the same stablecoin are now flagged as `atomic_roundtrip` and excluded from all flow aggregates
- `sync-mint-burn` now auto-heals recent `amount_usd IS NULL` rows within a 48-hour window using `price_cache`
- Coins with less than $50K of absolute 24h flow now return `NR` for pressure shift instead of a misleading score
- Cron metadata now reports `atomicRoundtripsDetected` and `nullPricesHealed`

---

## v4.4 - Two-signal flow semantics and baseline-aware interpretation (Mar 7, 2026)

- Per-coin flow UI now separates raw 24h net flow from baseline-relative pressure shift
- API now exposes `pressureShiftScore`, `pressureShiftState`, `netFlowDirection24h`, `has24hActivity`, and baseline context fields
- `flowIntensity` remains in the API as a deprecated compatibility alias for `pressureShiftScore`
- Printer/shredder visuals now follow actual net flow direction instead of score sign

---

## v4.3 - NR gating for no-activity flow windows (Mar 4, 2026)

- Coins with no mint/burn activity in the active 24h window now publish `null` Flow Intensity (`NR`) instead of a synthetic neutral value
- Bank Run Gauge excludes those NR windows from the market-cap-weighted composite
- Frontend flow-intensity UI now renders NR explicitly for null windows

---

## v4.2 - Signed zero-baseline flow-intensity semantics (Mar 4, 2026)

- Flow Intensity Score moved from midpoint `0-100` to signed `-100 to +100` semantics
- Bank Run Gauge score moved to signed `-100 to +100` with neutral baseline at `0`
- Band thresholds were remapped around zero while preserving `CRISIS` to `SURGE` labels
- Frontend midpoint conversion shim was removed so UI consumes canonical signed API values directly

---

## v4.1 - Reliability remediation and controlled backfill recovery (Mar 4, 2026)

**Commit:** `20f56c3`

- Added run-state rotation and per-chain budget quotas to improve deterministic coverage under limits
- Added degraded/error status escalation from sustained low coverage or API failures
- Added authenticated chunked backfill endpoint (`POST /api/backfill-mint-burn`) using ingestion pipeline logic

---

## v4.0 - reUSD deposit amount scale correction (Mar 4, 2026)

**Commit:** `a49abfa`

- Corrected reUSD `Deposited` event decimals from `6` to `18`
- Removed reUSD mint-volume inflation caused by scale mismatch
- Added regression test for known on-chain deposit payload decoding

---

## v3.2 - Event-time USD valuation for flow amounts (Mar 3, 2026)

**Commit:** `89ef4fa`

- Event valuation now prefers historical `supply_history` price snapshots for the event day
- Added event-level valuation provenance (`price_used`, `price_timestamp`, `price_source`)
- Added parsed/dropped row accounting for ingestion observability

---

## v3.1 - Alchemy migration and chain-aware scan controls (Mar 3, 2026)

**Commits:** `32f1e37`, `8193ab3`, `3b66c98`

- Replaced Etherscan log ingestion with Alchemy JSON-RPC (`eth_getLogs`)
- Added batch timestamp resolution from `eth_getBlockByNumber` with retry guards
- Added chain-aware scan and safety controls (including Optimism support)

---

## v3.0 - reUSD multi-chain coverage and aggregate dedup fix (Mar 2, 2026)

**Commits:** `34893a5`, `aa2bcb8`

- Added reUSD mint/burn event tracking across Ethereum, Arbitrum, Base, and Avalanche
- Added nth-data-slot amount decoding for non-standard event payload layouts
- Fixed aggregate loop to deduplicate by stablecoin ID, preventing duplicate rows and weighted overcounts

---

## v2.1 - Grade-aware flight-to-quality classification (Mar 1, 2026)

**Commits:** `dcdefde`, `c1c1839`

- FTQ safe/risky classification moved from hardcoded IDs to report-card score buckets
- Fallback to hardcoded safe havens now only applies when report-card cache is stale or missing
- Largest-event attribution aligned to requested `hours` window semantics

---

## v2.0 - USDT treasury-event capture and partial-data gauge support (Mar 1, 2026)

**Commits:** `2144236`, `1eddad0`

- Added `startBlock` per config to avoid pre-deployment scans
- Added USDT `Issue`/`Redeem` ingestion for mint/burn activity not emitted as `Transfer`
- Gauge now computes from available non-null FIS inputs instead of returning null when any coin is immature

---

## v1.0 - Initial Mint/Burn Flow release (Mar 1, 2026)

**Commits:** `06ad0d9`, `e36a0c1`, `2473c86`, `fea681c`

- Introduced phase-1 mint/burn contract coverage for 10 tracked stablecoins
- Shipped FIS, Bank Run Gauge bands, and flight-to-quality detection thresholds
- Shipped incremental sync cron plus aggregate/per-coin API endpoints

---

## Notes

- Mint/burn methodology did not initially ship with explicit version tracking; versions above were assigned retroactively from methodology-impacting commit boundaries.
- Canonical machine-readable source: `shared/lib/mint-burn-flow-version.ts`.
