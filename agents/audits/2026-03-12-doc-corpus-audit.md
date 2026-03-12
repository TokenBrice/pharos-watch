# Documentation Corpus Audit — 2026-03-12

Scope: `/docs/*` verified against the live repository state on March 12, 2026, plus cross-consistency checks against `README.md`, `AGENTS.md`, and `CLAUDE.md`.

Counting note: `Claims checked` below means audited claim groups or contract clusters, not raw sentence count. Examples: endpoint inventories, route trees, schema blocks, cron schedules, formula definitions, or operational guarantees.

## 1. Per-Document Verification Report

| Document | Claims Checked | Verified | Issues Found | Issues Fixed | Status |
|----------|----------------|----------|--------------|--------------|--------|
| `about-page.md` | 8 | 8 | 0 | 0 | Verified |
| `api-reference.md` | 45 | 45 | 0 | 0 | Verified |
| `architecture.md` | 20 | 20 | 0 | 0 | Verified |
| `blacklist-tracker-timeline.md` | 7 | 7 | 0 | 0 | Verified |
| `blacklist-tracker.md` | 14 | 14 | 0 | 0 | Verified |
| `bluechip-ratings.md` | 7 | 7 | 0 | 0 | Verified |
| `cemetery-and-compare.md` | 9 | 9 | 0 | 0 | Verified |
| `classification.md` | 8 | 8 | 0 | 0 | Verified |
| `data-flow-map.md` | 9 | 9 | 0 | 0 | Verified |
| `data-pipeline.md` | 20 | 20 | 0 | 0 | Verified |
| `depeg-detection.md` | 16 | 16 | 0 | 0 | Verified |
| `depeg-dews-timeline.md` | 10 | 10 | 0 | 0 | Verified |
| `dependency-map.md` | 10 | 10 | 0 | 0 | Verified |
| `deployment-process.md` | 8 | 8 | 0 | 0 | Verified |
| `design-context.md` | 6 | 6 | 0 | 0 | Verified |
| `design-language.md` | 12 | 12 | 0 | 0 | Verified |
| `design-tokens.md` | 12 | 12 | 0 | 0 | Verified |
| `dews.md` | 14 | 14 | 0 | 0 | Verified |
| `dex-liquidity.md` | 18 | 18 | 0 | 0 | Verified |
| `digest-pipeline.md` | 13 | 13 | 0 | 0 | Verified |
| `docs/README.md` | 6 | 6 | 0 | 0 | Verified |
| `feedback-pipeline.md` | 10 | 10 | 0 | 0 | Verified |
| `liquidity-score-timeline.md` | 9 | 9 | 0 | 0 | Verified |
| `methodology-page.md` | 8 | 8 | 0 | 0 | Verified |
| `mint-burn-flows-timeline.md` | 11 | 11 | 0 | 0 | Verified |
| `mint-burn-flows.md` | 20 | 20 | 0 | 0 | Verified |
| `report-cards-timeline.md` | 12 | 12 | 0 | 0 | Verified |
| `report-cards.md` | 19 | 19 | 0 | 0 | Verified |
| `scripts.md` | 10 | 10 | 0 | 0 | Verified |
| `shadow-stablecoins.md` | 8 | 8 | 0 | 0 | Verified |
| `stability-index-timeline.md` | 9 | 9 | 0 | 0 | Verified |
| `stability-index.md` | 13 | 13 | 0 | 0 | Verified |
| `status-dashboard.md` | 17 | 17 | 0 | 0 | Verified |
| `supply-snapshot.md` | 12 | 12 | 0 | 0 | Verified |
| `telegram-alerts.md` | 14 | 14 | 0 | 0 | Verified |
| `testing.md` | 15 | 15 | 0 | 0 | Verified |
| `worker-and-api-limits.md` | 12 | 12 | 0 | 0 | Verified |
| `worker-infrastructure.md` | 24 | 22 | 2 | 2 | Corrected |
| `yield-intelligence.md` | 21 | 21 | 0 | 0 | Verified |
| `documentation-map-2026-03-05.tsv` | 7 | 6 | 1 | 1 | Corrected |

### Issues Found

## worker-infrastructure.md

**Status:** 22 verified / 1 inaccurate / 1 ambiguous

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Opening summary | Ambiguous | Worker has 22 named runtime jobs, without distinguishing scheduled jobs from `/api/status`-tracked jobs | Scheduled handler runs 22 jobs because the Telegram trigger executes both `dispatch-telegram-alerts` and `announce-cemetery-additions`, but shared cron metadata and `/api/status` intentionally track 21 jobs because `announce-cemetery-additions` is excluded from `CRON_JOB_DEFINITIONS` | `worker/src/handlers/scheduled.ts:395`, `shared/lib/cron-jobs.ts:84`, `docs/worker-infrastructure.md:3` | Yes |
| 2 | `Circuit Breakers` table | Inaccurate | `CMC_PRICES` is `enrich-prices` pass 3.5 fallback; `DEXSCREENER_PRICES` is pass 4 fallback | `enrich-prices.ts` documents the live pipeline as pass 2 = CoinMarketCap, pass 3 = DexScreener | `worker/src/cron/enrich-prices.ts:192`, `docs/worker-infrastructure.md:433` | Yes |

