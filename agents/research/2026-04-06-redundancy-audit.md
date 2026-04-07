# Redundancy Audit - Stablecoin Dashboard

Date: 2026-04-06
Scope: complete runtime tree review across `src/`, `shared/`, `worker/src/`, `functions/`, and `scripts/`, plus relevant docs/config called out in the brief.
Status: confirmed findings only. No plausible-but-unconfirmed items are listed below.

## Executive Tally

- Total confirmed findings: 4
- High impact: 1
- Medium impact: 3
- Low impact: 0
- Dead-code checks run: `npm run check:unused-code`, `npm run check:duplicate-exports`, `npm run check:shared-cycles`
- Result from automated redundancy checks: no additional confirmed dead internal modules, duplicate exports, or circular dependency findings

## Findings

### R1. Hotspot backlog state is duplicated across JSON and markdown, and both copies are now stale for already-split modules

Impact: High
Category: duplicated process state / stale remediation backlog

Occurrences:

- `scripts/lib/hotspot-ratchet-baseline.json:2-9` still records `shared/lib/report-cards.ts` as a 946-line queued hotspot.
- `shared/lib/report-cards.ts:1-45` is now only a barrel export facade.
- `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:64-67` still instructs maintainers to split `shared/lib/report-cards.ts`.
- `scripts/lib/hotspot-ratchet-baseline.json:146-152` still records `worker/src/cron/daily-digest/collectors.ts` as a 955-line deferred hotspot.
- `worker/src/cron/daily-digest/collectors.ts:1-24` is now only a collector barrel.
- `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:56-59` still defers splitting `worker/src/cron/daily-digest/collectors.ts`.
- `scripts/lib/hotspot-ratchet-baseline.json:234-240` still records `worker/src/cron/yield-sync/sources.ts` as an 804-line deferred hotspot.
- `worker/src/cron/yield-sync/sources.ts:1-33` is now a barrel plus a small constant list.
- `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:60-63` still defers splitting `worker/src/cron/yield-sync/sources.ts`.
- `scripts/lib/hotspot-ratchet-baseline.json:26-32` still records `worker/src/handlers/http.ts` as a 54-line stabilized shell.
- `worker/src/handlers/http.ts:1-10` is now only a thin delegate to `handleHttpRequestImpl`.
- `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:98-108` still lists `worker/src/handlers/http.ts` in the stabilized set.
- `docs/testing.md:203-203` still documents the matching backlog note at the old path `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`, which no longer matches the historical location.

Why this is redundant:

The repo keeps the same hotspot queue state in two places: the ratchet baseline JSON and a markdown backlog note. Both artifacts have drifted from the code after successful file decompositions, so the codebase now carries duplicated remediation state plus stale instructions. This is high-signal because it directly misstates current module shape for already-remediated files.

Consolidation strategy:

- Pick one canonical source for hotspot state. The baseline JSON is the stronger candidate because it already drives enforcement.
- Generate the markdown backlog from the JSON, or remove the markdown file entirely if its only purpose is to mirror the queue.
- Refresh or delete stale entries for the already-decomposed facade files above.
- Fix the `docs/testing.md` link to the actual backlog location or to the generated artifact that replaces it.

### R2. The hotspot ratchet only detects growth, so redundant stale backlog entries survive indefinitely after decompositions

Impact: Medium
Category: stale guardrail / redundant enforcement metadata

Occurrences:

- `scripts/lib/hotspot-ratchet.mjs:84-107` compares `current > baseline` only and never flags a baseline entry that has become obviously obsolete after a major shrink.
- `docs/testing.md:203-203` explicitly says the hotspot ratchet baseline doubles as a decomposition backlog and that the matching backlog note must be updated at the same time.
- `scripts/lib/hotspot-ratchet-baseline.json:2-9`
- `scripts/lib/hotspot-ratchet-baseline.json:26-32`
- `scripts/lib/hotspot-ratchet-baseline.json:146-152`
- `scripts/lib/hotspot-ratchet-baseline.json:234-240`

Why this is redundant:

The ratchet is supposed to preserve the decomposition queue, but its comparison logic only guards against regressions. Once a hotspot shrinks into a facade, the stale oversized baseline entry remains valid forever. That makes the baseline both enforcement data and stale historical duplicate, which is exactly what happened in R1.

Consolidation strategy:

- Add a complementary staleness check for large downward deltas, such as a warning or failure when file size/branch count drops far below baseline.
- Treat "barrel/facade-only" modules as a special case that must be re-baselined immediately.
- Remove the separate manual requirement to keep a mirrored markdown backlog in sync if the ratchet can own both the queue and stale-entry detection.

