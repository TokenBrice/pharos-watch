# Audit Remediation — Design Document

**Date:** 2026-03-06
**Source:** `agents/audit/2026-03-06-full-codebase-audit.md` (91 findings)
**Scope:** Critical + High + Medium findings only (73 of 91; 18 Low deferred)

## Strategy

Implement all 73 findings across 5 cross-cutting phases, ordered by risk and dependency. Each phase groups thematically related findings so changes are co-located and reviewable as coherent units.

## Phase Overview

| Phase | Theme | Findings | Worktrees | Depends On |
|-------|-------|----------|-----------|------------|
| 1 | SQL Safety & Input Validation | 17 | 2-3 | — |
| 2 | Error-State Handling & Degraded UX | 18 | 2 | — |
| 3 | Cron Reliability & Observability | 16 | 3 | Phase 2 |
| 4 | Testing Coverage | 11 | 3 | Phases 1-3 |
| 5 | Docs, SEO, Accessibility & Config Polish | 11 | 2 | Phases 1-3 |

**Phases 1 & 2 can run in parallel** — they touch disjoint files (worker SQL/API vs frontend components).
**Phases 4 & 5 can run in parallel** — tests and docs/SEO are independent.
**Phase 3 depends on Phase 2** — cron status reporting builds on error-propagation patterns.
**Phase 4 depends on Phases 1-3** — tests should target fixed code, not stale behavior.

## Phase 1: SQL Safety & Input Validation

### Findings (17)

**Critical (7):**
- SEC-001: Dynamic table/order interpolation in `fetchPaginatedEvents()` (`worker/src/lib/api-utils.ts:303`)
- SEC-002: WHERE fragment interpolation in mint/burn backfill (`worker/src/api/backfill-mint-burn-prices.ts:17`)
- SEC-003: Dynamic table interpolation in DEWS cleanup (`worker/src/cron/compute-dews.ts:55`)
- SEC-004: Dynamic IN-clause in status/health (`worker/src/api/status.ts:145`, `worker/src/api/health.ts:69`, `worker/src/handlers/scheduled.ts:197`)
- SEC-005: Dynamic IN-clause in digest/yield/timestamp (`worker/src/cron/sync-yield-data.ts`, `worker/src/cron/daily-digest.ts`, `worker/src/lib/alchemy-logs.ts`)
- SEC-006: SQL concatenation in mint/burn context loader (`worker/src/lib/mint-burn-pipeline/context.ts:38`)
- SEC-007: Dynamic cache-key IN query (`worker/src/lib/api-utils.ts:56`)

**High (2):**
- SCHEMA-002: Public blacklist endpoint allows unbounded reads (`worker/src/api/blacklist.ts:33`)
- API-001: Inline admin handlers bypass `withErrorHandler` (`worker/src/router.ts:146`)

**Medium (8):**
- SEC-008: Feedback rate-limit race condition (`worker/src/api/feedback.ts:50`)
- SEC-009: Hardcoded fallback salt (`worker/src/api/feedback.ts:319`)
- SEC-010: No general rate limiting on public API (`worker/src/router.ts:62`)
- SEC-011: Unguarded `decodeURIComponent` (`worker/src/router.ts:275`)
- SCHEMA-005: Blacklist filtered pagination missing index (`worker/src/api/blacklist.ts:81`)
- SCHEMA-006: Unbounded `db.batch()` in backfill depegs (`worker/src/api/backfill-depegs.ts:387`)
- API-003: Invalid dates pass regex → 404 instead of 400 (`worker/src/api/digest-snapshot.ts:28`)
- API-004: Malformed numeric params silently coerced (`worker/src/lib/api-utils.ts:152`)

### Approach

