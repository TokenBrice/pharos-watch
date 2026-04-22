# Full Audit Remediation Implementation Plan

Date: 2026-04-22
Owner: Codex
Status: reviewed v5, review phase clean
Source audit: `agents/audits/2026-04-22-full-codebase-audit.md`

## Scope

Implementation plan to remediate every finding from the 2026-04-22 full codebase audit:

- Redundancy: `R-01` through `R-09`
- Code quality: `Q-01` through `Q-06`
- Sustainability and maintainability: `S-01` through `S-07`
- Cross-cutting concerns: `CC-01` through `CC-05`

This plan covers planning, sequencing, validation, documentation, and rollout strategy. It does not implement code changes directly.

## Assumptions

- Remediation ships as a series of focused PRs, not one repo-wide refactor.
- Existing product behavior should remain stable unless a finding explicitly calls for API/runtime contract changes.
- `/docs/` remains the canonical product/process corpus; any behavior, API, env-contract, or operational change in this plan updates the matching docs.
- No D1 schema migration is currently required by the audited findings. If a later implementation uncovers migration need, that work must be broken out and follow the repo’s backward-compatible migration rules.
- Stable hotspot retirement is more important than maximizing parallelism. PR slicing should reduce merge pressure on the same high-change files.
- The current code baseline is clean for tests, lint, root typecheck, and worker typecheck, but not for hotspot enforcement: `npm run check:hotspot-ratchet` is currently failing on `worker/src/cron/dispatch-telegram-alerts.ts`. The plan therefore includes an explicit unblocker before any merge-gated deploy-impacting work.
- The stablecoin catalog restructure (`S-02`) is strategic and should preserve the current consumer-facing registry API until a generated aggregate is in place.

## Success Criteria

- Every audit finding is either implemented or explicitly deferred into a tracked follow-up with rationale, owner, and prerequisite state.
- The highest-risk compound issues (`CC-01` through `CC-05`) are broken into coherent remediation lanes rather than spread across unrelated PRs.
- No PR widens the current hotspot profile of `dispatch-telegram-alerts.ts`, `enrich-prices-primary.ts`, or other already-enrolled hotspots without an explicit hotspot-budget decision.
- The proxy retry/backoff contract is repaired first so user-facing degraded behavior improves before deeper refactors land.
- Shared contract duplication is reduced where script/runtime drift currently exists.
- The long-term structural items (`S-02`, `S-03`, `S-04`) gain executable prerequisites and clear cut lines instead of remaining abstract backlog items.
- `S-01` is not considered closed until Telegram, pricing, and `worker/src/lib/mint-burn-contracts.ts` all have explicit retirement lanes and the hotspot program itself has a tracked exit path for any remaining waivers.
- `S-03` is not considered closed by planning alone. It requires concrete Node 25 decoupling outputs or an explicit blocker register if the minimum runtime cannot yet be lowered.
- Canonical validation passes for every merged workstream:
  - `npm test`
  - `npm run lint`
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `npm run test:merge-gate` before push
  - plus targeted doc/guardrail/build checks for the touched surface

## Remediation Strategy

The plan is organized into four implementation tracks that map directly to the audit’s risk concentration:

1. **Contract and duplication quick wins**
   - Fix proxy semantics and low-risk duplication with small, isolated changes.
2. **Shared contract and status-surface cleanup**
   - Remove duplicated types/presentation logic and tighten UI/runtime boundaries.
3. **Hotspot decomposition**
   - Split the most overloaded operational paths by stable phase boundaries.
4. **Strategic platform work**
   - Tackle monolithic data sources, runtime/tooling coupling, and scaling ceilings.

This ordering keeps user-facing correctness and low-risk drift fixes ahead of broad refactors, while also ensuring strategic items are not left as vague future work.

## Gate 0 - Hotspot Ratchet Unblocker

Purpose:
- restore a merge-gated baseline before deploy-impacting work starts
- prevent the plan from requiring `npm run test:merge-gate` while knowingly leaving `check:hotspot-ratchet` red

Scope:
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `scripts/lib/hotspot-ratchet-baseline.json`
- `scripts/lib/hotspot-ratchet-waivers.json`
- optional tracker artifact under `agents/tasks/`

