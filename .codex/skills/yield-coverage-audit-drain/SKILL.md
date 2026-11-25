---
name: yield-coverage-audit-drain
description: Drain the Yield Intelligence coverage-audit queue into reviewed source mappings, intentional gaps, or deferrals. Use monthly after the audit or a coverage drop. Not for hunting outside the queue.
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs prose.

# Yield Coverage Audit Drain

## Trigger And Exclusions

Run after the monthly `yield-coverage-audit`, on a Yield Health coverage alert, or when the weekly curation digest (`scripts/maintenance/weekly-curation-digest.mjs`) lists overdue yield reviews. Every queue item is a lead: verify live source data, local identity, safety and publication gates, and current methodology before changing config. The queue is display-only; classifications live in the scratch note and accepted items become config changes. Never write dispositions or mutate D1 to drain it.

## Mandatory Core

1. Read routed yield docs and scoped instructions, then [Coverage Audit Queue](../../../docs/yield-intelligence-operations.md#coverage-audit-queue) for accounting, suppression, display caps and the accept/dismiss/intentional-gap/watch vocabulary.
2. Take a read-only snapshot. Prefer the `yieldHealth.coverageAudit` projection from the status request in [Yield Health first checks](../../../docs/runbooks/yield-health.md#first-checks), or read the cache row from `worker/` with an already authenticated session:

   ```bash
   npx wrangler d1 execute stablecoin-db --remote --command "select key, value, updated_at from cache where key = 'yield-coverage-audit';"
   ```

   Keep production D1 inspection SELECT-only. If remote D1 is unavailable, use the latest fixture or prior run output and label it.
3. Record the date, `reportedAt`, the full pre-cap `queueTotals` and their basis (never the bounded samples), `reviewDueAdapters` with its full count, and whether evidence is production, local or fixture-derived.
4. If the queue and the due-review list are empty, report source, date and zero counts, then stop.

Hard stops:

- Do not lower global lending APY, TVL or safety gates to win coverage.
- Do not add protocol allowlist entries beyond queue and category-gated evidence.
- Do not scrape product pages without a confirmed durable machine-readable source.
- Do not force coverage around a publication, safety or benchmark guard without written rationale.
- Do not bump a `reviewedAt` or `nextReviewAt` without a new review.

## Branch Reads And Actions

- Non-empty queue or due reviews: [queue-triage.md](references/queue-triage.md) owns per-kind triage, identity checks, the authored config targets and the reject/defer gate.
- Kind semantics: `YieldCoverageAuditQueueItemKind` in `shared/types/status/yield-liquidity.ts` and its emitters in `worker/src/cron/yield-coverage-audit/detectors.ts`; the source files win over any list here.
- Budget interpretation, unavailable supply and incident handling: [Yield Health remediation](../../../docs/runbooks/yield-health.md#remediation).
- Source or config, queue, or publication change: update the routed owner. Follow [Methodology Versioning](../../../docs/yield-intelligence.md#methodology-versioning) and [ADR-3](../../../docs/architecture.md#adr-3) only when methodology changes; a new provider also updates `docs/about-page.md`.

## Validation

```bash
npx vitest run worker/src/cron/__tests__/yield-config-registry.test.ts worker/src/cron/__tests__/yield-coverage-audit.test.ts worker/src/cron/__tests__/yield-helpers.test.ts worker/src/lib/status/__tests__/yield-health.test.ts
npm run check:stablecoin-data
```

Add `shared/lib/__tests__/yield-source-risk-registry.test.ts` for any venue-risk edit, `worker/src/cron/__tests__/fetch-tbill-rate.test.ts` when benchmarks change, and the frontend status or methodology tests when public status or copy changes.

Publish through `pharos-release-runner` when requested. After the deploy, prove the drained items cleared with [Recompute after a coverage drain](../../../docs/runbooks/yield-health.md#recompute-after-a-coverage-drain); an hourly publication does not clear a monthly cached item.

## Completion Evidence

Report the snapshot source and date, pre-cap totals, promotions by config file, rejections and deferrals each with its next trigger, lifecycle and exclusion reviews updated, checks run, and remaining queue-health risk.