1. **Centralized `buildInClause()` helper** in `worker/src/lib/db.ts`: returns `{ sql: string, binds: unknown[] }`. All SEC IN-clause findings (SEC-004/005/006/007) use this.
2. **Allowlist pattern for table/column interpolation**: `fetchPaginatedEvents()` validates against a const set of allowed table/column names (SEC-001). Same pattern for SEC-003 (DEWS tables).
3. **Parameterize WHERE fragment** in SEC-002 — replace string interpolation with builder pattern.
4. **Wrap inline admin routes** with `withErrorHandler` (API-001).
5. **Add default LIMIT cap** (1000) for public blacklist endpoint (SCHEMA-002).
6. **Composite index** for blacklist filtered pagination (SCHEMA-005).
7. **Chunk `db.batch()`** calls in backfill-depegs (SCHEMA-006).
8. **Date validation**: reject impossible calendar dates with 400 (API-003).
9. **Strict numeric parsing**: return 400 on malformed params instead of clamping (API-004).
10. **Guard `decodeURIComponent`** with try/catch, return 400 on malformed (SEC-011).
11. **Feedback hardening**: use INSERT-or-reject for rate limit (SEC-008), require env salt with startup check (SEC-009).
12. **Basic rate limiting middleware**: per-IP sliding window using D1 or in-memory counter (SEC-010).

### Worktrees

- `fix-sql-safety`: SEC-001→007 + SCHEMA-005 (SQL patterns + index)
- `fix-api-input`: API-001/003/004, SEC-008/009/010/011, SCHEMA-002/006 (input validation + API hardening)

## Phase 2: Error-State Handling & Degraded UX

### Findings (18)

**High (8):**
- UX-001: Dependency map masks fetch failures (`src/app/dependency-map/client.tsx:13`)
- UX-002: Digest archive hides errors (`src/components/digest-archive-client.tsx:85`)
- UX-003: Depeg history shows healthy on failure (`src/components/depeg-history.tsx:32`)
- UX-004: KPI bar shows zero on failure (`src/components/kpi-bar.tsx:170`)
- UX-005: Daily digest disappears on error (`src/components/daily-digest.tsx:21`)
- UX-006: Safety score history swallows errors (`src/components/stablecoin-detail/safety-score-history-section.tsx:30`)
- UX-007: DEWS detail conflates failure with missing (`src/components/dews-detail.tsx:72`)
- API-002: Feedback endpoint uncaught failures (`worker/src/api/feedback.ts:320`)

**Medium (10):**
- UX-008: Status dashboard blank on failure (`src/app/status/client.tsx:115`)
- UX-009: Status tables overflow on narrow viewports (`src/components/status/cache-freshness-table.tsx:21`)
- UX-010: Compare table lacks overflow container (`src/components/comparison-table.tsx:210`)
- UX-011: DEWS summary no empty/error fallback (`src/components/dews-summary.tsx:514`)
- API-005: Admin GETs missing `no-store` headers (`worker/src/router.ts:208`)
- CRON-006: Depeg failures don't degrade sync status (`worker/src/cron/sync-stablecoins.ts:563`)
- CRON-008: `status: "error"` doesn't trigger alerts (`worker/src/cron/sync-mint-burn.ts:608`)
- A11Y-003: Button groups missing `aria-pressed` (`src/app/safety-scores/client.tsx:302`)
- A11Y-004: Data tables missing captions (`src/components/stablecoin-table.tsx:197`)
- A11Y-005: Table headers missing `scope` (`src/components/stress-test-panel.tsx:176`)

### Approach

1. **Uniform error-before-empty pattern**: In all UX-001→007 components, check `isError` before the `!data` early return. Render `QueryErrorNotice` (already exists) with retry affordance.
2. **UX-008→011**: Add error fallbacks and `overflow-x-auto` wrappers.
3. **A11Y-003/004/005**: Add `aria-pressed` to toggle buttons, `<caption>` to data tables, `scope` to `<th>` elements — co-located with the same components being fixed for UX.
4. **API-002**: Wrap feedback handler with `withErrorHandler`.
5. **API-005**: Add explicit `Cache-Control: no-store` to admin GET endpoints.
6. **CRON-006/008**: Propagate sub-stage failures to degraded run status; trigger alerts on `status: "error"` returns.

### Worktrees

- `fix-frontend-errors`: UX-001→011, A11Y-003/004/005 (all frontend)
- `fix-worker-errors`: API-002/005, CRON-006/008 (all worker)

## Phase 3: Cron Reliability & Observability

### Findings (16)

**Critical (2):**
- STATUS-001: Synthetic probes bypass real path (`worker/src/cron/status-self-check.ts:64`)
- STATUS-002: Probe failures avoid alerting (`worker/src/cron/status-self-check.ts:148`)

