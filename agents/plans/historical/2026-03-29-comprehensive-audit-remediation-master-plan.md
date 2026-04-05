# 2026-03-29 Comprehensive Audit Remediation Master Plan

> Master implementation plan for [agents/audits/2026-03-29-comprehensive-codebase-audit-blueprint.md](../audits/2026-03-29-comprehensive-codebase-audit-blueprint.md).
> Scope covers all `22` verified findings plus the adjacent optimization opportunities surfaced while sequencing the work.

## Objective

Remediate the full audit in a way that:

- fixes correctness and latent security issues first
- removes duplicated core pipeline logic before adding more guardrails on top of it
- strengthens architectural contracts so future work cannot reintroduce the same classes of drift
- decomposes current hotspots without changing public methodology semantics
- upgrades lightweight dependencies and closes structural hygiene gaps before final closeout
- ends with a repo state where the original findings are resolved and the surrounding risk surface is materially lower

## Source Findings Covered

| Workstream | Findings |
| --- | --- |
| `WS0` Baseline, fixtures, and program controls | supporting work for all findings |
| `WS1` PSI backfill safety and scalability | `Q1`, `Q3` |
| `WS2` Admin route contract and admin-job framework | `Q2`, `Q6` |
| `WS3` Route-dependency and cron-authority hardening | `S1`, `S2` |
| `WS4` Core worker deduplication and shared runtime cleanup | `R1`, `R2`, `R3`, `R4`, `R6`, `R8`, `Q7` |
| `WS5` Frontend/API/origin deduplication and dead code cleanup | `R5`, `R7`, `S6` |
| `WS6` Shared type boundary and documentation-system cleanup | `S3`, `S4`, `Q5` |
| `WS7` Hotspot decomposition program | `Q4`, `S5` |
| `WS8` Dependency refresh and final ratchet tightening | `S7` |

All `22` findings are covered exactly once by the workstream map above.

## Optimization Opportunities Included

These are not separate audit findings, but they should be executed while the affected code is open:

1. Add regression fixtures and a reproducible benchmark harness for PSI backfill.
2. Add explicit contract tests for route wrappers and dependency hydration.
3. Extend cron guardrails so unknown schedules fail loudly in CI and test, not silently at runtime.
4. Replace regex-based doc-sync scraping with generated metadata / manifests wherever feasible.
5. Convert hotspot ratchets from passive ceilings into active decomposition targets with post-split baselines.
6. Centralize site/API/ops origin resolution and make scripts consume the same source.
7. Tighten `check-unused-code` after dead-code removal so fewer allowlist exceptions remain.
8. Leave measurable before/after acceptance criteria on large refactors, not just “file got smaller”.

## Constraints

- Keep public API behavior stable unless current behavior is misleading, unsafe, or destructive.
- Do not mix correctness fixes with broad shape-only refactors in the same PR.
- Preserve existing product and design-system patterns; this plan is not a redesign.
- If a change touches behavior, API contract, pipeline flow, cron behavior, or methodology rendering infrastructure, update the relevant docs in the same PR.
- If a change touches methodology semantics directly, also update `/methodology` and the matching timeline/changelog docs. This plan avoids methodology-semantic changes and should keep that surface stable.
- Before pushing any implementation PR, run `npm run test:merge-gate`.

## Non-Goals

- No scoring-formula changes for PSI, DEWS, liquidity, report cards, yield, mint/burn, blacklist tracking, or Chain Health.
- No broad router rewrite from scratch.
- No migration renumbering or destructive schema cleanup.
- No speculative dependency churn beyond the packages called out in `S7`.
- No redesign of the frontend IA or visual system.

## Success Criteria

