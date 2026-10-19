# Depeg Early Warning Score (DEWS)

> **Agent navigation** — Start with [Score Formula](#score-formula) and [Threat Bands](#threat-bands). Grep the matching heading for Sub-Signals & Weights · Sub-Signal Details · Edge Cases · Data Pipeline · API Endpoint · Frontend Integration instead of reading wholesale.

Per-coin, forward-looking stress score (0-100) for depeg stress. It is not a calibrated probability. Computed every 30 minutes from 8 sub-signals.

## Methodology Versioning

DEWS shares its methodology versioning with the Depeg Tracker pipeline. Both resolve their published version and changelog through `shared/lib/methodology-versions/registry.ts`.

- **Current methodology version:** <!-- GENERATED-START: methodology-version-depeg-dews -->`v6.35`<!-- GENERATED-END: methodology-version-depeg-dews -->
- **Public changelog page:** `/methodology/depeg-changelog/`
- **Canonical constants:** `shared/lib/methodology-versions/constants.ts`

Each API response includes the shared `methodology` envelope with `version`, `versionLabel`, `currentVersion`, `currentVersionLabel`, `changelogPath`, `asOf`, and `isCurrent` fields.

Release history is published in the [shared Depeg/DEWS changelog](https://pharos.watch/methodology/depeg-changelog/), not repeated here.

**Pending release obligations:** v6.34 requires owner-approved production-history replay and fixed-clock admission/band comparison, plus separate fresh admitted producer observations and production resource evidence. Activation remains provisional and must be re-dated at release; a version or passing replay does not prove production health. The v6.33 U-C20-16 production-history replay remains owner-approved prerequisite work; no completed replay result is asserted.

---

## Score Formula

```
base  = sum(W_i * S_i) / sum(W_i)          # available signals only
psiAmp = PSI < 75 ? 1 + ((75 - PSI) / 75) * 0.3 : 1.0
contagionAmp = same-peg first-pass bump, currently 1.15 for DANGER or 1.08 for WARNING, clamped to 1.2
preliminaryScore = round(clamp(0, 100, base * psiAmp * contagionAmp))
```

Only signals where `available = true` participate. Weights are redistributed proportionally across available signals.

**Minimum signal requirement:** At least 2 available signal sources (total weight >= 0.30). If weight is below 0.30, `computeDEWS()` returns `null` (insufficient data) instead of emitting `0/CALM`.

**Evidence-quality WATCH cap:** After the amplifier formula, `computeDEWS()` caps preliminary scores above `WATCH_MAX_SCORE = 35` back to WATCH when the evidence set has neither market-price evidence nor DEX-liquidity evidence and there is no severe issuer-control signal. Severe issuer-control evidence is a blacklist sub-signal at or above the configured severe threshold, so a real freeze/blacklist surge can exceed WATCH even without market or DEX corroboration. Capped rows carry `insufficientEvidenceReason = "data_quality_only"` when the price-confidence stress score is at least 50 and there is no other non-systemic evidence (only data quality plus systemic backdrop), or `"missing_market_or_liquidity_evidence"` when other non-market evidence exists, or the data-quality stress is below 50, while market/DEX corroboration is missing.
The gate constants live in `shared/lib/dews-config.ts`. Market-price evidence requires available divergence stress ≥ `EVIDENCE_STRESS_THRESHOLD` (10); DEX-liquidity evidence requires available pool-balance or liquidity-erosion stress ≥ 10. Severe issuer-control evidence requires available blacklist stress ≥ `SEVERE_ISSUER_CONTROL_THRESHOLD` (55). Source availability alone never bypasses the cap. Final DEWS is the preliminary score when either bypass qualifies, otherwise `min(preliminaryScore, WATCH_MAX_SCORE)`.

The market-price gate uses the final divergence sub-signal, after whole-bps derivation, curve interpolation, non-USD dampening and eligible previous-reading smoothing; it is not a fixed raw-deviation threshold.

**Systemic backdrop amplifier:** When PSI drops below 75 (below the STEADY band; 75 is STEADY's floor), individual DEWS scores are amplified by up to 30%. At PSI=40, amplification is ~14%. At PSI=0, amplification is 30%. This reflects that individual coin stress is more dangerous during systemic instability.

**Contagion Amplifier:** On top of the PSI amplifier, DEWS applies a bounded per-peg-type contagion amplifier derived from the same cycle's first-pass results. If any tracked stablecoin's first-pass band is `DANGER` (bump `1.15x`) or `WARNING` (bump `1.08x`), the other coins sharing its `pegType` are re-scored with that multiplier — the amplifier takes the largest qualifying bump, not a sum, so multiple DANGER coins on one peg type still cap at `1.15x`. The hard defensive cap is `1.2x` (`CONTAGION_AMPLIFIER_CAP`) for future bump values; different peg types do not share contagion risk. A coin that is itself `DANGER` or `WARNING` on the first pass does **not** contagion-amplify itself — its first-pass result carries forward unchanged. The resulting per-coin amplifier is surfaced on `/api/stress-signals` as `amplifiers.contagion` (default `1.0` when no contagion is detected or for legacy cached rows).

---

## Sub-Signals & Weights

| Signal                  | Key      | Weight | Data Source             | What It Detects                                                                      |
| ----------------------- | -------- | ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| Supply Velocity         | `supply` | <!-- GENERATED-START: dews-supply-weight -->0.25<!-- GENERATED-END: dews-supply-weight -->   | stablecoins cache       | Rapid redemptions (bank run)                                                         |
| Pool Balance Drift      | `pool`   | <!-- GENERATED-START: dews-pool-weight -->0.20<!-- GENERATED-END: dews-pool-weight -->   | `dex_liquidity`         | One-sided selling pressure in DEX pools                                              |
| Liquidity Erosion       | `liq`    | <!-- GENERATED-START: dews-liq-weight -->0.15<!-- GENERATED-END: dews-liq-weight -->   | `dex_liquidity_history` | LPs fleeing                                                                          |
| Price Confidence        | `price`  | <!-- GENERATED-START: dews-price-weight -->0.15<!-- GENERATED-END: dews-price-weight -->   | stablecoins cache       | Oracle/data source failures                                                          |
| Cross-Source Divergence | `diverg` | <!-- GENERATED-START: dews-diverg-weight -->0.15<!-- GENERATED-END: dews-diverg-weight -->   | `dex_prices` + cache    | Fragmented pricing, trust breakdown                                                  |
| Blacklist Activity      | `black`  | <!-- GENERATED-START: dews-black-weight -->0.10<!-- GENERATED-END: dews-black-weight -->   | `blacklist_events`      | Issuer emergency freeze surge                                                        |
| Mint/Burn Flow          | `flow`   | <!-- GENERATED-START: dews-flow-weight -->0.10<!-- GENERATED-END: dews-flow-weight -->   | `mint_burn_hourly`      | Redemption surge vs minting                                                          |
| Yield Anomaly           | `yield`  | <!-- GENERATED-START: dews-yield-weight -->0.05<!-- GENERATED-END: dews-yield-weight -->   | `yield_data` + `yield-rankings` cache | Yield warning signals plus populated source-risk and rank-attribution stress evidence |

Weights sum to 1.15 but only available signals participate, so redistribution normalizes by actual available weight. When `S_flow` and `S_yield` are both unavailable (most coins), effective weight is 1.00 across the 6 original signals.

---

## Threat Bands

| Range  | Band        | Hex       | Description                            |
| ------ | ----------- | --------- | -------------------------------------- |
| <!-- GENERATED-START: dews-calm-range -->0-15<!-- GENERATED-END: dews-calm-range -->   | <!-- GENERATED-START: dews-calm-label -->**CALM**<!-- GENERATED-END: dews-calm-label -->    | <!-- GENERATED-START: dews-calm-hex -->`#22c55e`<!-- GENERATED-END: dews-calm-hex --> | No stress signals detected             |
| <!-- GENERATED-START: dews-watch-range -->16-35<!-- GENERATED-END: dews-watch-range -->  | <!-- GENERATED-START: dews-watch-label -->**WATCH**<!-- GENERATED-END: dews-watch-label -->   | <!-- GENERATED-START: dews-watch-hex -->`#14b8a6`<!-- GENERATED-END: dews-watch-hex --> | Mild stress on 1-2 indicators          |
| <!-- GENERATED-START: dews-alert-range -->36-55<!-- GENERATED-END: dews-alert-range -->  | <!-- GENERATED-START: dews-alert-label -->**ALERT**<!-- GENERATED-END: dews-alert-label -->   | <!-- GENERATED-START: dews-alert-hex -->`#eab308`<!-- GENERATED-END: dews-alert-hex --> | Multiple indicators elevated           |
| <!-- GENERATED-START: dews-warning-range -->56-75<!-- GENERATED-END: dews-warning-range -->  | <!-- GENERATED-START: dews-warning-label -->**WARNING**<!-- GENERATED-END: dews-warning-label --> | <!-- GENERATED-START: dews-warning-hex -->`#f97316`<!-- GENERATED-END: dews-warning-hex --> | Strong stress signals, depeg plausible |
| <!-- GENERATED-START: dews-danger-range -->76-100<!-- GENERATED-END: dews-danger-range --> | <!-- GENERATED-START: dews-danger-label -->**DANGER**<!-- GENERATED-END: dews-danger-label -->  | <!-- GENERATED-START: dews-danger-hex -->`#ef4444`<!-- GENERATED-END: dews-danger-hex --> | Severe stress across available weighted signals |

---

## Sub-Signal Details

### S_supply — Supply Velocity

Measures supply contraction rate. Only negative changes contribute stress.

- **1d normalization:** `[0%, 0] → [1%, 15] → [3%, 40] → [5%, 65] → [10%, 85] → [20%, 100]`
- **7d normalization:** `[0%, 0] → [3%, 15] → [7%, 40] → [15%, 70] → [30%, 100]`
- **Blend:** `0.6 * norm1d + 0.4 * norm7d`
- **Size dampening:** `sizeFactor = min(1, log10(max(mcap, $1M) / $1M) / 3)` — every coin below $1B gets reduced signal ($100M ≈ 0.67x, $50M ≈ 0.57x, $10M ≈ 0.33x); the factor reaches 1.0 only at $1B+
- **Anchor availability:** if both previous-day and previous-week supply anchors are absent, the sub-signal is unavailable and its weight is redistributed. If one anchor is present, the present side is scored and the missing side contributes zero velocity. Explicit finite zero anchors stay available and produce zero velocity stress rather than a divide-by-zero or a false contraction

### S_pool — Pool Balance Drift

DEX pool imbalances from `dex_liquidity`. Blends:

- 40% balance stress (`100 * (1 - weighted_balance_ratio)`)
- 35% pool stress score (avg_pool_stress)
- 25% worst single pool imbalance (from `top_pools_json`, counting only pools with at least $100k TVL and a measured `extra.balanceRatio`)

The signal is unavailable unless both `weighted_balance_ratio` and `avg_pool_stress` are finite. The worst-pool component carries its own availability (`worstPoolStatus`):

- `observed` — at least one eligible pool has a measured balance ratio; pools without a balance measurement are excluded from the max, never read as perfect balance
- `empty` — the list was read and has no eligible pool: an observed empty set, scored as a measured `0`
- `unavailable` (`worstPool: null`, `worstPoolUnavailableReason`) — `top_pools_json` is missing (`top-pools-missing`), unparseable (`top-pools-json-parse-failed`), not an array (`top-pools-invalid-shape`), has an entry with a missing/invalid TVL or non-numeric ratio (`top-pools-entry-malformed`), or its eligible pools carry no balance measurement (`top-pools-balance-unmeasured`)

An unavailable worst-pool component drops out of both numerator and denominator: the blend is renormalized over the readable components (`value = (0.40·balance + 0.35·stress) / 0.75`) and `componentCoverage` publishes the readable share of the nominal weight (`0.75` or `1`). Unreadable detail therefore cannot publish a lower, calmer value than the readable components support (DEC-04). Decode failures are recorded per asset as `dex_liquidity.top_pools_json` malformed-input diagnostics with `degradesRun: false`, so one asset's bad detail degrades only that asset's pool signal and never holds the generation.

Smoothed (averaged) with the previous cycle's reading only when that reading was itself available **and** had the same `componentCoverage`. The persisted previous generation keeps an unavailable signal as `{value: 0, available: false}`, so smoothing requires the recorded `available` flag, not just the stored value — otherwise one evidence-less cycle would halve the next fresh reading and decay it over the following three. A previous reading built from different components (or a pre-v6.29 row with no recorded coverage) measured a different blend and is not averaged in. The pool signal publishes the outcome as `smoothing` (`applied`, `no-previous`, `previous-unavailable`, `previous-coverage-unknown`, `coverage-changed`).

### S_liq — Liquidity Erosion

7-day change in liquidity score and TVL from `dex_liquidity_history`.

Both live hydration and historical reconstruction use shared nearest-observation admission: positive TVL and `coverage_confidence >= 0.5`, within an inclusive 36-hour tolerance of the seven-day target. A closer ineligible row cannot mask an older eligible row. The historical liquidity score and its date retain that independently selected observation. The TVL anchor additionally requires the same `liquidityTvlBasisEpoch` as the stored current observation; it can select a different compatible row within the same tolerance, or remain null without discarding the score anchor. Same-epoch minor versions remain comparable. Explicit legacy identities belong to epoch 0; missing version projections or a missing current observation cannot establish TVL comparability. Durability/digest retain their stricter >=0.75 gates and separate score-identity rules.

Live history hydration receives the actually admitted per-coin current liquidity rows after their independent load; diagnostic failures are replayed in the original source order. Historical reconstruction first chooses its nearest eligible historical current anchor without an epoch comparator, then gates the weekly TVL anchor against that selected row's stored version, never today's runtime constant. A TVL-basis change alone does not make the historical score unavailable. Corrected input availability can change new DEWS scores or bands; stored scores and calibration history are not recomputed.

Live DEX history reads start at `now − 7 days − 36 hours` (8.5 days). Historical reconstruction's DEX-only read starts at `min(event UTC days) − 14 days − 36 hours` (15.5 days), covering the earliest seven-day evaluation's weekly anchor. Supply-history bounds and event/current-day buckets remain unchanged. Code, next-free Depeg/DEWS methodology version and approved replay evidence must release together; rollback restores an approved code/version pair, never retags archived scores.

- **Score erosion anchors:** `[0%, 0] → [5%, 15] → [15%, 40] → [30%, 70] → [50%, 100]`
- **TVL erosion anchors:** `[0%, 0] → [10%, 15] → [25%, 40] → [50%, 70] → [75%, 100]`
- 50/50 blend
- **Fail-closed:** current liquidity score is required, and at least one of the score or TVL 7-day anchors must be available. If both anchors are missing, the sub-signal is unavailable; if one anchor is missing, that side contributes 0 to the 50/50 blend.

### S_price — Price Confidence Degradation

Maps `priceConfidence` field: high=0, single-source=25, low=60, fallback=80, null price=100.
A missing, blank or unrecognised `priceConfidence` is unvalidated evidence, not a high-confidence reading: it scores as the worst known tier (80) and the signal carries a `price-confidence-unmapped` warning.
+15 transition bonus when confidence degrades from previous reading, capped at 100. The `high` → `single-source` reclassification is exempt: it is treated as a labelling change from the consensus honesty fix, not a real degradation, and adds no bonus.

### S_diverg — Cross-Source Price Divergence

Max of: primary deviation from peg, DEX deviation from peg, cross-source spread (all in bps).

The primary price must pass `isObservedPrice(...)`. Nominal par references are not observations and enter DEWS as `null`. Primary and independently admitted DEX deviations are evaluated separately against the admitted peg reference; cross-source spread exists only when both legs are observed, finite and positive. With neither valid leg, divergence is unavailable rather than a measured calm zero. A stressed DEX-only leg qualifies as `market-price` evidence and is not WATCH-capped merely because the primary observation is missing.

- DEX input comes only from `dex_prices` rows refreshed within the live depeg trust window (`DEX_FRESHNESS_SEC = 4500`, currently 75 minutes) **and** backed by at least `$1M` of aggregate source TVL, matching the live depeg trust floor
- **Anchors:** `[0bps, 0] → [25bps, 10] → [50bps, 25] → [75bps, 50] → [100bps, 75] → [200bps, 90] → [500bps, 100]`
- **Non-USD peg dampening:** `value *= 0.7`
- Averaged with the previous reading only when that reading was available.

Historical `stress_signal_history` rows do not retain the underlying DEX trust metadata (`source_total_tvl`, per-row freshness context) needed to replay this gate exactly. The Wave 5.9 repair path therefore refreshes current rows and prunes unrecomputable daily history from the Mar 9, 2026 trust-floor boundary onward instead of pretending those stored snapshots can be deterministically recomputed.

### S_black — Blacklist Activity

Only for stablecoin IDs with direct live blacklist tracker configs. Recent `blacklist_events` rows are resolved through tracker provenance (`config_key` / `contract_address`) to the owning canonical stablecoin ID before scoring, so same-symbol siblings do not inherit each other's freeze events. Legacy rows without provenance fall back only when the symbol maps to a single tracker-owned stablecoin ID. Uses 24h event count with spike detection relative to 7d daily average.
If the blacklist source read fails, tracked coins mark this signal unavailable rather than treating the missing rows as an observed zero; its weight is redistributed across the remaining available signals.

Only public events (`suppression_reason IS NULL`) enter either window. Suppressed EURC mirror-zero rows remain stored for provenance but cannot create a blacklist surge. The daily digest applies the same public-event eligibility before counting its rolling 24-hour activity or selecting candidates; unsuppressed zero-value events remain eligible. Excluding rows can change both the numerator and the 7-day baseline, so it does not imply every resulting DEWS score decreases.

### S_flow — Mint/Burn Flow

Requires at least 7 observed baseline days, a latest hourly row no older than 24h, complete 24h USD valuation, and no partial burn-baseline valuation. Missing values or failed gates make the signal unavailable; unknown legacy baseline valuation is tolerated. Fresh fully valued zero-volume rows produce zero stress. Measures:

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
| `zero-yield`       | 0      |

`YIELD_WARNING_SIGNAL_KEYS` in `shared/types/yield.ts` is the single authority for this vocabulary: `detectWarningSignals()` is typed to it and a test pins that every key it can emit has a reviewed score here. `zero-yield` is an APY-collapse editorial flag rather than a depeg-stress driver, so it is recognised and scored zero.

Score = `min(100, sum of active signal points)`. When the active warnings sum to no scored stress — an unrecognised key, or `zero-yield` alone — the sub-signal is marked **unavailable** (`yield-warnings-unscored`) and its weight is redistributed, rather than publishing a zero that reads as a measured clean yield.

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

Rank drivers add no duplicate points when their static counterpart fired: `source-switch` is paired only with `sourceSwitchCount30d > 0`; `source-risk` is paired only with `sourceRiskPenalty >= 1.5`. Other source-risk conditions do not suppress the rank-driver points.

`rankChangeAttribution` is populated generation-over-generation at publish time, when the publisher is given the previous publication; a payload without a comparable previous generation carries no rank-attribution evidence, and those rows simply contribute no structured driver points.

Structured evidence is additive with warning-string evidence and the final Yield Anomaly sub-signal still caps at 100. Medium reviewed venue risk adds the bounded `structured-medium-risk-venue` warning, while high reviewed venue risk keeps the stronger `structured-high-risk-venue` warning. Neutral structured rows do not become available zero-stress signals; missing, malformed, or neutral source-risk evidence remains a no-op so legacy warning-only behavior is preserved.

---

## Edge Cases

- **NAV tokens** (`flags.navToken`): Excluded entirely (price appreciates, not pegged)
- **Non-USD pegs:** S_diverg dampened by 0.7 factor (noisier FX pricing)
- **Coins under $1B:** S_supply dampened via the log size factor (full signal only at $1B+)
- **No DEX data:** S_pool and S_liq marked unavailable, weight redistributed
- **No blacklist tracking:** S_black unavailable for most coins
- **New coins / no history:** Signals gracefully degrade to unavailable; Supply Velocity is unavailable until at least one previous-day or previous-week supply anchor exists
- **Malformed core persisted inputs:** An eligible asset with unreadable previous stress-signal JSON or yield warning JSON is quarantined before scoring and contagion. Healthy peers can publish; `malformedPersistedInputs` retains the source, context, asset, decode `reason`, and `degradesRun: false`. Optional unreadable pool detail remains component-only unavailability. Only unscopable cohort-invalidating core inputs add `malformed-persisted-inputs` to global `degradedSources`.

---

## Data Pipeline

DEWS publishes complete admitted generations, not whichever rows finished most recently. An interrupted or dependency-held run leaves the prior accepted generation readable at its original age; a healthy run advances publication and freshness together. Per-asset malformed inputs are quarantined before scoring/contagion while healthy peers can publish. Historical evidence and previously accepted buffers are retained, and stale latest rows cannot reintroduce a quarantined asset into a newly accepted generation.

Foundational stablecoin inputs must pass canonical timestamp checks and the producer interval-plus-runtime freshness budget (inclusive). Stale/invalid foundational inputs stop before persistence. Stale DEX-liquidity or mint/burn inputs also withhold publication. Stale yield-ranking evidence is flagged but retained, rather than silently zeroing its stress contribution.

PSI amplification requires a valid sample within two PSI producer intervals (inclusive). Missing, stale, future-dated or invalid retained samples leave that optional backdrop unavailable without holding publication; otherwise DEWS and PSI could deadlock after a missed slot. A failed PSI read is a source failure and does hold publication. Previous-reading smoothing uses only accepted-generation evidence within its maximum age.

Storage, retention, exact publication proofs and machine-readable run diagnostics are owned by the [data-flow reference](https://github.com/TokenBrice/pharos-watch/blob/main/docs/data-flow-map.md#dews-internal-publication-contract). The separate DEWS/PSI invocation prevents a DEX source-stage overrun from blocking its scheduled slot.

---

## API Endpoint

### `GET /api/stress-signals`

**All coins (no params):** Returns current accepted-generation DEWS for active tracked stablecoins, with `signals`, newest `updatedAt`, oldest `oldestComputedAt`, malformed-row diagnostics and the shared methodology envelope. `eligibleCount` is the active-registry size; other lifecycle states are excluded. Aggregate freshness headers use `updatedAt`; the oldest row is disclosed separately, not used to stale the entire surface.

**Single coin:** `?stablecoin=usdt-tether&days=30` returns `current` plus daily `history` (default 30 days, range 1–365). Unknown IDs return `404 Unknown stablecoin`; pre-launch IDs return `404 Stablecoin not tracked`. Quarantined, delisted and frozen tracked IDs retain single-coin history access.

Readers validate the accepted pointer's timestamp, row count and ID digest, using its exact buffered generation if latest materialization is incomplete, never a partially newer write. Telegram and smoothing share that loader. A null scoring result writes no row: if peers publish without that asset, aggregate `missingCount` increases and single-coin `current` is null. Held/zero-result runs preserve the prior accepted generation and its original age. PSI requires complete exact-generation coverage.

Historical missing/unavailable sub-signals are gaps (`null`) without numeric tooltips, not zero stress. Current missing signals retain their machine reason; “not applicable” requires an explicit applicability reason; observed zero remains measured `0/100`. The [public OpenAPI contract](https://pharos.watch/openapi.json#/paths/~1api~1stress-signals/get) owns response shapes and authentication.

**Cache:** standard (s-maxage=300, max-age=60)

Calibration and repair are operator-only tools, not public scoring inputs. Their command, authorization and historical-reconstruction limits are documented in the [operator API reference](https://github.com/TokenBrice/pharos-watch/blob/main/docs/api-reference-admin.md#get-apibackfill-dews).

---

## Frontend Integration

DEWS is visible in the [depeg outlook](https://pharos.watch/depeg/) and stablecoin detail pages. Missing current data is unavailable, not CALM; missing historical sub-signals remain chart gaps with no numeric tooltip. An explicit zero stays measured zero. Literal threat labels and styles are owned by `shared/lib/classification.ts`.

### Radar Layout (`DEWSRadarPanel`)

The radar is center-is-danger: higher threat bands occupy inner rings and CALM coins form the peripheral ambient field. Band determines radial position; size provides supply context, not probability. Unavailable supply is disclosed rather than rendered as measured-small supply. A double halo identifies elevated coins also in a confirmed live depeg; zero confirmed events does not mean zero precursor stress.

The severity-ordered legend reports live counts, while keyboard inspection and detail breakdowns provide alternatives to the visual plot. Geometry is presentation only, not another score input. The [depeg outlook](https://pharos.watch/depeg/) is the public inspection surface; `src/lib/dews-radar-utils.ts` owns layout constants.

---

## Alerting

DEWS supports outbound Telegram subscriber alerts as well as the API and public outlook/detail surfaces. Subscriber filtering and deduplication belong to the Telegram alert subsystem; alert transport never changes the underlying DEWS methodology.
