# Pharos Stability Index (PSI)

Composite ecosystem health score (0–100) measuring how stable the stablecoin market is right now. Computed every 30 minutes.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-stability-index -->`v3.61`<!-- GENERATED-END: methodology-version-stability-index -->
- **Public changelog page:** `/methodology/stability-index-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/stability-index.ts`, with shared constants in `shared/lib/methodology-versions/constants.ts` and changelog entries in `shared/data/methodology-changelogs/stability-index/`

PSI versions are bumped when formula terms, caps, condition bands, or score-affecting input semantics change.
Historical entries before formal versioning were reconstructed from git commit history and marked as such.

## Formula

```
Score = 100 − severity − breadth − stressBreadth + trend
```

Clamped to [0, 100], rounded to 1 decimal place.

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

The cron computes **live deviation** from the current stablecoins snapshot price when available: `bps = ((current_price / peg_reference) - 1) × 10000`. It does not use `peak_deviation_bps` from the depeg event — a coin that peaked at 500bps but is currently at 120bps contributes only 120bps of severity.

For **already-open depegs only**, if the current stablecoins snapshot temporarily lacks a usable positive price, PSI falls back to the last replay-safe positive `price_cache` entry as long as it is no older than 6 hours. This preserves contributor continuity through transient price-validation gaps without anchoring PSI to arbitrarily stale prices.

The **historical admin replay** treats a depeg as active for any UTC day whose window overlaps the event interval. It canonicalizes legacy depeg IDs onto the current PSI universe before matching supply history (for example historical `ust-terra-classic` rows replay through the `ust-terra` shadow asset). When rebuilding a prior UTC day, it uses the nearest `supply_history` snapshot within 14 days of that UTC day (normally the same-day row) to derive replayed deviation when that snapshot price is usable, but it will not replay a daily deviation more severe than the event's recorded `peak_deviation_bps`. On the UTC day a depeg begins it keeps `peak_deviation_bps` as a floor only when the depeg materially persists past that UTC close and the daily snapshot undercaptures the shock by at least the configured depeg threshold. Same-day wicks that fully recover before the UTC close, near-midnight bleed-throughs, and moderate follow-on moves that the restored day price already captures use the daily historical price instead of the intraday peak. On that same start day, a replay whose restored daily price is back inside the configured depeg threshold drops out of PSI entirely instead of still contributing breadth; later days of a multi-day event replay from the daily price regardless of threshold, matching the live cron, which includes every open depeg without a threshold filter. Later days fall back to `peak_deviation_bps` when a usable historical day price is unavailable or when legacy peg-reference drift would otherwise exaggerate the daily replay. The restore path now also repairs replay-critical `supply_history.price` coverage for restored USD rows and PSI shadow assets when historical market series are available, so rebuilt history does not overuse peak fallback. This preserves real crisis windows without permanently peak-anchoring recovery days or turning stale peg references into synthetic daily collapses.

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

Age is measured from the **earliest** `started_at` across all active depeg events for a coin.

### Deduplication

