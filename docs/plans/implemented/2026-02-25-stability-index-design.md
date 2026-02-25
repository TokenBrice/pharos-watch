# Pharos Stability Index

**Date:** 2026-02-25
**Status:** Approved

## Goal

A single daily number (0–100) that scores overall stablecoin market health. Deterministic, transparent, computed from data already in D1. Think VIX or Fear & Greed Index — one number people check compulsively.

**Key insight:** Systemic importance is non-linear. A 10bps wobble on USDT is front-page news; a 2000bps depeg on a $15M coin is noise. The formula uses a `log₂(1 + mcap/$1B)` amplifier that makes mega-cap depegs disproportionately impactful.

## Why This Feature

The daily digest is text-only — it describes the market in prose. A numeric index creates:
- **Daily habit**: takes 2 seconds to check, creates FOMO when you miss a day
- **Shareability**: "Pharos Stability Index dropped to 65 today" is tweetable, embeddable, citable
- **Brand identity**: becomes the thing Pharos is known for
- **Digest anchor**: the editorial now *comments on the score* instead of raw data

## Condition Bands

The score maps to named conditions. The names ARE the brand — "Pharos just entered TREMOR" spreads in a way "the index is 65" never will.

| Range | Condition | Color | Character |
|---|---|---|---|
| 90–100 | **BEDROCK** | Green (`#22c55e`) | Boring. The way stablecoins should be. |
| 75–89 | **STEADY** | Teal (`#14b8a6`) | Minor noise, nothing systemic. |
| 60–74 | **TREMOR** | Yellow (`#eab308`) | Something real is happening. Pay attention. |
| 40–59 | **FRACTURE** | Orange (`#f97316`) | Multiple signals firing. DeFi Twitter is awake. |
| 20–39 | **CRISIS** | Red (`#ef4444`) | Active contagion risk. Last seen during SVB. |
| 0–19 | **MELTDOWN** | Dark red (`#991b1b`) | UST-tier. Generational event. |

### How Bands Enhance Every Surface

- **Widget**: displays `BEDROCK · 96.4` with band color — the name is the first thing people read
- **Digest**: Sonnet references the band naturally — "First day in TREMOR since March" gives historical context that a raw number can't
- **Tweets**: band transitions trigger automated tweets — "Pharos Stability Index has entered TREMOR (65.1)" — not just the daily editorial
- **Sparkline**: color-coded by band, making the UST crater visually obvious at a glance
- **Backtest**: historical band labels let people ask "how long were we in CRISIS during UST?" — narrative, not just numbers

### Implementation

A pure lookup function in `worker/src/lib/stability-index.ts` alongside the score computation:

```typescript
type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

function getConditionBand(score: number): { band: ConditionBand; color: string } { ... }
```

The band is included in the API response, stored alongside the score in DB snapshots, and passed to the digest prompt. The frontend maps band names to Tailwind color classes (static strings, not dynamically constructed).

## Scoring Algorithm

```
Score = clamp(0, 100, 100 − severity − breadth − freezes + trend)
```

### Components

| Component | Range | Formula | Purpose |
|---|---|---|---|
| **Severity** | 0–60 | `min(60, Σ (\|bps_i\|/100 × mcap_share_i × log₂(1 + mcap_i/$1B) × 60))` | Depeg impact weighted by market significance + systemic importance |
| **Breadth** | 0–15 | `min(15, Σ sqrt(mcap_i/$1B) × 3)` for depegged coins | How many coins are depegging, weighted so micro-caps barely register |
| **Freezes** | 0–10 | `min(10, freeze_events_24h × 2.5)` | Blacklist/freeze activity signals operational instability |
| **Trend** | −5 to +5 | `clamp(-5, 5, mcap_7d_change_pct)` | Market cap momentum — growth = confidence |

### Calibration (validated against live data, 2026-02-25)

| Scenario | Severity | Breadth | Score | Reading |
|---|---|---|---|---|
| Today (12 micro-coin depegs, +0.26% mcap) | 0.01 | 3.8 | **96.4** | Business as usual |
| USDT wobbles 10bps | 16.5 | 15.0 | **65.1** | SVB flashbacks, front-page news |
| USDT wobbles 30bps | 49.6 | 15.0 | **25.4** | Deep crisis |
| USDT 50bps + USDC 20bps + 4 freezes − 3% mcap | 60.0 | 15.0 | **12.0** | Full meltdown |
| UST-level collapse + contagion on USDT | 60.0 | 15.0 | **20.0** | Armageddon |

### Key Design Decisions

- **K=60 scaling constant**: Calibrated so a 10bps USDT wobble drops the score ~30 points. USDT/USDC depegs are psychologically traumatic events (SVB proved this) and should register as such.
- **log₂ amplifier**: USDT ($145B) gets a 7.2× multiplier, USDC ($60B) gets 5.9×, a $50M coin gets 0.07×. This captures systemic importance without arbitrary tiers.
- **Severity cap at 60**: Prevents a single catastrophic event from consuming the entire score range, leaving room for breadth/freezes/trend to add context.
- **mcap-weighted breadth**: 12 micro-coin depegs = 3.8 points. USDT alone depegging = 15 points (cap). Raw count would over-penalize normal market noise.

## Architecture

### Independent component, consumed by digest

The stability index is its own system — computed, stored, and served independently. The digest reads the latest score as one of its inputs.

```
Cron (daily, before digest)
  → computeStabilityIndex(db)  [pure function]
  → store snapshot in stability_index table
  → return score

Digest cron (daily, 08:00 UTC)
  → read latest stability index score
  → pass to Sonnet as part of digest input data
  → Sonnet comments on the score in its editorial

API: GET /api/stability-index
  → latest score + 30-day history

Frontend: homepage widget
  → score display + 30-day sparkline
```

