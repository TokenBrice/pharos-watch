# Documentation Audit Manifest - 2026-04-14

Purpose: inventory and verification checklist for the current documentation audit. Code remains the source of truth.

## Scope Decision

Primary code-synchronized documentation corpus:

- `/docs/` recursively: 57 files, including 56 Markdown files plus `documentation-map-2026-03-05.tsv`
- root `README.md`
- root agent guidance: `AGENTS.md`, `CLAUDE.md`
- support docs referenced by the primary corpus: `worker/migrations/MANIFEST.md`, `shared/data/stablecoins/PROVENANCE_NOTES.md`
- live documentation surfaces implemented in code: `/coverage/` and `/methodology/` under `src/app/`

Discovered but not treated as code-synchronized product docs:

- `/agents/`: 689 tracked Markdown artifacts. `agents/README.md` explicitly defines this tree as a working-artifact archive, not canonical product truth.
- `.claude/skills/`: 11 tracked skill docs. These are local agent-tooling instructions, not application docs.
- `.codex-autorunner/`: 12 tracked tool/autorunner docs. These are local tooling artifacts, not application docs.
- `node_modules/` and `worktrees/`: vendored or duplicate generated worktree content; excluded from application documentation verification.

## Primary Documentation Checklist

- [x] `README.md`
- [x] `AGENTS.md`
- [x] `CLAUDE.md`
- [x] `docs/README.md`
- [x] `docs/about-page.md`
- [x] `docs/api-page.md`
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
- [x] `docs/yield-intelligence-operations.md`
- [x] `docs/yield-intelligence-timeline.md`
- [x] `docs/yield-intelligence.md`
- [x] `worker/migrations/MANIFEST.md`
- [x] `shared/data/stablecoins/PROVENANCE_NOTES.md`

## Live Page Surfaces

- [x] `src/app/coverage/**`
- [x] `src/app/methodology/**`

## Verification Commands

- [x] `npm run check:doc-counts`
- [x] `npm run check:verified-doc-links`
- [x] `npm run check:doc-sync`
- [x] `npm run check:env-contract`
- [x] `npm run check:redemption-backstops`
- [x] `npm run check:cron-sync`
- [x] `npm run check:migrations`
- [x] custom backticked path-reference scan
- [x] custom external-link resolution scan