Implementation:
- either reduce `dispatch-telegram-alerts.ts` enough to clear the current regression immediately, or make a narrowly justified baseline/waiver adjustment that locks in strict no-growth rules until the real decomposition lands
- create a small hotspot-retirement tracker for the remaining `S-01` entries so no hotspot closure is implicit

Acceptance criteria:
- `npm run check:hotspot-ratchet` passes before the first deploy-impacting PR in this plan lands
- any remaining waiver entries touched by this plan have an explicit owner, disposition, and next review checkpoint recorded in the plan or tracker

## Workstream Order

1. **Gate 0: Hotspot ratchet unblocker**
2. **WS-1: Proxy/API contract integrity**
3. **WS-2: Adapter and utility deduplication**
4. **WS-3: Status surface contract cleanup**
5. **WS-4: Build/runtime shared-contract cleanup**
6. **WS-5: Frontend and status hotspot simplification**
7. **WS-6: Worker hotspot decomposition**
8. **WS-7: Catalog and platform restructuring**
9. **WS-8: Toolchain, env contract, and guardrail sustainability**

## PR Map

| PR | Workstream | Findings | Purpose |
| --- | --- | --- | --- |
| PR-00 | Gate 0 | `S-01` unblocker | Restore merge-gate viability and freeze hotspot growth before deploy-impacting work |
| PR-01 | WS-1 | `Q-01`, `Q-04` | Fix proxy retry semantics and degraded-service response shape |
| PR-02 | WS-2 | `R-01`, `R-02`, `R-04` | Remove low-risk worker duplication in adapters and API-key SQL |
| PR-03 | WS-4 | `R-03`, `R-06`, `R-07` | Centralize shared contracts and benchmark loader |
| PR-04 | WS-3 | `R-05`, `R-09` | Unify status types and severity rendering |
| PR-05 | WS-5 | `R-08`, `Q-05` | Reduce frontend transport abstractions and split `ContagionGraph` |
| PR-06 | WS-1 | `Q-06` | Add shared cancellation and timeout support to frontend API helpers |
| PR-07 | WS-6 | `Q-03`, `S-01` (Telegram slice) | Decompose Telegram dispatch path |
| PR-08 | WS-6 | `Q-02`, `S-01`, `CC-02` (Pricing slice) | Decompose primary pricing path |
| PR-09 | WS-6 | remainder `S-01` | Split `mint-burn-contracts.ts` and formalize hotspot-program retirement checkpoints |
| PR-10 | WS-5 | remainder `S-06`, `CC-03` | Split waived status/frontend hotspots after contract cleanup |
| Gate-WS7A | WS-7 | `S-02` design prerequisite | Lock catalog source model and cutover design before catalog migration work |
| PR-11 | WS-7 | `S-02` phase A | Add generator/aggregate foundation for fine-grained catalog sources |
| PR-12a | WS-7 | `S-02` phase B1 | Migrate one catalog family/batch onto the mixed-source generator path |
| PR-12b | WS-7 | `S-02` phase B2 | Migrate the next catalog family/batch while keeping mixed-source support |
| PR-12c | WS-7 | `S-02` phase B3 | Finish catalog migration and remove the old coarse-source loader |
| PR-13 | WS-7 | `S-04`, `CC-05` | Scale live reserve sync through sharding/resume-state work |
| PR-14 | WS-8 | `S-03` | Reduce Node 25 coupling and add LTS CI/runtime proof |
| PR-15 | WS-8 | `S-05` | Centralize env-contract ownership in a typed manifest |
| PR-16 | WS-8 | `S-07` | Consolidate guardrail/tooling surface without reducing protections |

## Detailed Workstreams

### WS-1 - Proxy/API Contract Integrity

Findings:
- `Q-01`
- `Q-04`
- `Q-06`
- `CC-01` prerequisite

Files:
- `functions/api/admin/[[path]].ts`
- `functions/_site-data/[[path]].ts`
- `functions/lib/proxy-utils.ts`
- `worker/src/api/feedback.ts`
- `worker/src/api/feedback/request.ts`
- `worker/src/lib/rate-limit.ts`
- `src/lib/api.ts`
- matching tests in `functions/__tests__/**`, `worker/src/api/__tests__/**`, `worker/src/lib/__tests__/**`, `src/lib/__tests__/**` or new tests
- docs: `docs/api-reference.md`, `docs/testing.md` only if validation guidance changes

