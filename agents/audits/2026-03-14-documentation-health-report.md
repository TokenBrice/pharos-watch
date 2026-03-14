# 2026-03-14 Documentation Health Report

## Scope

Canonical product docs audited against live code:

- `README.md`
- all files in `docs/`

Secondary discovered documentation/instruction files checked for drift risk:

- `AGENTS.md`
- `CLAUDE.md`

Code surfaces sampled during verification:

- `package.json`, `worker/package.json`
- `src/app/**/*`, `src/components/**/*`, `src/hooks/**/*`, `src/lib/**/*`
- `functions/**/*`
- `shared/lib/**/*`, `shared/types/**/*`
- `worker/src/**/*`, `worker/wrangler.toml`
- `.github/workflows/**/*`

## Summary

- Total canonical files audited: 50
- Critical issues fixed: 0
- Major issues fixed: 4
- Minor issues fixed: 2
- Coverage gaps filled: 2
- Structural index updates: 1

## Major Fixes

| File | What was wrong | Remediation |
|------|----------------|-------------|
| `docs/supply-snapshot.md` | Supply-history flow was still documented as detail-endpoint-derived; backfill coverage and internal helper references were stale | Rewrote the hook/API/backfill/error-handling sections to match `GET /api/supply-history`, `loadStablecoinsCache`, `db-cache`, and `cron-logger` |
| `docs/data-flow-map.md` | Supply history was incorrectly routed through `GET /api/stablecoin/:id` and `stablecoin-charts` | Split detail/chart flow from per-coin `supply_history` flow |
| `docs/architecture.md` | Hook inventory described `useSupplyHistory` as detail-endpoint-derived | Updated the hook contract to point to `/api/supply-history` |
| `docs/worker-infrastructure.md` | Module-init section referenced wrong/non-current initializer signatures and understated Telegram channel usage | Corrected init signatures/behavior and `TELEGRAM_CHAT_ID` usage |

## Minor Fixes

| File | What was wrong | Remediation |
|------|----------------|-------------|
| `docs/testing.md` | Two worker-library test rows pointed at the wrong modules | Remapped `log-cron-run.test.ts` to `cron-logger.ts` and `cron-leases.test.ts` to `cron-lease.ts` |
| `docs/feedback-pipeline.md` | Production CORS note omitted `https://ops.pharos.watch` from the checked-in allowlist | Updated the note to match `worker/wrangler.toml` and `worker/src/handlers/http.ts` |

## Coverage Gaps Filled

| File | Gap | Remediation |
|------|-----|-------------|
| `docs/portfolio-page.md` | `/portfolio/` had no dedicated route contract; behavior was only partially described inside `docs/report-cards.md` | Added a focused route doc for shell behavior, local persistence, share encoding, and report-card dependency |
| `docs/privacy-page.md` | `/privacy/` had no dedicated doc despite being a public route linked from the footer and sitemap | Added a focused route doc for metadata, content contract, navigation, and update rules |

## Structural Changes

| File | Change |
|------|--------|
| `docs/README.md` | Added the new `/portfolio/` and `/privacy/` route docs to the documentation index |

## Verified, No Changes Required

- `README.md`
- `docs/about-page.md`
- `docs/api-reference.md`
- `docs/blacklist-tracker-timeline.md`
- `docs/blacklist-tracker.md`
- `docs/bluechip-ratings.md`
- `docs/cemetery-and-compare.md`
- `docs/classification.md`
- `docs/coverage-page.md`
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
- `docs/documentation-map-2026-03-05.tsv` (retained as a non-canonical historical artifact)
- `docs/homepage.md`
- `docs/live-reserves.md`
- `docs/methodology-page.md`
- `docs/mint-burn-flows-timeline.md`
- `docs/mint-burn-flows.md`
- `docs/operator-origin-access.md`
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
- `docs/telegram-alerts.md`
- `docs/worker-and-api-limits.md`
- `docs/yield-intelligence-timeline.md`
- `docs/yield-intelligence.md`

## Notes

- `README.md`, `docs/deployment-process.md`, `docs/mint-burn-flows.md`, and `docs/scripts.md` were already dirty in the worktree before this audit. They were verified where relevant, but not rewritten during this pass unless a code-backed mismatch required it.
- `AGENTS.md` and `CLAUDE.md` remain secondary instruction files, not canonical product docs. I checked their command snippets and high-level repo descriptions for obvious drift while prioritizing `/docs/` and `README.md`.
