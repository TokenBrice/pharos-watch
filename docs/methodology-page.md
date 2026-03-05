# Methodology Page Contract

`/methodology` (`src/app/methodology/page.tsx`) is the canonical long-form explainer page for Pharos scoring systems. This file maps each section to its code source-of-truth so methodology UI content stays aligned with implementations.

---

## Route & Structure

- **Route:** `src/app/methodology/page.tsx`
- **Navigation model:** `METHODOLOGY_SECTIONS` + `LongformScrollspyNav`
- **Version badges:** imported from per-system version modules in `src/lib/*-version.ts`

---

## Section → Source Mapping

| Methodology Section | Primary Runtime Source(s) |
|---|---|
| Stability Index | `worker/src/lib/stability-index.ts`, `src/lib/stability-index-version.ts` |
| Safety Scores | `src/lib/report-cards.ts`, `src/lib/safety-score-version.ts` |
| Liquidity Score | `worker/src/cron/dex-liquidity/pool-helpers.ts`, `src/lib/liquidity-score-version.ts` |
| Mint/Burn Flow | `worker/src/lib/mint-burn-scoring.ts`, `src/lib/mint-burn-flow-version.ts` |
| Yield Intelligence | `worker/src/cron/yield-helpers.ts`, `worker/src/lib/constants.ts` (PYS constants), `src/lib/yield-methodology-version.ts` |
| PegScore + DEWS | `src/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `src/lib/depeg-dews-version.ts` |
| Contagion Stress Test | `src/lib/report-cards.ts` (`computeStressedGrades`) |
| Blacklist Tracker | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, `src/lib/blacklist-tracker-version.ts` |

---

## Update Rules

When changing any scoring methodology, update all three surfaces in the same change:

1. Runtime implementation (source file above).
2. Detailed methodology doc (`docs/*.md` for that system).
3. `/methodology` page copy and worked examples (`src/app/methodology/page.tsx`).

If a versioned methodology changes, bump the corresponding version module in `src/lib/*-version.ts` so badges/changelog links stay consistent.

---

## Verification Shortcuts

- **Safety score base weights / peg multiplier:** `src/lib/report-cards.ts`
- **PSI caps, formula, and bands:** `worker/src/lib/stability-index.ts`
- **Liquidity component weights:** `worker/src/cron/dex-liquidity/pool-helpers.ts`
- **FIS / gauge bands / flight-to-quality:** `worker/src/lib/mint-burn-scoring.ts`
- **DEWS weights / signal thresholds / bands:** `worker/src/lib/dews.ts`
- **Peg score blend / penalties / min history:** `src/lib/peg-score.ts`