**High (8):**
- CRON-001: Silent-success paths bypass alerting (`worker/src/cron/sync-stablecoin-charts.ts:63`)
- CRON-002: Blacklist sync swallows partial failures (`worker/src/cron/sync-blacklist.ts:710`)
- CRON-003: Quarter-hour connection fanout risk (`worker/src/handlers/scheduled.ts:118`)
- CRON-004: Abort signal not propagated (`worker/src/cron/sync-stablecoins.ts:291`)
- STATUS-003: Supply freshness blind spot (`worker/src/cron/snapshot-supply.ts:15`)
- STATUS-004: No DB health sentinel (`worker/src/api/status.ts:525`)
- STATUS-005: No queryable reliability history (`worker/src/api/status-history.ts:20`)
- STATUS-006: Incomplete dependency monitoring (`worker/src/lib/constants.ts:103`)

**Medium (6):**
- CRON-005: Timeout policy mismatch (`worker/wrangler.toml:10`)
- CRON-007: Yield sync non-atomic writes (`worker/src/cron/sync-yield-data.ts:588`)
- STATUS-007: Status UI hides secondary failures (`src/app/status/client.tsx:72`)
- STATUS-008: No per-dataset freshness (`worker/src/api/status.ts:615`)
- SCHEMA-003: Mint/burn events missing composite index (`worker/src/api/mint-burn-events.ts:72`)
- SCHEMA-004: Health symbol query full-scans events (`worker/src/api/health.ts:69`)

### Approach

1. **Real HTTP probes (STATUS-001)**: Replace `route()` call with `fetch()` against the worker's own URL.
2. **Independent alert on probe failure (STATUS-002)**: Add dedicated alert path that fires on probe failure regardless of discrepancy logic.
3. **Silent-success elimination (CRON-001/002)**: Jobs that return early on upstream failure must set `status: "degraded"` and log via alert helper.
4. **Connection budget (CRON-003)**: Serialize or stagger concurrent jobs on the quarter-hour slot; add connection-budget awareness.
5. **Abort propagation (CRON-004)**: Thread abort signal through sub-pipeline calls in sync-stablecoins.
6. **Timeout alignment (CRON-005)**: Reconcile `cpu_ms` with in-app timeout assumptions.
7. **Yield atomicity (CRON-007)**: Wrap multi-step writes in `db.batch()`.
8. **Supply zero-row detection (STATUS-003)**: Fail/degrade when snapshot produces 0 rows.
9. **DB health sentinel (STATUS-004)**: Add lightweight DB ping to status checks.
10. **Status history expansion (STATUS-005)**: Add time-range query support and uptime percentage.
11. **Dependency monitoring (STATUS-006)**: Add missing providers to circuit/status coverage.
12. **Status UI (STATUS-007)**: Surface secondary API failures in dashboard.
13. **Per-dataset freshness (STATUS-008)**: Add dataset-level freshness blocks to status payload.
14. **Performance indexes (SCHEMA-003/004)**: Add composite covering indexes for hot queries.

### Worktrees

- `fix-probe-alerts`: STATUS-001/002 (probe fidelity + alert hardening)
- `fix-cron-reliability`: CRON-001→005/007, STATUS-003 (cron job reliability)
- `fix-status-api`: STATUS-004→008, SCHEMA-003/004 (status API + indexes)

## Phase 4: Testing Coverage

### Findings (11)

**Critical (1):**
- TEST-001: Daily digest cron untested (`worker/src/cron/daily-digest.ts`)

**High (6):**
- TEST-002: PSI snapshot/recompute untested (`worker/src/cron/snapshot-psi.ts`)
- TEST-003: Auth helper lacks security tests (`worker/src/lib/auth.ts`)
- TEST-004: `mock-d1` hides regressions (`worker/src/api/__tests__/helpers/mock-d1.ts`)
- TEST-005: Fixtures drifted from schemas (`worker/src/api/__tests__/helpers/fixtures.ts`)
- TEST-006: Multiple cron transforms untested (`worker/src/cron/sync-stablecoin-charts.ts`)
- TEST-007: Frontend misses core view-model tests (`src/hooks/use-stablecoin-detail-view-model.ts`)

