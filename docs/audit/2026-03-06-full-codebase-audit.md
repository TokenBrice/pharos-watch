# Pharos Full Codebase Audit — 2026-03-06

## Executive Summary

### Overall Health
The codebase is structurally strong, with clear domain boundaries, broad API endpoint coverage, and strong use of shared modules. However, this audit identified **91 unique findings** after strict deduplication, including **10 critical** issues concentrated in security, status/observability, and testing. The largest systemic risks are dynamic SQL construction patterns in worker code, synthetic status probing that can report green while users fail, and untested high-complexity cron workflows.

Most remaining findings are medium/low quality and maintainability gaps, but there is a substantial high-severity band (31 findings) that can impact correctness, operator awareness, and user trust. Priority should be: (1) eliminate critical security/observability gaps, (2) harden cron status/error signaling, and (3) close testing blind spots around digest, PSI snapshot/recompute, and key frontend view-model flows.

### Findings by Severity
| Severity | Count |
|----------|-------|
| Critical | 10 |
| High | 31 |
| Medium | 32 |
| Low | 18 |
| **Total** | **91** |

### Domain Health
| Domain | Critical | High | Medium | Low | Verdict |
|--------|----------|------|--------|-----|---------|
| Documentation | 0 | 1 | 2 | 2 | Generally good; a few stale path/cache/env references remain. |
| Frontend: UI/UX | 0 | 7 | 4 | 3 | Main risk is error-state ambiguity that can mislead users during failures. |
| Frontend: Accessibility | 0 | 2 | 4 | 1 | Core UX is usable, but modal/form/table semantics need hardening. |
| Frontend: SEO & Meta | 0 | 1 | 2 | 3 | Baseline SEO is solid; route-level social metadata is incomplete. |
| API Correctness | 0 | 2 | 3 | 1 | Core contracts are good; error wrapping and input validation need tightening. |
| Cron Jobs & Data Pipeline | 0 | 4 | 4 | 2 | Reliability gaps center on silent-success paths and timeout/concurrency behavior. |
| Schema & Data Integrity | 0 | 4 | 3 | 1 | Performance and guardrail issues exist in hot-query/index/pagination paths. |
| Testing Coverage | 1 | 6 | 4 | 1 | Coverage breadth is uneven; critical cron/security/shared areas are under-tested. |
| Security | 7 | 0 | 4 | 3 | Systemic dynamic-SQL construction is the dominant security concern. |
| Status & Observability | 2 | 4 | 2 | 1 | Status exists but misses real-path probe fidelity and alert escalation cases. |

### Top 5 Most Impactful Findings
1. [SEC-005] Dynamic IN-clause SQL interpolation across digest/yield/timestamp code paths (`worker/src/cron/sync-yield-data.ts`, `worker/src/cron/daily-digest.ts`, `worker/src/lib/alchemy-logs.ts`) — critical, broad surface, high-effort remediation.
2. [STATUS-001] Synthetic status probes bypass the real production request path (`worker/src/cron/status-self-check.ts`) — critical observability blind spot with user-facing outage masking risk.
3. [SEC-001] Shared paginated-events helper uses dynamic table/order interpolation (`worker/src/lib/api-utils.ts`) — critical because it centralizes unsafe SQL-construction precedent.
4. [STATUS-002] Probe failures can avoid alerting when discrepancy logic does not trigger (`worker/src/cron/status-self-check.ts`) — critical detection/escalation gap.
5. [TEST-001] Daily digest cron has no tests (`worker/src/cron/daily-digest.ts`) — critical testing gap in a high-side-effect pipeline.

## Findings by Domain

### 1. Documentation

#### Critical
None

#### High
- [DOC-001] **Ticker-Migration Runbook Paths Point To Removed Directory** — The handover still uses `docs/plans/historical/ticker-issue-migration/...` in inventory/copy commands, but the repo path is `docs/plans/historical/ticker-issue-migration/...`; command blocks fail as written. File/Component: `docs/plans/historical/ticker-issue-migration/execution-handover.md` (references `docs/plans/historical/ticker-issue-migration/tickets/phase1-foundation/TICKET-001.md`). Effort: `[~1h]`

