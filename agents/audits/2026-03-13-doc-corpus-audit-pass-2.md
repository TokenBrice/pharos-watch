# Documentation Corpus Audit — 2026-03-13 (Pass 2)

Scope: full `/docs/` inventory, repo-verifiable claim checks against the live codebase, docs-link graph review, and targeted remediation. This pass treats code as the source of truth and only scores claims that can be verified from the repository state. Third-party quota/pricing claims remain externally sourced unless the repo hard-codes the behavior.

## 1. Executive Summary

- **Corpus size:** 45 files in `/docs/` (`44` Markdown docs + `1` TSV reference artifact).
- **Accuracy:** high for repo-verifiable claims. This pass found **2 verified inaccuracies**, both in [`docs/worker-infrastructure.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md), and fixed them.
- **Navigation:** local Markdown links are healthy. A full local link check found **0 broken links**. The graph is still highly README-centric, but this pass converted 12 high-traffic plain-text `docs/...` references into real links.
- **Redundancy:** moderate. The main overlap sits between the index, architecture/API/runtime docs, and repeated “see also” prose across feature docs.
- **Major gaps:** there is still **no standalone homepage route contract doc** and **no standalone `/start/` route contract doc**. Those behaviors are currently split across [`docs/architecture.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md), [`docs/design-language.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/design-language.md), tests, and component code.

## 2. Inventory And Map

### Inventory

#### Index And Meta

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/README.md` | Canonical index into the docs corpus | 2026-03-13 | Contributors, operators |
| `docs/documentation-map-2026-03-05.tsv` | Point-in-time docs surface map used for audits | 2026-03-13 | Auditors, contributors |

#### System And Operations

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/api-reference.md` | Exhaustive worker HTTP contract reference | 2026-03-13 | API consumers, contributors |
| `docs/architecture.md` | Curated file tree, route inventory, storage summary | 2026-03-13 | Contributors |
| `docs/worker-infrastructure.md` | Worker runtime, cron orchestration, env/auth/cache behavior | 2026-03-13 | Operators, contributors |
| `docs/worker-and-api-limits.md` | Upstream/platform constraints that shape worker design | 2026-03-12 | Operators, feature designers |
| `docs/data-flow-map.md` | Source → cron → storage → API → hook → page map | 2026-03-12 | Contributors |
| `docs/data-pipeline.md` | Stablecoin sync, price enrichment, guardrails | 2026-03-12 | Contributors, operators |
| `docs/deployment-process.md` | Local merge gate and CI/CD deploy sequence | 2026-03-12 | Contributors, operators |
| `docs/testing.md` | Test/lint commands, CI pipeline, test inventory | 2026-03-13 | Contributors |
| `docs/scripts.md` | Operational and CI helper script inventory | 2026-03-09 | Contributors, operators |

#### Route And Page Contracts

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/about-page.md` | `/about/` content/update contract | 2026-03-12 | Contributors, content maintainers |
| `docs/methodology-page.md` | `/methodology/` structure and update rules | 2026-03-12 | Contributors |
| `docs/stablecoin-detail-page.md` | `/stablecoin/[id]/` route shell and section contract | 2026-03-13 | Frontend contributors |
| `docs/cemetery-and-compare.md` | `/cemetery/` and `/compare/` data/URL contract | 2026-03-12 | Frontend contributors |
| `docs/dependency-map.md` | `/dependency-map/` graph/data contract | 2026-03-12 | Frontend contributors |
| `docs/coverage-page.md` | `/coverage/` matrix contract and update rules | 2026-03-12 | Contributors |
| `docs/status-dashboard.md` | `/status/` frontend/backend/admin contract | 2026-03-13 | Operators, frontend contributors |

#### Feature And Methodology Docs

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/classification.md` | Governance/backing/peg classification system | 2026-03-11 | Contributors |
| `docs/bluechip-ratings.md` | Bluechip sync coverage and public cache/API usage | 2026-03-12 | Contributors |
| `docs/depeg-detection.md` | Two-stage depeg detection and confirmation flow | 2026-03-12 | Contributors |
| `docs/dews.md` | DEWS formula, signals, bands, API shape | 2026-03-12 | Contributors |
| `docs/dex-liquidity.md` | Liquidity scoring, discovery, staging, price validation | 2026-03-13 | Feature owners, contributors |
| `docs/stability-index.md` | PSI formula, storage, API, frontend consumers | 2026-03-12 | Feature owners, contributors |
| `docs/report-cards.md` | Risk Lab scoring and dependency propagation | 2026-03-12 | Feature owners, contributors |
| `docs/redemption-backstops.md` | Redemption-route modeling and API consumers | 2026-03-13 | Feature owners, contributors |
| `docs/supply-snapshot.md` | Daily supply snapshot cron and consumers | 2026-03-12 | Contributors, operators |
| `docs/blacklist-tracker.md` | Blacklist/freeze sync flow, API, UI behavior | 2026-03-12 | Feature owners, operators |
| `docs/mint-burn-flows.md` | Mint/burn flow ingestion, scoring, API, UI | 2026-03-13 | Feature owners, contributors |
| `docs/yield-intelligence.md` | Yield sync, PYS scoring, APIs, UI | 2026-03-13 | Feature owners, contributors |
| `docs/digest-pipeline.md` | Daily digest generation, storage, distribution, UI | 2026-03-12 | Operators, contributors |
| `docs/feedback-pipeline.md` | Feedback widget and GitHub routing pipeline | 2026-03-12 | Contributors, operators |
| `docs/telegram-alerts.md` | Telegram webhook/bot commands, storage, dispatch | 2026-03-13 | Operators, contributors |
| `docs/shadow-stablecoins.md` | Shadow-asset scope and exclusion rules | 2026-03-08 | Contributors |
| `docs/live-reserves.md` | Live reserve sync adapters, storage, reserve API | 2026-03-13 | Feature owners, operators |

#### Design References

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/design-context.md` | User, brand, product-direction baseline | 2026-03-11 | Designers, contributors |
| `docs/design-language.md` | Live UI patterns and responsive behavior | 2026-03-12 | Designers, frontend contributors |
| `docs/design-tokens.md` | Token architecture and CSS variable layering | 2026-03-07 | Designers, frontend contributors |

#### Methodology Timelines

| File | Purpose | Last meaningful update | Apparent audience |
|---|---|---:|---|
| `docs/blacklist-tracker-timeline.md` | Blacklist methodology history | 2026-03-05 | Feature owners, contributors |
| `docs/depeg-dews-timeline.md` | Depeg/DEWS methodology history | 2026-03-10 | Feature owners, contributors |
| `docs/liquidity-score-timeline.md` | Liquidity methodology history | 2026-03-12 | Feature owners, contributors |
| `docs/mint-burn-flows-timeline.md` | Mint/burn methodology history | 2026-03-12 | Feature owners, contributors |
| `docs/report-cards-timeline.md` | Risk Lab methodology history | 2026-03-12 | Feature owners, contributors |
| `docs/stability-index-timeline.md` | PSI methodology history | 2026-03-05 | Feature owners, contributors |
| `docs/yield-intelligence-timeline.md` | Yield methodology history | 2026-03-12 | Feature owners, contributors |

### Dependency Map

**Clickable docs graph summary**

- Primary hub: [`docs/README.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/README.md) links to the rest of the corpus.
- Secondary hubs after this pass:
  - [`docs/report-cards.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/report-cards.md) → 4 outbound links
  - [`docs/architecture.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md) → 3 outbound links
  - [`docs/worker-infrastructure.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md) → 3 outbound links
- Leaf-doc pattern remains strong: **30 Markdown docs** have zero outbound Markdown links. That is not inherently wrong, but it keeps discoverability dependent on the README hub.
- Hard orphans: **none**. Every Markdown doc has at least one inbound Markdown link.
- Circular references: **1 intentional cycle** — [`docs/README.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/README.md) ↔ [`docs/architecture.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md).

**Audience-fit assessment**

- System/runtime docs are written for contributors/operators and generally match that audience.
- Feature docs are contributor-facing, not end-user-facing, and mostly stay at the correct level of detail.
- The main mismatch is structural rather than tonal: route-specific behavior for the homepage and `/start/` is important to frontend contributors but still lacks a dedicated contract doc.

## 3. Inaccuracies Found

[INACCURACY] `docs/worker-infrastructure.md:3`  
  Documented: `23` scheduled runtime jobs, with `CRON_INTERVALS` / `/api/status` tracking `22`.  
  Actual: `worker/src/handlers/scheduled/*.ts` executes **24** unique scheduled job names; `shared/lib/cron-jobs.ts` defines **23** tracked jobs in `CRON_JOB_DEFINITIONS`, which is what `CRON_INTERVALS` and `/api/status` expose. `announce-cemetery-additions` is the untracked sidecar.  
  Action: fix the doc. **Applied in this pass.**

[INACCURACY] `docs/worker-infrastructure.md:201`  
  Documented: fetch-heavy jobs such as `sync-stablecoin-charts` run on their own dedicated triggers.  
  Actual: `syncStablecoinCharts()` shares the `10,40 * * * *` half-hourly slot with `syncDexLiquidity()` and `syncYieldData()` in `worker/src/handlers/scheduled/half-hourly.ts`. The isolation boundary is the **lane/trigger slot**, not the individual charts job.  
  Action: fix the doc. **Applied in this pass.**

## 4. Redundancy Map

| Overlap | Where it appears | Recommendation | Status |
|---|---|---|---|
| Route inventory vs exact HTTP contract | `docs/architecture.md`, `docs/api-reference.md` | Keep `api-reference.md` canonical for request/response details; keep `architecture.md` curated and high-level | Accepted; no structural split yet |
| Runtime/cache/admin behavior repeated beside API docs | `docs/worker-infrastructure.md`, `docs/api-reference.md` | Keep handler/runtime rationale in `worker-infrastructure.md`; avoid re-explaining endpoint contracts there | Partially improved by link fixes |
| Merge-gate/deploy procedure repeated | `docs/testing.md`, `docs/deployment-process.md` | Keep `deployment-process.md` canonical; testing doc should link instead of restating | Improved in this pass |
| Reserve-boundary caveats repeated | `docs/live-reserves.md`, `docs/report-cards.md`, `docs/dependency-map.md` | Keep each feature doc canonical for its scoring/graph behavior and link across docs rather than duplicating caveats | Improved in this pass |
| Docs discovery duplicated through repeated prose references | Many feature docs referenced sibling docs as plain text `docs/...` | Replace with clickable cross-links so repeated “see X doc” text still improves navigation | Improved in this pass |

## 5. Condensation Opportunities

| File | Current size | Estimated target | Opportunity |
|---|---:|---:|---|
| `docs/api-reference.md` | 2,196 lines | ~1,500 lines | Split repetitive cache/error guidance from endpoint sections or generate schema tables from shared types |
| `docs/worker-infrastructure.md` | 853 lines | ~650 lines | Trim duplicated API/cache detail that already belongs in `api-reference.md`; keep runtime and slot rationale |
| `docs/testing.md` | 588 lines | ~420 lines | Move exhaustive suite inventory to a generated appendix or sharply shorten repetitive test-case descriptions |
| `docs/yield-intelligence.md` | 645 lines | ~500 lines | Collapse repeated tier/fallback explanations and separate API/UI sections more aggressively |
| `docs/mint-burn-flows.md` | 634 lines | ~500 lines | Reduce repeated component inventory and UI restatements that already live in `architecture.md` |

## 6. Completeness Gaps

- **Homepage contract doc missing.** The homepage has route-specific behavior (`src/app/page.tsx`, `src/components/homepage-client.tsx`, `src/lib/start-here-callout.ts`) but no dedicated `/docs` contract page.
- **`/start/` route contract doc missing.** Behavior is spread across `src/app/start/page.tsx`, `src/components/start-here-page.tsx`, `src/components/start-here-visit-marker.tsx`, `docs/design-language.md`, and tests.
- **No generated current docs graph artifact.** [`docs/documentation-map-2026-03-05.tsv`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/documentation-map-2026-03-05.tsv) is historical, not regenerated from the live corpus.
- **Plain-text references are still common in tables.** This pass fixed the highest-value prose references, but many table cells in [`docs/worker-infrastructure.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md) still hold non-clickable `docs/...` strings.
- **No missing router endpoint docs found.** `shared/lib/api-endpoints.ts` and `worker/src/router.ts` remain covered by [`docs/api-reference.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md), so the main completeness gaps are route/page docs, not worker API docs.

## 7. Proposed Changes

1. **Fix verified inaccuracies and contradictions in runtime docs.**  
   Applied: corrected the scheduled-job counts and the lane-vs-dedicated-trigger wording in [`docs/worker-infrastructure.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md).

2. **Reduce navigational debt by converting plain-text doc references into links.**  
   Applied across high-traffic docs: [`docs/architecture.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md), [`docs/bluechip-ratings.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/bluechip-ratings.md), [`docs/coverage-page.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/coverage-page.md), [`docs/data-pipeline.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-pipeline.md), [`docs/digest-pipeline.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/digest-pipeline.md), [`docs/live-reserves.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md), [`docs/mint-burn-flows.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/mint-burn-flows.md), [`docs/redemption-backstops.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/redemption-backstops.md), [`docs/report-cards.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/report-cards.md), [`docs/stability-index.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/stability-index.md), [`docs/testing.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md), and [`docs/worker-infrastructure.md`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md).

3. **Add missing page-contract docs for the homepage and `/start/`.**  
   Not yet applied. Highest-value next addition if the team wants route-level frontend docs to match the rest of the corpus.

4. **Plan a targeted split/trim of oversized reference docs.**  
   Not yet applied. Recommended first targets: `api-reference.md`, `worker-infrastructure.md`, `testing.md`.

## Verification Notes

- Verified scheduled-job counts from `worker/src/handlers/scheduled/*.ts` and `shared/lib/cron-jobs.ts`.
- Verified route and runtime wording against `worker/src/router.ts`, `worker/src/handlers/http.ts`, and `worker/wrangler.toml`.
- Re-ran a local Markdown link check after edits: **0 broken local links**.
