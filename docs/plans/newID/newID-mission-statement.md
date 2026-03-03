# newID Mission Statement

Date: 2026-03-04  
Codename: `newID`  
Status: guiding document for migration readiness and execution planning

## Mission

Replace ambiguous/internal stablecoin identity with one canonical model: `ticker-name` (example: `usdc-circle`), and make that identity reliable across API, UI, worker pipelines, and persistence.

Success means:
- one stablecoin identity model everywhere
- no symbol ambiguity in routes, state, or storage
- no hidden coupling between internal IDs and provider IDs
- safe migration path with rehearsed rollback

## Scope And Non-Goals

In scope:
- readiness and execution planning from standards to go/no-go
- data/route compatibility strategy
- Cloudflare D1-safe migration mechanics
- observability, QA, and operational runbooks

Out of scope in readiness phase:
- immediate production cutover
- one-shot production DB rewrite without rehearsal evidence

## Core Principles

- Canonical identity first: `ticker-name` is the only durable internal identity.
- Immutable IDs: rebrands handled by aliases, not canonical ID mutation.
- Provider decoupling: provider keys (`llamaId`, `geckoId`, etc.) are separate from internal IDs.
- Compatibility window: old IDs/symbol links resolve safely during transition, then sunset deliberately.
- Rehearsal before production: no migration-affecting merge to `main` without DB rehearsal evidence.
- Branch safety: `main` is deploy-triggering, so work happens on feature/integration branches first.
- Evidence-based gates: promote by `R0`..`R4` sign-offs, not intuition.
- Cost-aware execution: D1 write-heavy operations are planned with budget/limits guardrails.

## High-Level Phases

1. Phase A: Identity Foundation (`R0`)
- finalize canonical ID spec (`ID_SPEC_V1`)
- freeze deterministic old->new mapping (`MAPPING_V1`)
- complete coupling inventory

2. Phase B: Compatibility Architecture (`R1`)
- decouple provider IDs from internal IDs
- define alias resolution + redirect contracts
- lock URL/query-state normalization plan

3. Phase C: Migration Mechanics (`R2`)
- finalize D1 migration/rollback mechanics
- define cache/artifact migration behavior
- validate DB rehearsal lane and reproducible dry-runs

4. Phase D: Confidence Layer (`R3`)
- update tests/CI guardrails
- lock analytics/SEO/observability checks
- complete docs and operator runbooks

5. Phase E: Rehearsal + Decision (`R4`)
- full end-to-end rehearsal with evidence artifacts
- final product/engineering/ops go-no-go decision

## Delivery Model: Agent-Driven And Parallel

- Workstream-oriented execution (`WS0`..`WS12`) with explicit owners.
- Parallelization by independent lanes (spec/mapping, API/routing, DB mechanics, observability/docs).
- Ticketized work with strict artifact handoffs (specs, reports, checksums, rehearsal evidence).
- Use Codex Autorunner (or equivalent CAD/CAR-style ticket orchestrator) for multi-agent throughput, with protected branches and required reviews.

## Cloudflare D1 Rehearsal Principle

This migration treats a rehearsal DB lane as mandatory for any change that can alter persisted IDs.

Operational baseline:
- D1 Time Travel available (30 days Workers Paid, 7 days Free).
- No one-command D1 clone/fork from Time Travel today; rehearsal copy flow is export/import.
- Remote D1 export can block DB requests while running; schedule explicitly.
- Import file cap is 5 GB per file; split strategy required for larger datasets.
- D1 limits that shape migration SQL: 30s query duration, 100KB statement, 100 bound parameters, 2MB row/blob/string.

## Budget And Cost Envelope (Incremental Estimate)

Assumptions used (as of 2026-03-04):
- Workers Paid: minimum $5/month (10M requests + 30M CPU ms included).
- D1 Paid included pool: 25B rows read, 50M rows written, 5GB storage.
- D1 overage: $0.001 per 1M rows read, $1.00 per 1M rows written, $0.75 per GB-month storage.
- Time Travel/restore: no separate line-item fee.
- Read replication: no replica surcharge; normal row billing applies.
- Optional R2 archival and Workflows costs only if enabled.

Order-of-magnitude migration-month envelope:
- Low: $0 to $10 incremental
- Medium: $20 to $80 incremental
- High: $150 to $300+ incremental

Cost guardrail:
- monitor `rows_written` first; write volume is the primary D1 cost driver.

## References

- Readiness tasklist: `docs/plans/newID/newid-migration-readiness-tasklist.md`
- Deep research: `docs/plans/newID/disambiguation-research.md`
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- Cloudflare D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Cloudflare D1 Wrangler commands: https://developers.cloudflare.com/d1/wrangler-commands/
- Cloudflare D1 environments: https://developers.cloudflare.com/d1/configuration/environments/
- Cloudflare D1 read replication: https://developers.cloudflare.com/d1/best-practices/read-replication/