A coin may have multiple overlapping depeg events (e.g., one event opened at 100bps that's still active when a second event opens at 200bps due to a peg reference change). To avoid double-counting:

1. Events are grouped by `stablecoin_id`
2. For each coin, the event with the **worst current abs(bps)** is used for severity
3. The **earliest `started_at`** across all events determines the depreciation age
4. Each coin contributes exactly **once** to both severity and breadth

### Per-coin contributors

The cron captures a per-coin breakdown in `input_snapshot.contributors`:

```json
[{ "id": "a7a5-old-vector", "symbol": "A7A5", "bps": -9871, "mcapUsd": 507000000, "ageDays": 61.2, "factor": 0.74 }]
```

The API surfaces this array in `current.contributors` (not in history). The frontend renders it as a "Top Contributors" table showing each coin's deviation, market cap, age, depreciation factor, and severity/breadth cost.

## Condition Bands

| Range | Band | Color | Character |
|-------|------|-------|-----------|
| 90–100 | **BEDROCK** | `#22c55e` (green) | Boring. The way stablecoins should be |
| 75–89 | **STEADY** | `#14b8a6` (teal) | Minor noise, nothing systemic |
| 60–74 | **TREMOR** | `#eab308` (yellow) | Something real is happening. Pay attention |
| 40–59 | **FRACTURE** | `#f97316` (orange) | Multiple signals firing. DeFi Twitter is awake |
| 20–39 | **CRISIS** | `#ef4444` (red) | Active contagion risk. Last seen during SVB |
| 0–19 | **MELTDOWN** | `#991b1b` (dark red) | UST-tier. Generational event |

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
| Active depegs (bps + mcap) | `depeg_events` where `ended_at IS NULL`, with current price from stablecoins cache or, for already-open depegs missing a current price, a replay-safe `price_cache` fallback ≤6h old |
| Total market cap | Sum of the core PSI assets present in the stablecoins cache (`CORE_PSI_ELIGIBLE_IDS` = active core stablecoins + active cash equivalents + shadow; variants, stable-value investments, excluded, pre-launch, quarantined, delisted, and frozen tracked rows excluded) |
| 7-day market cap change | Paired current vs previous-week totals from the stablecoins cache; assets without observed previous-week supply are excluded from both sides |
| DEWS stress breadth | Exact core-universe `stress_signal_publication_rows` from the published DEWS generation pointer; DEWS still monitors all active listings, but only core/cash/shadow warning bands (`ALERT`, `WARNING`, `DANGER`) contribute after the generation is proven non-empty and fresh |

If the strict-mode stablecoins cache is unavailable, the cron returns `status: "degraded"` with `fallbackMode: "stablecoins-cache-unavailable"` before any depeg or DEWS work and publishes no sample. If the active-depeg query is unavailable, the cron fails closed and does not publish a fresh PSI sample for that cycle. If the DEWS publication pointer is missing, invalid, or unreadable, or if its exact canonical generation is empty, incomplete, has unusable `computed_at`, or is stale by more than two `compute-dews` intervals, the cron also fails closed instead of treating stress breadth as zero. If `totalMcapUsd` is missing or `<= 0`, `computeStabilityIndex()` returns `null` (insufficient data) and no new score is produced for that cycle.

## Cron & Storage

- **30-min samples**: `computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` — runs every **30 minutes** (`26,56 * * * *`) after `compute-dews` on the DB-only DEWS/PSI lane. The lane is separate from both the hourly `10 * * * *` DEX source stage and the `16,46 * * * *` scoring consumer, so a DEX invocation overrun cannot prevent PSI publication. Computes severity/breadth from core-universe active depegs, stress breadth from core-universe DEWS rows, and trend from paired current/previous-week market caps for core-universe assets with observed previous-week supply. PSI requires the `dews:published-generation` pointer and reads only rows with that exact `computed_at`, row count, and stablecoin-ID digest so stale retained rows or a failed partial generation cannot affect stress breadth. If DEWS input is unavailable, empty, incomplete, lacks usable row timestamps, or is stale by more than two `compute-dews` intervals, the run records that dependency loss in cron metadata, returns `status: "degraded"`, and does **not** publish a fresh PSI sample; the API keeps serving the last healthy stored value rather than understating stress breadth as zero. If the active-depeg query itself is unavailable, the run likewise skips the sample and leaves the last valid stored PSI untouched. For already-open core-universe depegs whose current stablecoins snapshot price is temporarily missing, the cron can reuse a replay-safe positive `price_cache` price if it is at most 6 hours old; otherwise that coin is skipped for that sample. If total market cap input is missing/zero, PSI compute returns `null`, the cron skips writing that sample, and the API continues serving the last valid stored value. Samples are stored in `stability_index_samples` (baseline schema `0000_baseline.sql`) and pruned after 90 days.
- **Daily aggregation**: `snapshotPsiDaily()` in `worker/src/cron/snapshot-psi.ts` — runs daily at **08:00 UTC**. Averages all 30-minute samples from the previous UTC day and stores one row in the `stability_index` table by deleting any existing row for the midnight-keyed `computed_at` and inserting the new one in a single atomic `db.batch()`. The table is keyed by a surrogate `id` with no UNIQUE constraint on `computed_at`, so `INSERT OR REPLACE` would append a second row for the day rather than replace it; the delete-then-insert is idempotent across re-runs and collapses any duplicate rows left by earlier runs. If the prior UTC day has zero samples, the cron returns `status: "degraded"` with `reason: "no-samples-for-yesterday"` and skips the write.
- **Historical admin backfill**: `handleBackfillStabilityIndex()` replays completed UTC days only. The replay path bounds market-cap denominators to the core PSI universe, canonicalizes legacy depeg IDs into the current PSI universe before matching supply history, treats any core-universe depeg overlapping the UTC day as active, derives depeg severity from the nearest `supply_history.price` within 14 days of the UTC day when available, never lets that replayed daily deviation exceed the event's recorded `peak_deviation_bps`, keeps `peak_deviation_bps` as a start-day floor only when the event materially persists past that UTC close and the daily snapshot undercaptures the move by at least the configured depeg threshold, drops start-day replay entries whose restored daily price is already back inside the configured depeg threshold (later days of a multi-day event are not threshold-filtered), and otherwise falls back to `peak_deviation_bps` for missing/invalid historical prices or stale peg references. The paired supply-history and historical-price repair jobs are expected to restore replay-critical `supply_history.price` coverage, including PSI-only shadow assets, before the PSI rebuild is rerun. For methodology `v3.0+`, it also derives historical `stressBreadth` from same-day core-universe `stress_signal_history` warning bands (`ALERT`, `WARNING`, `DANGER`). When a rebuild day cannot be replayed because archival inputs are missing, the endpoint preserves the existing stored row instead of deleting that day.
- **Pure compute**: `computeStabilityIndex()` in `worker/src/lib/stability-index.ts` — stateless, deterministic
- **Tables**: `stability_index_samples` (defined in `worker/migrations/0000_baseline.sql` after the D1 squash) — per-sample: `stored_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON), `methodology_version`. `stability_index` (defined in `worker/migrations/0000_baseline.sql` after the D1 squash) — daily averages: `computed_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON), `methodology_version`

