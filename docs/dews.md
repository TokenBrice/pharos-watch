# Depeg Early Warning Score (DEWS)

Per-coin, forward-looking stress score (0-100) estimating depeg probability. Computed every 30 minutes from 8 sub-signals.

## Methodology Versioning

DEWS shares its methodology versioning with the Depeg Tracker pipeline. Both are tracked together in `shared/lib/depeg-dews-version.ts`.

- **Current methodology version:** `v5.9`
- **Public changelog page:** `/methodology/depeg-changelog/`
- **Canonical source:** `shared/lib/depeg-dews-version.ts`

Each API response includes a `methodology` envelope with `version`, `changelogPath`, and `isCurrent` fields.

---

## Score Formula

```
base  = sum(W_i * S_i) / sum(W_i)          # available signals only
amp   = PSI < 75 ? 1 + ((75 - PSI) / 75) * 0.3 : 1.0
DEWS  = round(clamp(0, 100, base * amp))
```

Only signals where `available = true` participate. Weights are redistributed proportionally across available signals.

**Minimum signal requirement:** At least 2 available signal sources (total weight >= 0.30). If weight is below 0.30, `computeDEWS()` returns `null` (insufficient data) instead of emitting `0/CALM`.

**Systemic backdrop amplifier:** When PSI drops below 75 (STEADY band), individual DEWS scores are amplified by up to 30%. At PSI=40, amplification is ~14%. At PSI=0, amplification is 30%. This reflects that individual coin stress is more dangerous during systemic instability.

---

## Sub-Signals & Weights

| Signal                  | Key      | Weight | Data Source             | What It Detects                                                                      |
| ----------------------- | -------- | ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| Supply Velocity         | `supply` | 0.25   | stablecoins cache       | Rapid redemptions (bank run)                                                         |
| Pool Balance Drift      | `pool`   | 0.20   | `dex_liquidity`         | One-sided selling pressure in DEX pools                                              |
| Liquidity Erosion       | `liq`    | 0.15   | `dex_liquidity_history` | LPs fleeing                                                                          |
| Price Confidence        | `price`  | 0.15   | stablecoins cache       | Oracle/data source failures                                                          |
| Cross-Source Divergence | `diverg` | 0.15   | `dex_prices` + cache    | Fragmented pricing, trust breakdown                                                  |
| Blacklist Activity      | `black`  | 0.10   | `blacklist_events`      | Issuer emergency freeze surge                                                        |
| Mint/Burn Flow          | `flow`   | 0.10   | `mint_burn_hourly`      | Redemption surge vs minting                                                          |
| Yield Anomaly           | `yield`  | 0.05   | `yield_data`            | Yield warning signals (spike, divergence, TVL outflow, negative trend, reward-heavy) |

Weights sum to 1.15 but only available signals participate, so redistribution normalizes by actual available weight. When `S_flow` and `S_yield` are both unavailable (most coins), effective weight is 1.00 across the 6 original signals.

---

## Threat Bands

| Range  | Band        | Hex       | Description                            |
| ------ | ----------- | --------- | -------------------------------------- |
| 0-15   | **CALM**    | `#22c55e` | No stress signals detected             |
| 16-35  | **WATCH**   | `#14b8a6` | Mild stress on 1-2 indicators          |
| 36-55  | **ALERT**   | `#eab308` | Multiple indicators elevated           |
| 56-75  | **WARNING** | `#f97316` | Strong stress signals, depeg plausible |
| 76-100 | **DANGER**  | `#ef4444` | All precursors firing                  |

---

## Sub-Signal Details

### S_supply — Supply Velocity

Measures supply contraction rate. Only negative changes contribute stress.

- **1d normalization:** `[0%, 0] → [1%, 15] → [3%, 40] → [5%, 65] → [10%, 85] → [20%, 100]`
- **7d normalization:** `[0%, 0] → [3%, 15] → [7%, 40] → [15%, 70] → [30%, 100]`
- **Blend:** `0.6 * norm1d + 0.4 * norm7d`
- **Size dampening:** `sizeFactor = min(1, log10(max(mcap, $1M) / $1M) / 3)` — small coins (<$50M) get reduced signal

### S_pool — Pool Balance Drift

DEX pool imbalances from `dex_liquidity`. Blends:

- 40% balance stress (1 - weighted_balance_ratio)
- 35% pool stress score (avg_pool_stress)
- 25% worst single pool imbalance (from top_pools_json)

Smoothed with previous reading when available.

### S_liq — Liquidity Erosion

7-day change in liquidity score and TVL from `dex_liquidity_history`.

- **Score erosion anchors:** `[0%, 0] → [5%, 15] → [15%, 40] → [30%, 70] → [50%, 100]`
- **TVL erosion anchors:** `[0%, 0] → [10%, 15] → [25%, 40] → [50%, 70] → [75%, 100]`
- 50/50 blend

### S_price — Price Confidence Degradation

Maps `priceConfidence` field: high=0, single-source=25, low=60, fallback=80, null price=100.
+15 transition bonus when confidence degrades from previous reading.

