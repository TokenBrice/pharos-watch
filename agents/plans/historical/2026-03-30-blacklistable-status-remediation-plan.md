# Blacklistable Status Remediation Plan

Date: 2026-03-30

## Objective

Remediate the blacklistable-status system so that:

1. every product surface uses the same resolved blacklist status
2. transitive inherited resolution is deterministic, including cyclic dependency graphs
3. future added coins are less dependent on one-off metadata/manual regex updates
4. docs and tests match the actual implementation contract

## Scope

In scope:

- shared blacklist-status resolution API and heuristics
- worker report-card snapshot propagation
- frontend/status consumers that currently mix raw metadata and resolved status
- metadata/copy helpers that still read only `canBeBlacklisted`
- methodology/docs describing blacklist attribution
- targeted tests and regression coverage

Out of scope:

- changing the blacklist methodology itself beyond the audit findings
- large reserve-metadata recuration unrelated to resolver mechanics
- redesigning UI copy beyond what is needed for correctness/consistency

## Current Problems To Remediate

1. Multiple call sites still compute a weaker local approximation with `isBlacklistable(meta)` or raw `coin.canBeBlacklisted`.
2. The worker propagation algorithm only does one transitive pass and is not fixed-point safe for cycles.
3. Curated reserve detection is less future-open than live reserve detection.
4. Docs disagree on whether live reserve enrichment participates in blacklist attribution.
5. The current helper API shape makes it easy to call the wrong resolution mode.

## Target Contract

After remediation, there should be one canonical resolved status contract:

- `true`
- `false`
- `"possible"`
- `"inherited"`

Resolution rules:

1. Explicit `meta.canBeBlacklisted` still wins.
2. `centralized` governance still resolves to `true`.
3. Reserve-derived inherited risk is computed from the canonical resolution graph, not a one-shot local lookup.
4. Both curated and live reserve slices use the same clue-detection pipeline.
5. Product surfaces should prefer a pre-resolved status from report cards when present, and any local fallback should use the same canonical resolver context instead of raw metadata-only logic.

## Workstreams

### W1. Create a canonical resolver API

Goal:

- Replace the current “same function, optional context” pattern with explicit resolution helpers so weak local calls are harder to write accidentally.

Planned changes:

- Refactor [report-card-blacklist-risk.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-blacklist-risk.ts)
- Split responsibilities into explicit pieces:
  - reserve-slice clue classification
  - live/curated slice enrichment
  - single-coin resolution given a context
  - graph/fixed-point resolution for sets of coins
- Export a small canonical surface, for example:
  - a pure single-coin resolver that requires explicit context
  - a collection resolver for `StablecoinMeta[]`
  - a display-label helper to avoid UI-local status mapping drift

Acceptance criteria:

- No important UI/API consumer should need to call a context-free approximation for active tracked coins.
- The naming should make “raw metadata guess” vs “fully resolved status” unambiguous.

### W2. Replace one-pass propagation with deterministic graph resolution

Goal:

- Make inherited resolution correct for cycles and stable regardless of traversal order.

Planned changes:

- Refactor the propagation logic in [report-cards-snapshot.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts)
- Keep dependency traversal/topological ordering when useful for efficiency, but do not rely on it for correctness
- Implement a fixed-point loop or SCC-safe graph pass:
  - initialize first-order blacklistable set
  - repeatedly recompute inherited statuses until no new blacklistable IDs are added
  - stop when stable

Acceptance criteria:

- Cycles terminate and resolve deterministically.
- Existing transitive cases stay correct.
- No status should depend on input ordering alone.

### W3. Unify curated and live reserve clue enrichment

Goal:

- Apply the same enrichment behavior to both curated and live reserves wherever feasible.

Planned changes:

- Extend [report-card-blacklist-risk.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-blacklist-risk.ts) so curated slices can benefit from the same symbol-driven enrichment path currently applied to live slices
- Preserve explicit `coinId` and `blacklistable` metadata as strongest signals
- Keep heuristics conservative enough to avoid broad false positives