#### Medium
- [DOC-002] **Broken Cross-Reference In cmcs Preparation Guide** — The “Reference Implementation” link points to `../plans/historical/ticker-issue-migration/` instead of the legacy location. File/Component: `docs/process/cmcs-large-implementation-preparation.md`. Effort: `[~30m]`
- [DOC-003] **Worker Env Table Missing Active Binding** — Docs omit `MAINTENANCE_MODE` from the env table even though it is typed and actively used for maintenance `503` responses. File/Component: `docs/worker-infrastructure.md` (code: `worker/src/lib/env.ts`, `worker/src/handlers/http.ts`). Effort: `[~30m]`

#### Low
- [DOC-004] **Cache Profile Table Omits `status-history` No-Store Contract** — API docs list `no-store` for `health,status` but omit `GET /api/status-history`, which also sets `Cache-Control: no-store`. File/Component: `docs/api-reference.md` (code: `worker/src/api/status-history.ts`). Effort: `[~30m]`
- [DOC-005] **Prior Audit Report Path Inventory Is Now Stale** — Historical report includes many moved paths and now creates follow-up validation noise without context. File/Component: `docs/documentation-audit-report-2026-03-05.md`. Effort: `[~1h]`

### 2. Frontend: UI/UX

#### Critical
None

#### High
- [UX-001] **Dependency map masks fetch failures as empty state** — Query failures render like true empty data because errors are not read before empty fallback. File/Component: `src/app/dependency-map/client.tsx:13`. Effort: `[~small]`
- [UX-002] **Digest archive hides API errors behind "No digests yet"** — Early `!data` return runs before error handling, masking failure as empty archive. File/Component: `src/components/digest-archive-client.tsx:85`. Effort: `[~small]`
- [UX-003] **Depeg history reports healthy peg when query fails** — Only `isLoading` is handled; failed fetches can show "No depeg events recorded". File/Component: `src/components/depeg-history.tsx:32`. Effort: `[~small]`
- [UX-004] **KPI bar shows fabricated zero metrics on failed queries** — Missing data falls back to zeros, making outages look like real `$0` market conditions. File/Component: `src/components/kpi-bar.tsx:170`. Effort: `[~medium]`
- [UX-005] **Daily digest silently disappears on error/empty** — Component returns `null` after load when data is absent, with no feedback/retry affordance. File/Component: `src/components/daily-digest.tsx:21`. Effort: `[~small]`
- [UX-006] **Safety score history section swallows loading and failures** — Loading/error/empty paths all return `null`, hiding state from users. File/Component: `src/components/stablecoin-detail/safety-score-history-section.tsx:30`. Effort: `[~small]`
- [UX-007] **DEWS detail conflates failures with missing data** — Failed fetches flow into "No DEWS data available yet" messaging. File/Component: `src/components/dews-detail.tsx:72`. Effort: `[~small]`

#### Medium
- [UX-008] **Status dashboard can render a blank page** — `if (!data) return null` yields fully empty view with no recovery guidance. File/Component: `src/app/status/client.tsx:115`. Effort: `[~small]`
- [UX-009] **Status data tables can overflow on narrow viewports** — Raw tables without `overflow-x-auto` wrappers clip content on smaller screens. File/Component: `src/components/status/cache-freshness-table.tsx:21`, `src/components/status/circuit-breaker-table.tsx:29`, `src/components/status/transition-timeline.tsx:28`. Effort: `[~small]`
- [UX-010] **Compare desktop table lacks horizontal overflow container** — Min-width columns can break layout near the `sm` breakpoint. File/Component: `src/components/comparison-table.tsx:210`. Effort: `[~small]`
- [UX-011] **DEWS summary has no empty/error fallback** — After loading, missing signals cause a silent `null` render. File/Component: `src/components/dews-summary.tsx:514`. Effort: `[~small]`

#### Low
- [UX-012] **Compare page duplicates chart color palette with hardcoded hex values** — Local color map duplicates shared palette and increases drift risk. File/Component: `src/app/compare/client.tsx:48`, `src/lib/chart-colors.ts`. Effort: `[~small]`
- [UX-013] **Status severity colors are hardcoded instead of centralized semantic tokens** — Raw green/red class usage can drift from design-system semantics and accessibility tuning. File/Component: `src/components/status/cache-freshness-table.tsx:37`, `src/components/status/circuit-breaker-table.tsx:45`. Effort: `[~medium]`
- [UX-014] **Flows page header pattern diverges from shared page shell** — Custom header implementation diverges from common `FeaturePageShell` conventions. File/Component: `src/app/flows/page.tsx:56`, `src/components/feature-page-shell.tsx:53`. Effort: `[~medium]`