1. The `Q1` PSI backfill truncation bug is fixed and covered by regression tests.
2. Admin route wrappers have an unambiguous, tested auth contract.
3. Cron authority is unified or exhaustively checked so missing runner wiring cannot silently no-op.
4. Route dependency hydration becomes exhaustive and typed.
5. All duplicate worker pipeline logic identified in `R1-R4`, `R6`, and `R8` is removed or materially collapsed.
6. Hidden dead code and duplicated frontend contract parsing/origin config are removed.
7. Shared types stop depending on heavyweight implementation modules for live reserves.
8. Methodology/changelog content and doc-sync validation are on a more maintainable structure.
9. Current hotspot files have either been decomposed or moved into an explicit, bounded multi-PR decomposition queue with measurable exits.
10. Validation is green at the end:
   - `npm run test:merge-gate`
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`

## Mandatory Validation Gates

Run for every non-docs PR:

```bash
npm run test:merge-gate
```

Keep these targeted gates attached to the touched area:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Run these whenever the relevant surfaces change:

```bash
npm run check:worker-boundary
npm run check:shared-cycles
npm run check:migrations
npm run check:cron-sync
npm run check:cron-connections
npm run check:doc-counts
npm run check:doc-sync
npm run check:duplicate-exports
npm run check:unused-code
npm run check:hotspot-ratchet
npm run audit:deps
```

## Program Structure

Implement in five phases so the riskier changes land behind a stable baseline.

| Phase | PRs | Goal |
| --- | --- | --- |
| `P0` | `PR-00` | Baseline capture, fixtures, and safety rails |
| `P1` | `PR-01` to `PR-04` | Correctness, auth, and architecture-safety fixes |
| `P2` | `PR-05` to `PR-09` | Core duplication removal and shared config cleanup |
| `P3` | `PR-10` to `PR-12` | Shared-boundary cleanup, documentation system hardening, and content architecture work |
| `P4` | `PR-13` to `PR-15` | Hotspot decomposition, dependency refresh, and closeout ratchets |

Recommended merge order:

```text
PR-00 Baseline characterization and benchmark fixtures
PR-01 PSI backfill safety and bounded recompute
PR-02 Admin route wrapper contract hardening
PR-03 Cron authority unification and unknown-schedule fail-fast
PR-04 Exhaustive route dependency hydration
PR-05 Pricing / API parsing / dead-code cleanup
PR-06 Historical pricing, FX, and RPC source consolidation
PR-07 Blacklist/contracts/paging deduplication
PR-08 Shared admin-job runner framework
PR-09 Shared origins and runtime URL centralization
PR-10 Shared live-reserve type boundary cleanup
PR-11 Methodology/changelog content extraction + doc-sync modernization
PR-12 Hotspot ratchet conversion to decomposition backlog and budgets
PR-13 Worker hotspot decomposition tranche A
PR-14 Worker/frontend hotspot decomposition tranche B
PR-15 Dependency refresh, docs sweep, and final guardrail tightening
```

## Parallelization Rules

- `PR-01` and `PR-02` should not overlap because both touch admin/operational safety.
- `PR-03` can run in parallel with `PR-05` once `PR-00` lands.
- `PR-04` should land after `PR-02` because wrapper contract changes clarify dependency expectations in route handlers.
- `PR-06` and `PR-07` can run in parallel after `PR-05`.
- `PR-10` can run in parallel with `PR-11`.
- `PR-13` and `PR-14` must use disjoint write scopes.
- `PR-15` should stay isolated as the final stabilization window.

## Phase 0 - Baseline And Program Controls

### `PR-00` Baseline characterization and benchmark fixtures

Findings supported: all

Primary files:

- `agents/audits/2026-03-29-comprehensive-codebase-audit-blueprint.md`
- targeted tests and fixtures in `worker/src/api/__tests__/`, `worker/src/lib/__tests__/`, `worker/src/__tests__/`, `src/lib/__tests__/`
- optional benchmark helper under `scripts/` or `worker/scripts/`

Tasks:

1. Add a regression fixture for bounded PSI backfill with rows before and after the target window.
2. Capture characterization fixtures for:
   - route-wrapper auth behavior
   - cron schedule mapping behavior
   - route dependency hydration behavior
   - current API parsing behavior in `src/lib/api.ts`
3. Add a PSI backfill benchmark harness or deterministic synthetic input generator so future performance claims are measurable.
4. Record current line counts / hotspot baselines for all planned decomposition targets.
5. Create a remediation checklist section in the plan PR description template covering docs, merge gate, and rollback notes.

Acceptance criteria:

- all critical-path upcoming fixes have characterization tests or fixtures first
- hotspot starting sizes and current validation outputs are captured

Validation:

```bash
npm test -- worker/src/api/__tests__/backfill-stability-index.test.ts
npm test -- worker/src/__tests__/trigger-digest-route.test.ts worker/src/api/__tests__/router-contract.test.ts
```

## Phase 1 - Correctness, Safety, And Architecture Contracts

### `WS1` PSI backfill safety and scalability

#### `PR-01` Fix bounded PSI backfill truncation and reduce full-history work

Findings: `Q1`, `Q3`
Opportunities: benchmark harness, bounded-range performance assertions

Primary files:

- `worker/src/api/backfill-stability-index.ts`
- `worker/src/api/__tests__/backfill-stability-index.test.ts`
- `docs/api-reference.md`
- `docs/testing.md`

Tasks:

1. Change bounded backfills to preserve rows outside the requested range.
2. Replace the current “rebuild requested range then delete whole table” flow with one of:
   - range-scoped `DELETE + INSERT` within the requested window, or
   - full-table rebuild only when no explicit range was provided.
3. For bounded runs, query only the necessary input windows from `depeg_events`, `supply_history`, `stress_signal_history`, and `stability_index`.
4. Chunk long-range recomputation to bound memory and batch size.
5. Add regression tests for:
   - bounded non-dry-run preserving pre/post rows
   - full rebuild preserving expected ordering
   - empty/no-completed-day window still returning the current benign response
6. Add a benchmark or diagnostic summary to the response for internal tests only if it does not alter public contract semantics.

Acceptance criteria:

- no bounded run can delete out-of-range PSI history
- bounded runs stop loading irrelevant historical tables
- test coverage explicitly exercises the old bug shape

Validation:

```bash
npm test -- worker/src/api/__tests__/backfill-stability-index.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Risk:

- High if implemented sloppily, because this touches production repair tooling and historical data.

Docs:

- update `docs/api-reference.md` if request semantics or dry-run summary fields change
- update `docs/testing.md` to mention new regression coverage if appropriate

### `WS2` Admin route contract and admin-job framework

#### `PR-02` Make admin-route wrapper behavior explicit and testable

Findings: `Q2`
Opportunities: wrapper contract tests, naming cleanup

Primary files:

- `worker/src/lib/route-wrappers.ts`
- `worker/src/route-registry.ts`
- route-wrapper and route-registry tests

Tasks:

1. Decide one canonical contract:
   - preferred: `makeIdempotentAdminRoute()` enforces `withAdmin()` itself
   - fallback: rename to `makeIdempotentRoute()` and require explicit handler auth
2. Update route registrations accordingly.
3. Add wrapper-specific tests that prove:
   - unauthorized requests are rejected
   - authorized requests still execute with idempotency handling
   - route naming / helper semantics are not misleading anymore
4. Audit all current admin route uses to ensure no double-auth side effects.

Acceptance criteria:

- wrapper names match behavior
- future route authors cannot accidentally assume nonexistent auth

Validation:

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/__tests__/trigger-digest-route.test.ts worker/src/api/__tests__/router-contract.test.ts
npm run test:merge-gate
```

Docs:

- update `docs/architecture.md` and `docs/api-reference.md` if wrapper/auth mechanics or admin-route guarantees are now stated more explicitly

#### `PR-08` Extract shared admin-job runner after wrapper contract lands

Findings: `Q6`
Opportunities: normalize dry-run/reporting/error conventions across admin jobs

Primary files:

- `worker/src/api/backfill-depegs.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-stability-index.ts`
- `worker/src/api/backfill-mint-burn.ts`
- shared helper in `worker/src/lib/` or `worker/src/api/`
- related admin tests

Tasks:

1. Introduce a shared admin-job runner that owns:
   - auth entry
   - dry-run parsing
   - stablecoin/range selection parsing where common
   - structured summary response shape where common
   - consistent error and logging conventions
2. Migrate the four audited backfill handlers one at a time.
3. Keep endpoint-specific core logic separate from shared request orchestration.
4. Expand tests to assert consistent dry-run and summary behavior across handlers.

Acceptance criteria:

- backfill handlers share one hardened orchestration path
- endpoint-specific behavior remains readable and local

Validation:

```bash
npm test -- worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/backfill-supply-history.test.ts worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts
npm run test:merge-gate
```

### `WS3` Route-dependency and cron-authority hardening

#### `PR-03` Unify cron authority and fail on unmapped schedules

Findings: `S2`
Opportunities: stronger CI/runtime assertions, less silent operational failure

Primary files:

- `worker/wrangler.toml`
- `shared/lib/cron-jobs.ts`
- `worker/src/handlers/scheduled.ts`
- `scripts/check-cron-schedule-sync.ts`
- scheduled-handler tests
- `docs/worker-and-api-limits.md`
- `docs/testing.md`

Tasks:

1. Collapse cron expression metadata and runner metadata into one typed source of truth, or make the current split exhaustive.
2. Extend the cron sync check to validate:
   - Wrangler expressions match shared metadata
   - every expression has exactly one runner
   - every runner key exists in shared metadata
3. Change `handleScheduledEvent()` so unknown schedules log loudly and fail in test mode rather than silently returning.
4. Add regression tests for unmapped schedule behavior.

Acceptance criteria:

- cron schedule drift cannot silently produce a no-op runtime
- CI catches runner-map drift, not just Wrangler/shared drift

Validation:

```bash
npm run check:cron-sync
npm test -- worker/src/__tests__/index.scheduled.test.ts
npm run test:merge-gate
```

#### `PR-04` Make route dependency hydration exhaustive

Findings: `S1`
Opportunities: remove latent runtime drift between endpoint metadata and hydrated route context

Primary files:

- `shared/lib/api-endpoints.ts`
- `worker/src/handlers/http/context.ts`
- `worker/src/route-registry.ts`
- route context / router tests

Tasks:

1. Replace the `switch` in `buildRouteContext()` with an exhaustive typed resolver map keyed by `EndpointDependency`.
2. Make missing dependency resolvers fail at compile time via `satisfies Record<EndpointDependency, ...>`.
3. Tighten `FullRouteContext` typing so optional bags correspond more directly to the dependency map.
4. Add tests that prove newly declared route dependencies must be hydrated.

Acceptance criteria:

- adding a new endpoint dependency now forces a resolver implementation
- route dependency hydration no longer depends on a non-exhaustive manual `switch`

Validation:

```bash
npm test -- worker/src/api/__tests__/router-contract.test.ts
npm run check:worker-boundary
npm run test:merge-gate
```

Docs:

- update `docs/architecture.md` to reflect the new single dependency-hydration path

## Phase 2 - Duplication Removal And Shared Config Cleanup

### `WS4` Core worker deduplication and shared runtime cleanup

#### `PR-05` Collapse pricing/app parsing dead-simple duplication

Findings: `R1`, `R5`, `R7`
Opportunities: fewer drift points, tighter unused-code guardrails

Primary files:

- `worker/src/cron/sync-stablecoins/pricing.ts`
- `src/lib/api.ts`
- `worker/src/lib/runtime-credentials.ts`
- `scripts/check-unused-code.mjs`

Tasks:

1. Extract a single helper for validated price-candidate application and use it in both primary and GT-probe paths.
2. Extract a shared API payload validation helper for `apiFetch()` and `apiFetchWithMeta()`.
3. Remove `buildTwitterCreds()` if still unused and delete the allowlist suppression.
4. Re-run `check-unused-code` and trim any now-unnecessary allowlist entries opened up by the refactor.

Acceptance criteria:

- pricing metadata application is canonical
- frontend API contract parsing has one implementation
- dead-code suppression shrinks

Validation:

```bash
npm run check:unused-code
npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts src/lib/__tests__/api-fetch-contracts.test.ts src/lib/__tests__/api-endpoints.test.ts
npm run test:merge-gate
```

#### `PR-06` Consolidate historical pricing, FX application, and fallback RPC definitions

Findings: `R2`, `R3`, `Q7`
Opportunities: easier future provider additions, less config drift

Primary files:

- `worker/src/lib/authoritative-price-sources.ts`
- `worker/src/cron/sync-fx-rates-helpers.ts`
- `worker/src/lib/chain-registry.ts`
- related tests

Tasks:

1. Extract a shared historical quote collector for authoritative redeem-price providers.
2. Extract a shared FX rate-application helper used by both secondary-rate methods.
3. Move fallback Ethereum/public RPC definitions into a single shared registry consumed by both chain-registry and authoritative-price-sources.
4. Keep provider-specific data fetchers and validation thresholds local.

Acceptance criteria:

- quote collection logic is shared but provider-specific fetchers remain explicit
- FX application semantics are canonical
- fallback RPC edits happen in one place

Validation:

```bash
npm test -- worker/src/lib/__tests__/authoritative-price-sources.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts worker/src/lib/__tests__/env.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

