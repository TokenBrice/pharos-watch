# Live Reserve Sync Remediation Plan (2026-03-24)

Input audit:
- [2026-03-24 live reserve sync audit](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-24-live-reserve-sync-audit.md)

Goal:
- improve reserve-data accuracy first
- then harden reliability/observability
- then reduce adapter maintenance cost and LOC without destabilizing production behavior

Non-goals:
- no broad coverage expansion in this plan
- no adapter redesign just for style
- no public API contract change unless a change is explicitly called out and documented

## Execution Strategy

Recommended order:
1. Fix the small number of clear correctness bugs
2. Tighten the independent-feed freshness contract
3. Unify helper/adapter infrastructure
4. Reduce repeated bucket logic and improve observability

This is intentionally not a “big bang” refactor. The system is already working; the next step is targeted hardening.

## Workstream A: Correctness Fixes

Priority: `P0`

### A1. Fix `fx` unknown-exposure handling

Problem:
- unknown positive collateral keys are warned about but excluded from the rendered reserve mix

Implementation:
- update [fx.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/fx.ts)
- include an explicit unmapped/other slice when unknown positive balances exist
- populate `unknownExposurePct`
- keep degraded warnings for the unknown keys

Acceptance criteria:
- if upstream adds an unknown collateral key with positive balance, reserve slices no longer normalize known assets to 100%
- metadata includes `unknownExposurePct`
- adapter tests cover at least:
  - all-known collateral
  - unknown collateral only
  - mixed known + unknown collateral

### A2. Review and harden `m0` unit-scaling assumption

Problem:
- `m0.ts` applies a repo-local scaling assumption to `totalCash`

Implementation:
- verify the upstream field units against current upstream behavior/docs
- encode the assumption more explicitly in code/comments/tests
- if the assumption is no longer valid, correct the transformation

Acceptance criteria:
- scaling behavior is explicitly justified in code and tests
- reconciliation checks still pass after the change

### A3. Add stronger metadata minimums to sparse adapters

Problem:
- some independent adapters produce usable slices but weak operator/debug metadata

First targets:
- [asymmetry.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/asymmetry.ts)
- [crvusd.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/crvusd.ts)
- [collateral-positions-api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/collateral-positions-api.ts)

Implementation:
- add consistent metadata where available:
  - item count
  - unknown exposure
  - timestamp presence/absence reason

Acceptance criteria:
- these adapters expose enough metadata to explain a degraded sync without rereading raw upstream payloads

## Workstream B: Freshness Contract Hardening

Priority: `P0`

### B1. Define the rule for independent adapters without `sourceTimestamp`

Current problem:
- 16 `independent` coins rely on adapters that do not emit trustworthy upstream timestamps

Decision to lock:
- either these feeds remain `independent` but become non-scoring while freshness is unverified
- or they remain scoring-eligible only if we can justify them as intrinsically realtime and encode that rule explicitly

Recommended decision:
- for scoring purposes, “independent” should require either:
  - verified timestamp-backed freshness
  - or an explicitly reviewed adapter-level exemption documented in code/docs

### B2. Implement stricter validation for independent scoring passthrough

Implementation options:
- `Option 1` recommended:
  - keep detail/status surfaces unchanged
  - tighten `loadFreshIndependentLiveReserveMap()` eligibility so timestamp-less/unverified feeds do not pass through to report-card collateral scoring by default
- `Option 2`:
  - degrade sync state itself for all timestamp-less independent feeds

Recommended implementation:
- choose `Option 1` first because it is safer and more targeted
- only move to sync-state degradation where the product intent is clearly “this feed is not good enough even for live detail presentation”

Acceptance criteria:
- no timestamp-less independent feed reaches collateral passthrough unless it has an explicit reviewed exemption
- status/detail reserve views still show the live feed when it is otherwise useful
- methodology docs are updated if scoring eligibility rules change

### B3. Standardize freshness metadata semantics

Implementation:
- ensure every adapter emits one of:
  - `sourceTimestamp + freshnessMode`
  - `freshnessMode: "not-applicable"` for direct on-chain state
  - explicit “unverified freshness” metadata for feeds that cannot prove recency

Targets:
- especially `accountable`, `circle-transparency`, `m0`, `mento`, `openeden-usdo`, `reservoir`

Acceptance criteria:
- no independent adapter silently omits freshness semantics

## Workstream C: Reliability Hardening

Priority: `P1`

### C1. Move `erc4626-single-asset` onto the shared on-chain helper path

Problem:
- it ignores `rpcUrl`, `fallbackRpcUrl`, `rpcMode`, and Etherscan fallback behavior

Implementation:
- rework [erc4626-single-asset.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/erc4626-single-asset.ts) to use the same `helpers.ts` on-chain calls as the rest of the adapter family
- remove reserve-adapter dependence on [evm.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/evm.ts) if it becomes redundant

Acceptance criteria:
- ERC-4626 adapter honors the same RPC fallback contract as `single-asset`, `chainlink-nav`, `chainlink-por`, and `evm-branch-balances`
- tests cover fallback/read-failure behavior

### C2. Harden `fetchDefiLlamaPrices()`

Implementation:
- add request-cache support using `AdapterContext.requestCache`
- cancel unread non-OK bodies before throwing
- keep timeout bounded and explicit

Acceptance criteria:
- duplicate price requests inside one run are deduplicated
- non-OK DefiLlama responses do not strand a response body

### C3. Improve HTML-parser failure signaling