Expected direction:

- Normalize both live and curated slices through a common enrichment/classification path before final scoring
- Reuse a precomputed blacklistable symbol index instead of rebuilding it per-coin if practical

Acceptance criteria:

- Adding a newly tracked blacklistable coin should improve reserve detection without always requiring a new hardcoded regex.

### W4. Move all consumers onto canonical resolved status

Goal:

- Eliminate cross-surface disagreement.

Planned consumers to update:

- [stablecoin-table.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-table.tsx)
- [stablecoin-table-logic.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-table-logic.ts)
- [hero-card.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-detail/hero-card.tsx)
- [blacklist-status-charts.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/blacklist-status-charts.tsx)
- [page-metadata.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts)
- [compare-pages.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/compare-pages.ts)

Implementation direction:

- For report-card-backed surfaces, use `reportCard.rawInputs.canBeBlacklisted` as the primary source
- For local fallback paths, use the new canonical resolver helper rather than raw metadata-only checks
- Replace metadata-only descriptive copy with canonical label helpers where appropriate

Acceptance criteria:

- Current locally observed mismatches between naive and report-card-style resolution should disappear on runtime surfaces.
- Copy-only/static helpers should no longer label inherited/possible coins as “No explicit blacklist flag” when the resolver says otherwise.

### W5. Tighten tests around the real contract

Goal:

- Lock in the resolution semantics so future heuristic edits do not silently reintroduce drift.

Planned test work:

- Expand [report-cards.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/report-cards.test.ts)
- Expand [report-cards-snapshot-topo.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts)
- Add targeted tests for:
  - cyclic dependency fixed-point resolution
  - curated/live enrichment parity
  - consumer-side canonical status formatting helpers
  - metadata/copy helper behavior for inherited and transitive possible cases

Acceptance criteria:

- Tests cover both single-coin heuristics and multi-coin propagation.
- There is at least one regression test for the order-dependent cycle case.

### W6. Reconcile docs

Goal:

- Ensure methodology and implementation docs describe the same system.

Planned docs:

- [report-cards.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/report-cards.md)
- [report-cards-timeline.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/report-cards-timeline.md) if behavior changes materially enough to document
- [live-reserves.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md)
- [api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md) if the `canBeBlacklisted` field description needs clarification

Acceptance criteria:

- No doc should still claim that live reserve enrichment is excluded if code uses it.
- The difference between raw metadata and resolved status should be explicit.

## Recommended Execution Order

1. W1 canonical resolver API
2. W2 fixed-point worker propagation
3. W3 curated/live enrichment parity
4. W4 consumer migration
5. W5 tests
6. W6 docs sync

Reasoning:

- W1 and W2 establish the real contract.
- W3 prevents future metadata dependence from undermining the contract.
- W4 then removes consumer drift.
- W5/W6 lock the final behavior in.

## Risks

1. Over-broad heuristic enrichment could turn too many coins from `No` to `Possible`.
   - Mitigation: keep explicit metadata and `coinId` stronger than text heuristics; add regression fixtures for clean decentralized names.

2. Consumer migration could break static pages or copy assumptions.
   - Mitigation: centralize label formatting and add narrow tests for metadata helpers.

3. Fixed-point graph resolution could increase complexity or runtime.
   - Mitigation: blacklist resolution only runs over the tracked active metadata set; the graph is small enough that clarity should win over micro-optimization.

## Validation Plan

Minimum targeted validation during implementation:

- `npm test -- shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`

Expected full validation before completion if code changes land:

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:doc-sync`

If worker-facing code changes materially:

- `cd worker && npx tsc --noEmit`

## Expected Outcome

After this work, blacklistable-status attribution should behave as a single coherent subsystem rather than a mix of:

- raw metadata flags
- local heuristic fallbacks
- worker-only transitive resolution
- docs that describe different versions of the system