**Medium (4):**
- TEST-008: Cache-passthrough tests are shallow (`worker/src/api/__tests__/cache-passthrough.test.ts`)
- TEST-009: Weak assertions in API tests (`worker/src/api/__tests__/peg-summary.test.ts`)
- TEST-010: sync-stablecoins test over-mocked (`worker/src/cron/__tests__/sync-stablecoins.test.ts`)
- TEST-011: Shared library under-tested (`shared/lib/peg-rates.ts`)

### Approach

1. **Test infrastructure first (TEST-004/005)**: Improve mock-d1 fidelity (bind-sensitive, batch failure). Update fixture builders to match current schemas. This is a prerequisite for other worker tests.
2. **Worker tests (TEST-001/002/003/006/008/009/010)**: Write tests for daily digest, PSI snapshot, auth helper, untested crons. Strengthen shallow API tests and reduce mock coupling.
3. **Frontend + shared tests (TEST-007/011)**: Add tests for detail-page view-model hook and shared lib modules.

### Worktrees

- `fix-test-infra`: TEST-004/005 (prerequisite — must complete before other test worktrees)
- `fix-worker-tests`: TEST-001/002/003/006/008/009/010 (dependent on fix-test-infra)
- `fix-frontend-tests`: TEST-007/011 (independent of fix-test-infra)

## Phase 5: Docs, SEO, Accessibility & Config Polish

### Findings (11)

**High (5):**
- DOC-001: Stale migration runbook paths (`docs/plans/historical/ticker-issue-migration/execution-handover.md`)
- SEO-001: `og:image` missing on 12 routes (`src/app/about/page.tsx`, etc.)
- A11Y-001: Command palette not a dialog (`src/components/command-palette.tsx:262`)
- A11Y-002: Form controls missing labels (`src/components/status/admin-key-form.tsx:41`)
- SCHEMA-001: Invalid wrangler.toml (`worker/wrangler.toml:5`)

**Medium (6):**
- DOC-002: Broken cross-reference in cmcs guide (`docs/process/cmcs-large-implementation-preparation.md`)
- DOC-003: Worker env table missing MAINTENANCE_MODE (`docs/worker-infrastructure.md`)
- SEO-002: `og:type` missing on routes (`src/lib/page-metadata.ts:28`)
- SEO-003: Status page social cards inherit homepage (`src/app/status/page.tsx:4`)
- A11Y-006: Homepage missing h1 on small viewports (`src/app/page.tsx:37`)
- SCHEMA-007: Migration number collision at 0046 (`worker/migrations/0046_mint_burn_bridge_classification.sql`)

### Approach

1. **Config fix**: Fix wrangler.toml TOML parse error (SCHEMA-001).
2. **Docs fixes**: Update stale paths, add missing env bindings, fix cross-references (DOC-001/002/003).
3. **SEO metadata**: Add `og:image` and `og:type` to all route templates via shared metadata helper extension (SEO-001/002/003).
4. **A11Y dialog**: Convert command palette to proper `<dialog>` or Radix Dialog with focus trap (A11Y-001).
5. **A11Y labels**: Add `aria-label` / `<label>` to unlabeled form controls (A11Y-002).
6. **A11Y heading**: Ensure visible `<h1>` on all viewports (A11Y-006).
7. **Migration rename**: Rename one of the colliding 0046 files (SCHEMA-007).

### Worktrees

- `fix-seo-a11y`: SEO-001/002/003, A11Y-001/002/006 (frontend)
- `fix-docs-config`: DOC-001/002/003, SCHEMA-001/007 (non-frontend)

## Excluded (18 Low findings — deferred)

DOC-004, DOC-005, UX-012, UX-013, UX-014, A11Y-007, SEO-004, SEO-005, SEO-006, API-006, CRON-009, CRON-010, SCHEMA-008, TEST-012, SEC-012, SEC-013, SEC-014, STATUS-009.

## Execution Timeline

```
Week 1:  Phase 1 ─────────────┐
         Phase 2 ─────────────┤ (parallel)
                               │
Week 2:  Phase 3 ─────────────┤ (after Phase 2)
                               │
Week 3:  Phase 4 ─────────────┤ (after Phases 1-3)
         Phase 5 ─────────────┘ (parallel with Phase 4)
```

Total worktrees: 13 (across 5 phases, never more than 4-5 concurrent).
