# Documentation Audit Manifest — 2026-03-25

## Scope Summary

- Discovery-time `/docs/` files: 63
- Additional support docs in scope: 6
- Total discovered documentation assets audited: 69
- Post-remediation verified `/docs/` corpus: 55
- Working-artifact files archived out of `/docs/`: 8

## Scope Notes

- `/coverage/` was audited through [docs/coverage-page.md](../../docs/coverage-page.md) and verified against `src/app/coverage/*`.
- `/methodology/` was audited through [docs/methodology-page.md](../../docs/methodology-page.md) and verified against `src/app/methodology/*`.
- Generated output, vendored dependencies, and worktree mirrors were excluded from scope: `out/**`, `node_modules/**`, `.claude/worktrees/**`.
- `AGENTS.md`, `shared/data/stablecoins/PROVENANCE_NOTES.md`, and `agents/process/cmux-browser.md` were verified and required no content changes.

## Verified `/docs/` Corpus

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
- [x] `docs/upcoming-page.md`
- [x] `docs/worker-and-api-limits.md`
- [x] `docs/worker-infrastructure.md`
- [x] `docs/yield-intelligence-timeline.md`
- [x] `docs/yield-intelligence.md`

## Support Docs In Scope

- [x] `README.md`
- [x] `AGENTS.md`
- [x] `CLAUDE.md`
- [x] `worker/migrations/MANIFEST.md`
- [x] `shared/data/stablecoins/PROVENANCE_NOTES.md`
- [x] `agents/process/cmux-browser.md`

## Archived Out Of `/docs/`

These files were discovered during inventory inside `docs/superpowers/**`. They were planning/spec artifacts, not verified product documentation, so they were moved to `/agents/` to restore the documented rule that `/docs/` is the verified corpus.

- [x] `docs/superpowers/plans/2026-03-24-design-polish-plan.md` -> `agents/plans/historical/2026-03-24-design-polish-plan.md`
- [x] `docs/superpowers/plans/2026-03-24-pyusd-usd1-blacklist-tracking.md` -> `agents/plans/historical/2026-03-24-pyusd-usd1-blacklist-tracking.md`
- [x] `docs/superpowers/plans/2026-03-25-distribution-charts.md` -> `agents/plans/historical/2026-03-25-distribution-charts.md`
- [x] `docs/superpowers/plans/2026-03-25-audit-remediation.md` -> `agents/plans/historical/2026-03-25-audit-remediation.md`
- [x] `docs/superpowers/plans/2026-03-25-yield-expansion-phase1-2.md` -> `agents/plans/historical/2026-03-25-yield-expansion-phase1-2.md`
- [x] `docs/superpowers/plans/2026-03-25-yield-expansion-phase3.md` -> `agents/plans/historical/2026-03-25-yield-expansion-phase3.md`
- [x] `docs/superpowers/specs/2026-03-24-pyusd-usd1-blacklist-tracking-design.md` -> `agents/specs/2026-03-24-pyusd-usd1-blacklist-tracking-design.md`
- [x] `docs/superpowers/specs/2026-03-25-distribution-charts-design.md` -> `agents/specs/2026-03-25-distribution-charts-design.md`
