# Pharos Stability Index (PSI)

> **Agent navigation** — Start with [Formula](#formula) and [Condition Bands](#condition-bands). Grep the matching heading for Components · Calibration Examples · Input Data · Cron & Storage · API · Frontend · Digest Integration instead of reading wholesale.

Composite ecosystem health score (0–100) measuring how stable the stablecoin market is right now. Computed every 30 minutes.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-stability-index -->`v3.67`<!-- GENERATED-END: methodology-version-stability-index -->
- **Public changelog page:** `/methodology/stability-index-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/registry.ts`, with shared constants in `shared/lib/methodology-versions/constants.ts` and changelog entries in `shared/data/methodology-changelogs/stability-index/`

PSI versions are bumped when formula terms, caps, condition bands, or score-affecting input semantics change.
Historical entries before formal versioning were reconstructed from git commit history and marked as such.

The [structured changelog](https://pharos.watch/methodology/stability-index-changelog/) owns release history. Historical repair, replay and provenance behavior is specified under [Cron & Storage](#cron--storage); a version bump alone asserts no completed rewrite or production acceptance.

**Release obligations:** fixed-clock replay, changed-day attribution and owner review precede historical repair release. Fresh admitted producer observations and production resource evidence are separate gates; neither a version bump nor replay proves production health.

## Formula

```
Score = 100 − severity − breadth − stressBreadth + trend
```

Clamped to [0, 100], rounded to 1 decimal place. `shared/lib/psi-policy.ts` owns component limits and inclusive band boundaries; Worker scoring, frontend chart zones, average/event labels, and beam maxima consume that policy.

## Components

| Component | Range | Formula | Purpose |
|-----------|-------|---------|---------|
| **Severity** | 0–68 | `min(68, Σ (abs(bps) / 100 × mcap_share × log₂(1 + mcap / $1B) × 60 × factor))` | Depeg impact weighted by market cap significance |
| **Breadth** | 0–17 | `min(17, Σ sqrt(mcap / $1B) × 3 × factor)` per unique depegged coin | Number of depegging coins, weighted so micro-caps barely register |
| **Stress Breadth** | 0–5 | `min(5, dewsStressBreadth)` | DEWS-derived market-cap-weighted stress signal: each coin in ALERT+ band contributes `sqrt(mcap / $1B) × 1.5`, not a simple count |
| **Trend** | −5 to +5 | `clamp(-5, 5, mcap_7d_change_pct)` | 7-day total market cap momentum |

Severity and breadth iterate over all open `depeg_events` rows in the core aggregate universe when a usable current or replay price and peg reference are available; they do not apply a peg-threshold filter. Multiple rows for one coin are deduplicated before contribution, with depreciation applied to chronic depegs. The core aggregate universe contains active core stablecoins and active cash equivalents. Tracked variants and stable-value investment products remain readable elsewhere in Pharos but do not enter PSI as independent monetary supply.

### Severity scaling

- `K = 60` scaling constant, calibrated so a 10bps USDT wobble drops the score ~37 points. Multiplied by `factor` for depreciation.
- **log₂ amplifier** makes mega-cap depegs disproportionately impactful: USDT ($145B) gets 7.2×, USDC ($60B) gets 5.9×, a $50M coin gets 0.07×
- **Cap at 68** prevents a single catastrophic event from consuming the entire score range

### Breadth scaling

- Uses `sqrt(mcap / $1B)` so 12 micro-coin depegs ≈ 3.8 points, but USDT alone ≈ 17 points (cap)

### Deviation source

For **USD-domain events**, the cron computes live deviation from the current stablecoins snapshot price when available: `bps = ((current_price / peg_reference) - 1) × 10000`. It does not use `peak_deviation_bps` from the depeg event — a coin that peaked at 500bps but is currently at 120bps contributes only 120bps of severity.

Quote domains are preserved by `shared/lib/depeg-quote-domain.ts`: explicit historical `depeg_event_provenance.quote_mode` takes precedence; otherwise live non-USD events with reference `1` are native-domain events. Their USD stablecoins/supply-history/price-cache marks are never divided by the native reference. Live sampling reads the latest validated native quote retained per active event in D1 `cache["depeg-native-quote:<eventId>"]`, alongside timestamped native `start_price`/`started_at` or `recovery_price`/`ended_at` evidence. It chooses the latest observation at or before evaluation and strictly younger than the named six-hour `PSI_NATIVE_EVIDENCE_MAX_AGE_SEC` budget. The existing depeg-detection producer persists directly observed CoinGecko native quotes as `{ value, observedAt, source }`, with `observedAt` taken from upstream `last_updated_at`, never the local fetch clock. Writes are monotonic by that clock; invalid, stale, future, or wrong-peg-domain quotes are not persisted. Producer fetch count is unchanged, event references are never rewritten, and PSI remains DB-only with no network fetching or FX synthesis.

Native-quote cache matching canonicalizes both the stored event peg type and the incoming quote currency through the shared peg taxonomy. Currency aliases such as `BRL` / `REAL` therefore retain the same event-specific quote and its upstream observation timestamp.

**Historical retained-evidence limitation:** only the latest current quote per active event is retained, not a continuous native quote history. Historical replay still reads timestamped start/recovery evidence at UTC close (bounded by now); it does not borrow the latest live cache mark. `peak_price` has no observation timestamp, so it cannot establish contemporaneous evidence. For both paths, absent or stale applicable evidence remains omitted with `open-depeg-no-price` and `openDepegsWithoutPrice`; an event peak is not a native-price fallback. Changing FX or USD prices alone cannot create native deviation. The existing USD-domain replay peak cap/start-day policy below remains unchanged. Historical repair still requires an evidence-bounded replay manifest and separate publication authorization.

On subsequent native-quote producer passes, event-specific cache rows for closed or removed events are deleted; they are not a replay archive.

For **already-open depegs only**, if the current stablecoins snapshot temporarily lacks a usable positive price, PSI falls back to the last replay-safe positive `price_cache` entry strictly younger than 6 hours. If neither price is usable, the run publishes the remaining computable components without assigning synthetic deviation. A successful sample and prune returns `status: "ok"` with `metadata.reason: "psi-sample-published"` and `metadata.quality.reasons` including `open-depeg-no-price`. The snapshot retains `degradedComponents` and `openDepegsWithoutPrice`; the API projects the count into `current.inputDegradation.openDepegNoPrice` / `.openDepegsWithoutPrice`.

The live snapshot price must also pass `isObservedPrice(...)`: a nominal par reference is not a price observation and cannot turn an open depeg into measured calm. Replay fallback rejects legacy `protocol-redeem` cache rows for IDs matched by the protocol-par route registry, because those pre-cutover rows represented nominal par rather than an observation. Observed market rows for those IDs and observed redemption rows for other routes remain eligible. If no replay-safe price is available, that event is disclosed as `open-depeg-no-price` rather than assigned zero deviation.

The **historical admin replay** treats a depeg as active for any UTC day overlapping the event interval. Legacy IDs canonicalize before matching supply history (`ust-terra-classic` → historical asset `ust-terra`). Supply/price lookup is strictly as-of the UTC day, within 14 days: no later observation can supply that day's market cap or price, and an absent supply observation excludes the asset from that day's denominator. A usable historical price determines severity, bounded by recorded `peak_deviation_bps`. On the start day, the peak remains a floor only when the event materially persists past UTC close and the snapshot undercaptures the shock by at least the configured threshold. Recovered same-day wicks, near-midnight bleed-through and captured moderate moves use daily price; a start-day price inside the threshold drops out entirely. Later days replay from daily price without threshold filtering, matching the live open-event universe, and use peak fallback only for unavailable price or legacy peg-reference drift. Historical price/supply repairs cover PSI historical assets only when upstream market series exist; they never manufacture missing coverage.

### Depreciation

Chronically depegged coins have their severity and breadth contributions reduced over time to prevent zombie stablecoins from permanently dominating the score.

```
factor = depegAgeDays ≤ 30 ? 1.0 : max(0.25, 1.0 - (depegAgeDays - 30) / 120)
```

| Age | Factor | Meaning |
|-----|--------|---------|
| 0–30 days | 100% | Full impact — fresh depeg, market-relevant |
| 45 days | 87.5% | Still significant |
| 60 days | 75% | Fading |
| 90 days | 50% | Half impact |
| 120 days | 25% | Floor reached |
| 120+ days | 25% | Permanent residual |

Age is measured from the **earliest** `started_at` among the coin's admitted active events with usable price evidence. Missing-quote events are counted in diagnostics, but do not determine age or severity.

### Deduplication

A coin may have multiple overlapping depeg events (e.g., one event opened at 100bps that's still active when a second event opens at 200bps due to a peg reference change). To avoid double-counting:

1. Events are grouped by `stablecoin_id`
2. For each coin, the event with the **worst current abs(bps)** is used for severity
3. The **earliest `started_at`** among events admitted with usable price evidence determines the depreciation age
4. Each coin contributes exactly **once** to both severity and breadth

### Per-coin contributors

The cron captures a per-coin breakdown in `input_snapshot.contributors`:

```json
[{ "id": "a7a5-old-vector", "symbol": "A7A5", "bps": -9871, "mcapUsd": 507000000, "ageDays": 61.2, "factor": 0.74 }]
```

The API surfaces this array in `current.contributors` (not in history). The frontend renders it as a "Top Contributors" table showing each coin's deviation, market cap, age, depreciation factor, and severity/breadth cost. `factor` retains the full-precision scoring value, so `computePsiDepegContribution()` reproduces the uncapped costs; only visible ages, percentages and costs are rounded. Legacy samples may retain their originally rounded factors.

## Condition Bands

| Range | Band | Color | Character |
|-------|------|-------|-----------|
| 90–100 | **BEDROCK** | `#22c55e` (green) | Boring. The way stablecoins should be |
| 75–<90 | **STEADY** | `#14b8a6` (teal) | Minor noise, nothing systemic |
| 60–<75 | **TREMOR** | `#eab308` (yellow) | Something real is happening. Pay attention |
| 40–<60 | **FRACTURE** | `#f97316` (orange) | Multiple signals firing. DeFi Twitter is awake |
| 20–<40 | **CRISIS** | `#ef4444` (red) | Active contagion risk. Last seen during SVB |
| 0–<20 | **MELTDOWN** | `#991b1b` (dark red) | UST-tier. Generational event |

## Calibration Examples

| Scenario | Score | Band |
|----------|-------|------|
| 12 micro-coin depegs, +0.26% mcap | 96.4 | BEDROCK |
| USDT wobbles 10bps | 63.1 | TREMOR |
| USDT wobbles 30bps | 23.4 | CRISIS |
| USDT 50bps + USDC 20bps − 3% mcap | 12.0 | MELTDOWN |

Rows assume a single USDT depeg at ~$145B inside a ~$315B core universe, no DEWS stress, and a flat 7-day trend unless stated; breadth sits at its 17-point cap in both USDT rows.

## Input Data

| Input | Source |
|-------|--------|
| Active depegs (bps + mcap) | `depeg_events` where `ended_at IS NULL`; USD-domain events use current stablecoins prices or replay-safe `price_cache` fallback, while native-domain events use per-event `depeg-native-quote:<eventId>` cache or timestamped start/recovery observations, strictly younger than 6h |
| Total market cap | Sum of admitted finite nonnegative current supply from `CORE_PSI_ELIGIBLE_IDS` (active core stablecoins + active cash equivalents + PSI historical assets; other listing classes excluded) |
| 7-day market cap change | Paired current vs previous-week totals; absent, empty, wholly invalid, nonfinite or negative observations leave both trend sides |
| DEWS stress breadth | Exact core-universe `stress_signal_publication_rows` from the published DEWS generation; only core/cash/historical warning bands (`ALERT`, `WARNING`, `DANGER`) contribute after non-empty/fresh generation proof, though DEWS monitors all active listings |

Strict stablecoins-cache failure, active-depeg read failure, or unavailable accepted DEWS dependency holds the sample with a named `degraded` reason. DEWS must remain an exact non-empty canonical generation with valid timestamps, matching row count/digest and age at most 3,600 seconds. Current supply uses `getCirculatingRawOrNull()`: absent, empty, wholly invalid, nonfinite or negative totals are omitted from market-cap denominators, stress weights and contributors; observed zero remains valid. Omitted current and previous-week identities are recorded in `supplyUnavailableIds` / `trendUnavailableIds`. A nonfinite or nonpositive aggregate market cap holds with `insufficient-market-cap`; a nonfinite or nonpositive aggregate paired denominator holds with `trend-inputs-unavailable`, `mcap7dChangePct: null`, and `preservedCurrentSample: true`, never invented zero trend. Successful publication with omissions is `ok` plus `metadata.quality`, not a failed execution or a claim of complete inputs.

## Cron & Storage

- **30-min samples**: `computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` — runs every **30 minutes** (`26,56 * * * *`) after `compute-dews` on the DB-only DEWS/PSI lane. The lane is separate from both the hourly `10 * * * *` DEX source stage and the `16,46 * * * *` scoring consumer, so a DEX invocation overrun cannot prevent PSI publication. Computes severity/breadth from core-universe active depegs, stress breadth from core-universe DEWS rows, and trend from paired current/previous-week market caps for core-universe assets with observed previous-week supply. PSI requires the `dews:published-generation` pointer and reads only rows with that exact `computed_at`, row count, and stablecoin-ID digest so stale retained rows or a failed partial generation cannot affect stress breadth. If DEWS input is unavailable, empty, incomplete, lacks usable row timestamps, or is stale by more than two `compute-dews` intervals, the run records that dependency loss in cron metadata, returns `status: "degraded"` with `fallbackMode: "dews-unavailable"` and `preservedCurrentSample: true`, and does **not** publish a fresh PSI sample; the API keeps serving the last healthy stored value rather than understating stress breadth as zero. If the active-depeg query itself is unavailable, the run likewise skips the sample and leaves the last valid stored PSI untouched. For already-open core-universe depegs whose current stablecoins snapshot price is temporarily missing, the cron can reuse a replay-safe positive `price_cache` price if it is strictly younger than 6 hours; otherwise that coin is skipped for that sample. If total market cap input is missing/zero, PSI compute returns `null`, the cron skips writing that sample, and the API continues serving the last valid stored value. Samples are stored in `stability_index_samples` (baseline schema `0000_baseline.sql`) and pruned after 90 days.
  After admission, a successful sample write and prune reports `psi-sample-published`; omissions remain visible in the persisted snapshot and cron quality findings. Invalid aggregate market-cap or paired trend input preserves the prior sample without changing its age or methodology. Asset quarantine in an accepted DEWS generation is not a whole-source hold: PSI uses exactly its admitted rows within the unchanged 3,600-second budget.
- **Daily aggregation**: `snapshotPsiDaily()` in `worker/src/cron/snapshot-psi.ts` averages the previous UTC day's samples at 08:00 UTC; quarter-hourly catch-up retries only while that day's midnight-keyed row is absent. Admission runs before any child execution or lease: before 08:00 (`before_daily_slot`) and after an existing row is read (`same_day_snapshot_exists`), only the parent slot summary records a neutral no-op. These no-ops create no snapshot cron/lease/child rows and cannot refresh snapshot publication freshness. A failed admission read remains an error, never evidence that the row exists or is missing. Atomic date replacement is idempotent and collapses duplicates. Actual catch-up outcomes are `same_day_catch_up` or degraded `no-samples-for-yesterday` without a write; the preferred daily chain and public-dataset write-once/fresh-cache gates are unchanged.
- **Historical operator backfill**: `backfill-stability-index` in `worker/scripts/one-shot-backfill.ts` invokes `handleBackfillStabilityIndex()` from `worker/scripts/backfills/backfill-stability-index.ts`; it is not a deployed admin API action. Follow [One-shot historical backfills](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/one-shot-backfills.md#backfill-stability-index) for preview, bounded scope and atomic-import consent. Replay covers completed UTC days using the core PSI denominator, canonical aliases, overlapping events and the as-of rules above. Repair historical assets' supply/prices first without fabricating series. Methodology `v3.0+` uses same-day core-universe DEWS archive bands; missing archival inputs preserve the existing day. New snapshots use `historicalAssetCoverageCount`, while retained JSON keeps its original field names.
  Backfill and audit-triggered repairs share `worker/src/lib/psi-replay-inputs.ts` and `replayHistoricalPsiForDay()`, including daily prices, native quote-domain/start/recovery evidence and same-day DEWS archive rows. Supply reads start **21 days before** the first replay day (7-day trend plus the canonical 14-day as-of margin), so narrowing an operator window does not truncate admissible evidence. Historical trend pairs only identities observed on both target dates, independently of the current severity denominator; unpaired identities are named in `trendUnavailableIds`. Missing/nonpositive paired prior totals hold with `trend-inputs-unavailable`. For v3, absent DEWS rows hold with `dews-archive-unavailable`, while an observed all-CALM day measures zero; snapshots retain `dewsArchiveRowCount` and `dewsArchiveSnapshotDate`. Held days keep their existing score, components and provenance unchanged. Audit verdict changes project the **post-mutation** eligible event universe in both directions before scoring, and commit provenance plus available PSI repairs atomically.
- **Pure compute**: `computeStabilityIndex()` in `worker/src/lib/stability-index.ts` — stateless, deterministic
- **Tables**: `stability_index_samples` (defined in `worker/migrations/0000_baseline.sql` after the D1 squash) — per-sample: `stored_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON), `methodology_version`. `stability_index` (defined in `worker/migrations/0000_baseline.sql` after the D1 squash) — daily averages: `computed_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON), `methodology_version`

Daily provenance is additive inside the existing `input_snapshot` JSON; no migration is required. All-day averaging remains authoritative across methodology transitions. Summary/detail history and the current daily fallback expose optional `dailyProvenance`: `{ aggregation: "all-day", sampleCount, methodologyBreakdown: Record<string, number>, componentSampleCounts: { severity, breadth, stressBreadth, trend } | null }`. A modal compatibility version label is not the sole attribution. Legacy rows without recorded component counts expose `null` counts rather than inventing coverage. Optional `componentsUnavailable` identifies null/missing components or components with known zero sample counts.

History provenance extraction is limited to rows with `computed_at >= now - 91 days`: SQL short-circuits older `input_snapshot` blobs before JSON parsing and returns NULL provenance (omitted from the wire). Unbounded detail remains available on demand; the initial page requests a bounded year. The separately fetched current daily fallback retains its provenance.

Since v3.64, the daily snapshot writer persists an all-null component as `null`, an observed zero as `0`, and a partially observed component as the average of its observed samples alongside its count. Readers preserve explicit nulls and show missing component history as gaps/unavailable, never measured zero. Legacy stored rows retain their original values and methodology; missing legacy counts remain unknown rather than inferred complete. Snapshot read failure returns `db_query_failed` without replacing the previous daily row. Activation requires observed Release A Worker/Pages readiness; rollback is limited to that nullable-compatible pair, not pre-A clients.

Cutover observation: wait for the next daily snapshot after activation, then refetch `/api/stability-index?detail=true` after its standard edge 300-second/browser 60-second cache windows. Verify persisted component values against `componentSampleCounts`; old historical rows are not rewritten or relabelled by deployment.

## API

`GET /api/stability-index` — latest score + recent history (default: latest ~91 daily rows with today's running average prepended). `?detail=true` returns full history and per-day components; adding `&days=365` bounds rich history to the recent year (30–365 days accepted). Detail `headlineAggregates` contains the band streak and per-event worst observed scores, computed from full admitted history, with source `computedAt` and response `generatedAt`. Bounded reads use a thin full-history projection rather than decoding older component blobs. `current.inputDegradation` retains dependency and unpriced-event diagnostics, including stored supply/trend omission IDs; old snapshots do not invent these arrays. Cache: standard (5-min edge, 1-min browser).

See the [API Reference](https://pharos.watch/api/) for the full response shape.

## Frontend

- **Homepage and dedicated page:** the headline labels its basis (raw instant sample or rolling 24-hour average); PSI universe labels identify core plus PSI historical assets. The homepage sparkline and comparison use the last 90 chart points. Beam Dimmers show current component pressure and prior-sample deltas, not causal event history; zero remains on the floor and unavailable values are not zero.
- **PSI beacon:** presentation only, with state in `shared/lib/psi-beacon.ts` and geometry in `shared/lib/psi-beacon-geometry.ts`. Lit length represents the instant 0–100 score without a minimum; the 24-hour average is a separate tick. Penalty/trend spans reconcile to the published score or become an unattributed span. Exact values accompany display-floor slivers; missing components are unknown, `openDepegNoPrice` marks severity as a lower bound, and the formula clamp remains visible. Freshness follows the sample generation: retained data has neutral styling and an “as of” label, while unavailable data has no beam or average tick. Band thresholds have non-colour labels; all beacon surfaces are static.
- **Hooks**: `useStabilityIndex()` (homepage), `useStabilityIndexDetail()` (bounded page startup), `useStabilityIndexFullHistory()` (on-demand history), in `src/hooks/api-hooks.ts`.
- **30d stats:** observed history within the source evaluation's UTC day and preceding 29 days; gaps never extend the window to obtain 30 rows.
- **Event dates:** timeline labels preserve authored UTC calendar dates, including cross-year ranges; viewer timezone never changes labels or event-window matching.
- **Bounded initial admission:** the page starts with the recent year and authoritative server-computed band streak. Shared UTC-day semantics count the current row, then stop at the first missing completed UTC day or band change. The streak's `computedAt` must match `current.computedAt`; it is never recounted from the bounded window.
- **Deferred history:** the reserved chart initially selects 1y; only All enables the separately keyed full-history query. The event timeline uses bounded server aggregates from the shared event-window matcher, preserving older scores without downloading their history. Headline 30d statistics use the bounded window without extending across gaps. Projections and range tick labels remain memoized; exports and the accessible table's bounded-row disclosure are unchanged.
- **Route compatibility:** legacy `/stability-index-alt` redirects to `/stability-index` via `public/_redirects`.

## Digest Integration

The daily digest cron (08:05 UTC) queries the latest PSI sample plus daily rows (current and yesterday) and passes PSI score, band, components, and yesterday's score into the Anthropic digest prompt. Its market-cap, trend, supply-mover, and stress aggregates use the same core-universe boundary as PSI, so wrapper or investment supply is not narrated as independent stablecoin growth. The digest uses PSI as a market-regime frame within the body rather than the opener; the generation policy leads from the highest-impact unsuppressed editorial candidate and opens from that candidate's subject, treating PSI as "the product's headline index, not a mandatory daily paragraph" — included only when it moved, diverged materially from the underlying signals, or frames the lead. The digest runs on its own 08:05 UTC trigger, five minutes after the daily PSI snapshot (`snapshot-psi`) at 08:00 UTC, so it reads today's stored row without an explicit promise chain.
