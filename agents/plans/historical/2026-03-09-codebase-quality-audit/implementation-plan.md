# Codebase Quality Audit — Implementation Plan

## Execution Strategy
- **2 phases**, sequential gates (Phase C items deferred to backlog)
- **13 tickets** total (7 Phase A, 6 Phase B)
- Phase A: all parallel (non-overlapping files)
- Phase B: all parallel (non-overlapping files), gated on Phase A

## Finding Summary

| Report | Critical | Important | Minor | Key Themes |
|--------|----------|-----------|-------|------------|
| R1 Frontend Code Quality | 3 | 10 | 11 | Methodology duplication, table architecture, dead exports |
| R2 Worker & Shared | 5 | 10 | 7 | Dead supplyMethod/types, fetch/DB duplication, cross-boundary |
| R3 UI/UX Quality | 1 | 8 | 4 | Empty states, SEO gaps, a11y, responsive |
| R4 Performance | 2 | 4 | 3 | Bundle (html-to-image), flows triple-fetch, API efficiency |
| R5 Data Integrity | 4 | 4 | 3 | PSI/DEWS scoring edge cases, supply derivation, migration numbering |
| R6 Design System | 3 | 5 | 2 | Dynamic Tailwind (175), hardcoded colors (127), font-mono |
| R7 Security | 1 | 2 | 2 | JSON-LD XSS, telegram webhook auth, CI pinning |
| R8 Testing & Docs | 6 gaps | 2 quality | 5 doc | Rate limiter untested, cron count stale, yield symbols |

## Cross-Report Deduplication

| Overlap | Resolution |
|---------|-----------|
| R7-M2 (env docs) = R8 missing docs (.env.example) | Single ticket (TICKET-006) |
| R8-D1 (cron count) related to R2-I6 (telegram dispatch tracking) | Both in TICKET-006 |
| R6-C3 + R3-I3/M4 both touch stablecoin-table.tsx | Combined in TICKET-010 |
| R6-C3 + R6-I1 + R3-C1 all touch stability-index/client.tsx | Combined in TICKET-010 |
| R1-I2 (dead exports) and R2-C2 (dead types) | Split by area: TICKET-002 (frontend), TICKET-003 (shared/worker) |

## Phase A: Safe Cleanup + Security (~-700 LOC)

All changes are pure deletions, additive fixes, config changes, or security patches. Zero risk of behavior change.

| Worktree | Ticket | Key Files | Est. LOC | Model | Effort |
|----------|--------|-----------|----------|-------|--------|
| `audit-xss-fix` | TICKET-001 | src/app/stablecoin/[id]/page.tsx, src/components/breadcrumb-json-ld.tsx, src/app/stablecoins/[peg]/page.tsx | +10 | codex | high |
| `audit-fe-dead-code` | TICKET-002 | ~15 src/ files (exports, props, constants) | -160 | spark | medium |
| `audit-worker-dead-code` | TICKET-003 | shared/types/index.ts, shared/lib/stablecoins.ts, shared/index.ts, worker/src/lib/depeg-helpers.ts, worker/src/cron/detect-depegs.ts | -310 | codex | high |
| `audit-seo-a11y` | TICKET-004 | src/app/page.tsx, src/app/sitemap.ts, src/components/sidebar.tsx, src/components/theme-toggle.tsx | +30 | spark | medium |
| `audit-worker-consolidation` | TICKET-005 | worker/src/api/status-history.ts, worker/src/api/status.ts, worker/src/lib/status-reliability.ts, worker/src/router.ts, worker/src/api/mint-burn-events.ts, worker/src/api/stablecoin-detail/shared.ts, shared/lib/api-endpoints.ts | -25 | spark | medium |
| `audit-ci-docs` | TICKET-006 | .github/workflows/, docs/worker-infrastructure.md, docs/yield-intelligence.md, .env.example (new) | +20 | spark | medium |
| `audit-perf-config` | TICKET-007 | next.config.ts, src/app/globals.css | -5 | spark | medium |

**Dispatch:** All 7 in parallel (non-overlapping files).
**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test`

## Phase B: Data Integrity + Design Polish (~+50 LOC net, mostly refactoring)

Behavior-modifying fixes: scoring corrections, empty states, design compliance, performance. All are behavior-preserving or additive.

| Worktree | Ticket | Key Files | Est. LOC | Model | Effort |
|----------|--------|-----------|----------|-------|--------|
| `audit-worker-scoring` | TICKET-008 | worker/src/lib/stability-index.ts, worker/src/lib/dews.ts, worker/src/cron/detect-depegs.ts, worker/src/cron/sync-stablecoin-charts.ts | +40 | codex | high |
| `audit-fe-data-integrity` | TICKET-009 | src/lib/stablecoin-detail-derive.ts, src/hooks/use-stablecoins.ts, src/hooks/use-stablecoin-detail-view-model.ts | +15 | codex | high |
| `audit-si-table-ui` | TICKET-010 | src/app/stability-index/client.tsx, src/components/stablecoin-table.tsx, src/components/stability-index.tsx | +40 | codex | xhigh |
| `audit-design-system` | TICKET-011 | ~12 src/components/ files (font-mono, color, N/A, focus, empty states) | +30 | codex | high |
| `audit-chart-lazy` | TICKET-012 | src/lib/chart-export.ts, src/components/total-mcap-chart.tsx, src/components/psi-history-chart.tsx | +10 | codex | high |
| `audit-worker-fetch` | TICKET-013 | worker/src/api/audit-depeg-history.ts, worker/src/api/backfill-supply-history.ts | -20 | codex | high |

**Dispatch:** All 6 in parallel (non-overlapping files).
**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` + manual spot-check of stability-index, stablecoin table, chart export, and detail pages.

## Deferred to Backlog

These items are either high-effort/low-priority, or need deeper design work before implementation:

- **R6-C1:** Dynamic Tailwind class interpolation (175 instances, 61 files) — needs analysis of which are actually broken vs safe patterns using `cn()` with static class maps
- **R6-C2:** Hardcoded color literals (127 instances, 37 files) — many are in chart configs which are intentional
- **R5-C1:** Non-USD supply history FX normalization — needs design doc for how to handle non-USD peg detail data
- **R5-C4:** Migration numbering collisions — needs careful renumbering with production D1 state awareness
- **R1-C1:** Methodology page refactoring (-520 LOC) — large, needs component design
- **R1-C2:** Table component shared architecture (-430 LOC) — large abstraction change
- **R1-C3:** Hook extraction (use-portfolio/use-stress-test) — needs design
- **R2-C3:** Endpoint registry consolidation (-140 LOC) — architecture change
- **R2-C4:** Supply-history backfill helper (-180 LOC) — needs testing
- **R2-C5:** GT pool crawl helper (-80 LOC) — needs testing
- **R4-C2:** Flows page code splitting + data dedup — architecture change
- **R4-I2-I4:** API performance (chart overfetch, dex-liquidity SELECT *, peg-summary caching) — needs profiling
- **R8-G1/G3/G4/G6:** Test coverage gaps (rate limiter, reclassifier, yield config, taxonomy) — separate testing initiative
- **R7-I1:** Telegram webhook auth hardening — needs Telegram API research
- **R2-I7-I8:** Shared boundary cleanup + cron metadata sharing — cross-cutting
- **R1-I4-I7:** Component consolidation (empty states, status tables, chart cards) — Phase C abstractions

## Total Estimated Impact (Phases A + B)
- LOC: ~-700 (Phase A) + ~+50 net (Phase B) = ~-650 net
- Findings resolved: ~45 of ~90 total
- Deferred: ~45 items (listed above)
