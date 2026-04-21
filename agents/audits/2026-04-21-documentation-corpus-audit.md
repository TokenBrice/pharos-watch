# 2026-04-21 Documentation Corpus Audit

## Assumptions And Scope

- Code is the source of truth. Documentation was checked against local source, generated artifacts, and repo guard scripts in this worktree.
- The verified corpus for automated checks is the same one used by repo tooling: root `README.md` plus `docs/**` Markdown. `CLAUDE.md` and `AGENTS.md` were cross-checked for headline counts by `npm run check:doc-counts`.
- "Claims checked" in the dashboard means concrete code-verifiable claims covered by the source-path, link, count, methodology-sync, endpoint, route, cron, migration, and generated-map checks run in this pass. It is not a prose style review.

## Verification Commands

| Check | Result | Ground Truth Covered |
|---|---|---|
| `npm run check:verified-doc-links` | Pass | 67 verified Markdown files; relative doc links and anchors |
| `npm run check:doc-source-paths` | Pass | Inline code path references in verified docs |
| `npm run check:doc-counts` | Pass | 197 tracked stablecoins, 2 shadow assets, 199 PSI-eligible assets, 44 reserve adapters, 19 Bluechip slugs, 152 live-enabled assets |
| `npm run check:doc-sync` | Pass | Methodology versions, report-card weights/thresholds, depeg constants, DEWS weights/bands, liquidity weights, worker limits, API freshness, status thresholds |
| `npm run check:openapi` | Pass | Generated public OpenAPI catalogue |
| `npm run check:postman` | Pass | Generated public Postman collection/environment |
| `npm run check:llms-txt` | Pass | Generated `/llms.txt` public index |
| `npm run check:cron-sync` | Pass | 17 cron triggers and 17 scheduled runner mappings |
| `npm run check:cron-connections` | Pass | 16 job-bearing trigger budgets within the 6-connection pool |
| `npm run check:migrations` | Pass | 34 worker SQL migrations; rollout-safety checks on 33 post-baseline migrations |

Additional manual inventory checks:

- API reference headings cover all 62 endpoint-method pairs derived from `shared/lib/api-endpoints`.
- `docs/README.md` route tables now cover all 49 `src/app/**/page.tsx` routes.
- `docs/agent-code-map.md` was regenerated from `scripts/generate-agent-code-map.mjs`.

## Per-Document Verification Report

## docs/README.md

**Status:** 2 incomplete / fixed

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Public Route Coverage | Incomplete | Route lookup omitted `/docs/` and `/docs/[slug]/` | Both are static public routes and sitemap entries backed by `PUBLIC_DOCS` | `src/app/docs/page.tsx:7`, `src/app/docs/[slug]/page.tsx:45`, `src/app/sitemap.ts:311`, `shared/lib/public-docs.ts:17` | Yes |
| 2 | Operator Routes | Ambiguous | Route cell mixed URL with host qualifier | The app route is `/admin/`; host/access context belongs in prose | `src/app/admin/page.tsx:4` | Yes |

### Changes Applied

- Added `/docs/` and `/docs/[slug]/` to the public route coverage map.
- Normalized the operator route row to `/admin/` and moved the `ops.pharos.watch` host qualifier into the section prose.

## docs/agent-code-map.md

**Status:** 1 stale / fixed

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Generated code map | Stale | Missing newer route, handler, function, and script entries | Generator includes `/docs` routes, `dews-psi` slot, newer scripts/tests, and updated exports | `scripts/generate-agent-code-map.mjs:11` | Yes |

### Changes Applied

- Regenerated `docs/agent-code-map.md` with `node scripts/generate-agent-code-map.mjs`.

## docs/digest-pipeline.md

**Status:** 1 stale / fixed

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | File Index | Stale | `worker/src/handlers/scheduled.ts` was described as the digest scheduling owner | `scheduled.ts` is the dispatcher; the 08:05 digest/Bluechip/discovery slot lives in `daily-0805.ts` | `worker/src/handlers/scheduled.ts:21`, `worker/src/handlers/scheduled/daily-0805.ts:19` | Yes |

### Changes Applied

- Split the file-index entry into dispatcher responsibility and `worker/src/handlers/scheduled/daily-0805.ts` slot responsibility.

## docs/blacklist-tracker.md

**Status:** 1 stale / fixed

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | File Index | Stale | `worker/src/handlers/scheduled.ts` was described as blacklist cron orchestration | `scheduled.ts` dispatches; `hourly-blacklist.ts` runs the dedicated 6-hourly sync slot | `worker/src/handlers/scheduled.ts:8`, `worker/src/handlers/scheduled/hourly-blacklist.ts:7` | Yes |

### Changes Applied

- Added `worker/src/handlers/scheduled/hourly-blacklist.ts` and narrowed the `scheduled.ts` row to dispatcher responsibility.

## docs/mint-burn-flows.md

**Status:** 1 ambiguous / fixed

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Cron Schedule | Ambiguous | Cron was "executed via `worker/src/handlers/scheduled.ts`" | The dispatcher routes isolated critical/extended slots through `twenty-minute-mint-burn-critical.ts`, `twenty-minute-mint-burn-extended.ts`, and shared `mint-burn-slot.ts` | `worker/src/handlers/scheduled.ts:9`, `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts:4`, `worker/src/handlers/scheduled/mint-burn-slot.ts:13` | Yes |

### Changes Applied

- Expanded the registration bullet to name the specific slot runner files and the shared mint/burn slot helper.

## No-Issue Documents

The following docs had no additional actionable drift after the checks and targeted source comparisons above:

