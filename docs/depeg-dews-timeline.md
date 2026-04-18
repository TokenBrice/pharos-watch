# Depeg Tracker + DEWS Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers `v1.0` through `v5.94` (2026-02-18 -> 2026-04-18).

---
## v5.94 — Pool-confirmation hardening, backfill atomicity, confirmation-provenance surfacing (Apr 18, 2026)

**Commit:** `unreleased`

- Pool-only pending promotion now requires 2 pools or a single pool with `>= $5M` TVL; single-pool manipulation can no longer unilaterally promote a pending depeg
- Historical backfill delete+insert share a single D1 batch, so a worker interruption during backfill no longer leaves a coin with zero depeg rows
- Off-chain (CoinGecko/DefiLlama) confirmation fetches are now circuit-breaker-guarded, so a provider outage no longer hammers the endpoint for 45 min per pending row
- Promoted depeg events now persist `confirmation_sources` (e.g. `"DEX+CEX"`) and `pending_reason` (e.g. `"large-cap+low-confidence"`) for ex-post diagnostics
- DEWS liquidity sub-signal fails closed when both 7-day anchors (score erosion and TVL erosion) are missing instead of silently contributing `0`

---
## v5.93 — Blacklist signal coverage follows direct EVM wave (Apr 15, 2026)

**Commit:** `unreleased`

- DEWS blacklist-activity input now follows the direct EVM blacklist tracker expansion
- FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, and BUIDL receive blacklist-event count signals when otherwise DEWS-eligible
- Non-USD amount valuation remains owned by the blacklist tracker ledger; DEWS uses event counts only

---
## v5.92 — Blacklist signal coverage follows first-wave tracker expansion (Apr 15, 2026)

**Commit:** `unreleased`

- DEWS blacklist-activity input now follows the expanded live blacklist tracker symbol set
- USDG, RLUSD, U, USDTB, and A7A5 receive blacklist-event count signals when they are otherwise DEWS-eligible
- A7A5's DEWS contribution is event-count stress only; non-USD amount valuation remains part of the blacklist tracker ledger

---
## v5.91 — Conservative DEWS freshness and zero-supply current-row retirement (Apr 11, 2026)

**Commit:** `unreleased`

- Aggregate `/api/stress-signals` responses now keep `updatedAt` as the newest returned row while exposing `oldestComputedAt`
- Aggregate freshness headers now use the oldest returned current row, so a stale per-coin row cannot be hidden by newer rows for other coins
- The DEWS cron now retires current `stress_signals` rows for PSI-eligible assets that are explicitly present in the stablecoins cache with zero current circulating supply
- Daily `stress_signal_history` remains intact for those assets, and last-valid rows still remain available for positive-supply coins that only miss enough signal coverage in a single cycle

---
## v5.9 — Direction-true confirmation, pending refreshes, and DEWS live-trust alignment (Apr 8, 2026)

**Commit:** `unreleased`

- Pending depeg rows now refresh live first/last/peak state while they wait for confirmation instead of behaving like write-once snapshots
- Pending promotion now requires same-direction corroboration; opposite-side native/off-chain/CEX/DEX/pool evidence rejects the candidate instead of confirming it
- Native-quote recovery no longer persists contradictory `recovery_price` values, and the audit repair path can null legacy rows that still carry a terminal depegged price
- DEWS divergence now reuses the same `$1M` live depeg DEX trust floor instead of the lighter UI gate
- Because historical DEWS daily snapshots do not retain that DEX trust metadata, the repair path refreshes current rows and prunes unrecomputable history from the Mar 9, 2026 trust-floor boundary onward

---
## v5.8 — Daily-confirmed native-peg historical replay (Apr 7, 2026)

**Commit:** `unreleased`

- Supported non-USD fiat historical replay now treats native-fiat CoinGecko history as a day-scale confirmation lane instead of trusting thin hourly native prints on their own
- Historical native-fiat replay now uses daily points plus a two-point confirmation window across 36 hours before opening normal non-USD fiat backfill events
- Extreme single-point native crashes of 5,000 bps or more are still preserved, and the admin/backfill path now carries the configured CoinGecko API key through historical market-chart replay during large repairs

