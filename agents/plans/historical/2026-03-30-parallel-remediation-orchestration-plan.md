# 2026-03-30 Parallel Remediation Orchestration Plan

## Objective

Turn the findings in [2026-03-30-multi-agent-remediation-blueprint.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-30-multi-agent-remediation-blueprint.md) into a dispatch-ready implementation program optimized for parallel subagent execution while keeping merge conflicts, validation churn, and architectural risk bounded.

This plan is intentionally execution-oriented. It assumes the orchestrator owns sequencing, branch discipline, merge gating, and final integration, while subagents own isolated tickets with explicit write scopes.

## Source Findings Covered

- Redundancy: `R1` to `R6`
- Quality: `Q1` to `Q6`
- Sustainability: `S1` to `S6`

## Program Rules

1. One ticket, one branch, one primary owner.
2. No two active tickets may edit the same hotspot file unless one is explicitly waiting on the other.
3. Shared docs and governance files are locked to convergence tickets to avoid avoidable rebases.
4. Every ticket must preserve existing product behavior unless the finding explicitly requires a behavior change.
5. Every behavior, pipeline, or methodology change must update the matching verified docs before final closeout.
6. The orchestrator, not the worker subagent, owns cross-ticket rebases and merge ordering.

## Validation Baseline

Every ticket runs its targeted checks. Every merge wave ends with:

```bash
npm run lint
npm run typecheck
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Worker-heavy waves should also run:

```bash
npm run check:cron-sync
npm run check:cron-connections
npm run check:sql-safety
npm run check:migrations
npm run check:doc-sync
```

## Locked Files And Merge Ownership

These files create unnecessary contention and should not be edited opportunistically:

- `package.json`, `worker/package.json`, `.github/workflows/*`: platform lane only
- `README.md`, `docs/testing.md`, `docs/deployment-process.md`, `docs/scripts.md`, `docs/data-flow-map.md`: docs convergence tickets only unless a ticket is doc-only
- `scripts/lib/hotspot-ratchet-baseline.json`, `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`: hotspot-governance lane only
- `functions/api/admin/[[path]].ts`: ops lane first, admin-abstraction lane later
- `worker/src/cron/sync-stablecoins/*`: cache-hardening lane first, cache-helper lane later
- `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/publication.ts`: yield-guard lane first, cache-helper lane later
- `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/blacklist/*`: externally owned, excluded from this orchestration train

## External Holds

These findings remain covered at the program level but are intentionally removed from the active dispatch train because another agent or workstream owns the logic:

- `EXT-BLACKLIST-01`
  - Audit finding coverage: part of `S2`
  - Scope:
    - `worker/src/cron/sync-blacklist.ts`
    - `worker/src/cron/blacklist/*`
  - Reason:
    - blacklistable item inheritance logic is being modified elsewhere, so concurrent structural work here would create unnecessary overlap risk
  - Program treatment:
    - excluded from subagent dispatch in this plan
    - keep as an external dependency to reconcile after the other agent lands
    - revisit only after the external branch merges and the blacklist surface is stable again

## Execution Waves

| Wave | Goal | Parallelism |
| --- | --- | --- |
| `W0` | Baseline capture, branch setup, file locks, and dispatch packets | orchestrator only |
| `W1` | Independent correctness and low-conflict quick wins | very high |
| `W2` | Shared contracts and medium refactors built on `W1` behavior | high |
| `W3` | Structural worker decomposition with disjoint write scopes | high |
| `W4` | Hotspot governance refresh and next-tier frontend/shared work | medium |
| `W5` | Docs convergence, dependency closeout, final full validation | low |

## Wave 0

### `CTRL-00` Orchestrator setup

- Scope:
  - Confirm `main` passes the validation baseline before opening the train.
  - Create one branch per ticket using `orch/<ticket-id>`.
  - Publish the locked-file list to all subagents.
  - Prepare a merge queue ordered by wave.
- Validation:
  - full validation baseline
- Output:
  - ready-to-dispatch ticket packets

## Wave 1

These tickets are intentionally chosen because they do not need each other and can run in parallel with minimal overlap.

### `COR-01` Stablecoin cache hardening

- Findings: `Q1`
- Scope:
  - `worker/src/cron/sync-stablecoins/stages.ts`
  - `worker/src/cron/sync-stablecoins/runtime.ts`
  - `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - `worker/src/cron/__tests__/sync-stablecoins-stages.test.ts`
- Goal:
  - Guard malformed cached JSON in the staleness path and add direct regression coverage.
- Dependencies:
  - none
- Validation:
  - `npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-stages.test.ts`
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/pricing-pipeline.md`, `docs/data-flow-map.md`, `docs/testing.md`
- Merge notes:
  - must merge before `REF-02`

### `COR-02` Yield publication guard hardening

- Findings: `Q2`
- Scope:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/yield-sync/publication.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `worker/src/cron/__tests__/yield-publication.test.ts`
- Goal:
  - Treat malformed prior rankings cache as degraded or blocking, not as zero prior rows.
- Dependencies:
  - none
- Validation:
  - `npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-publication.test.ts`
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/yield-intelligence.md`, `docs/yield-intelligence-operations.md`, `docs/testing.md`
- Merge notes:
  - must merge before `REF-02`

### `OPS-01` Pages ops gate consolidation and proxy diagnostics

- Findings: `R4`, `Q4`
- Scope:
  - `functions/admin/[[path]].ts`
  - `functions/api/admin/[[path]].ts`
  - `functions/lib/ops-origin.ts`
  - `functions/__tests__/admin-host-gate.test.ts`
  - `functions/__tests__/ops-admin-proxy.test.ts`
- Goal:
  - Extract one canonical ops-origin gate helper and add sanitized upstream failure logging in the proxy.
- Dependencies:
  - none
- Validation:
  - `npm test -- functions/__tests__/admin-host-gate.test.ts functions/__tests__/ops-admin-proxy.test.ts`
  - `npm run build`
- Docs:
  - queue notes for `docs/operator-origin-access.md`, `docs/api-reference.md`
- Merge notes:
  - must merge before `REF-03`

### `SEC-01` Rate-limit fallback decision and implementation

- Findings: `Q3`
- Scope:
  - `worker/src/lib/rate-limit.ts`
  - `worker/src/handlers/http/gates.ts`
  - add or update tests beside the affected modules
- Goal:
  - Replace undocumented fail-open behavior with an explicit policy: bounded fallback, clear alerting, or documented fail-open if retained.
- Dependencies:
  - none
- Validation:
  - targeted worker tests for the limiter and gate path
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/worker-and-api-limits.md`
- Merge notes:
  - independent; if behavior changes, keep isolated from other worker tickets

### `TEST-01` Shared test ownership canonization

- Findings: `R6`
- Scope:
  - `src/lib/__tests__/format.test.ts`
  - `shared/lib/__tests__/format.test.ts`
  - `src/lib/__tests__/supply.test.ts`
  - `shared/lib/__tests__/supply.test.ts`
- Goal:
  - Keep canonical shared-helper assertions in `shared`, and keep `src` tests only for frontend-specific behavior.
- Dependencies:
  - none
- Validation:
  - `npm test -- src/lib/__tests__/format.test.ts src/lib/__tests__/supply.test.ts shared/lib/__tests__/format.test.ts shared/lib/__tests__/supply.test.ts`
- Docs:
  - queue note for `docs/testing.md`
- Merge notes:
  - independent; prefer to land early so later refactors inherit the cleaner test boundary

### `PLAT-01` Validation contract extraction

- Findings: `R2`
- Scope:
  - `scripts/test-merge-gate.mjs`
  - `scripts/lib/validate-contract.mjs` or equivalent new shared manifest/script
  - `scripts/__tests__/test-merge-gate.test.ts`
  - `scripts/__tests__/validate-ci-parity.test.ts`
- Goal:
  - Move validate command inventory to one authoritative source that local merge-gate and CI can both consume.
- Dependencies:
  - none
- Validation:
  - `npm test -- scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
  - `npm run test:merge-gate`
- Docs:
  - none in this ticket
- Merge notes:
  - must merge before `PLAT-02`

### `FE-01` Chain route hardening and test scaffolding

- Findings: `Q5`
- Scope:
  - `src/app/chains/[chain]/client.tsx`
  - new tests under `src/app/chains/[chain]/__tests__/`
- Goal:
  - Add route-level coverage for primary branches, sort/filter behavior, and degraded-data states, while extracting easy view-model helpers.
- Dependencies:
  - none
- Validation:
  - `npm test -- src/app/chains/[chain]`
  - `npm run build`
  - `npm run lint`
- Docs:
  - none expected unless test conventions change
- Merge notes:
  - must merge before any later decomposition of this route

## Wave 2

These tickets either consolidate duplicated behavior exposed by `W1` or touch files intentionally reserved until the quick wins are stable.

### `REF-01` Weekly-digest exclusion helper

- Findings: `R3`
- Scope:
  - `worker/src/cron/daily-digest.ts`
  - `worker/src/cron/daily-digest/collectors.ts`
  - `worker/src/cron/weekly-recap.ts`
- Goal:
  - Extract one shared digest-history exclusion fragment/helper and remove raw SQL duplication.
- Dependencies:
  - none
- Validation:
  - `npm test -- worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/weekly-recap.test.ts`
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue note for `docs/digest-pipeline.md`
- Merge notes:
  - should merge before `STR-01`

### `REF-02` Canonical worker cache-reader helper

- Findings: `R1`
- Scope:
  - `worker/src/lib/api-utils.ts` or new `worker/src/lib/cache-json.ts`
  - `worker/src/cron/sync-stablecoins/shared.ts`
  - `worker/src/cron/sync-stablecoins/stages.ts`
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/yield-sync/publication.ts`
  - `worker/src/cron/dispatch-telegram-alerts.ts`
  - `worker/src/cron/yield-coverage-audit.ts`
  - directly affected tests
- Goal:
  - Replace manual cache `JSON.parse` branches with one typed helper family and one degrade-policy surface.
- Dependencies:
  - `COR-01`
  - `COR-02`
- Validation:
  - targeted stablecoins, yield, telegram, and yield-coverage tests
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/pricing-pipeline.md`, `docs/yield-intelligence.md`, `docs/worker-infrastructure.md`, `docs/testing.md`
- Merge notes:
  - do not start before `COR-01` and `COR-02` merge

### `REF-03` Canonical admin-route abstraction

- Findings: `R5`
- Scope:
  - `worker/src/lib/route-wrappers.ts`
  - `worker/src/lib/admin-job.ts`
  - `worker/src/api/admin-actions.ts`
  - `worker/src/api/status.ts`
  - `worker/src/api/status-history.ts`
  - directly affected tests
- Goal:
  - Choose one admin-route abstraction for auth, body parsing, idempotency, and job orchestration.
- Dependencies:
  - `OPS-01` recommended first so Pages-side admin boundary behavior is already stable
- Validation:
  - targeted admin and status API tests
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/api-reference.md`, `docs/architecture.md`
- Merge notes:
  - run after `OPS-01`; keep route surface stable while internal abstraction changes

### `PLAT-02` CI parity, Node 24, and lint warning policy

- Findings: `Q6`, `S5`
- Scope:
  - `.github/workflows/validate-ci.yml`
  - `.github/workflows/deploy-cloudflare.yml`
  - `package.json`
  - `scripts/check-stablecoin-data.ts`
  - `scripts/__tests__/validate-ci-parity.test.ts`
- Goal:
  - Make CI consume the shared validation contract, decide whether warnings fail lint, and either strengthen Node 24 validation or narrow the engine claim.
- Dependencies:
  - `PLAT-01`
- Validation:
  - `npm run lint`
  - `npm test -- scripts/__tests__/validate-ci-parity.test.ts`
  - `npm run test:merge-gate`
- Docs:
  - queue notes for `README.md`, `docs/testing.md`, `docs/deployment-process.md`
- Merge notes:
  - must merge before `PLAT-03` and `DOC-01`

### `FE-02` Methodology content extraction

- Findings: `S4`
- Scope:
  - `src/app/methodology/sections/core/safety-scores-section.tsx`
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
  - `src/app/methodology/scoring-changelog/content-v5.tsx`
  - `src/app/methodology/scoring-changelog/content-v6.tsx`
  - `src/app/methodology/scoring-changelog/content-legacy.tsx`
  - any new content registry files created to hold extracted content
- Goal:
  - Move long-form methodology content into content-oriented structures without changing meaning or design.
- Dependencies:
  - none
- Validation:
  - targeted methodology tests if added
  - `npm run build`
  - `npm run check:doc-sync`
- Docs:
  - queue notes for `docs/methodology-page.md` and relevant timeline docs only if semantics change
- Merge notes:
  - keep content verbatim where possible; isolate this from unrelated UI work

## Wave 3

These are the large structural tickets. They can run in parallel because the write scopes are disjoint.

### `STR-01` Daily-digest collector decomposition

- Findings: `S1`
- Scope:
  - `worker/src/cron/daily-digest.ts`
  - `worker/src/cron/daily-digest/collectors.ts`
  - new helper modules under `worker/src/cron/daily-digest/`
  - directly affected tests
- Goal:
  - Split collector families and shared primitives so `collectors.ts` becomes orchestration plus composition, not the entire implementation surface.
- Dependencies:
  - `REF-01` preferred first
- Validation:
  - `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/digest-pipeline.md`, `docs/data-flow-map.md`, `docs/testing.md`
- Merge notes:
  - do not share branch scope with `STR-02` or `STR-04`

### `STR-02` Yield-source family split

- Findings: `S1`
- Scope:
  - `worker/src/cron/yield-sync/sources.ts`
  - `worker/src/cron/yield-sync/sources-helpers.ts`
  - `worker/src/cron/yield-sync/sources-optional-protocols.ts`
  - new family modules under `worker/src/cron/yield-sync/`
  - directly affected tests
- Goal:
  - Replace one monolith with source-family modules and a stable registry assembly point.
- Dependencies:
  - `REF-02` preferred first
- Validation:
  - targeted yield-source and resolve tests
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/yield-intelligence.md`, `docs/yield-intelligence-operations.md`, `docs/data-flow-map.md`, `docs/testing.md`
- Merge notes:
  - keep public export surface stable while internal structure changes

### `STR-04` FX-rate orchestration split

- Findings: `S2`
- Scope:
  - `worker/src/cron/sync-fx-rates.ts`
  - `worker/src/cron/sync-fx-rates-helpers.ts`
  - any new helper modules introduced by the split
  - directly affected tests
- Goal:
  - Reduce `sync-fx-rates.ts` to orchestration and isolate provider selection, fallback policy, persistence, and reporting.
- Dependencies:
  - none
- Validation:
  - `npm test -- worker/src/cron/__tests__/sync-fx-rates.test.ts worker/src/lib/__tests__/fx-rate-state.test.ts`
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for `docs/worker-infrastructure.md`, `docs/data-flow-map.md`, `docs/testing.md`
- Merge notes:
  - independent of the other structural worker tickets

## Wave 4

This wave turns the structural results into sustained governance and opens the next decomposition queue.

### `GOV-01` Hotspot ratchet expansion

- Findings: `S3`
- Scope:
  - `scripts/lib/hotspot-ratchet-baseline.json`
  - `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`
- Required tracked additions:
  - `shared/lib/report-cards.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/dex-liquidity/scoring.ts`
  - `worker/src/cron/dispatch-telegram-alerts.ts`
  - `worker/src/cron/sync-live-reserves.ts`
  - `src/components/contagion-graph.tsx`
  - `src/app/chains/[chain]/client.tsx`
- Goal:
  - Expand hotspot governance so large high-risk files are tracked before they become permanent blind spots.
- Dependencies:
  - `STR-01`
  - `STR-02`
  - `STR-04`
  - `FE-01`
- Validation:
  - `npm run check:hotspot-ratchet`
  - if baseline changes are needed, rerun the ratchet after the baseline update
- Docs:
  - queue notes for `docs/scripts.md`, `README.md`
- Merge notes:
  - last before docs convergence; baseline must reflect post-split file sizes, not pre-split sizes

### `FE-03` Frontend/shared next-tier hotspot decomposition

- Findings: phase-4 backlog implied by `S3` and `Q5`
- Scope:
  - `shared/lib/report-cards.ts`
  - `src/components/contagion-graph.tsx`
  - follow-on work for `src/app/chains/[chain]/client.tsx` only after `FE-01`
- Goal:
  - Start decomposing the highest-value frontend/shared hotspot files once test scaffolding and ratchet tracking exist.
- Dependencies:
  - `FE-01`
  - `GOV-01` recommended first
- Validation:
  - targeted component/shared-lib tests
  - `npm run build`
  - `npm run lint`
- Docs:
  - queue notes only if external contracts change
- Merge notes:
  - split into separate branches per file family if all three are pursued at once

### `WORK-04` Worker next-tier hotspot intake

- Findings: phase-4 backlog implied by `S3`
- Scope candidates:
  - `worker/src/cron/sync-live-reserves.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/dex-liquidity/scoring.ts`
  - `worker/src/cron/dispatch-telegram-alerts.ts`
- Goal:
  - Convert the newly tracked worker hotspots into owned decomposition tickets instead of leaving them as ratchet-only debt.
- Dependencies:
  - `GOV-01`
- Validation:
  - targeted tests per module
  - `cd worker && npx tsc --noEmit`
- Docs:
  - queue notes for the corresponding feature docs
- Merge notes:
  - treat this as a queue, not one branch; dispatch one hotspot per subagent

## Wave 5

### `PLAT-03` Scheduled full dependency audit

- Findings: `S6`
- Scope:
  - `.github/workflows/dependency-audit.yml` or equivalent scheduled workflow
  - `package.json` if a new audit script is added
- Goal:
  - Add a scheduled full dependency audit that includes devDependencies while keeping the blocking prod gate intact.
- Dependencies:
  - `PLAT-02`
- Validation:
  - `npm run audit:deps`
  - `npm audit --audit-level=high`
  - `npm run test:merge-gate`
- Docs:
  - update `docs/testing.md`, `docs/scripts.md`
- Merge notes:
  - land after CI contract work is stable

### `DOC-01` Docs convergence and final policy alignment

- Findings:
  - all tickets that queued doc notes
- Scope:
  - `README.md`
  - `docs/testing.md`
  - `docs/deployment-process.md`
  - `docs/scripts.md`
  - `docs/data-flow-map.md`
  - plus any area-specific docs queued by merged tickets
- Goal:
  - Reconcile the verified documentation corpus with the final code state after the remediation waves land.
- Dependencies:
  - all preceding waves complete
- Validation:
  - `npm run check:doc-sync`
  - `npm run test:merge-gate`
- Merge notes:
  - only the orchestrator should own this ticket to collapse doc churn once

## Ticket Dispatch Order

### First dispatch batch

- `COR-01`
- `COR-02`
- `OPS-01`
- `SEC-01`
- `TEST-01`
- `PLAT-01`
- `FE-01`

### Second dispatch batch

- `REF-01`
- `REF-02`
- `REF-03`
- `PLAT-02`
- `FE-02`

### Third dispatch batch

- `STR-01`
- `STR-02`
- `STR-04`

### Fourth dispatch batch

- `GOV-01`
- `FE-03`
- `WORK-04`

### Final dispatch batch

- `PLAT-03`
- `DOC-01`

## Subagent Prompt Template

Use this template for each dispatched ticket:

```text
Implement ticket <TICKET-ID> from /agents/plans/2026-03-30-parallel-remediation-orchestration-plan.md.

Constraints:
- You own only the listed files and directly related tests.
- Do not edit locked files unless the ticket explicitly names them.
- Do not revert or refactor unrelated code.
- Preserve current external behavior unless the ticket explicitly changes it.
- Run the ticket-specific validation commands before handing back.
- Report: files changed, behavior changes, tests run, doc notes to queue for DOC-01, and any follow-up risks.
```

## Orchestrator Responsibilities

The orchestrator should do the following between waves:

1. Rebase active branches only after the previous wave merges.
2. Run the wave gate validation once per merge batch, not after every PR.
3. Reject any ticket that expands into a locked file without approval.
4. Convert doc edits inside non-doc tickets into queued notes unless the ticket is doc-only.
5. Open the next wave only after dependency tickets are merged and the validation gate is green.
6. Treat `EXT-BLACKLIST-01` as out of scope for dispatch until the external blacklist logic work is merged.

## Recommended Merge Sequence

1. Merge `COR-01`, `COR-02`, `OPS-01`, `SEC-01`, `TEST-01`, `PLAT-01`, `FE-01`
2. Run full wave gate
3. Merge `REF-01`, `REF-02`, `REF-03`, `PLAT-02`, `FE-02`
4. Run full wave gate
5. Merge `STR-01`, `STR-02`, `STR-04`
6. Run worker-heavy wave gate
7. Merge `GOV-01`, then any approved `FE-03` and `WORK-04` subbranches
8. Run full wave gate
9. Merge `PLAT-03`
10. Merge `DOC-01`
11. Run final full validation baseline

## Success Criteria

- Every finding in the 2026-03-30 remediation blueprint is mapped to a concrete implementation ticket or governed queue.
- No active wave contains overlapping write scopes without an explicit dependency.
- The merge-gate contract is single-sourced.
- The top worker hotspots in scope for this train have owners and decomposition tickets, not just backlog mentions.
- Blacklist decomposition is explicitly held out of this train and tracked as an external dependency instead of conflicting active work.
- Hotspot governance covers the next tier of large production files.
- Final docs match the final implementation state.