| Document | Status |
|---|---|
| `README.md` | Pass |
| `docs/about-page.md` | Pass |
| `docs/agent-task-router.md` | Pass |
| `docs/api-endpoint-authoring.md` | Pass |
| `docs/api-page.md` | Pass |
| `docs/api-reference.md` | Pass |
| `docs/architecture.md` | Pass |
| `docs/blacklist-tracker-timeline.md` | Pass |
| `docs/bluechip-ratings.md` | Pass |
| `docs/cemetery-and-compare.md` | Pass |
| `docs/chain-health-timeline.md` | Pass |
| `docs/chain-health.md` | Pass |
| `docs/chains-page.md` | Pass |
| `docs/classification.md` | Pass |
| `docs/coverage-page.md` | Pass |
| `docs/data-flow-map.md` | Pass |
| `docs/data-pipeline.md` | Pass |
| `docs/depeg-detection.md` | Pass |
| `docs/depeg-dews-timeline.md` | Pass |
| `docs/dependency-map.md` | Pass |
| `docs/deployment-process.md` | Pass |
| `docs/design-context.md` | Pass |
| `docs/design-language.md` | Pass |
| `docs/design-tokens.md` | Pass |
| `docs/dews.md` | Pass |
| `docs/dex-liquidity.md` | Pass |
| `docs/feedback-pipeline.md` | Pass |
| `docs/funding-page.md` | Pass |
| `docs/homepage.md` | Pass |
| `docs/liquidity-score-timeline.md` | Pass |
| `docs/live-reserves.md` | Pass |
| `docs/methodology-page.md` | Pass |
| `docs/mint-burn-flows-timeline.md` | Pass |
| `docs/operator-origin-access.md` | Pass |
| `docs/portfolio-page.md` | Pass |
| `docs/pricing-pipeline-timeline.md` | Pass |
| `docs/pricing-pipeline.md` | Pass |
| `docs/privacy-page.md` | Pass |
| `docs/redemption-backstops.md` | Pass |
| `docs/report-cards-timeline.md` | Pass |
| `docs/report-cards.md` | Pass |
| `docs/runbooks/blacklist-sync.md` | Pass |
| `docs/runbooks/db-connectivity.md` | Pass |
| `docs/runbooks/mint-burn-integrity.md` | Pass |
| `docs/runbooks/stablecoins-cache.md` | Pass |
| `docs/scripts.md` | Pass |
| `docs/shadow-stablecoins.md` | Pass |
| `docs/stability-index-timeline.md` | Pass |
| `docs/stability-index.md` | Pass |
| `docs/stablecoin-data.md` | Pass |
| `docs/stablecoin-detail-page.md` | Pass |
| `docs/start-page.md` | Pass |
| `docs/status-dashboard.md` | Pass |
| `docs/supply-snapshot.md` | Pass |
| `docs/telegram-alerts.md` | Pass |
| `docs/testing.md` | Pass |
| `docs/upcoming-page.md` | Pass |
| `docs/worker-and-api-limits.md` | Pass |
| `docs/worker-infrastructure.md` | Pass |
| `docs/yield-intelligence-operations.md` | Pass |
| `docs/yield-intelligence-timeline.md` | Pass |
| `docs/yield-intelligence.md` | Pass |

## Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---|---|---|
| Public docs archive route (`/docs/`, `/docs/[slug]/`) | Low | No new doc. Covered by `docs/architecture.md`; route lookup gap fixed in `docs/README.md`. |
| Scheduled slot runners after folderization | Low | No new doc. File-index references fixed in affected feature docs. |

### New Documents Created

- None. Existing docs already cover the major systems named in the prompt: cemetery/compare, dependency map, portfolio, blacklist tracker, daily digest, Bluechip ratings, worker runtime, data flow, scripts, API authoring, and operator access.

## Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|---|---|---|---|
| `docs/README.md` | `docs/architecture.md` / `src/app/sitemap.ts` | Route coverage omitted `/docs/` routes that architecture and sitemap already describe | Added route rows for `/docs/` and `/docs/[slug]/` |
| `docs/digest-pipeline.md` | `worker/src/handlers/scheduled/daily-0805.ts` | Digest file index pointed only at the dispatcher | Added the slot runner row |
| `docs/blacklist-tracker.md` | `worker/src/handlers/scheduled/hourly-blacklist.ts` | Blacklist file index pointed only at the dispatcher | Added the slot runner row |
| `docs/mint-burn-flows.md` | `worker/src/handlers/scheduled/*mint-burn*.ts` | Registration wording hid the two isolated mint/burn slot files | Named the specific slot runners and shared helper |
| `docs/agent-code-map.md` | Current source tree | Generated map omitted newer files/exports | Regenerated from source |

### Terminology Standardization

- "Scheduled dispatcher" now refers to `worker/src/handlers/scheduled.ts`.
- "Slot runner" now refers to files under `worker/src/handlers/scheduled/*.ts` that own a specific cron lane.
- Public docs route coverage now uses exact route strings (`/docs/`, `/docs/[slug]/`, `/admin/`) and keeps host qualifiers in prose.

## Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|---|---:|---:|---:|---:|
| `docs/README.md` | checked | pass | 2 | 2 |
| `docs/agent-code-map.md` | checked | pass | 1 | 1 |
| `docs/blacklist-tracker.md` | checked | pass | 1 | 1 |
| `docs/digest-pipeline.md` | checked | pass | 1 | 1 |
| `docs/mint-burn-flows.md` | checked | pass | 1 | 1 |
| All other `docs/**/*.md` plus root `README.md` | checked | pass | 0 | 0 |
| TOTAL | checked | pass | 6 | 6 |