Targets:
- `circle-transparency`
- `fdusd-transparency`
- `mento`
- `sgforge-coinvertible`

Implementation:
- keep current parsing if necessary, but split failure modes into:
  - network failure
  - parse failure
  - “DOM/layout changed” failure

Acceptance criteria:
- status/history makes parser drift distinguishable from ordinary upstream downtime

## Workstream D: Contract Unification

Priority: `P1`

### D1. Finish migration to shared param parsing

Targets:
- [accountable.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/accountable.ts)
- [circle-transparency.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/circle-transparency.ts)
- [erc4626-single-asset.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/erc4626-single-asset.ts)

Acceptance criteria:
- all reserve adapters either use `parseLiveReserveAdapterParams(...)` or have a documented reason not to

### D2. Resolve the `timeoutMs` contract mismatch

Current state:
- `helpers.ts` supports `params.timeoutMs`
- schema does not

Decision:
- either remove the feature
- or add it to the relevant adapter schemas and use it intentionally

Recommended:
- remove it unless there is an immediate real use case

Acceptance criteria:
- runtime helper behavior and schema contract are aligned

## Workstream E: Maintainability / LOC Reduction

Priority: `P2`

### E1. Extract a small shared bucketed-composition helper

Best candidates:
- `ethena`
- `falcon`
- `dola-inverse`
- `sky-makercore`
- `fx`
- `btcfi`

Do not over-abstract. A minimal helper should cover:
- bucket accumulation
- unknown handling
- optional `coinId` / `depType`
- metadata for unknown exposure

Acceptance criteria:
- repeated logic shrinks meaningfully without making adapters harder to read

### E2. Consolidate reusable symbol maps

Implementation:
- move reusable alias/risk/bucket data into shared lookup modules where it is genuinely common
- keep truly protocol-specific mappings local

Acceptance criteria:
- obvious cross-adapter duplication is reduced
- canonical risk rules stay rooted in shared code, not redefined ad hoc

### E3. Split `gho.ts` only if there is active follow-on work

Recommendation:
- do not refactor `gho.ts` immediately unless another change is already touching it
- if touched, split into smaller decoder/loader/adapter helpers in a `gho/` folder

Acceptance criteria:
- no churn-only refactor; only do this when it buys real implementation clarity

## Workstream F: Observability And Status Semantics

Priority: `P2`

### F1. Decide how stale vs active failure should be counted in status

Current issue:
- a stale-but-currently-failing feed is counted as stale first

Recommended:
- make current `error` dominate `stale` in the overview
- keep categories mutually exclusive

Acceptance criteria:
- reserve-sync overview better reflects active incidents

### F2. Add a small parser/adapter-failure taxonomy to attempt history

Implementation:
- enrich attempt metadata or warning codes so failures can be grouped by:
  - network
  - upstream 4xx/5xx
  - parser drift
  - validation failure
  - storage/write failure

Acceptance criteria:
- operator debugging no longer depends on grepping raw logs first

## Recommended Delivery Phases

### Phase 1
- A1 `fx`
- B1/B2 freshness contract decision + scoring-path implementation
- C1 `erc4626-single-asset`
- D1 shared param parsing cleanup

Reason:
- this phase removes the highest-value accuracy/reliability risks with limited blast radius

### Phase 2
- C2 DefiLlama price helper hardening
- B3 freshness metadata standardization
- A3 sparse metadata improvements
- F1 stale/error status semantics

Reason:
- improves operational trust once the correctness bugs are fixed

### Phase 3
- C3 HTML parser failure taxonomy
- E1 bucket helper extraction
- E2 symbol-map consolidation
- optional E3 `gho` modularization

Reason:
- mostly maintainability work after the data contract is stable

## Suggested Ticket Breakdown

1. `LR-001` Fix `fx` unknown exposure modeling
2. `LR-002` Tighten independent-feed scoring freshness contract
3. `LR-003` Rework `erc4626-single-asset` onto shared on-chain helpers
4. `LR-004` Finish adapter param-parser convergence
5. `LR-005` Harden `fetchDefiLlamaPrices()` request handling/cache
6. `LR-006` Standardize freshness metadata for timestamp-less adapters
7. `LR-007` Improve sparse adapter metadata (`asymmetry`, `crvusd`, `collateral-positions-api`)
8. `LR-008` Refine reserve status overview stale/error precedence
9. `LR-009` Add HTML parser failure taxonomy
10. `LR-010` Extract shared bucketed-composition helper

## Validation Plan

For every implementation phase:
- run targeted reserve tests first
- then run full reserve-related suites
- before push, run the repo merge gate

Minimum targeted commands:

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__ worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts
```

Pre-push gate:

```bash
npm run test:merge-gate
```

Additional doc-sync / methodology validation required when the scoring freshness contract changes:

```bash
npm run check:doc-sync
```

## Documentation Follow-Up

Update these when the relevant work lands:
- [docs/live-reserves.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md)
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md) if test commands/coverage change
- methodology docs if collateral passthrough eligibility changes:
  - [src/app/methodology/scoring-changelog/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/scoring-changelog/page.tsx)
  - [src/app/methodology/sections/core-sections.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/core-sections.tsx)

## Recommendation

Start with:
- `LR-001`
- `LR-002`
- `LR-003`
- `LR-004`

That sequence fixes the most important accuracy issue, closes the most meaningful reliability gap, and prevents more drift while the rest of the cleanup is still pending.