### 3. Frontend: Accessibility

#### Critical
None

#### High
- [A11Y-001] **Command palette is not exposed as a true modal dialog** — Overlay lacks proper dialog semantics/focus trapping and allows tabbing into background content. File/Component: `src/components/command-palette.tsx:262`. Effort: `[~medium]`
- [A11Y-002] **Multiple form controls are missing accessible labels** — Inputs/selects rely on placeholder or nearby text only, reducing programmatic label quality. File/Component: `src/components/status/admin-key-form.tsx:41`, `src/components/digest-archive-client.tsx:124`, `src/components/coin-selector.tsx:169`. Effort: `[~low]`

#### Medium
- [A11Y-003] **Selected state in button groups is not programmatically exposed** — Segmented controls do not set `aria-pressed` (or equivalent group semantics). File/Component: `src/app/safety-scores/client.tsx:302`, `src/components/feedback-modal.tsx:138`. Effort: `[~low]`
- [A11Y-004] **Data tables are missing captions/accessible table names** — Table-heavy views omit caption/label context for assistive tech. File/Component: `src/components/stablecoin-table.tsx:197`, `src/components/status/transition-timeline.tsx:28`, `src/components/stress-test-panel.tsx:173`. Effort: `[~medium]`
- [A11Y-005] **Table headers do not define explicit scope** — `<th>` elements often omit `scope`, weakening header associations. File/Component: `src/components/stress-test-panel.tsx:176` (pattern across data tables). Effort: `[~low]`
- [A11Y-006] **Homepage top-level heading is missing on small viewports** — Reliance on an `<h1>` in hidden `SiteHeader` leaves small screens without page-level heading. File/Component: `src/app/page.tsx:37`, `src/components/site-header.tsx:64`. Effort: `[~low]`

#### Low
- [A11Y-007] **Icon-only chart export controls rely on `title` instead of explicit accessible names** — Icon buttons need explicit `aria-label`/SR text for reliable AT support. File/Component: `src/components/total-mcap-chart.tsx:101`, `src/components/psi-history-chart.tsx:181`. Effort: `[~low]`

### 4. Frontend: SEO & Meta

#### Critical
None

#### High
- [SEO-001] **`og:image` missing on 12 route templates** — Several route templates emit no `og:image`, causing unreliable social-card previews. File/Component: `src/app/about/page.tsx:38`, `src/app/privacy/page.tsx:12`, `src/app/methodology/changelog-page-utils.ts:28`, `src/app/stablecoin/[id]/page.tsx:41`, `src/app/stablecoins/[peg]/page.tsx:38`, `src/app/digest/[date]/page.tsx:46`. Effort: `[~2-3h]`

#### Medium
- [SEO-002] **`og:type` missing on most routes** — Shared/page metadata objects often omit `openGraph.type` (`website`/`article`). File/Component: `src/lib/page-metadata.ts:28`, `src/app/methodology/changelog-page-utils.ts:28`, `src/app/about/page.tsx:38`, `src/app/stablecoin/[id]/page.tsx:41`. Effort: `[~1-2h]`
- [SEO-003] **`/status/` social cards point to homepage metadata** — Status page sets title/description/noindex but lacks route-level OG/Twitter fields, inheriting homepage preview metadata. File/Component: `src/app/status/page.tsx:4`. Effort: `[~30m]`

#### Low
- [SEO-004] **`robots.txt` is fully permissive (including admin-like route)** — Robots policy currently allows all paths with no explicit exclusion strategy for operational namespaces. File/Component: `src/app/robots.ts:7`. Effort: `[~20m]`
- [SEO-005] **Three page files have no local metadata export** — Homepage/blacklist/flows rely on parent layout metadata only, reducing per-route SEO ownership. File/Component: `src/app/page.tsx:9`, `src/app/blacklist/page.tsx:1`, `src/app/flows/page.tsx:1`, `src/app/layout.tsx:36`, `src/app/blacklist/layout.tsx:4`, `src/app/flows/layout.tsx:4`. Effort: `[~30-45m]`
- [SEO-006] **Stablecoin detail JSON-LD lacks `FinancialProduct` schema** — Detail pages publish `Dataset` JSON-LD but no product-level schema for richer search classification. File/Component: `src/app/stablecoin/[id]/page.tsx:125`. Effort: `[~1-2h]`

