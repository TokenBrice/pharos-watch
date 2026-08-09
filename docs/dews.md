# Depeg Early Warning Score (DEWS)

Per-coin, forward-looking stress score (0-100) for depeg stress. It is not a calibrated probability. Computed every 30 minutes from 8 sub-signals.

## Methodology Versioning

DEWS shares its methodology versioning with the Depeg Tracker pipeline. Both are tracked together in `shared/lib/methodology-versions/depeg-dews.ts`.

- **Current methodology version:** `v6.1`
- **Public changelog page:** `/methodology/depeg-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/depeg-dews.ts`

Each API response includes the shared `methodology` envelope with `version`, `versionLabel`, `currentVersion`, `currentVersionLabel`, `changelogPath`, `asOf`, and `isCurrent` fields.

---

## Score Formula

```
base  = sum(W_i * S_i) / sum(W_i)          # available signals only
psiAmp = PSI < 75 ? 1 + ((75 - PSI) / 75) * 0.3 : 1.0
contagionAmp = same-peg first-pass bump, currently 1.15 for DANGER or 1.08 for WARNING, clamped to 1.2
DEWS = round(clamp(0, 100, base * psiAmp * contagionAmp))
```

Only signals where `available = true` participate. Weights are redistributed proportionally across available signals.

**Minimum signal requirement:** At least 2 available signal sources (total weight >= 0.30). If weight is below 0.30, `computeDEWS()` returns `null` (insufficient data) instead of emitting `0/CALM`.

**Evidence-quality WATCH cap:** After the amplifier formula, `computeDEWS()` caps preliminary scores above `WATCH_MAX_SCORE = 35` back to WATCH when the evidence set has neither market-price evidence nor DEX-liquidity evidence and there is no severe issuer-control signal. Severe issuer-control evidence is a blacklist sub-signal at or above the configured severe threshold, so a real freeze/blacklist surge can exceed WATCH even without market or DEX corroboration. Capped rows carry `insufficientEvidenceReason = "data_quality_only"` when the price-confidence stress score is at least 50 and there is no other non-systemic evidence (only data quality plus systemic backdrop), or `"missing_market_or_liquidity_evidence"` when other non-market evidence exists, or the data-quality stress is below 50, while market/DEX corroboration is missing.

Known and accepted: the market-price evidence gate is `value >= 10`, which sits on the `[25, 10]` knot of the divergence curve and so behaves as `worstBps >= 25`; the non-USD `x0.7` damper moves that to a non-integer ~32.143 bps, so whole-bps rounding upstream drops market-price evidence across a ~0.36 bps window (`worstBps` in 32.143-32.5) on non-USD pegs only. It gates an evidence kind rather than a score, and USD pegs round one-directionally in the conservative direction.