Implementation:
- Preserve `Retry-After` in proxy response forwarding for error/degraded responses.
- Add explicit regression tests for `429`, `503`, and timeout passthrough behavior.
- Normalize feedback limiter/storage dependency failures to an explicit `503` + `Retry-After` path instead of generic `500`.
- Keep all of `Q-04` in this workstream so feedback dependency behavior is changed once, not split across multiple PRs.
- `Q-06` is handled in `PR-06`, but the closure bar is explicit now: shared API helpers must accept caller-provided `AbortSignal`, and the shared layer must also expose a standard timeout wrapper/default path for callers that do not provide one.

Acceptance criteria:
- Requests routed through Pages proxies retain upstream `Retry-After`.
- Feedback dependency failures are distinguishable from user errors and normal quota exhaustion.
- Shared frontend fetch helpers support both caller-provided cancellation and a standard timeout path/default wrapper.

Validation:
- `npm test -- functions/__tests__/site-data-proxy.test.ts functions/__tests__/ops-admin-proxy.test.ts`
- `npm test -- worker/src/api/__tests__/feedback.test.ts worker/src/lib/__tests__/rate-limit.test.ts`
- `npm test -- src/lib/__tests__/api-fetch-contracts.test.ts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- `docs/api-reference.md`

### WS-2 - Adapter And Utility Deduplication

Findings:
- `R-01`
- `R-02`
- `R-04`

Files:
- `worker/src/cron/reserve-adapters/buck-io-transparency.ts`
- `worker/src/cron/reserve-adapters/circle-transparency.ts`
- `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts`
- `worker/src/cron/reserve-adapters/usdh-native-markets.ts`
- `worker/src/cron/reserve-adapters/evm-branch-balances.ts`
- `worker/src/cron/reserve-adapters/liquity-v1.ts`
- `worker/src/cron/reserve-adapters/liquity-v2-branches.ts`
- new shared reserve-adapter helpers under `worker/src/cron/reserve-adapters/`
- `worker/src/lib/api-key-admin.ts`
- `worker/src/lib/api-key-core.ts`
- matching tests under `worker/src/cron/reserve-adapters/__tests__/` and `worker/src/lib/__tests__/api-keys.test.ts`

Implementation:
- Extract shared helpers for redemption metadata and optional redemption-rate probing.
- Replace repeated API-key projection lists with named shared column fragments or selector helpers.
- Keep functional behavior unchanged; this is a consolidation-only lane.

Acceptance criteria:
- No adapter output changes beyond equivalent object construction.
- API-key queries still return the same row shapes as before.

Validation:
- targeted adapter tests covering touched adapters
- `npm test -- worker/src/lib/__tests__/api-keys.test.ts`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- none expected unless helper extraction changes documented adapter conventions

### WS-3 - Status Surface Contract Cleanup

Findings:
- `R-05`
- `R-09`
- `CC-03`

Files:
- `shared/types/status.ts`
- `src/lib/status-dashboard-model.ts`
- `src/components/status/status-facts.tsx`
- `src/components/status/transition-timeline.tsx`
- `src/components/status/recommended-action-strip.tsx`
- `src/components/status/admin-actions-panel.tsx`
- `src/components/status/system-diagnostics.tsx`
- `src/components/status/data-quality-cards.tsx`
- `src/components/status/uptime-bar.tsx`
- supporting tests under `src/components/status/__tests__/`

Implementation:
- Replace local status-shape redefinitions with shared status contracts or shared-type-derived props.
- Centralize severity pill rendering through one helper/component.
- Keep the status route behavior stable while reducing duplication and contract ownership drift.

Acceptance criteria:
- Status components no longer declare overlapping local status contract shapes where shared types already exist.
- Severity class semantics are defined in one place.

Validation:
- targeted status component tests
- `npm run lint`
- `npm run typecheck`

Docs:
- only if a status contract name/path change needs `docs/architecture.md` or `docs/api-reference.md` clarification

### WS-4 - Build/Runtime Shared-Contract Cleanup

Findings:
- `R-03`
- `R-06`
- `R-07`
- `CC-02`
- `CC-04`

Files:
- `worker/src/cron/fetch-tbill-rate.ts`
- `worker/src/cron/yield-sync/sources-riskfree.ts`
- new shared loader/helper module in `worker/src/cron/` or `worker/src/lib/`
- `scripts/lib/markdown-renderers.ts`
- `src/app/digest/[date]/page.tsx`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/components/ai-summary.tsx`
- `src/components/stablecoin-detail/notices-and-summary-section.tsx`
- `src/components/stablecoin-detail/overview-section.tsx`
- new shared contracts module in `shared/types/` or `shared/lib/`