### 5. API Correctness

#### Critical
None

#### High
- [API-001] **Inline router admin handlers bypass centralized error wrapping** — Route-local handlers are not wrapped with `withErrorHandler`, so thrown errors can escape structured JSON contracts. File/Component: `worker/src/router.ts:146` (endpoints include `POST /api/trigger-digest`, `POST /api/reset-blacklist-sync`, `GET /api/debug-sync-state`). Effort: `[~2h]`
- [API-002] **Feedback endpoint has uncaught failure paths before final error response** — `handleFeedback` is not wrapped with `withErrorHandler`; pre-inner-catch failures can return non-standard 500 responses. File/Component: `worker/src/router.ts:137`, `worker/src/api/feedback.ts:320`. Effort: `[~1h]`

#### Medium
- [API-003] **Invalid calendar dates pass regex and return 404 instead of 400** — Date format regex accepts impossible dates, leading to not-found flow instead of input error. File/Component: `worker/src/api/digest-snapshot.ts:28`. Effort: `[~1h]`
- [API-004] **Malformed numeric query params are silently coerced/clamped, not rejected** — Shared parse helper defaults malformed numbers instead of returning `400`, conflicting with documented behavior. File/Component: `worker/src/lib/api-utils.ts:152`, `worker/src/api/depeg-events.ts:23`, `docs/api-reference.md:77`. Effort: `[~3h]`
- [API-005] **Admin GET responses inconsistently omit `no-store` headers** — Some admin/diagnostic GET endpoints rely on router cache bypass but omit explicit `Cache-Control: no-store`. File/Component: `worker/src/router.ts:208`, `worker/src/api/backfill-dews.ts:172`, `worker/src/api/audit-depeg-history.ts:299`. Effort: `[~1h]`

#### Low
- [API-006] **Stablecoin detail cache profile is documented inconsistently** — Top profile table is correct, but endpoint section labels `GET /api/stablecoin/:id` as realtime instead of per-coin cached. File/Component: `docs/api-reference.md:164`, `worker/src/api/stablecoin-detail/shared.ts:45`. Effort: `[~15m]`
- Deduplicated note: legacy `API-007` is merged into **DOC-004** (same `status-history` no-store documentation omission and root cause).

### 6. Cron Jobs & Data Pipeline

#### Critical
None

#### High
- [CRON-001] **Silent-success cron paths bypass alerting and can show healthy status while stale** — Several jobs return early on upstream failures without degraded/error status, and run logging defaults to `ok`. File/Component: `worker/src/cron/sync-stablecoin-charts.ts:63`, `worker/src/cron/sync-usds-status.ts:93`, `worker/src/cron/sync-bluechip.ts:103`, `worker/src/lib/db.ts:374`, `worker/src/api/status.ts:202`. Effort: `[~4h]`
- [CRON-002] **Blacklist sync swallows partial API failures but still reports success** — Per-config failures are counted/logged but job returns success semantics. File/Component: `worker/src/cron/sync-blacklist.ts:710`, `worker/src/cron/sync-blacklist.ts:719`. Effort: `[~3h]`
- [CRON-003] **Quarter-hour slot has connection-fanout risk against Workers 6-connection limit** — Concurrent schedule plus nested fan-out in stablecoin sync risks intermittent connection exhaustion. File/Component: `worker/src/handlers/scheduled.ts:118`, `worker/src/handlers/scheduled.ts:125`, `worker/src/handlers/scheduled.ts:126`, `worker/src/cron/sync-stablecoins.ts:296`, `worker/src/cron/sync-stablecoins/supplemental-assets.ts:318`, `docs/worker-and-api-limits.md:23`. Effort: `[~6h]`
- [CRON-004] **Abort signal is not propagated through major `sync-stablecoins` sub-pipelines** — Timeout signal is established but not threaded through key helper calls, allowing continued side-effecting work after timeout intent. File/Component: `worker/src/lib/db.ts:348`, `worker/src/cron/sync-stablecoins.ts:291`, `worker/src/cron/sync-stablecoins.ts:300`, `worker/src/cron/sync-stablecoins.ts:389`, `worker/src/cron/sync-stablecoins.ts:432`, `worker/src/cron/sync-stablecoins/supplemental-assets.ts:300`. Effort: `[~5h]`

