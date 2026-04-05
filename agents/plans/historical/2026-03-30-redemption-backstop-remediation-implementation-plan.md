# 2026-03-30 Redemption Backstop Remediation Implementation Plan

Companion audit:
- `agents/audits/2026-03-30-redemption-backstop-comprehensive-audit.md`

Historical context:
- `agents/plans/historical/redemption-backstop-remediation-plan-2026-03-25.md`

Goal:
- remediate every issue identified in the 2026-03-30 redemption-backstop audit
- restore truthfulness of published redemption data before expanding coverage
- leave the module easier to review, cheaper to extend, and harder to drift out of sync with docs

## Objectives

1. Make live-backed redemption capacity and fee data strict enough to trust.
2. Bring runtime types, storage, API, docs, methodology copy, and UI semantics back into one coherent contract.
3. Remove misleading dynamic classifications and force registry evidence discipline.
4. Reduce hotspot complexity and repetitive config boilerplate without weakening existing behavior.
5. Use the cleanup to unlock the highest-value low/mid-effort coverage wins.

## Current Baseline

Audit validation already completed:

- `npm run check:redemption-backstops`
- `npm run check:doc-sync`
- `npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/api/__tests__/redemption-backstops.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`

Current module snapshot from the audit:

- `144` configured routes
- `9` `reserve-sync-metadata` routes
- `123` config-level `documented-bound` routes
- `12` heuristic routes
- `36` documented-bound routes still missing explicit `docs[]`
- `12` routes still missing `reviewedAt`

This baseline should be re-run after each major tranche, then expanded to repo-level validation before merge.

## Scope

In scope:

- redemption-backstop registry, type model, confidence model, scoring inputs, runtime resolver, store, API output, and detail UI
- all current redemption-backstop adapters that influence `reserve-sync-metadata`
- guardrail scripts, methodology/docs/API sync, and version/changelog surfaces
- route review and config cleanup required to resolve the audit findings
- low/mid-effort feature coverage wins explicitly identified by the audit

Out of scope:

- redesigning the stablecoin detail page beyond the provenance/fidelity fixes required here
- adding wholly new reserve systems that were not called out by the audit
- changing unrelated scoring products or reserve-adapter consumers outside the redemption blast radius

## Success Criteria

Functional:

1. No reserve-sync route can use degraded, weak, or fee-only metadata as live capacity.
2. Direct live capacity, proxy live capacity, documented bounds, and heuristics are distinct in code, API, docs, and UI.
3. `pusd-plume` no longer presents fake dynamic capacity.
4. Reviewed documented-bound routes always carry explicit reviewed sources.
5. Redemption detail views show review timing and source provenance as separate facts.
6. The remaining reserve-sync routes reflect their true telemetry strength instead of collapsing into one `dynamic` bucket.

Engineering:

1. `worker/src/lib/redemption-backstop-sources.ts` is decomposed into smaller policy-focused units.
2. Reserve metadata loading is either truly batch-oriented or the dead abstraction is removed.
3. Config families use small shared helpers for repeated reviewed route patterns.
4. Bounded-capacity semantics are typed well enough that future scoring changes do not require rereading prose notes.

Coverage:

1. The `12` unreviewed routes are either route-reviewed or intentionally kept out of the reviewed/documented-bound path.
2. The best audit-identified coverage wins have an explicit delivery lane:
   - `USDD`
   - `USDe`
   - `wsrUSD`
   - `DOLA`
   - `reUSD`
   - `LISUSD`

## Constraints

- Accuracy and honesty work land before coverage expansion.
- Public methodology changes must update both `docs/` and the methodology surface.
- Avoid schema migrations unless a clear contract gap cannot be fixed through `details_json`.
- Keep rollout backward-compatible for existing stored redemption rows and consumer parsing.
- Before any branch is pushed, run `npm run test:merge-gate`.

## Findings Coverage Matrix

| Audit finding | Workstreams |
| --- | --- |
| Live reserve metadata trust is weaker than docs claim | `W0`, `W1`, `W3`, `W9` |
| Docs/API contract are out of sync with code | `W2`, `W7`, `W9` |
| `pusd-plume` is misclassified as dynamic | `W1`, `W4`, `W9` |
| Reserve-sync routes are collapsed into one `dynamic` bucket | `W2`, `W3`, `W7`, `W9` |
| Sync still does per-coin reserve metadata reads; preload refactor unfinished | `W5`, `W9` |
| Docs provenance is flattened in the UI | `W2`, `W4`, `W7`, `W9` |
| Guardrails are too weak | `W0`, `W4`, `W9` |
| Config surface is repetitive / review-heavy | `W6`, `W9` |
| Ratio/full-supply semantics are under-typed | `W6`, `W7`, `W9` |
| Low/mid-effort coverage wins are not planned concretely | `W4`, `W8`, `W9` |