**Systemic backdrop amplifier:** When PSI drops below 75 (below the STEADY band; 75 is STEADY's floor), individual DEWS scores are amplified by up to 30%. At PSI=40, amplification is ~14%. At PSI=0, amplification is 30%. This reflects that individual coin stress is more dangerous during systemic instability.

**Contagion Amplifier:** On top of the PSI amplifier, DEWS applies a bounded per-peg-type contagion amplifier derived from the same cycle's first-pass results. If any tracked stablecoin's first-pass band is `DANGER` (bump `1.15x`) or `WARNING` (bump `1.08x`), the other coins sharing its `pegType` are re-scored with that multiplier — the amplifier takes the largest qualifying bump, not a sum, so multiple DANGER coins on one peg type still cap at `1.15x`. The hard defensive cap is `1.2x` (`CONTAGION_AMPLIFIER_CAP`) for future bump values; different peg types do not share contagion risk. A coin that is itself `DANGER` or `WARNING` on the first pass does **not** contagion-amplify itself — its first-pass result carries forward unchanged. The resulting per-coin amplifier is surfaced on `/api/stress-signals` as `amplifiers.contagion` (default `1.0` when no contagion is detected or for legacy cached rows).

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
| Yield Anomaly           | `yield`  | 0.05   | `yield_data` + `yield-rankings` cache | Yield warning signals plus populated source-risk and rank-attribution stress evidence |

Weights sum to 1.15 but only available signals participate, so redistribution normalizes by actual available weight. When `S_flow` and `S_yield` are both unavailable (most coins), effective weight is 1.00 across the 6 original signals.

---

## Threat Bands

| Range  | Band        | Hex       | Description                            |
| ------ | ----------- | --------- | -------------------------------------- |
| 0-15   | **CALM**    | `#22c55e` | No stress signals detected             |
| 16-35  | **WATCH**   | `#14b8a6` | Mild stress on 1-2 indicators          |
| 36-55  | **ALERT**   | `#eab308` | Multiple indicators elevated           |
| 56-75  | **WARNING** | `#f97316` | Strong stress signals, depeg plausible |
| 76-100 | **DANGER**  | `#ef4444` | Severe stress across available weighted signals |

---

## Sub-Signal Details

### S_supply — Supply Velocity

Measures supply contraction rate. Only negative changes contribute stress.

- **1d normalization:** `[0%, 0] → [1%, 15] → [3%, 40] → [5%, 65] → [10%, 85] → [20%, 100]`
- **7d normalization:** `[0%, 0] → [3%, 15] → [7%, 40] → [15%, 70] → [30%, 100]`
- **Blend:** `0.6 * norm1d + 0.4 * norm7d`
- **Size dampening:** `sizeFactor = min(1, log10(max(mcap, $1M) / $1M) / 3)` — small coins (<$50M) get reduced signal
- **Anchor availability:** if both previous-day and previous-week supply anchors are absent, the sub-signal is unavailable and its weight is redistributed. If one anchor is present, the present side is scored and the missing side contributes zero velocity. Explicit finite zero anchors stay available and produce zero velocity stress rather than a divide-by-zero or a false contraction

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
- **Fail-closed:** current liquidity score is required, and at least one of the score or TVL 7-day anchors must be available. If both anchors are missing, the sub-signal is unavailable; if one anchor is missing, that side contributes 0 to the 50/50 blend.

### S_price — Price Confidence Degradation

Maps `priceConfidence` field: high=0, single-source=25, low=60, fallback=80, null price=100.
+15 transition bonus when confidence degrades from previous reading.

### S_diverg — Cross-Source Price Divergence

Max of: primary deviation from peg, DEX deviation from peg, cross-source spread (all in bps).

- DEX input comes only from `dex_prices` rows refreshed within the live depeg trust window (`DEX_FRESHNESS_SEC = 2100`, currently 35 minutes) **and** backed by at least `$1M` of aggregate source TVL, matching the live depeg trust floor
- **Anchors:** `[0bps, 0] → [25bps, 10] → [50bps, 25] → [75bps, 50] → [100bps, 75] → [200bps, 90] → [500bps, 100]`
- **Non-USD peg dampening:** `value *= 0.7`
- Smoothed with previous reading.

Historical `stress_signal_history` rows do not retain the underlying DEX trust metadata (`source_total_tvl`, per-row freshness context) needed to replay this gate exactly. The Wave 5.9 repair path therefore refreshes current rows and prunes unrecomputable daily history from the Mar 9, 2026 trust-floor boundary onward instead of pretending those stored snapshots can be deterministically recomputed.

### S_black — Blacklist Activity

Only for stablecoin IDs with direct live blacklist tracker configs. Recent `blacklist_events` rows are resolved through tracker provenance (`config_key` / `contract_address`) to the owning canonical stablecoin ID before scoring, so same-symbol siblings do not inherit each other's freeze events. Legacy rows without provenance fall back only when the symbol maps to a single tracker-owned stablecoin ID. Uses 24h event count with spike detection relative to 7d daily average.

### S_flow — Mint/Burn Flow

Available only when `mint_burn_hourly` has at least 7 observed baseline days and a fresh latest 24h row. A fresh 24h row with zero mint/burn volume still contributes zero flow stress; a mature baseline with no fresh 24h row is marked stale and its signal weight is redistributed. Measures:

- **Burn surge:** 24h burn volume / 30d daily average
- **Burn-to-mint ratio:** 24h burns / 24h mints
- 60/40 blend of surge and ratio scores

### S_yield — Yield Anomaly

Available for yield-bearing coins with warning signals in `yield_data` or populated structured yield stress in the published `yield-rankings` cache. Maps active warning signals to stress points:

| Warning Signal     | Points |
| ------------------ | ------ |
| `yield-spike`      | 30     |
| `yield-divergence` | 25     |
| `tvl-outflow`      | 35     |
| `negative-trend`   | 15     |
| `reward-heavy`     | 20     |

Score = `min(100, sum of active signal points)`.

Structured Yield Intelligence source-risk and rank-attribution evidence adds these stress points inside the same Yield Anomaly sub-signal:

| Structured input | Points |
| --- | ---: |
| `sourceRisk.rewardShare > 0.5` | 20 |
| `sourceRisk.sourceDepthRatio < 0.001` | 35 |
| `sourceRisk.sourceAgeSeconds > 6h` | 15 |
| `sourceRisk.sourceSwitchCount30d > 0` | 20 |
| `sourceRisk.sourceRiskPenalty >= 1.5` | 20 |
| `sourceRisk.venueRiskTier = "medium"` | 10 |
| `sourceRisk.venueRiskTier = "high"` | 25 |
| `rankChangeAttribution.primaryDriver = "source-switch"` | 20 |
| `rankChangeAttribution.primaryDriver = "source-risk"` | 20 |

Structured evidence is additive with warning-string evidence and the final Yield Anomaly sub-signal still caps at 100. Medium reviewed venue risk adds the bounded `structured-medium-risk-venue` warning, while high reviewed venue risk keeps the stronger `structured-high-risk-venue` warning. Neutral structured rows do not become available zero-stress signals; missing, malformed, or neutral source-risk evidence remains a no-op so legacy warning-only behavior is preserved.

---

## Edge Cases

- **NAV tokens** (`flags.navToken`): Excluded entirely (price appreciates, not pegged)
- **Non-USD pegs:** S_diverg dampened by 0.7 factor (noisier FX pricing)
- **Small coins (<$50M):** S_supply dampened via size factor
- **No DEX data:** S_pool and S_liq marked unavailable, weight redistributed
- **No blacklist tracking:** S_black unavailable for most coins
- **New coins / no history:** Signals gracefully degrade to unavailable; Supply Velocity is unavailable until at least one previous-day or previous-week supply anchor exists

---

## Data Pipeline

### Tables

| Table                   | Pruning  | Purpose                                |
| ----------------------- | -------- | -------------------------------------- |
| `stress_signals`        | 7 days   | 30-minute rolling samples              |
| `stress_signals_latest` | current  | Latest-row materialization for hot readers |
| `stress_signal_history` | 365 days | Daily snapshots (first exact-coverage run of UTC day) |
| `surface_publication_generations` (`surface = "dews"`) | durable | Successfully published generations consumed by Tape and publication health |

`cache["dews:published-generation"]` is the completed-publication pointer for current DEWS readers. The cron writes it only after current/latest rows have been written, retention work has completed, and generation row counts match the computed result count. That pointer and its `surface_publication_generations` row commit in one D1 batch, so downstream consumers cannot observe a pointer without durable publication proof or ledger a generation whose pointer lost the race to a newer run. Migration `0182` bootstraps the pre-existing pointer, and the Tape projector reconciles the current validated pointer again at runtime to cover the migration-to-deploy window. `cache["freshness:dews"]` remains the healthy-run freshness sentinel and only advances for non-degraded publications.

### Cron Schedule

**Trigger:** `26,56 * * * *` — DB-only DEWS/PSI lane. It runs after the `10,40 * * * *` DEX source stage and `16,46 * * * *` scoring consumer, but it is a separate scheduled invocation so a DEX invocation overrun cannot prevent DEWS publication.

**Cron name:** `compute-dews`

**Run health semantics:** DEWS records upstream read problems as structured cron metadata (`sourceFailures`, `sourceCoverage`, `validationFailures`). The cron returns `status: "degraded"` when non-bootstrap source dependencies fail. Bootstrap grace is now a one-time state transition, tracked by the `dews:bootstrap-complete` cache sentinel written on the first cron run that reaches persistence — even if that run is degraded by other source failures or wrote no rows. Before that first run, only explicitly optional missing tables are tagged `bootstrapAllowed=true`; once the sentinel exists, those same failures degrade the run normally. Stale `dex_liquidity` and stale `mint_burn_hourly` freshness are recorded in metadata, but rows that meet signal-coverage requirements are still persisted. The same metadata includes `dependencies.dexLiquidity` diagnostics from `dex_liquidity_publication_generations` so operators can distinguish stale DEWS inputs caused by a failed/latest DEX publication from normal downstream catch-up.

**Off-chain confirmation resilience:** CoinGecko and DefiLlama confirmation fetches used by the pending-depeg pipeline are wrapped in a circuit breaker. A sustained provider outage trips the breaker and short-circuits subsequent confirmation lookups until it resets, so a single upstream failure no longer hammers the endpoint for 45 minutes per pending row.

**Data flow:**

1. Read stablecoins cache, derive peg rates with cached `fxFallbackRates` for thin non-USD groups
2. Read `dex_liquidity`, live-depeg-trusted `dex_prices`, and `dex_liquidity_history`
3. Read `blacklist_events` counts (24h + 7d)
4. Read previous `stress_signals` for smoothing
5. Read `mint_burn_hourly` aggregates, separating 30d baseline coverage from latest-row freshness
6. Read `yield_data.warning_signals` and structured `sourceRisk` / `rankChangeAttribution` evidence from the published `yield-rankings` cache
7. Compute DEWS per PSI-eligible coin
8. Batch write to `stress_signals` and `stress_signals_latest` (only for coins where `computeDEWS()` returned a score)
9. Retire current rows for PSI-eligible assets that are explicitly present in the stablecoins cache with zero current circulating supply
10. Seal the producer-owned daily `stress_signal_history` rows to the exact computed stablecoin ID set in one atomic replacement; frozen historical rows remain outside that ownership boundary
11. Purge rows for IDs no longer in the current PSI-eligible universe (chunked ID deletes, 90 IDs/chunk, to stay under D1 bind-variable limits)
12. Prune old data
13. Validate row counts, then atomically advance `dews:published-generation` and its durable published-generation ledger row; healthy runs also advance `freshness:dews`

---

## API Endpoint

### `GET /api/stress-signals`

**All coins (no params):** Returns latest DEWS for readable tracked stablecoins. The response-level freshness headers use the latest aggregate publication timestamp (`updatedAt`) so one retained frozen/long-tail row does not stale the entire `/depeg` surface; `oldestComputedAt` remains in the body for consumers that need to detect per-coin lag. Pre-launch tracked entries are excluded because the handler gates on readable tracked IDs.

When a coin has insufficient data in a cycle (`computeDEWS() === null`), that run skips writes for the coin, so this endpoint continues serving the last valid cached row.

Current DEWS readers, Telegram alert snapshots, and smoothing inputs apply `computed_at <= dews:published-generation` when the pointer exists. That prevents partially written newer runs from becoming visible while still allowing retained last-valid rows from older completed generations. The PSI stress-breadth read instead requires an exact `computed_at = dews:published-generation` match once the pointer exists, so a coin without a fresh row in that generation drops out of the breadth term for that cycle rather than falling back to a retained older row.

```text
{
  "signals": {
    "usdt-tether": { "score": 5, "band": "CALM", "signals": { ... }, "computedAt": 1740000000, "methodologyVersion": "6.1" },
    ...
  },
  "updatedAt": 1740000000,
  "oldestComputedAt": 1740000000,
  "malformedRows": 0,
  "methodology": { "version": "6.1", "versionLabel": "...", "currentVersion": "6.1", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000 }
}
```

`updatedAt` is the newest current row in the aggregate response and is used for aggregate `X-Data-Age` / `Warning` freshness headers. `oldestComputedAt` is the oldest returned current row and is body-only for consumers that need per-coin lag detection.

**Single coin:** `?stablecoin=usdt-tether&days=30` (default 30, min 1, max 365) — Returns latest + daily history.

Unknown IDs return `404` with `Unknown stablecoin`; tracked-but-non-active IDs return `404` with `Stablecoin not tracked`.

```text
{
  "current": { "score": 5, "band": "CALM", "signals": { ... }, "computedAt": 1740000000, "methodologyVersion": "6.1" },
  "history": [
    { "date": 1739900000, "score": 3, "band": "CALM", "signals": { ... }, "methodologyVersion": "6.1" },
    ...
  ],
  "malformedRows": 0,
  "methodology": { "version": "6.1", "versionLabel": "...", "currentVersion": "6.1", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000 }
}
```

**Cache:** standard (s-maxage=300, max-age=60)

### `GET /api/backfill-dews` (admin)

Validates DEWS against historical depeg events. The primary calibration path uses stored `stress_signal_history` rows plus curated anchors and reports precision, recall, false-positive days, false-negative incidents, lead-time P50/P90, alert churn, band-transition stability, and cohort metrics. The older supply/liquidity reconstruction remains a diagnostic path because it cannot replay every live signal or source-trust gate.

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