#### Medium
- [CRON-005] **Cron timeout policy mismatches Worker CPU cap** — `cpu_ms = 5000` conflicts with in-app 5-15 minute timeout assumptions. File/Component: `worker/wrangler.toml:10`, `worker/src/lib/db.ts:328`. Effort: `[~2h]`
- [CRON-006] **Depeg sub-stage failures do not degrade `sync-stablecoins` status** — Depeg stage errors are metadata-only and do not force degraded run status. File/Component: `worker/src/cron/sync-stablecoins.ts:563`, `worker/src/cron/sync-stablecoins.ts:596`. Effort: `[~2h]`
- [CRON-007] **Yield sync writes are non-atomic across tables/cache** — Multi-step writes lack run-level atomicity, risking mixed-era state on partial failure. File/Component: `worker/src/cron/sync-yield-data.ts:588`, `worker/src/cron/sync-yield-data.ts:597`, `worker/src/cron/sync-yield-data.ts:641`. Effort: `[~6h]`
- [CRON-008] **`status: "error"` return does not trigger alerts** — `sync-mint-burn` may return `status: "error"`, but alerting only runs on thrown exceptions. File/Component: `worker/src/cron/sync-mint-burn.ts:608`, `worker/src/cron/sync-mint-burn.ts:667`, `worker/src/lib/db.ts:393`. Effort: `[~2h]`

#### Low
- [CRON-009] **Internal depeg/enrichment stages are not first-class monitored jobs** — Significant sub-stages inside `sync-stablecoins` are not independently tracked in schedule/status coverage. File/Component: `worker/src/cron/sync-stablecoins.ts:8`, `worker/src/cron/sync-stablecoins.ts:9`, `worker/src/lib/cron-schedule.ts:16`. Effort: `[~3h]`
- [CRON-010] **Alert transport has single-channel dependency** — Alert helper supports webhook target only; no optional multi-sink failover. File/Component: `worker/src/lib/alerts.ts:8`, `worker/src/handlers/scheduled.ts:269`. Effort: `[~3h]`

### 7. Schema & Data Integrity

#### Critical
None

#### High
- [SCHEMA-001] **Invalid Wrangler Config Blocks Binding Validation** — `worker/wrangler.toml` has an unclosed `routes` array and fails TOML parsing, blocking reliable config/binding validation. File/Component: `worker/wrangler.toml:5`. Effort: `[~15m]`
- [SCHEMA-002] **Public Blacklist Endpoint Allows Unbounded Reads** — Default `limit=0` can disable SQL `LIMIT` and allow full-table reads from public endpoint. File/Component: `worker/src/api/blacklist.ts:33`, `worker/src/lib/db.ts:28`. Effort: `[~1h]`
- [SCHEMA-003] **Mint/Burn Events Query Missing Composite Covering Index** — Hot query (`stablecoin_id + chain_id` ordered by `timestamp DESC`) is under-indexed and can scan large partitions. File/Component: `worker/src/api/mint-burn-events.ts:72`, table `mint_burn_events`. Effort: `[~0.5d]`
- [SCHEMA-004] **Health/Freshness Symbol Query Full-Scans ~1M Event Rows** — Health/freshness symbol aggregation lacks supporting `symbol` index on large event table. File/Component: `worker/src/api/health.ts:69`, table `mint_burn_events`. Effort: `[~0.5d]`

#### Medium
- [SCHEMA-005] **Blacklist Filtered Pagination Sorts via Temp B-Tree** — Filtered query paths sort by timestamp without aligned composite indexes, forcing extra sort work. File/Component: `worker/src/api/blacklist.ts:81`, table `blacklist_events`. Effort: `[~0.5d]`
- [SCHEMA-006] **Backfill Depegs Uses Unbounded `db.batch()` Statement Count** — Per-coin batch can exceed D1 statement limits on long histories. File/Component: `worker/src/api/backfill-depegs.ts:387`, table `depeg_events`. Effort: `[~1h]`
- [SCHEMA-007] **Migration Number Collision at `0046` Increases Ordering Risk** — Two migration files share numeric prefix, increasing sequence ambiguity and script fragility. File/Component: `worker/migrations/0046_mint_burn_bridge_classification.sql:1` (paired `0046` migration). Effort: `[~1h]`

