# Stability Index Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers PSI `v1.0` through `v3.1` (2026-02-25 -> 2026-03-23).

---

## v3.1 — Open-depeg replay-price fallback (Mar 23, 2026)

- Active depegs can now keep contributing to PSI when the current stablecoins snapshot temporarily lacks a usable price
- Severity/breadth now fall back to the last replay-safe positive `price_cache` value for already-open depegs, capped to a 6-hour TTL
- Prevents transient omissions from the Top Contributors table and the PSI sample input set during price-validation churn

---

## v3.0 — DEWS stress breadth component (Mar 1, 2026)

**Commits:** `dcdefde`

- Added `stressBreadth` component from DEWS stress signals
- Formula changed to:

```text
Score = 100 - severity - breadth - stressBreadth + trend
```

- Stress breadth capped at 5 points

---

## v2.1 — Trend hardening + retention guard (Feb 27, 2026)

**Commits:** `76aa8c6`, `74aa1cd`

- Trend input now guards against `NaN`/`Infinity` (treated as `0` before clamp)
- Added 90-day pruning for `stability_index_samples`

---

## v2.0 — Remove freezes, rebalance caps (Feb 26, 2026)

**Commit:** `bc2cfcf`

- Removed `freezes` component
- Reallocated penalty capacity:
  - severity cap `60 -> 68`
  - breadth cap `15 -> 17`
- Formula became:

```text
Score = 100 - severity - breadth + trend
```

---

## v1.3 — Samples architecture + 24h average model (Feb 26, 2026)

**Commits:** `9508e29`, `ad75f4f`

- Introduced `stability_index_samples` (15-minute samples) + daily snapshot cron
- API/UI switched to emphasize 24h average PSI
- Backfill realism adjusted to use `peak_deviation_bps` in historical path

---

## v1.2 — 15-minute chained compute + depreciation/dedup (Feb 25, 2026)

**Commits:** `8acaa7d`, `a79049d`, `2dfb975`, `615256a`

- PSI compute moved to chained 15-minute cron after stablecoins sync
- Added chronic-depeg depreciation:
  - 30-day grace
  - linear decay over 120 days
  - 25% floor
- Deduplicated active depegs per coin (worst current bps + earliest start age)

---

## v1.1 — Live deviation semantics (Feb 25, 2026)

**Commit:** `14c75e7`

- Live severity switched from peak event deviation to **current** deviation

---

## v1.0 — Initial PSI release (Feb 25, 2026)

**Commits:** `c4c7caa`, `c21a6bd`, `5eaf440`, `6b3e7e5`, `a3f2b53`

- Initial formula:

```text
Score = 100 - severity - breadth - freezes + trend
```

- Initial caps:
  - severity: 60
  - breadth: 15
  - freezes: 10
- Condition bands, API endpoint, cron persistence, and frontend integration launched

---

## Notes

- PSI did not initially ship with explicit version tags/changelog; versions above were assigned retroactively from score-impacting commit boundaries.
- Effective boundaries for data backfills are encoded in `shared/lib/stability-index-version.ts` and migration `worker/migrations/0035_stability_index_methodology_version.sql`.
