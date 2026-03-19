# Documentation Audit Manifest — 2026-03-19

Canonical source-of-truth documentation surfaces to audit and remediate in this pass.

## Scope

### Core entry points

- [x] `README.md`
- [x] `docs/README.md`

### Canonical docs corpus (`/docs`)

- [x] `docs/about-page.md`
- [x] `docs/api-reference.md`
- [x] `docs/architecture.md`
- [x] `docs/blacklist-tracker-timeline.md`
- [x] `docs/blacklist-tracker.md`
- [x] `docs/bluechip-ratings.md`
- [x] `docs/cemetery-and-compare.md`
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
- [x] `docs/superpowers/plans/2026-03-18-multi-dex-api-integration.md` — archived to `agents/plans/historical/2026-03-18-multi-dex-api-integration.md` because it is implementation history, not canonical docs corpus
- [x] `docs/superpowers/specs/2026-03-18-multi-dex-api-integration-design.md` — archived to `agents/specs/2026-03-18-multi-dex-api-integration-design.md` for the same reason

### Live documentation pages to verify against runtime code

- [x] `/coverage/` via `src/app/coverage/page.tsx` and `src/app/coverage/client.tsx`
- [x] `/methodology/` via `src/app/methodology/page.tsx` and `src/app/methodology/methodology-sections.tsx`
- [x] Methodology changelog routes under `src/app/methodology/*-changelog/page.tsx`

### Auxiliary project documentation discovered outside `/docs`

- [x] `AGENTS.md`
- [x] `CLAUDE.md`
- [x] `worker/migrations/MANIFEST.md`

## Explicitly excluded from this audit

- Historical notes under `/agents/` other than files created for this audit. Repo instructions define `/agents/` as working-artifact/archive context rather than the verified docs corpus.

## Output files for this audit

- `agents/audits/2026-03-19-documentation-audit-manifest.md`
- `agents/audits/2026-03-19-documentation-health-report.md`