#### Low
- [SCHEMA-008] **Purely Destructive Migration Exists Without In-File Recreate** — `0020_drop_mint_burn.sql` drops critical tables without same-file recreate safety. File/Component: `worker/migrations/0020_drop_mint_burn.sql:1`. Effort: `[~2h]`
- Deduplicated note: legacy `SCHEMA-009` is merged into **SEC-001** (same dynamic `tableName/orderBy` interpolation in `worker/src/lib/api-utils.ts` and root cause).

### 8. Testing Coverage

#### Critical
- [TEST-001] **Daily Digest Cron Has No Tests** — `generateDailyDigest` has no direct tests despite complex aggregation, LLM shaping, DB writes, and social side effects. File/Component: `worker/src/cron/daily-digest.ts`. Effort: `[~L]`

#### High
- [TEST-002] **PSI Daily Snapshot/Recompute Path Untested** — Snapshot/recompute logic for daily PSI history has no direct tests for boundary math and stale-snapshot tolerance. File/Component: `worker/src/cron/snapshot-psi.ts`, `worker/src/lib/psi-recompute.ts`. Effort: `[~M]`
- [TEST-003] **Admin Auth Helper Lacks Direct Security Tests** — No dedicated helper-level tests for malformed headers/missing key/timing-safe compare behavior. File/Component: `worker/src/lib/auth.ts`. Effort: `[~S]`
- [TEST-004] **`mock-d1` Can Hide SQL/Bind Regressions** — Mock behavior is low-fidelity (substring matching, bind-insensitive, always-success batch semantics). File/Component: `worker/src/api/__tests__/helpers/mock-d1.ts`. Effort: `[~M]`
- [TEST-005] **Fixture Shapes Drifted From Runtime Schemas** — Fixture builders emit outdated/minimal shapes not aligned with current runtime schema requirements. File/Component: `worker/src/api/__tests__/helpers/fixtures.ts`, `shared/types/index.ts`. Effort: `[~M]`
- [TEST-006] **Multiple Data-Transformation Crons Are Untested** — Several transform/config crons and related paths lack direct tests. File/Component: `worker/src/cron/sync-stablecoin-charts.ts`, `worker/src/cron/sync-usds-status.ts`, `worker/src/cron/sync-bluechip.ts`, `worker/src/cron/yield-config.ts`. Effort: `[~L]`
- [TEST-007] **Frontend Coverage Misses Core View-Model and Pages** — No `src/app` tests and no direct test for the detail-page aggregation hook. File/Component: `src/hooks/use-stablecoin-detail-view-model.ts`, `src/app/**`. Effort: `[~M]`

#### Medium
- [TEST-008] **Cache-Passthrough API Tests Are Mostly Envelope Checks** — Route-specific payload contract assertions are shallow for several passthrough handlers. File/Component: `worker/src/api/stablecoins.ts`, `worker/src/api/stablecoin-charts.ts`, `worker/src/api/usds-status.ts`, `worker/src/api/bluechip.ts`, `worker/src/api/yield-rankings.ts` (tests: `worker/src/api/__tests__/cache-passthrough.test.ts`). Effort: `[~S]`
- [TEST-009] **Weak Assertions Present in Critical API Tests** — Use of `toBeTruthy()`/`toBeDefined()` where concrete value-level checks are expected. File/Component: `worker/src/api/peg-summary.ts`, `worker/src/api/stablecoin-summary.ts`, `worker/src/api/stablecoin-detail.ts` (tests: `worker/src/api/__tests__/peg-summary.test.ts`, `worker/src/api/__tests__/stablecoin-summary.test.ts`, `worker/src/api/__tests__/stablecoin-detail.test.ts`). Effort: `[~S]`
- [TEST-010] **`sync-stablecoins` Test Is Heavily Coupled to Mocks/Internals** — Over-mocking internals reduces integration confidence and increases refactor brittleness. File/Component: `worker/src/cron/sync-stablecoins.ts` (tests: `worker/src/cron/__tests__/sync-stablecoins.test.ts`). Effort: `[~M]`
- [TEST-011] **Shared Library Has Only One Dedicated Test File** — Most shared modules lack direct shared-layer tests. File/Component: `shared/lib/peg-rates.ts`, `shared/lib/psi-eligible.ts`, `shared/lib/chains.ts` (only dedicated file: `shared/lib/__tests__/stablecoin-id-registry.test.ts`). Effort: `[~M]`