Implementation:
- Centralize the risk-free benchmark loader.
- Move digest and summary contracts to one shared runtime-neutral module.
- Convert script/runtime consumers to import the shared types.

Acceptance criteria:
- Script and app consumers compile against a single digest contract definition.
- Stablecoin detail summary surfaces share one summary contract.
- Risk-free benchmark lookup behavior is defined once.

Validation:
- targeted benchmark/yield tests
- `npm test -- src/lib/__tests__/stablecoin-detail-view-model.test.ts src/lib/__tests__/yield-benchmark.test.ts worker/src/cron/__tests__/fetch-tbill-rate.test.ts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- none expected unless benchmark-loader ownership changes documented script/runtime boundaries

### WS-5 - Frontend And Status Hotspot Simplification

Findings:
- `R-08`
- `Q-05`
- `S-06`
- `CC-03`

Files:
- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/components/contagion-graph.tsx`
- `src/components/contagion-graph-graph.ts`
- `src/app/stability-index/client.tsx`
- `src/app/safety-scores/client.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/app/status/client.tsx`
- `src/components/status/cron-metadata-summary.ts`
- `src/components/status/api-keys-panel.tsx`
- `scripts/lib/hotspot-ratchet-waivers.json`
- any related hotspot metadata entries touched when `S-06` waivers are retired
- related tests under `src/components/__tests__/`, `src/hooks/__tests__/`, `src/lib/__tests__/`

Implementation:
- Narrow or remove the stablecoin-detail transport abstraction by grouping inputs or collapsing the builder boundary.
- Split `ContagionGraph` into render shell plus dedicated behavior helpers/hooks for drag, hover/ripple, and tooltip view-model logic.
- For waived large route/components, preserve visual behavior but reduce file-level concentration by extracting section or model layers.
- Add a dedicated post-`WS-3` status-hotspot lane for the currently waived status modules so `CC-03` is not treated as solved by type cleanup alone.
- Update hotspot waiver metadata as part of `PR-10` so `S-06` closure is explicit instead of implied by code movement alone.

Acceptance criteria:
- `ContagionGraph` has explicit tests for drag persistence, edge hover behavior, and neighborhood visibility filtering.
- Stablecoin detail view-model assembly no longer mirrors a wide parameter list one field at a time.
- Waived frontend/status hotspot modules shrink without UX regressions, and touched hotspot entries are revalidated with `check:hotspot-ratchet`.

Validation:
- `npm test -- src/components/__tests__/contagion-graph.test.tsx src/components/__tests__/contagion-graph-graph.test.ts src/hooks/__tests__/use-stablecoin-detail-view-model*.test* src/lib/__tests__/stablecoin-detail-view-model.test.ts`
- `npm run lint`
- `npm run typecheck`
- `npm run check:hotspot-ratchet` for the PRs that touch waived hotspot modules

Docs:
- none unless route/component decomposition changes agent-code-map or architecture guidance

### WS-6 - Worker Hotspot Decomposition

Findings:
- `Q-02`
- `Q-03`
- `S-01`
- `CC-01`
- `CC-02`

Files:
- `worker/src/cron/dispatch-telegram-alerts.ts`
- adjacent telegram modules under `worker/src/cron/`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- related pricing helpers under `worker/src/cron/sync-stablecoins/`
- `worker/src/lib/mint-burn-contracts.ts`
- hotspot metadata files:
  - `scripts/lib/hotspot-ratchet-baseline.json`
  - `scripts/lib/hotspot-ratchet-waivers.json`
