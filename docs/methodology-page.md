# Methodology Page Contract

`/methodology` (`src/app/methodology/page.tsx`) is the canonical long-form explainer page for Pharos scoring systems. The route shell still owns metadata, breadcrumb/FAQ structured data, and the reader-guide hero chrome, while the long-form section bodies live in `src/app/methodology/methodology-sections.tsx`.

---

## Route & Structure

- **Route shell:** `src/app/methodology/page.tsx` (metadata, breadcrumb JSON-LD, FAQ JSON-LD, hero/reader-guide shell)
- **Shared helpers + section metadata:** `src/app/methodology/methodology-shared.tsx`
- **Section content module:** `src/app/methodology/methodology-sections.tsx`
- **Navigation model:** `METHODOLOGY_SECTIONS` + `LongformScrollspyNav`
- **Mode switching:** `MethodologyModeToggle`; mobile renders the toggle inside the hero guide card, `md+` renders it in the jump rail
- **Mode persistence contract:** `MethodologyModeToggle` stores `pharos.methodology.mode` in `localStorage` and opens/closes authored `details` blocks via the `data-methodology-details` / `data-methodology-worked-example` attributes emitted by `MethodologyDetails` and `WorkedExample`
- **Orientation content:** mobile compresses the reading guide into the hero card; `md+` keeps both the top-right reader-guide hero card and the dedicated "How to Read This Page" overview card
- **Reusable long-form primitives:** `MethodologyDetails`, `MethodologyFacts`, `WorkedExample`, and `MethodologySectionShell`
- **Version metadata:** per-system version modules in `shared/lib/*-version.ts`, mostly built on top of `shared/lib/methodology-version.ts`
- **Public changelog routes:** pricing pipeline, stability index, scoring, liquidity score, mint/burn flow, yield, depeg, and blacklist tracker all live under `src/app/methodology/*-changelog/page.tsx`
- **Changelog wrappers:** most changelog routes use `src/app/methodology/changelog-route-factory.tsx`; the shared shell is `src/components/methodology-changelog-page.tsx`
- **Scoring changelog special case:** `src/app/methodology/scoring-changelog/page.tsx` uses the shared route factory for metadata + shell wiring while still authoring its nav entries and version cards locally
- **Cross-app methodology links:** `src/lib/methodology-context.ts` and `src/components/methodology-hint.tsx` hard-code the anchors and changelog paths used by cards/tooltips across the app

---

## Section → Source Mapping

| Methodology Section   | Primary Runtime Source(s)                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pricing Pipeline      | `worker/src/lib/price-consensus.ts`, `worker/src/cron/enrich-prices.ts`, `worker/src/lib/authoritative-price-sources.ts`, `worker/src/lib/price-validation.ts`, `shared/lib/pricing-pipeline-version.ts`                              |
| Stability Index       | `worker/src/lib/stability-index.ts`, `shared/lib/stability-index-version.ts`                                                                                                                                                         |
| Safety Scores         | `shared/lib/report-cards.ts`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/safety-score-version.ts`, `worker/src/cron/sync-redemption-backstops.ts`                                                                     |
| Liquidity Score       | `worker/src/cron/dex-liquidity/pool-helpers.ts`, `shared/lib/liquidity-score-version.ts`                                                                                                                                             |
| Mint/Burn Flow        | `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`, `shared/lib/mint-burn-flow-version.ts`                                                                                                                     |
| Yield Intelligence    | `worker/src/cron/yield-helpers.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/{cache,resolve,rankings,sources}.ts`, `worker/src/lib/constants.ts` (PYS constants), `shared/lib/yield-methodology-version.ts` |
| PegScore + DEWS       | `shared/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `shared/lib/depeg-dews-version.ts`                                                                                                                                              |
| Contagion Stress Test | `shared/lib/report-cards.ts` (`computeStressedGrades`)                                                                                                                                                                               |
| Blacklist Tracker     | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, `shared/lib/blacklist-tracker-version.ts`                                                                                                              |

---

## Update Rules

When changing any methodology surface, update the runtime implementation, the detailed `/docs` explainer, and the authored `/methodology` section copy in the same change:

1. Runtime implementation (source file above).
2. Detailed methodology doc (`docs/*.md` for that system).
3. `/methodology` page copy and worked examples in `src/app/methodology/methodology-sections.tsx`.

If a versioned methodology changes, bump the corresponding version module in `shared/lib/*-version.ts` so badges/changelog links stay consistent.

Also update `src/app/methodology/page.tsx` whenever its FAQ structured-data answers, metadata copy, or reader-guide copy changes. Those claims are runtime-facing even when the shell layout itself is unchanged.

If section IDs or changelog paths change, also update `src/lib/methodology-context.ts` so in-app "View methodology" and "Version history" links keep resolving to the correct anchor/route.

If you add a new methodology changelog route, follow the existing pattern:

1. Add or update the version source in `shared/lib/*-version.ts`.
2. Add the public route in `src/app/methodology/*-changelog/page.tsx` using `createMethodologyChangelogRoute(...)`.
3. Wire the new anchor/path into `src/lib/methodology-context.ts` if any cards/tooltips deep-link to it.

If the pricing pipeline's source roster or live-price selection semantics change, also update:

1. `docs/pricing-pipeline.md`
2. `docs/data-pipeline.md`
3. `docs/about-page.md` plus `src/app/about/page.tsx`

For the safety-score changelog specifically, update both:

1. `shared/lib/safety-score-version.ts` for shared route metadata / navigation versions.
2. `src/app/methodology/scoring-changelog/page.tsx` for the authored long-form version cards and reference tables.

---

## Verification Shortcuts

- **Pricing pipeline source weights / consensus threshold:** `worker/src/cron/enrich-prices.ts`, `worker/src/lib/price-consensus.ts`
- **Safety score base weights / peg multiplier:** `shared/lib/report-cards.ts`
- **PSI caps, formula, and bands:** `worker/src/lib/stability-index.ts`
- **Liquidity component weights:** `worker/src/cron/dex-liquidity/pool-helpers.ts`
- **Pressure Shift / gauge bands / flight-to-quality:** `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`
- **DEWS weights / signal thresholds / bands:** `worker/src/lib/dews.ts`
- **Peg score blend / penalties / min history:** `shared/lib/peg-score.ts`

## Changelog

- **v3.6** (2026-03-14): Documented the remaining route-shell contract in `page.tsx` (FAQ/metadata/reader-guide copy), the persisted Reader/Analyst mode toggle behavior, the shared changelog factory, and the cross-app anchor/path dependency in `src/lib/methodology-context.ts`.
- **v3.5** (2026-03-14): Added Pricing Pipeline section (first position) with 8-source consensus diagram, source weights table, enrichment pipeline, confidence levels, and validation modes. Created `shared/lib/pricing-pipeline-version.ts` and `src/app/methodology/pricing-pipeline-changelog/page.tsx`.
- **v3.4** (2026-03-12): Corrected the update contract so methodology-copy edits point to `methodology-sections.tsx`, which is where the authored long-form content and worked examples now live.
- **v3.3** (2026-03-09): Separated discovery pipeline with staged pool confidence decay. Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on a dedicated 30-minute cron with a 20-minute crawl budget. Staged pools merge into scoring with freshness confidence decay (`max(0.5, 1 - ageHours/48)`) and explicit defaults contract. Chain-aware source routing reduces wasted API calls. Tiered priority with exponential backoff prevents looping on pool-less coins.