---
## v5.7 — Launch-date peg-score anchors for older tracked assets (Apr 7, 2026)

**Commit:** `unreleased`

- PegScore tracking windows now prefer a curated launch date when the asset metadata provides one, falling back to the earliest `supply_history` snapshot only when no launch date is curated
- This prevents older tracked assets with late `supply_history` coverage from appearing artificially young in the peg-score window
- BRZ now uses its July 19, 2019 launch date as the peg-score age anchor instead of a much later coverage-start artifact

---
## v5.6 — Generalized native-peg routing and replay for non-USD fiat assets (Apr 7, 2026)

**Commit:** `unreleased`

- Fresh direct native-peg quotes can now veto, sustain, or resolve live depeg state across the supported non-USD fiat set instead of remaining effectively BRL-only
- Pending depeg confirmation now prefers that same direct native quote first whenever CoinGecko exposes the matching fiat pair
- Historical backfill now replays supported non-USD fiat assets against direct native fiat history and a native `1.0` peg when available, removing large classes of synthetic backfill rows caused only by USD/FX mismatch

## v5.5 — Direct native-peg corroboration for BRL depeg routing (Apr 7, 2026)

**Commit:** `unreleased`

- Fresh direct native-peg quotes can now veto or resolve BRZ-style live depeg mutations when the USD/FX-derived signal disagrees
- Pending depeg confirmation now prefers the fresh direct native quote over a weaker derived USD cross-check when that native pair exists
- This blocks FX-reference mismatches from opening or sustaining false BRL depeg rows while preserving genuine native-peg stress

## v5.4 — Thin-fiat peg-reference fail-closed and corroborated primary recovery (Apr 7, 2026)

**Commit:** `unreleased`

- Thin non-USD fiat peg groups with fewer than 3 contributors now fail closed for live depeg mutations unless cached FX fallback is available
- Fresh non-cached multi-source primary agreement can now retire an already-open live row once the coin is back inside threshold
- Prevents BRL-style peer-median reference glitches from both opening false live rows and leaving them stuck open after FX fallback normalizes

## v5.3 — DEWS flow baseline continuity on quiet 24-hour windows (Apr 6, 2026)

**Commit:** `unreleased`

- DEWS no longer drops the mint/burn flow signal just because the latest 24-hour window has zero activity
- Coins with >= 7 days of mint/burn history now keep the flow signal available as long as the 30-day baseline exists
- A quiet day now contributes zero flow stress instead of redistributing the flow weight away from the final score

## v5.2 — Corroborated DEX recovery gating for live depeg state (Apr 3, 2026)

**Commit:** `unreleased`

- Aggregate DEX bridge rows no longer count as sufficient evidence on their own for ambiguous-primary recoveries or recovery-style event suppression
- DEX-assisted recovery now requires at least 2 corroborating protocol-level DEX groups inside threshold
- Large challenger pools can veto ambiguous-primary DEX recoveries when they still show the old depeg direction
- Prevents synthetic live-event splits on chronic depegs where one high-TVL DEX protocol median snaps back toward peg while the broader DEX surface remains broken
- The detail/API surface now explicitly marks coins below the `$1M` live-event floor so empty depeg history no longer implies that a low-cap off-peg coin necessarily maintained peg

## v5.1 — Ongoing depeg continuity over DEX-only contradiction (Mar 31, 2026)

**Commit:** `unreleased`

- Same-direction DEX disagreement no longer auto-closes an already-open depeg event
- Open events now stay continuous until the normal recovery path confirms resolution below threshold
- Prevents repeated event splitting when aggregate DEX pricing temporarily snaps back toward peg while the stablecoin remains clearly depegged elsewhere

## v5.0 — DEWS blacklist coverage parity and thin-peg FX fallback parity (Mar 28, 2026)

**Commit:** `unreleased`

- DEWS blacklist coverage now derives from the shared supported blacklist symbol set instead of a stale hardcoded subset
- `PYUSD` and `USD1` now receive the same DEWS blacklist-activity signal treatment as `USDC`, `USDT`, `PAXG`, and `XAUT`
- Thin non-USD DEWS divergence inputs now use cached `fxFallbackRates`, matching the live depeg and peg-summary peg-reference path

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
