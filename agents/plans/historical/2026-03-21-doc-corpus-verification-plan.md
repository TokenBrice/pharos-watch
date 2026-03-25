# 2026-03-21 Doc Corpus Verification Plan

## Objective

Verify every document in `/docs/` against the live codebase, correct factual drift in place, identify missing coverage, and produce a source-cited audit report.

## Scope

- `/docs/*.md`
- Cross-check references in `/README.md`, `/AGENTS.md`, and `/CLAUDE.md`
- Code surfaces under `src/`, `shared/`, `worker/`, `scripts/`, and `data/`

## Verification Rules

1. Treat every documentation claim as unverified until matched to code.
2. Prefer direct source files over secondary docs when resolving conflicts.
3. Record exact source files and lines for every non-obvious correction.
4. Keep doc edits minimal and factual; no style rewrites unless needed for clarity.
5. Add new docs only when an implemented system lacks a usable explanation path.

## Work Batches

### Batch 1: Core corpus and system maps

- `docs/README.md`
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/data-flow-map.md`
- `docs/data-pipeline.md`
- `docs/deployment-process.md`
- `docs/testing.md`
- `docs/scripts.md`

### Batch 2: Route and page contracts

- `docs/homepage.md`
- `docs/start-page.md`
- `docs/about-page.md`
- `docs/methodology-page.md`
- `docs/stablecoin-detail-page.md`
- `docs/chains-page.md`
- `docs/cemetery-and-compare.md`
- `docs/dependency-map.md`
- `docs/coverage-page.md`
- `docs/portfolio-page.md`
- `docs/privacy-page.md`
- `docs/status-dashboard.md`

### Batch 3: Feature and methodology docs

- `docs/classification.md`
- `docs/pricing-pipeline.md`
- `docs/bluechip-ratings.md`
- `docs/depeg-detection.md`
- `docs/dews.md`
- `docs/dex-liquidity.md`
- `docs/stability-index.md`
- `docs/report-cards.md`
- `docs/redemption-backstops.md`
- `docs/supply-snapshot.md`
- `docs/blacklist-tracker.md`
- `docs/mint-burn-flows.md`
- `docs/yield-intelligence.md`
- `docs/digest-pipeline.md`
- `docs/feedback-pipeline.md`
- `docs/telegram-alerts.md`
- `docs/live-reserves.md`
- `docs/shadow-stablecoins.md`

### Batch 4: Design docs

- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`

### Batch 5: Timeline and version-history docs

- `docs/chain-health-timeline.md`
- `docs/blacklist-tracker-timeline.md`
- `docs/depeg-dews-timeline.md`
- `docs/liquidity-score-timeline.md`
- `docs/mint-burn-flows-timeline.md`
- `docs/pricing-pipeline-timeline.md`
- `docs/report-cards-timeline.md`
- `docs/stability-index-timeline.md`
- `docs/yield-intelligence-timeline.md`

## Deliverables

- Corrected documentation files in `/docs/`
- Any warranted new `/docs/` files for uncovered systems
- Structured verification report for the user
- Audit notes under `/agents/audits/` if intermediate findings need preservation
