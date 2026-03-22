# Archivist Doc Surface Audit

Date: 2026-03-22

## Scope

- `README.md`
- `/docs/`
- `/coverage/`
- public methodology surfaces represented in this repo by `src/app/methodology/**/page.tsx` and `docs/methodology-page.md`
- public coverage surface represented in this repo by `src/app/coverage/*` plus generated `coverage/` artifacts

## Verification Pass

Commands run:

```bash
find docs -maxdepth 2 -type f | sort
find coverage -maxdepth 3 -type f | sort
find src/app -maxdepth 3 \( -path '*/methodology*' -o -path '*/coverage*' -o -path '*/about*' \) | sort
npm run check:doc-counts
npm run check:doc-sync
```

Additional checks:

- local markdown-link resolution across `README.md` and every `docs/*.md` file
- route-map diff between `src/app/**/page.tsx`, `src/app/sitemap.ts`, and `docs/README.md`
- spot verification of the public route contracts against:
  - `src/app/upcoming/page.tsx`
  - `src/components/upcoming-client.tsx`
  - `src/app/coverage/page.tsx`
  - `src/app/coverage/client.tsx`
  - `src/hooks/use-coverage-matrix-model.ts`
  - `src/lib/coverage.ts`
  - `src/app/methodology/page.tsx`
  - `src/app/methodology/changelog-route-factory.tsx`
  - `shared/lib/api-endpoints.ts`
  - `worker/src/route-registry.ts`
  - `worker/src/router.ts`
  - `shared/lib/cron-jobs.ts`
  - `worker/src/handlers/scheduled.ts`
  - `worker/src/lib/env.ts`

## Inventory Snapshot

Last-modified signals collected from `git log -1 --format=%cs`:

```text
2026-03-22 README.md
2026-03-22 docs/README.md
2026-03-22 docs/about-page.md
2026-03-22 docs/api-reference.md
2026-03-22 docs/architecture.md
2026-03-22 docs/blacklist-tracker.md
2026-03-14 docs/blacklist-tracker-timeline.md
2026-03-22 docs/bluechip-ratings.md
2026-03-22 docs/cemetery-and-compare.md
2026-03-22 docs/chain-health-timeline.md
2026-03-22 docs/chains-page.md
2026-03-22 docs/classification.md
2026-03-21 docs/coverage-page.md
2026-03-22 docs/data-flow-map.md
2026-03-22 docs/data-pipeline.md
2026-03-22 docs/depeg-detection.md
2026-03-22 docs/depeg-dews-timeline.md
2026-03-22 docs/dependency-map.md
2026-03-22 docs/deployment-process.md
2026-03-11 docs/design-context.md
2026-03-22 docs/design-language.md
2026-03-18 docs/design-tokens.md
2026-03-22 docs/dews.md
2026-03-22 docs/dex-liquidity.md
2026-03-22 docs/digest-pipeline.md
2026-03-22 docs/feedback-pipeline.md
2026-03-22 docs/homepage.md
2026-03-20 docs/liquidity-score-timeline.md
2026-03-22 docs/live-reserves.md
2026-03-22 docs/methodology-page.md
2026-03-22 docs/mint-burn-flows.md
2026-03-12 docs/mint-burn-flows-timeline.md
2026-03-22 docs/operator-origin-access.md
2026-03-14 docs/portfolio-page.md
2026-03-22 docs/pricing-pipeline.md
2026-03-22 docs/pricing-pipeline-timeline.md
2026-03-22 docs/privacy-page.md
2026-03-22 docs/redemption-backstops.md
2026-03-22 docs/report-cards.md
2026-03-22 docs/report-cards-timeline.md
2026-03-22 docs/scripts.md
2026-03-22 docs/shadow-stablecoins.md
2026-03-21 docs/stability-index.md
2026-03-05 docs/stability-index-timeline.md
2026-03-22 docs/stablecoin-detail-page.md
2026-03-19 docs/start-page.md
2026-03-22 docs/status-dashboard.md
2026-03-22 docs/supply-snapshot.md
2026-03-22 docs/telegram-alerts.md
2026-03-22 docs/testing.md
2026-03-22 docs/worker-and-api-limits.md
2026-03-22 docs/worker-infrastructure.md
2026-03-22 docs/yield-intelligence.md
2026-03-20 docs/yield-intelligence-timeline.md
2026-03-21 src/app/coverage/page.tsx
2026-03-22 src/app/coverage/client.tsx
2026-03-12 src/app/coverage/error.tsx
2026-03-21 src/app/methodology/page.tsx
2026-03-07 src/app/methodology/blacklist-tracker-changelog/page.tsx
2026-03-16 src/app/methodology/chain-health-changelog/page.tsx
2026-03-07 src/app/methodology/depeg-changelog/page.tsx
2026-03-07 src/app/methodology/liquidity-score-changelog/page.tsx
2026-03-07 src/app/methodology/mint-burn-flow-changelog/page.tsx
2026-03-14 src/app/methodology/pricing-pipeline-changelog/page.tsx
2026-03-22 src/app/methodology/scoring-changelog/page.tsx
2026-03-07 src/app/methodology/stability-index-changelog/page.tsx
2026-03-07 src/app/methodology/yield-changelog/page.tsx
2026-03-22 coverage/lcov.info
2026-03-22 coverage/lcov-report/index.html
2026-03-22 coverage/lcov-report/base.css
2026-03-22 coverage/lcov-report/block-navigation.js
2026-03-22 coverage/lcov-report/favicon.png
2026-03-22 coverage/lcov-report/prettify.css
2026-03-22 coverage/lcov-report/prettify.js
2026-03-22 coverage/lcov-report/sort-arrow-sprite.png
2026-03-22 coverage/lcov-report/sorter.js
```