#### `PR-07` Consolidate blacklist mapping, tracked-contract resolution, and provider paging

Findings: `R4`, `R6`, `R8`

Primary files:

- `worker/src/api/blacklist.ts`
- `worker/src/api/blacklist-summary.ts`
- `worker/src/lib/blacklist-contracts.ts`
- `worker/src/lib/mint-burn-contracts.ts`
- `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`
- `worker/src/lib/coingecko-onchain.ts`

Tasks:

1. Extract shared blacklist row-to-API mapping.
2. Extract a shared tracked runtime contract resolution base helper.
3. Extract shared paged token-pool crawler primitives for GeckoTerminal / CoinGecko Onchain-like APIs.
4. Backfill targeted tests for each shared abstraction before deleting old call-site logic.

Acceptance criteria:

- duplicate mapping and resolution logic are removed
- provider paging stays explicit at the edges and generic in the middle

Validation:

```bash
npm test -- worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/blacklist-summary.test.ts worker/src/lib/__tests__/mint-burn-contracts.test.ts worker/src/lib/__tests__/blacklist-contracts.test.ts worker/src/cron/dex-liquidity/__tests__/geckoterminal-shared.test.ts worker/src/lib/__tests__/coingecko-onchain.test.ts
npm run test:merge-gate
```