- hotspot retirement tracker under `agents/tasks/` if remaining waivers survive this lane
- targeted tests in:
  - `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
  - `worker/src/cron/__tests__/enrich-prices.test.ts`
  - other touched tests

Implementation:
- Telegram path:
  - split snapshot loading/diffing
  - split subscriber routing and quiet-hours filtering
  - split delivery scheduling/queue budgeting
  - keep one thin orchestration shell
- Pricing path:
  - split provider collection
  - split normalization and source diagnostics
  - split consensus selection
  - split post-consensus hardening/challenge logic
  - split GT reprobe mutation
- Mint/burn hotspot path:
  - split `worker/src/lib/mint-burn-contracts.ts` into data-only config and validator/schema logic
  - keep current consumer API stable while reducing file-level concentration
- Update hotspot baseline/waiver data only if the new structure is materially smaller and justified by actual code movement, not by relabeling.
- Record any surviving waiver entries for `S-01` in a tracker with explicit owner, next review checkpoint, and closure trigger.

Acceptance criteria:
- `dispatchTelegramAlerts()` and the pricing entrypoint become orchestration shells over testable subphases.
- `worker/src/lib/mint-burn-contracts.ts` is decomposed enough that config data and validation logic are not still co-located as one hotspot.
- Existing behavior and tests remain green, with added seam-level tests where practical.
- Hotspot ratchet passes for the touched files, and any remaining hotspot waivers under `S-01` have explicit owner/checkpoint metadata rather than implicit carry-forward.

Validation:
- `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts worker/src/cron/__tests__/enrich-prices.test.ts`
- `npm run check:hotspot-ratchet`
- `npm run check:cron-connections`
- `npm run check:cron-abort-contract` whenever leased cron paths, cron-lease wrappers, or scheduled-runner handoff code are touched
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- `docs/worker-and-api-limits.md` if budgets/phase ownership documentation changes
- `docs/architecture.md` if module boundaries materially change

### WS-7 - Catalog And Platform Restructuring

Findings:
- `S-02`
- `S-04`
- `CC-05`

#### Gate-WS7A - Catalog Source-Model Approval Gate

Purpose:
- prevent `S-02` implementation from starting before the catalog source model and cutover sequence are locked

Required outputs:
- checked-in design artifact under `/agents/specs/` or `/agents/plans/` that names:
  - chosen source model: per-coin, grouped-manifest, or hybrid
  - mixed-source support strategy during migration
  - cutover order by current source file/family or migration batch
  - rollback/backout approach if a partial migration must be reverted
  - required script, doc, and validation changes
  - owner and explicit approval/signoff checkpoint before any WS-7 implementation PR, explicitly including `PR-11` and `PR-13`

Acceptance criteria:
- the design artifact is specific enough that `PR-11` can be sized without reopening the source-model decision
- mixed old/new source support is either explicitly required in the generator or explicitly ruled out with a safe alternative
- rollback/backout mechanics are documented before any catalog migration PR starts

Validation:
- `npm run check:stablecoin-data`
- `npm run check:doc-counts` if the chosen shape affects data-source counting assumptions
- reviewer signoff recorded in the artifact

Files:
- `shared/data/stablecoins/*.json`
- `shared/lib/stablecoins/registry.ts`
- any new generation scripts
- `worker/src/cron/sync-live-reserves.ts`
- `worker/src/cron/reserve-adapters/index.ts`
- status/telemetry surfaces if deferred-tail metrics are exposed
- design/spec artifact under `agents/specs/` or `agents/plans/` to lock the catalog source model before implementation
- docs:
  - `docs/stablecoin-data.md`
  - `docs/live-reserves.md`
  - `docs/architecture.md`
  - `docs/worker-and-api-limits.md`

Implementation:
- Catalog:
  - Gate-WS7A first locks the source model and cutover sequence in `/agents/` before implementation starts
  - phase A adds generation/aggregation that preserves the current consumer API
  - phase B migrates source data in multiple PRs or batches, not one monolithic cutover
  - the phase-A generator must support mixed old/new source inputs until the final migration cleanup PR lands
  - keep schema validation and doc-count checks intact
- Live reserve sync:
  - shard work by adapter family or partition
  - persist resume/defer state
  - expose deferred-tail / budget-exhaustion metrics in status tooling

Implementation note:
- The current branch delivers the resume/defer state plus deferred-tail metrics portion of `PR-13`.
- The still-unimplemented sharding/partitioning step is tracked explicitly in `agents/tasks/2026-04-22-live-reserve-sharding-follow-up.md`.

Acceptance criteria:
- Catalog changes can land with smaller review surfaces and reduced merge conflicts while preserving current runtime imports.
- Live reserve sync exposes scaling pressure before user-visible staleness becomes the first signal.

Validation:
- `npm run check:stablecoin-data`
- `npm run check:doc-counts`
- `npm test` targeted live-reserve and registry suites
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- required: `docs/stablecoin-data.md`, `docs/live-reserves.md`, `docs/architecture.md`, `docs/worker-and-api-limits.md`

### WS-8 - Toolchain, Env Contract, And Guardrail Sustainability

Findings:
- `S-03`
- `S-05`
- `S-07`

Files:
- `package.json`
- `worker/package.json`
- `.github/actions/setup-workspace/action.yml`
- `.github/workflows/deploy-cloudflare.yml`
- `scripts/check-worker-migrations.mjs`
- `.env.example`
- `worker/src/lib/env.ts`
- `functions/lib/ops-env.ts`
- `functions/lib/site-api-env.ts`
- `scripts/check-env-contract.mjs`
- selected custom scripts and workflow files
- docs:
  - `docs/testing.md`
  - `docs/deployment-process.md`
  - `docs/worker-and-api-limits.md`

Implementation:
- `PR-14` (`S-03`) must do concrete Node 25 decoupling work:
  - isolate or remove direct reliance on `--env-file-if-exists`
  - isolate or remove direct reliance on `node:sqlite` where it blocks LTS support
  - add a CI lane on the target LTS runtime
  - add an explicit LTS compatibility command set or helper script so proof is not implicit
  - prove root, worker, migration tooling, and env-loader-dependent entrypoints on that LTS target
  - only treat `S-03` as closed if the minimum runtime is actually lowered, or if remaining blockers are explicitly documented as follow-up debt with owner and closure trigger
- `PR-15` (`S-05`) consolidates env-contract maintenance around one typed manifest that generates or mechanically derives:
  - `.env.example`
  - runtime-specific active/reserved env views
  - relevant env docs snippets in the verified docs corpus
  - validation/sync checks that fail if those outputs drift from the manifest
- `PR-16` (`S-07`) audits the guardrail stack and retires custom checks only where guarantees can be preserved by standard tooling.
- `PR-16` must also produce a guardrail inventory/ownership artifact that names owner(s), review cadence, and retirement criteria for the custom verification layer so `S-07` is not reduced to code deletion alone.

Acceptance criteria:
- Node-25-specific runtime coupling is concretely reduced, an LTS CI lane exists, and the runtime floor is lowered where feasible or blocked with explicit tracked blockers.
- Env-contract ownership is centralized enough that worker, Pages Functions, and CI views do not drift independently.
- Guardrail consolidation does not reduce protection on migrations, docs, or runtime-boundary checks.
- The custom guardrail subsystem has explicit ownership and a review cadence recorded in a checked-in artifact.

Validation:
- explicit target-LTS validation for `PR-14`, including:
  - root `npm test`
  - root `npm run lint`
  - root `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
  - `npm run check:migrations`
  - explicit env-loader compatibility checks for the entrypoints that currently depend on env-file behavior, via the new `PR-14` helper/command set
  - the new target-LTS CI lane must run this exact command list before `S-03` can be closed
- updated CI/workflow dry validation where possible
- `npm run check:env-contract`
- `npm run check:migrations`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- required: `docs/testing.md`, `docs/deployment-process.md`, `docs/worker-and-api-limits.md`

## Finding Coverage Matrix

| Finding | Workstream | PR | Notes |
| --- | --- | --- | --- |
| `R-01` | WS-2 | PR-02 | reserve adapter metadata helper |
| `R-02` | WS-2 | PR-02 | reserve adapter redemption-rate probe helper |
| `R-03` | WS-4 | PR-03 | benchmark loader centralization |
| `R-04` | WS-2 | PR-02 | shared API-key SQL projection fragments |
| `R-05` | WS-3 | PR-04 | status severity rendering centralization |
| `R-06` | WS-4 | PR-03 | digest contract centralization |
| `R-07` | WS-4 | PR-03 | shared summary contract |
| `R-08` | WS-5 | PR-05 | stablecoin-detail view-model simplification |
| `R-09` | WS-3 | PR-04 | shared status types |
| `Q-01` | WS-1 | PR-01 | proxy `Retry-After` preservation |
| `Q-02` | WS-6 | PR-08 | pricing module decomposition |
| `Q-03` | WS-6 | PR-07 | Telegram dispatch decomposition |
| `Q-04` | WS-1 | PR-01 | feedback degraded-service behavior lands in one PR |
| `Q-05` | WS-5 | PR-05 | `ContagionGraph` split + tests |
| `Q-06` | WS-1 | PR-06 | frontend fetch cancellation/timeout support |
| `S-01` | Gate 0 / WS-6 | PR-00 / PR-07 / PR-08 / PR-09 | hotspot unblocker plus Telegram, pricing, and mint-burn retirement lanes |
| `S-02` | WS-7 | Gate-WS7A / PR-11 / PR-12a / PR-12b / PR-12c | design checkpoint, generator foundation, then batched catalog migration |
| `S-03` | WS-8 | PR-14 | concrete Node/runtime decoupling |
| `S-04` | WS-7 | PR-13 | live reserve scaling work |
| `S-05` | WS-8 | PR-15 | typed env-contract manifest |
| `S-06` | WS-5 | PR-05 / PR-10 | frontend and status hotspot retirement |
| `S-07` | WS-8 | PR-16 | guardrail sustainability review |
| `CC-01` | WS-6 | PR-07 | Telegram path compound issue |
| `CC-02` | WS-4 / WS-6 | PR-03 / PR-08 | benchmark dedupe before pricing split |
| `CC-03` | WS-3 / WS-5 | PR-04 / PR-10 | status contract cleanup then status hotspot decomposition |
| `CC-04` | WS-4 | PR-03 | build/runtime shared contract layer |
| `CC-05` | WS-7 | Gate-WS7A / PR-11 / PR-12a / PR-12b / PR-12c / PR-13 | catalog blast-radius reduction and reserve scaling |

## Sequencing Rules

- `PR-00` must land first so the repository can satisfy its own merge-gate requirement.
- `PR-01` must land before deeper worker refactors so degraded-service behavior is corrected early.
- `PR-03` should precede `PR-08` because the benchmark-loader cleanup removes avoidable duplication before the primary pricing split.
- `PR-03` must precede `PR-05` because both touch the stablecoin-detail contract/view-model surface.
- `PR-04` should precede `PR-10` because status contract cleanup reduces churn across later status/front-end decomposition work.
- `PR-07`, `PR-08`, `PR-09`, and `PR-10` must land serially if they touch `scripts/lib/hotspot-ratchet-baseline.json`, `scripts/lib/hotspot-ratchet-waivers.json`, or the hotspot retirement tracker.
- `Gate-WS7A` must complete before `PR-11` and `PR-13` begin, because both catalog migration and live-reserve scaling depend on the chosen source-model and cutover mechanics.
- `PR-11`, `PR-12a`, `PR-12b`, `PR-12c`, and `PR-13` should be sequenced carefully because live reserve scaling depends on how the catalog source-of-truth is reshaped.
- `PR-14`, `PR-15`, and `PR-16` are explicitly split and should not be recombined.

## Validation Matrix

| Workstream | Required validation |
| --- | --- |
| Gate 0 | `check:hotspot-ratchet`, targeted tests if the unblocker changes code, `lint`, touched typecheck surface |
| WS-1 | targeted proxy/API tests, `lint`, root `typecheck`, worker `tsc` |
| WS-2 | targeted adapter/API-key tests, `lint`, worker `tsc` |
| WS-3 | targeted status tests, `lint`, root `typecheck` |
| WS-4 | targeted benchmark/contract tests, `lint`, root `typecheck`, worker `tsc` |
| WS-5 | targeted component/hook/status tests, `check:hotspot-ratchet` when waived hotspots are touched, `lint`, root `typecheck` |
| WS-6 | targeted cron tests, `check:hotspot-ratchet`, `check:cron-connections`, `lint`, worker `tsc` |
| WS-7 | `check:stablecoin-data`, `check:doc-counts`, targeted live-reserve/registry tests, `check:cron-connections` for `PR-13`, `check:cron-abort-contract` whenever leased cron or scheduled-runner handoff paths change, `check:cron-sync` whenever slot/runner metadata changes, `lint`, root `typecheck`, worker `tsc` |
| WS-8 | `check:env-contract`, `check:migrations`, workflow/runtime validation as applicable, `lint`, root `typecheck`, worker `tsc` |

Every merged PR also runs:
- `npm test`
- `npm run test:merge-gate`

Pages-impacting PRs additionally run:
- `npm run build`
- `npm run seo:check`

## Risk Register

### Highest-risk areas

- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `shared/data/stablecoins/*.json`
- `worker/src/cron/sync-live-reserves.ts`
- Node/toolchain/workflow files in `PR-14`, `PR-15`, and `PR-16`

### Risk controls

- Keep behavior-preserving dedupe and contract cleanups ahead of broad refactors.
- Do not combine Telegram and pricing hotspot work in one PR.
- Do not combine mint-burn hotspot retirement with Telegram or pricing decomposition in one PR.
- Require targeted seam-level tests for newly extracted phases/helpers.
- Avoid mixing strategic platform work (`S-02`, `S-03`, `S-04`) with unrelated UI cleanup.
- Update docs in the same PR as any contract or operational change.

## Open Decisions

- Whether the stablecoin catalog should move all the way to per-coin files in one step, or first to smaller grouped manifests plus generation. `Gate-WS7A` exists to resolve this before implementation starts.
- How much live reserve deferred-tail telemetry should be surfaced publicly versus only in admin/status tooling.
- Whether frontend API timeout support should use an opt-in wrapper only or also introduce a conservative shared default. Either way, both caller-provided cancellation and a standard timeout path are required.

## Review Loop Log

### Review Round 0
- Initial draft created.
- Pending formal review.

### Review Round 1
- Reviewer findings received:
  - execution review: `PE-01` through `PE-06`
  - completeness review: `PC-01` through `PC-06`
- Applied fixes:
  - added `Gate 0` hotspot-ratchet unblocker before deploy-impacting work
  - added explicit `S-01` closure lane for `worker/src/lib/mint-burn-contracts.ts` and hotspot-program retirement tracking
  - split the former monolithic `PR-12` into `PR-14`, `PR-15`, and `PR-16`
  - added `Gate-WS7A` design checkpoint before catalog migration
  - kept all of `Q-04` in `PR-01`
  - added explicit sequencing for `PR-03` before `PR-05`
  - expanded `WS-5` to include waived status-surface hotspots
  - strengthened `Q-06` and `S-03` closure criteria from optional/planning language to concrete outputs
  - added explicit `ContagionGraph` test expectations and `docs/worker-and-api-limits.md` to `WS-7`

### Review Round 2
- Reviewer findings received:
  - completeness review: `PC-01` and `PC-02`
  - execution review: `PE-07` through `PE-11`
- Applied fixes:
  - added explicit guardrail ownership/review-cadence output to `PR-16`
  - corrected stale risk-register references to `PR-14` / `PR-15` / `PR-16`
  - split catalog migration into `PR-12a`, `PR-12b`, and `PR-12c` with mixed-source support
  - added a dedicated `Gate-WS7A` section with deliverables, acceptance criteria, validation, owner/signoff expectation
  - expanded hotspot-metadata serialization rules to include `PR-09`
  - added explicit `WS-7` cron-budget validation requirements for `PR-13`

### Review Round 3
- Reviewer findings received:
  - completeness review: `PC-01` and `PC-02`
  - execution review: `PE-12` through `PE-14`
- Applied fixes:
  - added `PR-10` hotspot-waiver metadata scope and serialized it with other hotspot-metadata PRs
  - expanded `Gate-WS7A` gating so `PR-13` cannot start before the catalog design checkpoint resolves dependencies
  - made `PR-15` explicitly generate/mechanically derive `.env.example`, runtime env views, and env docs snippets from the manifest
  - made `PR-14` validation explicit on the target LTS runtime instead of generic workflow validation

### Review Round 4
- Reviewer findings received:
  - execution review: `PE-15` through `PE-17`
- Applied fixes:
  - added `check:cron-abort-contract` coverage to `WS-6` and `WS-7` validation where leased cron paths change
  - tightened `PR-14` LTS proof to require explicit migration and env-loader validation commands, plus the new LTS CI lane running that exact list
  - aligned `Gate-WS7A` signoff wording with the sequencing rule so it clearly gates both `PR-11` and `PR-13`

### Review Round 5
- Final review phase results:
  - completeness review: `0` High, `0` Medium, `0` Minor
  - execution review: `0` High, `0` Medium, `0` Minor
- Exit condition met: review phase returned fewer than `3` minor issues.