Audience split:

- `README.md`: repo entrants and contributors
- `docs/*.md`: internal engineering reference corpus
- `src/app/methodology/**` and `src/app/coverage/*`: public documentation surfaces rendered by the app
- `coverage/*`: generated test-coverage artifacts for engineers, not hand-maintained prose

## Findings Matrix

| Status | Finding |
| --- | --- |
| ✅ Verified | `npm run check:doc-counts` passed; tracked/shadow/live-enabled/adapter/Bluechip counts are in sync with source. |
| ✅ Verified | `npm run check:doc-sync` passed; methodology versions and enforced doc-sync values match current code. |
| ✅ Verified | All local markdown links in `README.md` and `docs/*.md` resolve. |
| ❌ Missing | The live public `/upcoming/` route existed in `src/app/upcoming/page.tsx`, `src/components/upcoming-client.tsx`, and `src/app/sitemap.ts`, but had no dedicated route contract doc and was absent from the docs index route map. |
| ⚠️ Inaccurate | `README.md` and `docs/architecture.md` route trees omitted `src/app/upcoming/`, so their structural route inventories were incomplete. |
| 🔀 Redundant | Methodology changelog routes were documented indirectly through timeline docs and `docs/methodology-page.md`, but `docs/README.md` did not map those public URLs back to their authoritative docs. |

## Remediation Applied

1. Added `docs/upcoming-page.md` as the authoritative route contract for `/upcoming/`.
2. Updated `docs/README.md` to:
   - list `upcoming-page.md` under route contracts
   - map `/upcoming/` in the public route table
   - add an explicit methodology-changelog route map
3. Updated `README.md` to:
   - mention the upcoming-stablecoin surface in the feature list
   - add `src/app/upcoming/` to the project-structure tree
   - point contributors to `docs/upcoming-page.md`
4. Updated `docs/architecture.md` to:
   - include `src/app/upcoming/` in the curated file tree
   - include `/upcoming/` in the indexable major-feature route list
5. Updated `docs/homepage.md` to cross-reference the new `/upcoming/` route contract.

## Codebase Observations

- No code changes were made.
- The repo has no top-level `/methodology/` directory; the public methodology documentation surface is implemented under `src/app/methodology/`. Future doc requests should use the route implementation path, not assume a filesystem folder named `/methodology/`.
- `coverage/` is a generated Istanbul/V8 artifact set, not a maintained prose corpus. Treat it as output to verify or reference, not as a place for hand-authored docs unless the project intentionally adds a stable README there.