#### Low
- [TEST-012] **Clock-Dependent Tests Without Explicit Time Control** — Some tests use wall-clock behavior without consistent fake timers/time pinning, risking edge-case flakes. File/Component: `worker/src/api/digest-snapshot.ts`, `worker/src/api/stablecoin-summary.ts`, `worker/src/api/cache-passthrough.ts` (tests: `worker/src/api/__tests__/digest-snapshot.test.ts`, `worker/src/api/__tests__/stablecoin-summary.test.ts`, `worker/src/api/__tests__/cache-passthrough.test.ts`). Effort: `[~S]`

### 9. Security

#### Critical
- [SEC-001] **Dynamic SQL from table/order interpolation in shared helper** — `fetchPaginatedEvents()` interpolates `${config.tableName}` and `${config.orderBy}`; currently safe-by-convention but structurally injection-prone. File/Component: `worker/src/lib/api-utils.ts:303`. Effort: `[~2-4h]`
- [SEC-002] **Template-fragment SQL interpolation in mint/burn backfill repair** — SQL text interpolates `WHERE` fragment (`${needsRepairWhere}`) and breaks parameterized-query discipline. File/Component: `worker/src/api/backfill-mint-burn-prices.ts:17`. Effort: `[~1-2h]`
- [SEC-003] **Dynamic table interpolation in DEWS cleanup** — Dynamic table interpolation appears in select/delete operations. File/Component: `worker/src/cron/compute-dews.ts:55`. Effort: `[~1-2h]`
- [SEC-004] **Dynamic IN-clause SQL interpolation in status/health paths** — Placeholder list strings are interpolated into SQL in status/health/scheduled flows. File/Component: `worker/src/api/status.ts:145`, `worker/src/api/health.ts:69`, `worker/src/handlers/scheduled.ts:197`. Effort: `[~2-4h]`
- [SEC-005] **Dynamic IN-clause interpolation in digest/yield/timestamp queries** — Same interpolation pattern appears across multiple cron/lib query paths. File/Component: `worker/src/cron/sync-yield-data.ts:217`, `worker/src/cron/sync-yield-data.ts:455`, `worker/src/cron/sync-yield-data.ts:466`, `worker/src/cron/daily-digest.ts:344`, `worker/src/lib/alchemy-logs.ts:389`. Effort: `[~4-8h]`
- [SEC-006] **SQL string concatenation in mint/burn context loader** — Query text is assembled via concatenation around dynamic placeholder lists. File/Component: `worker/src/lib/mint-burn-pipeline/context.ts:38`, `worker/src/lib/mint-burn-pipeline/context.ts:53`. Effort: `[~1-2h]`
- [SEC-007] **Dynamic cache-key IN query interpolation** — Cache freshness query builds SQL text with placeholder list interpolation. File/Component: `worker/src/lib/api-utils.ts:56`. Effort: `[~1-2h]`

#### High
None

#### Medium
- [SEC-008] **Feedback rate limit is race-prone (check-then-insert)** — Separate count/insert operations allow concurrent burst bypass risk. File/Component: `worker/src/api/feedback.ts:50`. Effort: `[~2-4h]`
- [SEC-009] **Hardcoded fallback salt for IP hashing** — Predictable fallback salt weakens privacy guarantees if secret is unset. File/Component: `worker/src/api/feedback.ts:319`. Effort: `[~1h]`
- [SEC-010] **No general rate limiting on public API surface** — Public endpoints have no general request throttling middleware, increasing abuse/DoS exposure on expensive query paths. File/Component: `worker/src/router.ts:62`, `worker/src/handlers/http.ts:35`. Effort: `[~4-8h]`
- [SEC-011] **Malformed path can throw during `decodeURIComponent`** — Path decode calls are not guarded and malformed encodings can trigger unhandled exceptions. File/Component: `worker/src/router.ts:275`, `worker/src/router.ts:287`. Effort: `[~1h]`

#### Low
- [SEC-012] **CSP allows inline scripts/styles** — `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` reduce CSP effectiveness. File/Component: `public/_headers:7`. Effort: `[~4-8h]`
- [SEC-013] **Worker API headers omit frame policy header** — API responses omit `X-Frame-Options`, leaving a defense-in-depth hardening gap. File/Component: `worker/src/handlers/http.ts:9`. Effort: `[~30m]`
- [SEC-014] **Secrets/config mostly typed optional in Env** — Sensitive env variables are mostly optional at type level without strict startup validation. File/Component: `worker/src/lib/env.ts:4`. Effort: `[~2-3h]`