### S_diverg — Cross-Source Price Divergence

Max of: primary deviation from peg, DEX deviation from peg, cross-source spread (all in bps).

- DEX input comes only from `dex_prices` rows refreshed within the last 60 minutes **and** backed by at least `$1M` of aggregate source TVL, matching the live depeg trust floor
- **Anchors:** `[0bps, 0] → [25bps, 10] → [50bps, 25] → [75bps, 50] → [100bps, 75] → [200bps, 90] → [500bps, 100]`
- **Non-USD peg dampening:** `value *= 0.7`
- Smoothed with previous reading.

Historical `stress_signal_history` rows do not retain the underlying DEX trust metadata (`source_total_tvl`, per-row freshness context) needed to replay this gate exactly. The Wave 5.9 repair path therefore refreshes current rows and prunes unrecomputable daily history from the Mar 9, 2026 trust-floor boundary onward instead of pretending those stored snapshots can be deterministically recomputed.

### S_black — Blacklist Activity

Only for blacklist-tracked coins (currently USDC, USDT, PAXG, XAUT, PYUSD, and USD1). Coverage is derived from the shared supported blacklist symbol set, so DEWS stays aligned with the live blacklist tracker instead of maintaining a separate coin list. Uses 24h event count with spike detection relative to 7d daily average.

### S_flow — Mint/Burn Flow

Available only when `mint_burn_hourly` data exists and is >= 7 days old. A mature 30-day baseline with zero mint/burn activity in the latest 24h window still counts as available data and contributes zero flow stress. Measures:

- **Burn surge:** 24h burn volume / 30d daily average
- **Burn-to-mint ratio:** 24h burns / 24h mints
- 60/40 blend of surge and ratio scores

### S_yield — Yield Anomaly

Available only for yield-bearing coins with warning signals in `yield_data`. Maps active warning signals to stress points:

| Warning Signal     | Points |
| ------------------ | ------ |
| `yield-spike`      | 30     |
| `yield-divergence` | 25     |
| `tvl-outflow`      | 35     |
| `negative-trend`   | 15     |
| `reward-heavy`     | 20     |

Score = `min(100, sum of active signal points)`.

---

## Edge Cases

- **NAV tokens** (`flags.navToken`): Excluded entirely (price appreciates, not pegged)
- **Non-USD pegs:** S_diverg dampened by 0.7 factor (noisier FX pricing)
- **Small coins (<$50M):** S_supply dampened via size factor
- **No DEX data:** S_pool and S_liq marked unavailable, weight redistributed
- **No blacklist tracking:** S_black unavailable for most coins
- **New coins / no history:** Signals gracefully degrade to unavailable

---

## Data Pipeline

### Tables

| Table                   | Pruning  | Purpose                                |
| ----------------------- | -------- | -------------------------------------- |
| `stress_signals`        | 7 days   | 30-minute rolling samples              |
| `stress_signal_history` | 365 days | Daily snapshots (first run of UTC day) |

### Cron Schedule

**Trigger:** `10,40 * * * *` — chained after `sync-dex-liquidity` on the shared half-hourly lane

**Cron name:** `compute-dews`

**Run health semantics:** DEWS records upstream read problems as structured cron metadata (`sourceFailures`, `sourceCoverage`, `validationFailures`). The cron returns `status: "degraded"` when non-bootstrap source dependencies fail. Bootstrap grace is now a one-time state transition, tracked by the `dews:bootstrap-complete` cache sentinel after the first successful publication. Before that first success, only explicitly optional missing tables are tagged `bootstrapAllowed=true`; once the sentinel exists, those same failures degrade the run normally. Fresh `dex_liquidity` is now treated as a core dependency, and rows older than 2 hours block publication as a hard source-freshness failure.

**Data flow:**

1. Read stablecoins cache, derive peg rates with cached `fxFallbackRates` for thin non-USD groups
2. Read `dex_liquidity`, live-depeg-trusted `dex_prices`, and `dex_liquidity_history`
3. Read `blacklist_events` counts (24h + 7d)
4. Read previous `stress_signals` for smoothing
5. Read `mint_burn_hourly` aggregates
6. Compute DEWS per PSI-eligible coin
7. Batch write to `stress_signals` (only for coins where `computeDEWS()` returned a score)
8. Daily snapshot to `stress_signal_history` (first run of UTC day)
9. Purge rows for IDs no longer in the current PSI-eligible universe (chunked ID deletes, 90 IDs/chunk, to stay under D1 bind-variable limits)
10. Prune old data

---

## API Endpoint

### `GET /api/stress-signals`

**All coins (no params):** Returns latest DEWS for active tracked stablecoins only. Pre-launch tracked entries are excluded because the handler gates on `ACTIVE_IDS`.

When a coin has insufficient data in a cycle (`computeDEWS() === null`), that run skips writes for the coin, so this endpoint continues serving the last valid cached row.

