# Methodology Page Contract

`/methodology` (`src/app/methodology/page.tsx`) is the canonical long-form explainer page for Pharos scoring systems. Shared page chrome, helper components, and section metadata now live in `src/app/methodology/methodology-shared.tsx`, while the long-form section bodies are isolated in `src/app/methodology/methodology-sections.tsx` so authored content no longer sits inside the route shell.

---

## Route & Structure

- **Route shell:** `src/app/methodology/page.tsx`
- **Shared helpers + section metadata:** `src/app/methodology/methodology-shared.tsx`
- **Section content module:** `src/app/methodology/methodology-sections.tsx`
- **Navigation model:** `METHODOLOGY_SECTIONS` + `LongformScrollspyNav`
- **Mode switching:** `MethodologyModeToggle`; mobile renders the toggle inside the hero guide card, `md+` renders it in the jump rail
- **Orientation content:** mobile compresses the reading guide into the hero card; `md+` keeps the dedicated "How to Read This Page" overview card
- **Reusable long-form primitives:** `MethodologyDetails`, `MethodologyFacts`, `WorkedExample`, and `MethodologySectionShell`
- **Version badges:** imported from per-system version modules in `shared/lib/*-version.ts`
- **Changelog wrappers:** config-driven route wrappers via `src/app/methodology/changelog-route-factory.tsx`

---

## Section → Source Mapping

| Methodology Section   | Primary Runtime Source(s)                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stability Index       | `worker/src/lib/stability-index.ts`, `shared/lib/stability-index-version.ts`                                                                                                                                                         |
| Safety Scores         | `shared/lib/report-cards.ts`, `shared/lib/safety-score-version.ts`                                                                                                                                                                   |
| Liquidity Score       | `worker/src/cron/dex-liquidity/pool-helpers.ts`, `shared/lib/liquidity-score-version.ts`                                                                                                                                             |
| Mint/Burn Flow        | `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`, `shared/lib/mint-burn-flow-version.ts`                                                                                                                     |
| Yield Intelligence    | `worker/src/cron/yield-helpers.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/{cache,resolve,rankings,sources}.ts`, `worker/src/lib/constants.ts` (PYS constants), `shared/lib/yield-methodology-version.ts` |
| PegScore + DEWS       | `shared/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `shared/lib/depeg-dews-version.ts`                                                                                                                                              |
| Contagion Stress Test | `shared/lib/report-cards.ts` (`computeStressedGrades`)                                                                                                                                                                               |
| Blacklist Tracker     | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, `shared/lib/blacklist-tracker-version.ts`                                                                                                              |

---

## Update Rules

When changing any scoring methodology, update all three surfaces in the same change:

1. Runtime implementation (source file above).
2. Detailed methodology doc (`docs/*.md` for that system).
3. `/methodology` page copy and worked examples (`src/app/methodology/methodology-sections.tsx`; update `page.tsx` only when shell/layout wiring changes).

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

- **v3.4** (2026-03-12): Corrected the update contract so methodology-copy edits point to `methodology-sections.tsx`, which is where the authored long-form content and worked examples now live.
- **v3.3** (2026-03-09): Separated discovery pipeline with staged pool confidence decay. Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merge into scoring with freshness confidence decay (`max(0.5, 1 - ageHours/48)`) and explicit defaults contract. Chain-aware source routing reduces wasted API calls. Tiered priority with exponential backoff prevents looping on pool-less coins.