## API

`GET /api/stability-index` — latest score + recent history (default response uses the latest ~91 daily rows, with today's running average prepended when available). With `?detail=true`, it returns the full stored history with per-day component breakdowns. The current sample can also expose `inputDegradation` when the stored snapshot carried degraded-input metadata. Cache: standard (5-min edge, 1-min browser).

See [API Reference](./api-reference.md) for the full response shape.

## Frontend

- **Homepage PSI mini-card**: `src/components/home-alt-mini-cards/psi-band-card.tsx` — shows `current.score` (raw instant, unlabeled) alongside a last-90-days score sparkline and a `90D … vs avg` delta caption, so the headline number matches its raw-sample sparkline.
- **Dedicated page**: `src/app/stability-index/client.tsx` — hero KPI bar focused on the lighthouse/current PSI signal and historical PSI measurements, score history chart with band-colored zones, Beam Dimmers for the current formula component pressure (one independently scaled sparkline per component, with their own time range filter), methodology section, and contextual methodology hints on PSI plus the four component labels (`Severity`, `Breadth`, `Stress Breadth`, `Trend`). The headline score explicitly labels whether it is the rolling 24h average or raw instant sample. Beam Dimmers use the current PSI component values and prior-sample deltas only; they are not a causal event timeline and do not change scoring.
- **Hook**: `src/hooks/api-hooks.ts` — `useStabilityIndex()` (homepage), `useStabilityIndexDetail()` (page)
- **Route strategy (2026-03-05):** legacy `/stability-index-alt` was retired after Tier 3A review (no nav/sitemap/internal product usage) and now redirects to `/stability-index` via `public/_redirects`

## Digest Integration

The daily digest cron (08:05 UTC) queries the latest PSI sample plus daily rows (current and yesterday) and passes PSI score, band, components, and yesterday's score into the Anthropic digest prompt. Its market-cap, trend, supply-mover, and stress aggregates use the same core-universe boundary as PSI, so wrapper or investment supply is not narrated as independent stablecoin growth. The digest uses PSI as a market-regime frame within the body rather than the opener; the generation policy leads from the highest-impact editorial candidate, and PSI "is rarely the protagonist." The digest runs on its own 08:05 UTC trigger, five minutes after the daily PSI snapshot (`snapshot-psi`) at 08:00 UTC, so it reads today's stored row without an explicit promise chain.

## Stability Index (PSI) Computation

`computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` runs every 30 minutes on the DB-only DEWS/PSI lane (`26,56 * * * *`) and computes a composite ecosystem health score (0–100). Formula: `Score = 100 − severity − breadth − stressBreadth + trend`. If the DEWS dependency query is unavailable, empty, missing usable `computed_at`, or stale beyond two `compute-dews` intervals, the run returns `status: "degraded"` with `fallbackMode: "dews-unavailable"` and `preservedCurrentSample: true`, then skips fresh PSI sample publication instead of treating missing stress breadth as zero. If the active-depeg query is unavailable, the run also fails closed and skips publication instead of treating that outage as an empty depeg set. See [Pharos Stability Index](./stability-index.md) for the full algorithm, calibration examples, and band definitions.

**Band classification:** `BEDROCK` (90–100), `STEADY` (75–89), `TREMOR` (60–74), `FRACTURE` (40–59), `CRISIS` (20–39), `MELTDOWN` (0–19)

**Storage:** 30-minute samples go into `stability_index_samples`; daily averages are aggregated by `snapshotPsiDaily()` into `stability_index`. Both tables store `score`, `band`, `components` (JSON), `input_snapshot` (JSON). Schema definitions are in `worker/migrations/0000_baseline.sql`.