```json
{
  "signals": {
    "usdt-tether": { "score": 5, "band": "CALM", "signals": { ... }, "computedAt": 1740000000, "methodologyVersion": "5.9" },
    ...
  },
  "updatedAt": 1740000000,
  "malformedRows": 0,
  "methodology": { "version": "5.9", "versionLabel": "...", "currentVersion": "5.9", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000 }
}
```

**Single coin:** `?stablecoin=usdt-tether&days=30` (default 30, min 1, max 365) — Returns latest + daily history.

Unknown IDs and tracked-but-non-active IDs both return `404` (`Stablecoin not tracked`).

```json
{
  "current": { "score": 5, "band": "CALM", "signals": { ... }, "computedAt": 1740000000, "methodologyVersion": "5.9" },
  "history": [
    { "date": 1739900000, "score": 3, "band": "CALM", "signals": { ... }, "methodologyVersion": "5.9" },
    ...
  ],
  "malformedRows": 0,
  "methodology": { "version": "5.9", "versionLabel": "...", "currentVersion": "5.9", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000 }
}
```

**Cache:** standard (s-maxage=300, max-age=60)

### `GET /api/backfill-dews` (admin)

Validates DEWS against historical depeg events. Reports TP rate and lead time.

### `GET /api/backfill-dews?repair=...&dry-run=true` / `POST /api/backfill-dews?repair=...` (admin)

Repair modes:

- `repair=refresh-current`: preview or immediately republish current `stress_signals` rows under the live `$1M` DEX trust floor
- `repair=prune-history`: preview or delete bounded `stress_signal_history` windows that cannot be deterministically recomputed because the retained daily snapshots do not store the underlying DEX trust metadata

`GET` is accepted for the read-only backtest path and for repair previews with `dry-run=true`. Mutating DEWS repair runs require `POST`.

**Direct ops-api CLI example:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>`

---

## Frontend Integration

| Component     | File                              | Location                                                                              |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `DEWSBadge`   | `src/components/dews-badge.tsx`   | Table rows (hidden when CALM)                                                         |
| `DEWSDetail`  | `src/components/dews-detail.tsx`  | Stablecoin detail page; contextual methodology hint + footer links on the detail card |
| `DEWSSummary` | `src/components/dews-summary.tsx` | Homepage widget / depeg-page hero radar; title-level contextual methodology hint      |

**Hook:** `useStressSignals()` and `useStressSignalDetail(id, days)` in `src/hooks/api-hooks.ts`

**Classification constants:** `ThreatBand`, `THREAT_BAND_COLORS`, `THREAT_BAND_HEX`, `THREAT_BAND_LABELS` in `shared/lib/classification.ts`

**Design tokens:** `--dews-calm` through `--dews-danger`, plus radar contrast tokens (`--dews-radar-spoke`, `--dews-radar-calm-boundary`, `--dews-radar-band-ring-opacity`, `--dews-radar-outer-ring-opacity`, `--dews-radar-calm-dot-bloom`, `--dews-radar-calm-dot-core`) in `src/styles/tokens/semantic.css`

### Radar Layout (`DEWSSummary`)

The radar is center-is-danger: higher threat bands occupy inner rings, CALM coins form an ambient starfield at the periphery.

| Zone           | Radius range | Description                                                                     |
| -------------- | ------------ | ------------------------------------------------------------------------------- |
| Center label   | r 0–38       | `SCANNING` status label + total monitored count                                 |
| DANGER         | r 45–90      | Innermost elevated ring                                                         |
| WARNING        | r 95–140     |                                                                                 |
| ALERT          | r 143–175    |                                                                                 |
| WATCH          | r 178–208    | Outermost elevated ring                                                         |
| CALM starfield | r 212–238    | Non-interactive ambient dots (r=2 core + r=5 bloom, theme-aware opacity tokens) |
| Outer boundary | r 240        | Radar edge                                                                      |

Dashed ring boundaries are drawn at each zone's inner edge (r=45, 95, 143, 178) using the zone's threat color, plus a faint gray ring at r=212 delimiting the calm zone. Ring/spoke/calm-dot visibility is theme-aware via the DEWS radar tokens listed above. CALM dots are scattered deterministically using `deterministicRadiusOffset(id, 26)` from `src/lib/dews-radar-utils.ts`. The legend renders severity-order bands with live counts: `Danger (n)`, `Warning (n)`, `Alert (n)`, `Watch (n)`, `Calm (n)`. The `Calm` legend marker uses the same faint bloom+core star-dot treatment as the calm outer starfield.

---

## Alerting

DEWS has a dedicated outbound Telegram path via `dispatch-telegram-alerts`, scheduled every 5 minutes on the isolated `dispatch-telegram-alerts` cron. Subscriber filtering and dedupe behavior live in the Telegram alert subsystem, but DEWS remains surfaced through the normal read paths too:

- `GET /api/stress-signals`
- Telegram subscriber alerts (`dispatch-telegram-alerts`)
- Frontend components (`dews-badge`, `dews-detail`, `dews-summary`)
