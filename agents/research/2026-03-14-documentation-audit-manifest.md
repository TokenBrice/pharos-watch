# 2026-03-14 Documentation Audit Manifest

Primary documentation corpus audited against live code:

- `README.md`
- `docs/README.md`
- `docs/about-page.md`
- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/blacklist-tracker-timeline.md`
- `docs/blacklist-tracker.md`
- `docs/bluechip-ratings.md`
- `docs/cemetery-and-compare.md`
- `docs/classification.md`
- `docs/coverage-page.md`
- `docs/data-flow-map.md`
- `docs/data-pipeline.md`
- `docs/depeg-detection.md`
- `docs/depeg-dews-timeline.md`
- `docs/dependency-map.md`
- `docs/deployment-process.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `docs/dews.md`
- `docs/dex-liquidity.md`
- `docs/digest-pipeline.md`
- `docs/documentation-map-2026-03-05.tsv`
- `docs/feedback-pipeline.md`
- `docs/homepage.md`
- `docs/liquidity-score-timeline.md`
- `docs/live-reserves.md`
- `docs/methodology-page.md`
- `docs/mint-burn-flows-timeline.md`
- `docs/mint-burn-flows.md`
- `docs/operator-origin-access.md`
- `docs/portfolio-page.md`
- `docs/pricing-pipeline.md`
- `docs/privacy-page.md`
- `docs/redemption-backstops.md`
- `docs/report-cards-timeline.md`
- `docs/report-cards.md`
- `docs/scripts.md`
- `docs/shadow-stablecoins.md`
- `docs/stability-index-timeline.md`
- `docs/stability-index.md`
- `docs/stablecoin-detail-page.md`
- `docs/start-page.md`
- `docs/status-dashboard.md`
- `docs/supply-snapshot.md`
- `docs/telegram-alerts.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/worker-infrastructure.md`
- `docs/yield-intelligence-timeline.md`
- `docs/yield-intelligence.md`

Live documentation surfaces audited against runtime code:

- `/methodology/` (`src/app/methodology/page.tsx`)
- `src/app/methodology/methodology-shared.tsx`
- `src/app/methodology/methodology-sections.tsx`

Secondary discovered documentation/instruction files:

- `AGENTS.md`
- `CLAUDE.md`

Verification surfaces used for this audit:

- `package.json`
- `worker/package.json`
- `src/app/**/*`
- `src/components/**/*`
- `src/hooks/**/*`
- `src/lib/**/*`
- `functions/**/*`
- `shared/lib/**/*`
- `shared/types/**/*`
- `worker/src/**/*`
- `worker/wrangler.toml`
- `.github/workflows/**/*`

Notes:

- Inventory size: 51 files under `/docs/`, plus root `README.md`, auxiliary `AGENTS.md` / `CLAUDE.md`, and the live `/methodology/` route surface.
- `/docs/` plus `README.md` remain the canonical product documentation surface.
- `/agents/` is an audit workspace and archive, not canonical product documentation.
- `docs/documentation-map-2026-03-05.tsv` is a legacy-named audit-support artifact. It is explicitly non-canonical and no longer described as a March 5 point-in-time snapshot.