## Adapter Coverage Matrix

Every adapter currently feeding redemption backstops is covered explicitly.

| Adapter / route set | Planned outcome |
| --- | --- |
| `openeden-usdo` | keep as the reference `live-direct` path once strict eligibility gating lands |
| `gho` | keep in the strongest live tier only after redemption runtime honors warning/status/freshness gates |
| `sky-makercore` (`dai-makerdao`, `usds-sky`) | classify as `live-proxy`; add route review and explicit docs; do not allow strongest confidence tier |
| `ethena` (`usde-ethena`) | keep as `live-proxy` unless a smaller direct hot-redemption buffer can be sourced |
| `falcon` (`usdf-falcon`) | keep as `live-proxy` with queued-settlement semantics; no strongest live tier |
| `reservoir` (`wsrusd-reservoir`) | keep as `live-proxy` at best until freshness/source evidence improves |
| `infinifi` (`iusd-infinifi`) | keep conservative until freshness and route review are evidence-backed |
| `single-asset` (`pusd-plume`) | ban from dynamic-capacity routes; reclassify route to documented-bound unless adapter gains real capacity telemetry |

## Delivery Strategy

Ship this in nine workstreams grouped into four phases.

Order matters:

- truth-boundary fixes and guardrails must land before confidence reclassification is trustworthy
- contract alignment must happen with the runtime changes, not after them
- structural cleanup should follow the final policy choices so it mutualizes the right abstractions
- coverage expansion should only start after the module stops overstating evidence

### Phase A. Lock behavior and fix the current truth boundary

`W0` Characterization and guardrail baseline
`W1` Live metadata eligibility hardening

### Phase B. Make the public contract honest

`W2` Type/API/store/docs/methodology alignment
`W3` Live-direct vs live-proxy fidelity model
`W4` Registry evidence discipline and route review closure

### Phase C. Simplify the implementation

`W5` Reserve metadata loading and sync-path cleanup
`W6` Config mutualization and typed bounded-capacity semantics
`W7` Resolver/UI/store decomposition and provenance clarity

### Phase D. Expand coverage safely and close the program

`W8` Coverage expansion tranche
`W9` Final validation, rollout review, and closeout

## Workstreams

### W0. Characterization and Guardrail Baseline

Objective:
- capture current behavior before policy changes
- expand the repo checks from basic sanity to actual evidence-contract enforcement

Primary files:
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `shared/lib/__tests__/redemption-backstops.test.ts`
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `worker/src/api/__tests__/redemption-backstops.test.ts`
- `src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`
- `scripts/check-redemption-backstops.ts`
- `scripts/__tests__/` as needed for check coverage

Tasks:

1. Add characterization tests for the current reserve-sync runtime so the new gating and confidence changes are explicit.
2. Add failing guardrails for:
   - `documented-bound => reviewedAt`
   - `documented-bound => explicit docs[]`
   - `reserve-sync-metadata => adapter capability includes capacity telemetry`
   - doc/code enum parity for capacity confidence
   - banned adapter/config combinations such as `single-asset` + dynamic capacity
3. Add regression tests for detail-card provenance rendering so review date and provenance cannot flatten again.
4. Add consistency coverage for stored `details_json` shape once the richer payload is introduced in `W2`.

Acceptance criteria:

- the repo fails fast when registry evidence drifts from the contract
- Phase A/B runtime behavior changes are fully characterized before landing

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/api/__tests__/redemption-backstops.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx
npm run check:redemption-backstops
```

### W1. Live Metadata Eligibility Hardening

Objective:
- stop redemption from trusting live reserve metadata more loosely than the reserve subsystem itself justifies

Primary files:
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- `shared/lib/live-reserve-adapters.ts`
- `shared/types/live-reserves.ts`
- reserve-adapter tests under `worker/src/cron/reserve-adapters/__tests__/`

Tasks:

1. Introduce an explicit redemption eligibility gate, for example `isReserveMetadataEligibleForRedemption()`, that checks:
   - `syncStatus === "ok"`
   - no degrading warnings
   - allowed evidence class
   - freshness strong enough for redemption use, not just `fetchedAt`
   - adapter capability says whether live capacity and/or live fees are actually supported
2. Split eligibility for fee usage from eligibility for capacity usage where the adapter supports fee but not capacity.
3. Thread the gate through both live-fee resolution and live-capacity resolution.
4. Reclassify `pusd-plume` out of `reserve-sync-metadata` immediately unless the adapter is upgraded first.
5. Update reserve-adapter capability metadata so redemption does not infer fidelity indirectly.

Acceptance criteria:

- degraded or weak live snapshots cannot influence redemption capacity
- fee-only routes can use live fee data only when that is explicitly allowed
- `pusd-plume` no longer resolves through fake dynamic semantics

Validation:

```bash
npx vitest run worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/cron/reserve-adapters/__tests__/openeden.test.ts worker/src/cron/reserve-adapters/__tests__/gho.test.ts worker/src/cron/reserve-adapters/__tests__/ethena.test.ts worker/src/cron/reserve-adapters/__tests__/falcon.test.ts worker/src/cron/reserve-adapters/__tests__/reservoir.test.ts worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts
npm run check:redemption-backstops
```

### W2. Type, API, Store, Docs, and Methodology Alignment

Objective:
- make the public contract match the code exactly, with no placeholder semantics

Primary files:
- `shared/types/redemption.ts`
- `shared/lib/redemption-backstop-confidence.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/api/redemption-backstops.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`
- `shared/lib/redemption-backstop-version.ts`
- `src/app/methodology/sections/core-sections.tsx` or the relevant methodology redemption section module

Tasks:

1. Make the final program state match the documented `live-direct` / `live-proxy` contract.
   - if branch sequencing requires an intermediate step, docs may be temporarily narrowed only inside that intermediate branch
   - `W9` cannot close until the implemented runtime, persisted payloads, API contract, and docs all reflect the same final fidelity model
2. Update `RedemptionCapacityConfidence` and any derived confidence helpers to match the chosen runtime contract.
3. Expand persisted `details_json` to include the live/proxy/documented evidence needed for auditability without a schema migration.
4. Keep store decoding backward-compatible with already-written rows.
5. Update API docs, methodology docs, and version/changelog copy in the same tranche.

Acceptance criteria:

- code, stored payload shape, API schema, docs, and methodology language describe the same fidelity model
- no documented enum or field exists without runtime support

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstop-scoring.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts worker/src/api/__tests__/redemption-backstops.test.ts
npm run check:doc-sync
npm run check:redemption-backstops
```

### W3. Live-Direct vs Live-Proxy Fidelity Model

Objective:
- stop treating heterogeneous reserve-sync routes as one trust class

Primary files:
- `shared/lib/redemption-backstop-confidence.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `shared/types/redemption.ts`
- route configs under:
  - `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
  - `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
  - `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
  - `shared/lib/redemption-backstop-configs/queue-redeem.ts`

Tasks:

1. Add an explicit live-capacity fidelity layer:
   - `live-direct`
   - `live-proxy`
   - fallback documented/heuristic states as separate semantics
2. Make `high` model confidence require direct live capacity plus non-undisclosed fee confidence.
3. Route the current reserve-sync set honestly:
   - `openeden-usdo`: `live-direct`
   - `gho-aave`: `live-direct` once warning/status gating lands
   - `dai-makerdao`, `usds-sky`, `usde-ethena`, `usdf-falcon`, `wsrusd-reservoir`, `iusd-infinifi`: `live-proxy` unless stronger evidence is added
4. Preserve conservative fallback semantics when live data is unavailable.
5. Update scoring and any downstream coverage logic that interprets confidence buckets.

Acceptance criteria:

- proxy capacity can never silently resolve the strongest model confidence
- each reserve-sync route has an explicit fidelity classification justified by its telemetry

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstop-scoring.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts
```

### W4. Registry Evidence Discipline and Route Review Closure

Objective:
- close the reviewed-route backlog and stop fallback links from masquerading as reviewed evidence

Primary files:
- all files under `shared/lib/redemption-backstop-configs/`
- `scripts/check-redemption-backstops.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- `src/lib/coverage.ts`

Tasks:

1. Add explicit `docs[]` to the `36` documented-bound routes currently relying on fallback links, or downgrade them until docs are reviewed.
2. Resolve the `12` unreviewed routes by either adding reviewed evidence or downgrading them out of the reviewed/documented path in the same tranche:
   - `zarp-zarp`
   - `cetes-etherfuse`
   - `cgo-comtech`
   - `dgld-gold-token-sa`
   - `dai-makerdao`
   - `usds-sky`
   - `dusd-alto`
   - `ussd-sonic-labs`
   - `usdp-parallel`
   - `iusd-infinifi`
   - `dusd-dtrinity`
   - `yousd-yield-optimizer`
3. Update the detail card to always show both:
   - review date
   - doc provenance label
4. Tighten coverage classification if confidence bucket semantics change in `W3`.

Acceptance criteria:

- every reviewed documented-bound route has explicit reviewed evidence links
- every formerly unreviewed route is either fully reviewed or explicitly downgraded to a non-reviewed state
- no fallback link appears to be the reviewed source of truth
- unresolved routes are visibly and programmatically treated as such

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstops.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx
npm run check:redemption-backstops
```

### W5. Reserve Metadata Loading and Sync-Path Cleanup

Objective:
- finish the half-done preload path or remove it, and eliminate avoidable per-coin metadata reads

Primary files:
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- `worker/src/lib/live-reserves-store.ts` if a shared preload helper belongs there

Tasks:

1. Choose one implementation and complete it:
   - batch-load reserve metadata once per sync and thread it through entry resolution, or
   - delete the dead preload helper and keep the path intentionally single-lookup
2. Prefer the batch path if it materially reduces D1 reads without regrowing orchestration complexity.
3. Keep the sync shell focused on orchestration and push lookup details into dedicated helpers.
4. Add tests that prove the chosen path remains deterministic and preserves fallback behavior.

Acceptance criteria:

- the module no longer contains a misleading half-implemented preload abstraction
- sync-path data loading is explicit and reviewable

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts
cd worker && npx tsc --noEmit
```

### W6. Config Mutualization and Typed Bounded-Capacity Semantics

Objective:
- reduce review noise and replace prose-only capacity meaning with typed metadata

Primary files:
- `shared/lib/redemption-backstop-configs/shared.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- `shared/lib/redemption-backstops.ts`
- `shared/types/redemption.ts`

Tasks:

1. Add small helpers for repeated route patterns:
   - reviewed issuer full-supply
   - reviewed issuer delayed settlement
   - reviewed queue route
   - reviewed bounded-capacity route with docs and notes
2. Add a typed capacity-basis field for bounded models, for example:
   - `daily-limit`
   - `hot-buffer`
   - `psm-balance-share`
   - `strategy-buffer`
   - `issuer-term-redemption`
   - `full-system-eventual`
3. Move repeated mechanics into helpers while keeping evidence content in the family files.
4. Snapshot-test or consistency-test the registry after the helper extraction to keep the refactor mechanical.

Acceptance criteria:

- repetitive config patterns are encoded once
- bounded-capacity semantics are queryable without re-reading notes
- the helper layer does not obscure per-route evidence

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
npm run check:redemption-backstops
```

### W7. Resolver, UI, and Store Decomposition

Objective:
- split the hotspot runtime into smaller units that mirror the policy boundaries established in `W1` through `W6`

Primary files:
- `worker/src/lib/redemption-backstop-sources.ts`
- new helper modules under `worker/src/lib/` such as:
  - docs resolution
  - live metadata eligibility
  - capacity resolution
  - cost resolution
  - entry assembly / serialization
- `worker/src/lib/redemption-backstops-store.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`

Tasks:

1. Split `redemption-backstop-sources.ts` by responsibility instead of by route family.
2. Keep one stable public entry builder used by the cron and API paths.
3. Centralize the richer `details_json` serialization contract so UI and API consumers use the same persisted vocabulary.
4. Make the detail-card rendering depend on explicit provenance fields rather than implicit branch order.

Acceptance criteria:

- the runtime is easier to reason about because docs, cost, capacity, and assembly decisions are isolated
- store and UI logic consume the same explicit metadata model

Validation:

```bash
npx vitest run worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx
npm run check:hotspot-ratchet
```

### W8. Coverage Expansion Tranche

Objective:
- use the hardened model to capture the clearest low/mid-effort wins without reintroducing weak evidence

Primary files:
- the relevant route config family files
- reserve adapters where the audit identified a realistic upgrade path
- docs/about/methodology sources if new data sources are added

Priority order:

1. `USDD`
2. `USDe`
3. `wsrUSD`
4. `DOLA`
5. `reUSD`
6. `LISUSD`

Tasks:

1. `USDD`: promote to a better bounded or live-backed route using the existing reserve/PSM evidence already tracked by the platform.
2. `USDe`: refine current proxy semantics and, if feasible, ingest a smaller direct hot-redemption buffer instead of treating all liquid cash as immediate capacity.
3. `wsrUSD`: strengthen freshness and fee-confidence evidence before any confidence promotion.
4. `DOLA`, `reUSD`, `LISUSD`: replace weak bounded assumptions with reviewed documented evidence where current docs already support it.
5. Keep every promotion behind the stricter guardrails introduced in earlier workstreams.

Acceptance criteria:

- every new or upgraded route uses the new evidence model correctly
- no coverage win is taken by weakening the truth boundary

Validation:

```bash
npx vitest run shared/lib/__tests__/redemption-backstops.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/api/__tests__/redemption-backstops.test.ts
npm run check:redemption-backstops
npm run check:doc-sync
```

Docs:

- if a new data source is added, update `src/app/about/page.tsx`
- if methodology-facing coverage semantics change, update the redemption methodology section and version timeline in the same branch

### W9. Final Validation, Rollout Review, and Closeout

Objective:
- close the program only after the module, docs, and guardrails converge

Primary files:
- all touched redemption-backstop files
- `agents/plans/2026-03-29-hotspot-decomposition-backlog.md` if hotspot baselines change

Tasks:

1. Run the full redemption validation slice.
2. Run repo-level validation appropriate to the touched surfaces.
3. Perform a final audit replay against the original findings list.
4. Update hotspot backlog metadata if file budgets change intentionally.
5. Record any intentionally deferred low-severity follow-up items separately from the completed audit scope.

Required validation:

```bash
npm run lint
npm run typecheck
npm run check:redemption-backstops
npm run check:doc-sync
npm run check:hotspot-ratchet
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Targeted redemption replay:

```bash
npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/api/__tests__/redemption-backstops.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx
```

Acceptance criteria:

- every audit finding is either resolved or explicitly documented as a conscious low-severity follow-up
- docs and methodology remain in sync with the landed contract
- merge gate is green before push

## Recommended PR Sequence

```text
PR-00 W0 characterization + check hardening
PR-01 W1 live metadata eligibility + pusd-plume correction
PR-02 W2 contract alignment across types/store/API/docs/methodology
PR-03 W3 live-direct vs live-proxy model
PR-04 W4 route review closure + provenance UI fix
PR-05 W5 sync-path metadata loading cleanup
PR-06 W6 config helpers + typed bounded-capacity semantics
PR-07 W7 resolver/store hotspot decomposition
PR-08 W8 coverage expansion tranche
PR-09 W9 full validation + closeout
```

Parallelism guidance:

- `PR-01` must land before any confidence promotion work.
- `PR-02` and `PR-04` can overlap in analysis, but the branches should not merge out of order because UI/docs need the runtime contract from `PR-01`.
- `PR-05` and `PR-06` can proceed in parallel if write scopes stay separate.
- `PR-07` should follow `PR-05` and `PR-06` so it decomposes the final, not interim, policy model.
- `PR-08` should wait for `PR-01` through `PR-04`; coverage expansion before truth-boundary hardening would recreate the audit problem.

## Risks and Controls

1. Risk: partial rollout leaves docs ahead of runtime again.
   Control: `W2` lands contract, store, API, docs, methodology, and version updates together; `check:doc-sync` remains required.

2. Risk: stricter live gating drops coverage more than expected for current reserve-sync routes.
   Control: keep conservative documented or heuristic fallbacks in place until stronger evidence exists; validate route-by-route.

3. Risk: helper extraction hides evidence or makes configs harder to review.
   Control: only mutualize mechanics; keep per-route evidence content in family files and preserve consistency snapshots/tests.

4. Risk: richer `details_json` breaks old rows or consumers.
   Control: make store decoding additive and backward-compatible; characterize old-row behavior in tests first.

5. Risk: coverage expansion restarts drift by adding new sources without docs updates.
   Control: tie `W8` to the earlier guardrails and the repo rule that new data sources update the about page.

## Plan Validation

Validation rubric:

1. Every audit finding must map to at least one workstream and one acceptance gate.
2. Every `reserve-sync-metadata` adapter must have an explicit remediation decision.
3. No phase can depend on documentation catch-up after a user-visible runtime change.
4. The plan must define repo checks strong enough to prevent the audited drift from recurring.
5. Coverage expansion cannot precede truth-boundary hardening.

### Validation Round 1

Issues found:

- Medium: the initial draft did not force closure for the `36` documented-bound routes still missing explicit `docs[]`; it risked leaving the UI fix in place while the registry stayed under-specified.
- Medium: the initial draft treated coverage expansion as a loose backlog instead of binding it to the new fidelity/guardrail model.

Revisions made:

- strengthened `W4` so the `36` fallback-doc routes must either gain explicit `docs[]` or be downgraded
- tightened `W8` so every coverage promotion is explicitly gated on the stricter evidence model from `W1` through `W4`

### Validation Round 2

Checks:

- every audit finding maps to workstreams and acceptance criteria
- every adapter is explicitly classified
- sequencing prevents docs/runtime drift and premature coverage work
- validation commands cover registry, docs, store, API, UI, hotspot, and full merge-gate surfaces

Result:

- `0` medium-or-higher plan issues remain