### Changes Applied

- Clarified the opening sentence to distinguish the 22 scheduled jobs from the 21 jobs surfaced through `CRON_INTERVALS` and `/api/status`.
- Updated the circuit-breaker table to match the current enrichment pass numbering (`CMC_PRICES` = pass 2, `DEXSCREENER_PRICES` = pass 3).

## documentation-map-2026-03-05.tsv

**Status:** 6 verified / 1 incomplete

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Audit inventory rows | Incomplete | Latest listed audit artifact stops at the March 11 doc-corpus audit | This pass adds a new March 12 audit artifact under `agents/audits/` | `agents/audits/2026-03-12-doc-corpus-audit.md` | Yes |

### Changes Applied

- Added the new `agents/audits/2026-03-12-doc-corpus-audit.md` row to keep the documentation surface map aligned with the repo’s current audit inventory.

### Verified With No Issues Found

No code or contract drift was found in this pass for:

- `about-page.md`
- `api-reference.md`
- `architecture.md`
- `blacklist-tracker-timeline.md`
- `blacklist-tracker.md`
- `bluechip-ratings.md`
- `cemetery-and-compare.md`
- `classification.md`
- `data-flow-map.md`
- `data-pipeline.md`
- `depeg-detection.md`
- `depeg-dews-timeline.md`
- `dependency-map.md`
- `deployment-process.md`
- `design-context.md`
- `design-language.md`
- `design-tokens.md`
- `dews.md`
- `dex-liquidity.md`
- `digest-pipeline.md`
- `docs/README.md`
- `feedback-pipeline.md`
- `liquidity-score-timeline.md`
- `methodology-page.md`
- `mint-burn-flows-timeline.md`
- `mint-burn-flows.md`
- `report-cards-timeline.md`
- `report-cards.md`
- `scripts.md`
- `shadow-stablecoins.md`
- `stability-index-timeline.md`
- `stability-index.md`
- `status-dashboard.md`
- `supply-snapshot.md`
- `telegram-alerts.md`
- `testing.md`
- `worker-and-api-limits.md`
- `yield-intelligence.md`

## 2. Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| None significant in `/docs` after this pass | — | No new product/system doc required. The current corpus covers architecture, APIs, worker runtime, cron/data flow, major methodologies, page contracts, scripts, deployment, testing, and design references. |

### New Documents Created

- `agents/audits/2026-03-12-doc-corpus-audit.md` — current full verification artifact for this pass, stored under `agents/audits/` per repo convention for audits.

## 3. Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `AGENTS.md` | `CLAUDE.md` | One file described `docs/worker-infrastructure.md` as covering 22 jobs while the other said 21 | Standardized both to `22 scheduled jobs / 21 status-tracked jobs`, matching `worker/src/handlers/scheduled.ts` plus `shared/lib/cron-jobs.ts` |
| `docs/worker-infrastructure.md` | `/api/status` contract | Worker overview implied a single cron-job count, while `/api/status` only exposes 21 jobs | Clarified the worker doc to explain that `announce-cemetery-additions` is scheduled but intentionally excluded from status metadata |
| `docs/documentation-map-2026-03-05.tsv` | `agents/audits/` inventory | Documentation map lagged the latest audit artifact | Added the March 12 audit row |

### Terminology Standardization

- Standardized cron-job wording to `22 scheduled jobs / 21 status-tracked jobs`.
- Kept `scheduled jobs` for `worker/src/handlers/scheduled.ts` behavior and `status-tracked jobs` for `CRON_INTERVALS` / `/api/status`.

## 4. Summary Dashboard

| Document Set | Claims Checked | Verified | Issues Found | Issues Fixed |
|--------------|----------------|----------|--------------|--------------|
| `/docs/*.md` + `documentation-map-2026-03-05.tsv` | 523 | 520 | 3 | 3 |
| Cross-consistency (`README.md`, `AGENTS.md`, `CLAUDE.md`) | 3 conflict clusters | 3 | 3 | 3 |

### Outcome

- Product/system docs in `/docs` are current after this pass.
- No undocumented major subsystem warranted a new `/docs` file.
- The only live drift found was in worker cron-count wording and enrichment pass numbering, plus the audit-inventory reference artifact lag.
