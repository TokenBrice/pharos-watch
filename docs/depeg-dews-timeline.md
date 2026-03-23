# Depeg Tracker + DEWS Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers `v1.0` through `v4.9` (2026-02-18 -> 2026-03-23).

---

## v4.9 — Bootstrap sentinel and core-liquidity freshness gating (Mar 23, 2026)

**Commit:** `unreleased`

- DEWS bootstrap grace is now a one-time state transition, persisted via a dedicated `dews:bootstrap-complete` sentinel after the first successful publication
- Only explicitly optional missing tables are bootstrap-allowed before that first success; core dependencies no longer inherit stablecoins-cache freshness as a proxy for readiness
- `dex_liquidity` freshness is now enforced as a hard publication prerequisite, with rows older than 2 hours degrading the run and blocking writes

---

## v4.8 — Contradicted live depegs now retire into pending confirmation (Mar 22, 2026)

**Commit:** `unreleased`

- Opposite-direction live depeg rows no longer remain active just because the correcting primary price is still `confirm_required`
- When a low-confidence/cached/stale/fallback primary price flips across the peg, detection closes the stale live row immediately
- The replacement move still respects the two-stage guardrail by routing into `depeg_pending` until confirmation arrives

---

## v4.7 — Early peg score: minimum data threshold lowered from 30 to 7 days (Mar 21, 2026)

**Commit:** `unreleased`

- Peg score minimum tracking threshold reduced from 30 days to 7 days — coins now receive a composite score after their first week of history
- Scores based on 7–30 days of data are labelled "Early score" in the detail-page hero card (amber text, tooltip explaining limited history)
- Report card peg-stability dimension is now rated from day 7 (previously NR until day 30)
- NR ("Not Rated") display now only appears for coins with fewer than 7 days of tracking
- `limited` flag in `computePegStability` threshold lowered to match (< 7 days)

---

## v4.6 — Confidence-aware routing, extreme-move confirmation, and provenance surfacing (Mar 10, 2026)

**Commit:** `unreleased`

- Cached, fallback, low-confidence, and stale primary prices now require confirmation before they can directly mutate live depeg state
- Extreme moves no longer get dropped simply for crossing the old `<0.5x` / `>2x` peg guardrail; they enter a dedicated confirmation lane instead
- `/api/peg-summary` and `/depeg` now surface primary price provenance/trust plus backend freshness metadata, and `/depeg` can page beyond the first 100 events

---

## v4.5 — Trusted DEX-price gating for depeg suppression, confirmation, and UI checks (Mar 9, 2026)

**Commit:** `unreleased`

- Depeg suppression and pending-confirmation promotion now require fresh DEX rows backed by at least `$1M` of aggregate source TVL
- Public DEX price-check UI exposure now requires fresh data backed by at least `$250K` of aggregate source TVL
- Thin DEX rows can no longer veto new depeg events or confirm pending large-cap depegs on their own

---

## v4.4 — No-history coins now return null peg score (Mar 2, 2026)

**Commit:** `71cc096`

- `coinTrackingStart()` now returns `null` when both first-seen data and depeg events are absent
- Prevents synthetic "perfect peg" scores for insufficient-history coins

---

## v4.3 — Young-coin fairness + stronger active penalties (Mar 1, 2026)

**Commit:** `fd83a46`

- Tracking start formalized as `max(firstSeen, fourYearsAgo)` with earliest-event fallback
- Event severity now uses `max(durationPenalty, magnitudeFloor)`
- Active-depeg penalty steepened to `max(5, absBps / 50)`, capped at 50

---

## v4.2 — DEWS wave-2: yield + PSI context (Mar 1, 2026)

**Commit:** `dcdefde`

- Added 8th DEWS sub-signal: yield anomaly (`weight = 0.05`)
- Added PSI-based amplifier (up to +30% when PSI < 75)
- Cron now reads `yield_data.warning_signals` and latest PSI sample before scoring

---

## v4.1 — DEWS pool stress calibration fix (Mar 1, 2026)

**Commit:** `2d8f867`

- Fixed pool signal scaling: `avg_pool_stress` is already `0-100` (removed erroneous `* 100`)

---

## v4.0 — DEWS launch (Mar 1, 2026)

**Commits:** `a87876c`, `9bfe791`

- Initial DEWS model launched with 7 sub-signals
- Threat bands introduced: CALM / WATCH / ALERT / WARNING / DANGER
- 15-minute cron persistence to `stress_signals` + daily snapshots to `stress_signal_history`

---

## v3.2 — Tracking-window direction fix (Feb 27, 2026)

**Commit:** `74aa1cd`

- Fixed lookback boundary from `min(firstSeen, fourYearsAgo)` to `max(...)`
- Removed young-coin dilution across pre-launch periods

---

## v3.1 — Confirmation hardening (Feb 26, 2026)

**Commits:** `c2832ae`, `61e8f9b`, `c868ba2`, `76aa8c6`

- Added guards for invalid/non-finite peg references
- Pending confirmation mutations now execute atomically in batch
- Hardened error handling around DEX table loads

---

## v3.0 — Two-stage confirmation for large-cap depegs (Feb 25, 2026)

**Commits:** `ece06dd`, `c1adfa7`, `5fac720`, `9854efe`, `8c5a9b9`

- Added `depeg_pending` table and confirmation constants
- `>= $1B` coins now require secondary-source confirmation (CoinGecko or DEX) before promotion
- `sync-stablecoins` now runs detection + confirmation each cycle

---

## v2.1 — Four-year lookback window (Feb 20, 2026)

**Commit:** `29c1bdc`

- Added explicit 4-year peg-score lookback for detail-path scoring

---

## v2.0 — Peg-score severity rebalance + spread penalty (Feb 20, 2026)

**Commit:** `d2954c3`

- Severity moved from `sqrt` scaling to linear `peakBps/100` scaling
- Added spread penalty from event-magnitude standard deviation (cap 15)
- Composite became:

```text
score = 0.5*pegPct + 0.5*severity - activePenalty - spreadPenalty
```

---

## v1.2 — Non-USD thresholds + ongoing false-positive controls (Feb 20, 2026)

**Commits:** `9c0d1a6`, `7bc5361`, `8b01716`

- Non-USD depeg threshold raised to `150 bps` (`USD` remains `100 bps`)
- Cleanup migration removed old non-USD events below 150 bps
- Ongoing events now auto-close after sustained DEX disagreement (30m+, >=$1M TVL)

---

## v1.1 — Early hardening + active penalty floor (Feb 18, 2026)

**Commits:** `cb67892`, `c6c1391`, `4c818f5`, `8b0fe61`

- Added active-depeg penalty, then added a minimum floor
- Merged overlapping intervals to avoid double-counting depeg time
- Closed orphan open events deterministically during detection runs

---

## v1.0 — Initial depeg scoring + live detection (Feb 18, 2026)

**Commits:** `f1ea0d8`, `2556ae4`

- Initial peg score computation shipped
- Live depeg detection pipeline shipped
- Duplicate open-event merge and new-event DEX suppression introduced

---

## Notes

- Versions above are reconstructed retroactively from methodology-impacting commit boundaries.
- Canonical machine-readable source: `shared/lib/depeg-dews-version.ts`.
