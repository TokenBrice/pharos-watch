# 2026-03-22 Documentation Audit Manifest

Scope for this audit follows the repository's own documentation boundaries:

- canonical docs in `/docs/`
- root `README.md`
- repo-adjacent operational/reference docs that are part of the live product/data workflow
- live documentation routes for `/methodology/` and `/coverage/`

Explicit exclusions:

- `/agents/**` working notes, prior audits, and plans
- `AGENTS.md` and `CLAUDE.md` operator instructions
- generated `coverage/**` reports and `out/**` export artifacts

Status legend:

- `[x]` audited in this pass

## Canonical Docs

- [x] `docs/README.md`
- [x] `docs/about-page.md`
- [x] `docs/api-reference.md`
- [x] `docs/architecture.md`
- [x] `docs/blacklist-tracker-timeline.md`
- [x] `docs/blacklist-tracker.md`
- [x] `docs/bluechip-ratings.md`
- [x] `docs/cemetery-and-compare.md`
- [x] `docs/chain-health-timeline.md`
- [x] `docs/chains-page.md`
- [x] `docs/classification.md`
- [x] `docs/coverage-page.md`
- [x] `docs/data-flow-map.md`
- [x] `docs/data-pipeline.md`
- [x] `docs/depeg-detection.md`
- [x] `docs/depeg-dews-timeline.md`
- [x] `docs/dependency-map.md`
- [x] `docs/deployment-process.md`
- [x] `docs/design-context.md`
- [x] `docs/design-language.md`
- [x] `docs/design-tokens.md`
- [x] `docs/dews.md`
- [x] `docs/dex-liquidity.md`
- [x] `docs/digest-pipeline.md`
- [x] `docs/documentation-map-2026-03-05.tsv`
- [x] `docs/feedback-pipeline.md`
- [x] `docs/homepage.md`
- [x] `docs/liquidity-score-timeline.md`
- [x] `docs/live-reserves.md`
- [x] `docs/methodology-page.md`
- [x] `docs/mint-burn-flows-timeline.md`
- [x] `docs/mint-burn-flows.md`
- [x] `docs/operator-origin-access.md`
- [x] `docs/portfolio-page.md`
- [x] `docs/pricing-pipeline-timeline.md`
- [x] `docs/pricing-pipeline.md`
- [x] `docs/privacy-page.md`
- [x] `docs/redemption-backstops.md`
- [x] `docs/report-cards-timeline.md`
- [x] `docs/report-cards.md`
- [x] `docs/scripts.md`
- [x] `docs/shadow-stablecoins.md`
- [x] `docs/stability-index-timeline.md`
- [x] `docs/stability-index.md`
- [x] `docs/stablecoin-detail-page.md`
- [x] `docs/start-page.md`
- [x] `docs/status-dashboard.md`
- [x] `docs/supply-snapshot.md`
- [x] `docs/telegram-alerts.md`
- [x] `docs/testing.md`
- [x] `docs/worker-and-api-limits.md`
- [x] `docs/worker-infrastructure.md`
- [x] `docs/yield-intelligence-timeline.md`
- [x] `docs/yield-intelligence.md`

## Repo-Adjacent Docs

- [x] `README.md`
- [x] `worker/migrations/MANIFEST.md`
- [x] `shared/data/stablecoins/PROVENANCE_NOTES.md`

## Live Documentation Routes

- [x] `src/app/methodology/blacklist-tracker-changelog/page.tsx`
- [x] `src/app/methodology/chain-health-changelog/page.tsx`
- [x] `src/app/methodology/changelog-page-utils.ts`
- [x] `src/app/methodology/changelog-route-factory.tsx`
- [x] `src/app/methodology/depeg-changelog/page.tsx`
- [x] `src/app/methodology/error.tsx`
- [x] `src/app/methodology/liquidity-score-changelog/page.tsx`
- [x] `src/app/methodology/methodology-sections.tsx`
- [x] `src/app/methodology/methodology-shared.tsx`
- [x] `src/app/methodology/mint-burn-flow-changelog/page.tsx`
- [x] `src/app/methodology/page.tsx`
- [x] `src/app/methodology/pricing-pipeline-changelog/page.tsx`
- [x] `src/app/methodology/scoring-changelog/page.tsx`
- [x] `src/app/methodology/sections/core-sections.tsx`
- [x] `src/app/methodology/sections/monitoring-sections.tsx`
- [x] `src/app/methodology/stability-index-changelog/page.tsx`
- [x] `src/app/methodology/yield-changelog/page.tsx`
- [x] `src/app/coverage/client.tsx`
- [x] `src/app/coverage/error.tsx`
- [x] `src/app/coverage/page.tsx`