### Files

| File | Purpose |
|---|---|
| `worker/src/lib/stability-index.ts` | Pure compute function: takes data, returns score + component breakdown |
| `worker/src/cron/stability-index.ts` | Cron job: queries D1, calls compute, stores snapshot |
| `worker/src/api/stability-index.ts` | API handler: serves latest score + 30-day history |
| `worker/src/cron/daily-digest.ts` | Modified: reads latest score, passes to Sonnet prompt |
| `src/components/stability-index.tsx` | Homepage widget: score + sparkline |
| `src/hooks/use-stability-index.ts` | TanStack Query hook |

### Database

New table `stability_index`:

```sql
CREATE TABLE stability_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  components TEXT NOT NULL,  -- JSON: {severity, breadth, freezes, trend}
  input_snapshot TEXT NOT NULL  -- JSON: raw inputs for reproducibility
);
CREATE INDEX idx_stability_index_computed_at ON stability_index(computed_at);
```

### API Response Shape

```
GET /api/stability-index
```

```json
{
  "current": {
    "score": 96.4,
    "band": "BEDROCK",
    "components": {
      "severity": 0.01,
      "breadth": 3.84,
      "freezes": 0,
      "trend": 0.26
    },
    "computedAt": 1740470400
  },
  "history": [
    { "date": 1740384000, "score": 95.1, "band": "BEDROCK" },
    { "date": 1740297600, "score": 97.2, "band": "BEDROCK" }
  ]
}
```

Cache: `s-maxage=3600, max-age=300` (1 hour edge, 5 min browser — same cadence as digest).

### Cron Scheduling

The stability index cron runs at **07:55 UTC**, 5 minutes before the digest cron at 08:00 UTC. This ensures the score is fresh when Sonnet writes the editorial.

### Digest Integration

The digest user prompt gains one new line:

```
Pharos Stability Index: 96.4 [BEDROCK] (severity=0.01, breadth=3.84, freezes=0, trend=+0.26)
Yesterday: 95.1 [BEDROCK]
```

The system prompt gains one new instruction:

```
Open with the Pharos Stability Index score and its condition band.
Reference the band name naturally — "Another day in BEDROCK" or "We've slipped into TREMOR for the first time since March."
When the band changed from yesterday, lead with that transition — band shifts are the headline.
```

### Homepage Widget

Positioned above the digest text. Displays:
- Condition band name + score: e.g., `BEDROCK · 96.4`
- Band color applied to the name and score
- Label: "Pharos Stability Index"
- 30-day sparkline, color-coded by band (segments change color at band boundaries)
- Delta from yesterday with direction arrow (e.g., "▲ 1.2" or "▼ 3.5")

No dedicated page — homepage widget only. Can expand later if warranted.

## Historical Backtest

### Why

Without history, the index launches with one data point. The sparkline is a dot. For the first 30 calm days it's a flat line at ~96 — nobody shares a flat line.

Pharos already has ~4 years of depeg events and ~2-3 years of aggregate market cap data in D1. Replaying the formula over that history means day one launches with a chart showing the UST crater (May 2022), the SVB weekend (March 2023), and every wobble in between. That's a chart people screenshot. It also validates the calibration — if the formula doesn't tank during known crises, we'd want to know before launch.

### Data Availability

| Component | Historical depth | Source | Backtest quality |
|---|---|---|---|
| **Severity** (depegs) | ~4 years | `depeg_events` table (backfilled via `/api/backfill-depegs`) | Excellent — full event history with bps + timestamps |
| **Breadth** (depeg count) | ~4 years | Same as severity | Excellent |
| **Freezes** | Limited (since deployment) | `blacklist_events` (incremental sync only, no deep backfill) | Zeroed for pre-deployment dates — acceptable, only 0–10 points |
| **Trend** (7d mcap change) | ~2-3 years | `stablecoin-charts` cache (DefiLlama aggregate data, downsampled) | Good — daily granularity for last 90d, weekly for 90d–2y, monthly for 2y+ |
| **Market caps** (per-coin, for weighting) | ~1-2 years per coin | `supply_history` table (backfilled via `/api/backfill-supply-history`) | Good — daily snapshots, depth varies by coin |

### Backtest Strategy

A one-time admin endpoint (`/api/backfill-stability-index`) that:

1. **Iterates each day** in the available window (up to 4 years back)
2. **For each day**, reconstructs the market state:
   - Finds active depegs: `started_at <= day AND (ended_at > day OR ended_at IS NULL)`
   - Looks up per-coin market caps from `supply_history` (nearest available snapshot)
   - Computes total market cap from aggregate chart data for the trend component
   - Sets freeze count to 0 for dates before blacklist sync started
3. **Computes the score** using the same pure `computeStabilityIndex()` function
4. **Inserts into `stability_index`** with the computed_at set to each historical date

### Constraints & Acceptable Compromises

- **Freeze component zeroed historically**: Only affects 0–10 points. The severity and breadth components carry the signal for major events like UST/SVB.
- **Market cap granularity degrades**: Weekly beyond 90 days, monthly beyond 2 years. For the sparkline this is fine — we're showing shape, not precision.
- **Supply history gaps**: Some coins lack early history. The backtest uses whatever data is available and skips coins with no supply snapshot for a given date (their severity contribution is zero for that day).
- **One-time operation**: Run once at launch, then the daily cron takes over. No ongoing complexity.