### `WS5` Frontend/API/origin deduplication and dead code cleanup

#### `PR-09` Centralize canonical origins and shared runtime URL resolution

Findings: `S6`
Opportunities: make scripts and runtime code derive from the same config source

Primary files:

- `src/lib/site-config.ts`
- `src/lib/api.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `worker/src/cron/status-self-check.ts`
- `scripts/serve-static-export.mjs`
- `functions/lib/ops-origin.ts`
- `functions/lib/ops-env.ts`
- relevant tests / docs

Tasks:

1. Create one shared source for canonical site/API/ops origins and small environment override helpers.
2. Make frontend, worker, scripts, and Pages Functions consume that source instead of embedding literals.
3. Add tests around origin-resolution edge cases.

Acceptance criteria:

- host/origin changes become one-source edits
- no runtime path embeds a canonical origin literal unnecessarily

Validation:

```bash
npm test -- functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts functions/__tests__/admin-host-gate.test.ts
npm run build
npm run test:merge-gate
```

## Phase 3 - Boundary Cleanup, Content Architecture, And Doc Systems

### `WS6` Shared type boundary and documentation-system cleanup

#### `PR-10` Restore clean shared-type boundaries for live reserves

Findings: `S3`

Primary files:

- `shared/types/core.ts`
- `shared/types/live-reserves.ts`
- `shared/lib/live-reserve-adapters.ts`
- downstream imports in `src/` and `worker/src/`

Tasks:

1. Move neutral live-reserve interfaces and type aliases into `shared/types/live-reserves.ts`.
2. Make `shared/lib/live-reserve-adapters.ts` consume those types rather than exporting the boundary itself.
3. Minimize public re-export churn by preserving import ergonomics where possible.
4. Add or update tests to keep the type/runtime separation honest.

Acceptance criteria:

- `shared/types/*` no longer depends on heavyweight live-reserve implementation/config
- downstream runtime behavior is unchanged

Validation:

```bash
npm run check:worker-boundary
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

#### `PR-11` Extract methodology/changelog content and modernize doc-sync

Findings: `Q5`, `S4`
Opportunities: cleaner review diffs, broader doc drift coverage

Primary files:

- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `src/app/methodology/scoring-changelog/content.tsx`
- `shared/lib/safety-score-version.ts`
- `scripts/check-doc-sync.ts`
- `scripts/check-doc-counts.mjs`
- matching docs in `docs/`

Tasks:

1. Move long-form methodology/changelog content into MDX or structured content modules.
2. Keep rendering code and business/version metadata separate.
3. Replace regex-based doc-sync scraping where possible with generated metadata / manifests exported from code or content.
4. Expand doc-sync coverage to all methodology/versioned surfaces touched by the audit.
5. Preserve route URLs, anchors, and visible copy semantics unless there is an explicit content correction.

Acceptance criteria:

- methodology/changelog content no longer lives as giant TS/TSX blobs
- doc-sync checks rely less on syntax-sensitive scraping
- no methodology semantic changes are introduced accidentally

Validation:

```bash
npm run check:doc-counts
npm run check:doc-sync
npm run build
npm run test:merge-gate
```

Docs:

- update `docs/testing.md` if doc-sync tooling changes materially
- update `docs/architecture.md` if the methodology content system is restructured enough to matter for contributors

#### `PR-12` Convert hotspot ratchets into an explicit decomposition backlog with budgets

Findings: `S5`
Opportunities: turn passive ceilings into active simplification work

Primary files:

- `scripts/lib/hotspot-ratchet-baseline.json`
- hotspot target files
- `docs/testing.md`
- `agents/plans/` notes for decomposition ownership

Tasks:

1. Attach target budgets and decomposition notes to every audited hotspot, not just a max line count.
2. Group hotspots into:
   - immediate decomposition in `P4`
   - deferred with explicit reason and target budget
3. Update the ratchet or surrounding docs so it becomes a tracked simplification program rather than a passive “do not grow” list.

Acceptance criteria:

- every hotspot has a disposition and target shape
- future contributors can tell whether a file is intentionally deferred or queued for split

Validation:

```bash
npm run check:hotspot-ratchet
npm run test:merge-gate
```

## Phase 4 - Hotspot Decomposition, Dependency Refresh, And Closeout

### `WS7` Hotspot decomposition program

#### `PR-13` Worker hotspot decomposition tranche A

Findings: `Q4`, `S5`

Files in scope:

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/status-evaluation.ts`
- any new helper modules created under adjacent folders

Tasks:

1. Split orchestration from pure transform / persistence / formatting code in `sync-mint-burn.ts`.
2. Split status evaluation into:
   - data loading
   - status derivation
   - section assembly
   - response shaping
3. Keep behavior stable by adding characterization tests before movement.
4. Lower line counts materially and ratchet the new smaller modules after landing.

Acceptance criteria:

- both hotspots are materially smaller
- orchestration logic becomes easier to test in isolation

Validation:

```bash
npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/api/__tests__/status.test.ts worker/src/lib/__tests__/status-reliability.test.ts
npm run check:hotspot-ratchet
npm run test:merge-gate
```

#### `PR-14` Worker/frontend hotspot decomposition tranche B

Findings: `Q4`, `S5`

Files in scope:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `src/components/yield-leaderboard.tsx`
- deferred portions of methodology rendering if still oversized after `PR-10`

Tasks:

1. Split DEX liquidity orchestration into fetch/merge/score/persist phases with clearer module boundaries.
2. Split `yield-leaderboard.tsx` into data-model, table rendering, controls, and cell-format helpers.
3. If methodology section renderers remain oversized after content extraction, split section composition from content definition and primitives.

Acceptance criteria:

- each target file has a narrower reason to change
- hotspot ratchet reflects the new smaller modules

Validation:

```bash
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts src/components/__tests__/yield-table-logic.test.ts
npm run build
npm run check:hotspot-ratchet
npm run test:merge-gate
```

### `WS8` Dependency refresh and final ratchet tightening

#### `PR-15` Refresh selected dependencies, tighten guardrails, and close out the audit

Findings: `S7`
Opportunities: tighten final guardrails once duplication and hotspots have shrunk

Primary files:

- `package.json`
- `worker/package.json`
- lockfile
- `docs/testing.md`
- any remaining guardrail config

Tasks:

1. Upgrade `@cloudflare/workers-types` immediately.
2. Evaluate `eslint`, `typescript`, and `lucide-react` as isolated upgrade commits or one guarded closeout PR, depending on migration complexity.
3. After duplication cleanup lands, tighten:
   - `check-unused-code` allowlist
   - hotspot baselines for decomposed files
   - any wrapper/cron contract tests added earlier
4. Do a final doc sweep to ensure architecture/testing/limits docs reflect the new structures.

Acceptance criteria:

- low-risk dependency lag is reduced
- guardrails reflect the cleaner codebase and do not preserve stale exceptions
- the audit finding list can be closed with evidence

Validation:

```bash
npm run audit:deps
npm outdated
npm run test:merge-gate
```

## Finding Coverage Matrix

| Finding | PR | Workstream |
| --- | --- | --- |
| `R1` | `PR-05` | `WS4` |
| `R2` | `PR-06` | `WS4` |
| `R3` | `PR-06` | `WS4` |
| `R4` | `PR-07` | `WS4` |
| `R5` | `PR-05` | `WS5` |
| `R6` | `PR-07` | `WS4` |
| `R7` | `PR-05` | `WS5` |
| `R8` | `PR-07` | `WS4` |
| `Q1` | `PR-01` | `WS1` |
| `Q2` | `PR-02` | `WS2` |
| `Q3` | `PR-01` | `WS1` |
| `Q4` | `PR-12`, `PR-13` | `WS7` |
| `Q5` | `PR-10` | `WS6` |
| `Q6` | `PR-08` | `WS2` |
| `Q7` | `PR-06` | `WS4` |
| `S1` | `PR-04` | `WS3` |
| `S2` | `PR-03` | `WS3` |
| `S3` | `PR-10` | `WS6` |
| `S4` | `PR-11` | `WS6` |
| `S5` | `PR-12`, `PR-13`, `PR-14` | `WS7` |
| `S6` | `PR-09` | `WS5` |
| `S7` | `PR-15` | `WS8` |

## Rollout And Risk Controls

1. Land `PR-01` through `PR-04` before any large shape-only refactors.
2. Keep every PR mergeable and independently reversible.
3. For admin and cron changes, prefer additive tests before behavior movement.
4. For hotspot splits, preserve public exports until the final internal import migration is complete.
5. For content extraction, move content first, then simplify renderers in a follow-up diff inside the same PR if necessary.

## Closeout Criteria

The program is complete when:

1. every finding in the coverage matrix is closed with merged code or an explicit verified “no longer applies” outcome
2. all temporary benchmark fixtures or TODO scaffolding from `PR-00` are either retained intentionally or removed
3. docs match the new structures
4. the final `npm run test:merge-gate` is green
5. hotspot, unused-code, cron, and doc-sync guardrails reflect the new repo shape rather than pre-remediation debt

## Plan Validation

Validation rubric:

1. Coverage completeness: every audit finding mapped exactly once, with no orphaned issue.
2. Sequencing coherence: critical correctness and contract fixes precede refactors that depend on them.
3. Execution practicality: PRs are reviewable and have bounded scopes.
4. Validation sufficiency: every workstream has concrete acceptance checks and repo-native validation commands.
5. Documentation coverage: plans identify which docs move with behavioral or structural changes.
6. Risk containment: high-risk operational changes have rollback-conscious sequencing.

### Validation Pass 1

Medium issues found:

1. `Medium` The initial ordering mixed admin-job extraction with wrapper-contract repair, which risked making auth semantics harder to reason about while the contract was still ambiguous.
2. `Medium` The first hotspot-decomposition section did not convert the ratchet list into explicit budgets and dispositions, which would have left `S5` only partially addressed.
3. `Medium` The initial content/doc-sync phase did not clearly separate methodology-semantic safety from content-architecture changes, which increased review risk.
4. `Medium` The initial PR numbering around admin-job extraction and origin centralization was inconsistent enough to create execution ambiguity.

Revisions made:

1. Split wrapper hardening (`PR-02`) from admin-job extraction (`PR-08`).
2. Added `PR-12` to turn hotspot ratchets into an explicit decomposition program before large splits land.
3. Tightened `PR-11` so content extraction and doc-sync modernization are explicit non-semantic moves with preserved anchors and copy semantics.
4. Renumbered the PR sequence so every finding maps to one stable implementation slot without `PR-08b`-style ambiguity.

### Validation Pass 2

Results:

- Coverage completeness: pass
- Sequencing coherence: pass
- Execution practicality: pass
- Validation sufficiency: pass
- Documentation coverage: pass
- Risk containment: pass

Remaining plan issues:

- `0` critical
- `0` high
- `0` medium
- `2` low

Low issues remaining:

1. Exact benchmark implementation details for PSI backfill can still be chosen later as long as `PR-00` captures reproducible input generation.
2. The final packaging of `eslint`/`typescript`/`lucide-react` upgrades may still need to split into separate commits depending on migration friction.

Final verdict: the plan currently has fewer than one medium issue. The remaining open concerns are low severity and do not block execution.