### R3. Cron/status metadata coercion is duplicated across frontend summary components and worker-side status shaping

Impact: Medium
Category: duplicated parsing logic / overlapping responsibility

Occurrences:

- `src/components/status/cron-metadata-summary.ts:1-25` defines generic coercion helpers (`readNumber`, `readString`, `readRecord`, `readArray`, `readBoolean`).
- `src/components/status/cron-metadata-summary.ts:80-352` contains per-job metadata summarizers keyed by raw string job names.
- `src/components/status/telegram-bot-stats.tsx:40-85` redefines `asRecord`, `readNumber`, and a bespoke `parseDispatchMetadata`.
- `worker/src/lib/status/telegram-bot-stats.ts:120-136` defines separate numeric/timestamp coercion helpers (`coerceCount`, `coerceNullableTimestamp`, `roundMetric`) for the same status/telemetry domain.
- `shared/types/status.ts:30-37`
- `shared/types/status.ts:39-48`

Why this is redundant:

The shared status boundary exposes `metadata?: Record<string, unknown>`, so each consumer reparses the same loose payload shape with local helper functions. The duplication is not cosmetic: the frontend has one parser for generic cron summaries and another parser just for Telegram dispatch metadata, while the worker adds another coercion layer for adjacent telemetry mapping. This is overlapping responsibility caused by an untyped metadata boundary.

Consolidation strategy:

- Introduce shared codecs or typed metadata mappers in `shared/` for cron jobs that publish structured metadata.
- Replace ad hoc `read*`/`coerce*` helpers with shared parsing utilities plus job-specific typed view-model builders.
- Move string-keyed metadata summarization behind typed discriminators where possible so UI components only render already-shaped data.

### R4. `AdminAccess` is a single-mode abstraction that adds indirection without real variability

Impact: Medium
Category: redundant abstraction / thin wrapper

Occurrences:

- `src/lib/admin-access.ts:3-5` defines `AdminAccess` with only one legal mode, `"ops-proxy"`.
- `src/lib/admin-access.ts:13-21` branches on that single mode in `buildAdminApiPath`.
- `src/lib/admin-access.ts:23-31` provides `buildAdminFetchInit`, which only clones headers.
- `src/lib/admin-access.ts:33-34` returns the constant query scope `"ops-proxy"`.
- `src/app/admin/client.tsx:41-47` constructs `const adminAccess: AdminAccess = { mode: "ops-proxy" }`.
- `src/hooks/use-admin-polling-query.ts:13-32` threads `AdminAccess` through polling and query-key assembly even though scope and path behavior are constant.
- `src/hooks/__tests__/query-polling-policy.test.ts:82-104`
- `src/hooks/__tests__/query-polling-policy.test.ts:113-135`
- `src/hooks/__tests__/query-polling-policy.test.ts:144-168`
- `src/hooks/__tests__/query-polling-policy.test.ts:180-182`

Why this is redundant:

This abstraction models a mode system that currently has only one mode. The branching, wrapper helpers, query-scope helper, and repeated object construction add indirection without representing real choice. The result is duplicated plumbing across hooks and tests for a constant runtime behavior.

Consolidation strategy:

- Collapse `AdminAccess` into direct helpers for the current ops-proxy pathing model.
- Inline `getAdminQueryScope()` as the literal scope value or remove it by folding the constant into the query keys.
- Keep a union type only when a second admin transport mode actually exists.
- If header mutation is not expected soon, remove `buildAdminFetchInit()` and pass `undefined` or explicit headers directly from the small set of call sites.

## Notes on What Did Not Produce Confirmed Findings

- `npm run check:unused-code` reported no dead internal modules or unused named exports.
- `npm run check:duplicate-exports` reported no duplicate export issues.
- `npm run check:shared-cycles` reported no circular dependency issues.
- `npm audit --audit-level=high` reported no current high-severity dependency advisories, so no redundant-library finding was promoted from dependency review.

## Appendix: Notable Hotspot / Redundancy Review Files

- `scripts/lib/hotspot-ratchet-baseline.json`
- `scripts/lib/hotspot-ratchet.mjs`
- `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md`
- `docs/testing.md`
- `shared/lib/report-cards.ts`
- `worker/src/cron/daily-digest/collectors.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/handlers/http.ts`
- `src/components/status/cron-metadata-summary.ts`
- `src/components/status/telegram-bot-stats.tsx`
- `worker/src/lib/status/telegram-bot-stats.ts`
- `src/lib/admin-access.ts`
