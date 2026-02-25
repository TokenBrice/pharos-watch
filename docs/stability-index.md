# Pharos Stability Index (PSI)

Composite ecosystem health score (0–100) measuring how stable the stablecoin market is right now. Computed daily at 07:55 UTC.

## Formula

```
Score = 100 − severity − breadth − freezes + trend
```

Clamped to [0, 100], rounded to 1 decimal place.

## Components

| Component | Range | Formula | Purpose |
|-----------|-------|---------|---------|
| **Severity** | 0–60 | `min(60, Σ (abs(bps) / 100 × mcap_share × log₂(1 + mcap / $1B) × 60))` | Depeg impact weighted by market cap significance |
| **Breadth** | 0–15 | `min(15, Σ sqrt(mcap / $1B) × 3)` per depegged coin | Number of depegging coins, weighted so micro-caps barely register |
| **Freezes** | 0–10 | `min(10, freeze_events_24h × 2.5)` | Blacklist/freeze activity signals operational instability |
| **Trend** | −5 to +5 | `clamp(-5, 5, mcap_7d_change_pct)` | 7-day total market cap momentum |

Severity and breadth iterate over **active depegs only** (coins currently outside their peg threshold).

### Severity scaling

- `K = 60` scaling constant, calibrated so a 10bps USDT wobble drops the score ~30 points
- **log₂ amplifier** makes mega-cap depegs disproportionately impactful: USDT ($145B) gets 7.2×, USDC ($60B) gets 5.9×, a $50M coin gets 0.07×
- **Cap at 60** prevents a single catastrophic event from consuming the entire score range

### Breadth scaling

- Uses `sqrt(mcap / $1B)` so 12 micro-coin depegs ≈ 3.8 points, but USDT alone ≈ 15 points (cap)

### Deviation source

The cron computes **live deviation** from current price: `bps = ((current_price / peg_reference) - 1) × 10000`. It does not use `peak_deviation_bps` from the depeg event — a coin that peaked at 500bps but is currently at 120bps contributes only 120bps of severity.

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
| USDT wobbles 10bps | 65.1 | TREMOR |
| USDT wobbles 30bps | 25.4 | CRISIS |
| USDT 50bps + USDC 20bps + 4 freezes − 3% mcap | 12.0 | MELTDOWN |

## Input Data

| Input | Source |
|-------|--------|
| Active depegs (bps + mcap) | `depeg_events` where `ended_at IS NULL`, with current price from stablecoins cache |
| Total market cap | Sum of all tracked stablecoins from DefiLlama cache |
| 7-day market cap change | Current vs previous week total from stablecoins cache |
| Freeze count (24h) | `blacklist_events` where `timestamp > now - 86400` |

## Cron & Storage

- **Cron**: `computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` — runs daily at **07:55 UTC** (5 min before digest cron)
- **Pure compute**: `computeStabilityIndex()` in `worker/src/lib/stability-index.ts` — stateless, deterministic
- **Table**: `stability_index` (migration 0022) — `computed_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON)

## API

`GET /api/stability-index` — latest score + 90-day history (default). With `?detail=true`, full history with per-day component breakdowns. Cache: slow (1-hour edge, 5-min browser).

See `docs/api-reference.md` for full response shape.

## Frontend

- **Homepage widget**: `src/components/stability-index.tsx` — score, band, delta from yesterday, 30-day sparkline, animated lighthouse icon
- **Dedicated page**: `src/app/stability-index/client.tsx` — score history chart with band-colored zones, component breakdown stacked area chart, time range filter, methodology section
- **Hook**: `src/hooks/use-stability-index.ts` — `useStabilityIndex()` (homepage), `useStabilityIndexDetail()` (page)

## Digest Integration

The daily digest cron (08:00 UTC) queries the latest two stability index rows and passes PSI score, band, components, and yesterday's score to the Sonnet prompt. The digest opens with the current PSI band.

## Key Files

| File | Purpose |
|------|---------|
| `worker/src/lib/stability-index.ts` | Pure compute function, band definitions, colors |
| `worker/src/cron/stability-index.ts` | Daily cron job |
| `worker/src/api/stability-index.ts` | API endpoint |
| `worker/src/api/backfill-stability-index.ts` | Admin backfill (replays formula over historical data) |
| `src/components/stability-index.tsx` | Homepage widget + lighthouse SVG |
| `src/app/stability-index/client.tsx` | Full page with charts and methodology |
| `src/hooks/use-stability-index.ts` | TanStack Query hooks |