### 10. Status & Observability

#### Critical
- [STATUS-001] **Synthetic probes bypass real production path** — `runStatusSelfCheck` calls `route(...)` directly, bypassing DNS/TLS/CDN edge behavior and maintenance-mode gating. File/Component: `worker/src/cron/status-self-check.ts:64`. Effort: `[~1 day]`
- [STATUS-002] **Probe failures can avoid alerting entirely** — Alerting is tied to discrepancy logic; sustained probe failures can go unalerted when status/probe degrade together. File/Component: `worker/src/cron/status-self-check.ts:148`. Effort: `[~0.5 day]`

#### High
- [STATUS-003] **Supply freshness blind spot via "ok with 0 rows"** — `snapshot-supply` can report successful run with `itemCount: 0`, and status treats it as healthy execution. File/Component: `worker/src/cron/snapshot-supply.ts:15`. Effort: `[~1 day]`
- [STATUS-004] **No explicit DB health sentinel; partial DB failures are masked** — Status data-quality queries can swallow DB errors and continue with fallback values. File/Component: `worker/src/api/status.ts:525`. Effort: `[~0.5-1 day]`
- [STATUS-005] **Reliability history is not exposed as a queryable time series** — History API lacks probe-history windows, uptime percentage fields, and maintenance-adjusted SLI outputs. File/Component: `worker/src/api/status-history.ts:20`. Effort: `[~1-2 days]`
- [STATUS-006] **External dependency monitoring coverage is incomplete** — Circuit/status coverage omits several critical providers from telemetry and alert surfaces. File/Component: `worker/src/lib/constants.ts:103`. Effort: `[~1-2 days]`

#### Medium
- [STATUS-007] **Status UI hides secondary API failures** — Dashboard primarily hard-fails only on `/api/status`; health/probe fetch failures are not surfaced clearly. File/Component: `src/app/status/client.tsx:72`. Effort: `[~0.5 day]`
- [STATUS-008] **Freshness is not reported per critical dataset** — Status payload does not expose dataset-level freshness blocks for key tables/feeds. File/Component: `worker/src/api/status.ts:615`. Effort: `[~1 day]`

#### Low
- [STATUS-009] **`status-history` lacks time-range query semantics** — Endpoint supports `limit` only; a `days` style query is ignored and not clearly documented. File/Component: `worker/src/api/status-history.ts:17`. Effort: `[~0.5 day]`

## Cross-Cutting Concerns
- Error-state ambiguity and silent degradation handling appears in frontend UX, API wrapping, cron result signaling, and status surfaces (UX-001/002/003/004/005/006/007/008/011, API-001/002, CRON-001/002/006/008, STATUS-002/007).
- SQL construction patterns need a single secure standard: dynamic SQL interpolation appears across security-critical helpers and multiple cron/API paths (SEC-001 through SEC-007), while schema concerns confirm guardrail/perf exposure in nearby query builders (SCHEMA-002/003/004/005/006).
- Test confidence does not match operational criticality: complex cron and shared runtime logic are under-tested (TEST-001/002/003/006/011), increasing risk for regressions in already high-severity areas (security/status/cron).
- Documentation and contract drift still recurs at API/cache/env boundaries (DOC-003/004, API-004/006), indicating a need for tighter docs-as-contract checks in CI.
- Observability coverage is not yet end-to-end: probe fidelity, provider coverage, dataset freshness surfaces, and alert semantics have gaps (STATUS-001/002/005/006/008, CRON-009/010).

## Appendix

### Audit Methodology
- 10 parallel Codex agents, one per domain
- Each agent examined specific files and produced findings
- Findings consolidated, deduplicated, and cross-referenced
- Live probes against pharos.watch and api.pharos.watch

### Severity Definitions
| Severity | Definition |
|----------|-----------|
| Critical | Production risk, data loss, security vulnerability |
| High | Correctness issue, wrong behavior |
| Medium | Quality/maintainability concern |
| Low | Cosmetic, nice-to-have |

### Effort Estimate Key
| Tag | Meaning |
|-----|---------|
| [~30m] | Quick fix, single file |
| [~1h] | Small change, 1-2 files |
| [~2h] | Moderate change, 2-4 files |
| [~4h] | Half-day task |
| [~1d] | Full day |
| [~2-3d] | Multi-day effort |
| [~1w] | Week-long project |
