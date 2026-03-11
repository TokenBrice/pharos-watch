# Methodology Page Contract

`/methodology` (`src/app/methodology/page.tsx`) is the canonical long-form explainer page for Pharos scoring systems. This file maps each section to its code source-of-truth so methodology UI content stays aligned with implementations.

---

## Route & Structure

- **Route:** `src/app/methodology/page.tsx`
- **Navigation model:** `METHODOLOGY_SECTIONS` + `LongformScrollspyNav`
- **Version badges:** imported from per-system version modules in `shared/lib/*-version.ts`
- **Changelog wrappers:** config-driven route wrappers via `src/app/methodology/changelog-route-factory.tsx`

---

## Section → Source Mapping

| Methodology Section | Primary Runtime Source(s) |
|---|---|
| Stability Index | `worker/src/lib/stability-index.ts`, `shared/lib/stability-index-version.ts` |
| Safety Scores | `shared/lib/report-cards.ts`, `shared/lib/safety-score-version.ts` |
| Liquidity Score | `worker/src/cron/dex-liquidity/pool-helpers.ts`, `shared/lib/liquidity-score-version.ts` |
| Mint/Burn Flow | `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`, `shared/lib/mint-burn-flow-version.ts` |
| Yield Intelligence | `worker/src/cron/yield-helpers.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/{cache,resolve,rankings,sources}.ts`, `worker/src/lib/constants.ts` (PYS constants), `shared/lib/yield-methodology-version.ts` |
| PegScore + DEWS | `shared/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `shared/lib/depeg-dews-version.ts` |
| Contagion Stress Test | `shared/lib/report-cards.ts` (`computeStressedGrades`) |
| Blacklist Tracker | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, `shared/lib/blacklist-tracker-version.ts` |

---

## Update Rules

When changing any scoring methodology, update all three surfaces in the same change:

1. Runtime implementation (source file above).
2. Detailed methodology doc (`docs/*.md` for that system).
3. `/methodology` page copy and worked examples (`src/app/methodology/page.tsx`).

If a versioned methodology changes, bump the corresponding version module in `shared/lib/*-version.ts` so badges/changelog links stay consistent.

---

## Verification Shortcuts

- **Safety score base weights / peg multiplier:** `shared/lib/report-cards.ts`
- **PSI caps, formula, and bands:** `worker/src/lib/stability-index.ts`
- **Liquidity component weights:** `worker/src/cron/dex-liquidity/pool-helpers.ts`
- **Pressure Shift / gauge bands / flight-to-quality:** `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`
- **DEWS weights / signal thresholds / bands:** `worker/src/lib/dews.ts`
- **Peg score blend / penalties / min history:** `shared/lib/peg-score.ts`

## Changelog

- **v3.3** (2026-03-09): Separated discovery pipeline with staged pool confidence decay. Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merge into scoring with freshness confidence decay (`max(0.5, 1 - ageHours/48)`) and explicit defaults contract. Chain-aware source routing reduces wasted API calls. Tiered priority with exponential backoff prevents looping on pool-less coins.
