# 2026-03-24 Yield Safety Remediation Plan

> Execution plan for the findings in [../audits/2026-03-24-yield-safety-module-audit.md](../audits/2026-03-24-yield-safety-module-audit.md).
> Scope covers all findings from the audit: accuracy, reliability, maintainability, adapter coverage, contract alignment, validation, and rollout safety.

## Objective

Remediate the yield safety module so that:

1. published yield data is materially more accurate and better explained
2. degraded upstream states stop causing misleading freshness or destructive behavior
3. the adapter surface becomes easier to review, extend, and test
4. production coverage is explicit, validated, and complete for all intended assets
5. deploy and post-deploy validation become yield-aware rather than generic

## Non-Negotiable Constraints

- Keep changes root-cause driven. No temporary compatibility hacks without explicit expiry or removal criteria.
- Any methodology-affecting change must also update:
  - `shared/lib/yield-methodology-version.ts`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
  - `/methodology` content if the public description changes materially
- Any API contract change must update:
  - `docs/api-reference.md`
  - shared runtime schema/types
  - the matching frontend consumers
- Any new source or new source family must update:
  - source documentation
  - about-page attribution if it is a genuinely new external source
- No production push before:
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - `cd worker && npx tsc --noEmit`
  - `npm run test:merge-gate`

## Findings Covered

This plan covers all twelve findings from the audit.

High:

1. Publication/pruning order can delete valid current rows before rankings cache is known-good.
2. Freshness provenance is understated for `onchain` and `price-derived` rows.
3. Deterministic on-chain adapter model is too rigid and includes known-bad adapters.
4. Production adapter coverage still has gaps and metadata debt.
5. Tests do not validate the real production adapter registry.

Medium:

6. `yield-config.ts` is a monolithic hotspot with parallel registries.
7. Resolver repeatedly rescans arrays/maps instead of using indexed lookups.
8. Source-aware history exists in the API but is not used by the frontend.
9. Shared `yield-history` contract is out of sync with the worker response.
10. Source-link curation is incomplete for part of the lending allowlist.

Low:

11. Helper logic is duplicated across worker/API boundary.
12. Rankings cache write result under-reports failure detail.

## Recommended Delivery Strategy

Do this in six workstreams, in order:

1. Publish-safety and degraded-run hardening
2. Adapter registry hardening and coverage closure
3. Provenance/freshness accuracy
4. Contract alignment and source-aware frontend history
5. Codebase simplification and helper mutualization
6. Validation, deploy, and ops hardening

This order is deliberate:

- W1 removes the highest-risk correctness bug.
- W2 and W3 improve the truthfulness of the data itself.
- W4 exposes the backend’s real capabilities without carrying contract drift.
- W5 reduces future maintenance cost after the behavior is stabilized.
- W6 turns the remediation into an enforceable delivery standard.

## Workstream Overview

| ID | Priority | Outcome | Main surfaces |
| --- | --- | --- | --- |
| W1 | P0 | No destructive publish/prune mismatch on degraded or failed publication paths | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/publication.ts`, `worker/src/cron/yield-sync/history.ts` |
| W2 | P0 | Real adapter inventory is complete, typed, and production-validated | `worker/src/cron/yield-config.ts`, stablecoin metadata, new validation tests/scripts |
| W3 | P0 | Freshness/provenance reflects real source observation age and anchor quality | `worker/src/cron/yield-sync/{sources,publication,types}.ts`, shared yield types, frontend provenance renderers |
| W4 | P1 | Worker/API/frontend contracts align and source-aware history is usable | `worker/src/api/yield-history.ts`, `shared/types/yield.ts`, `src/hooks/api-hooks.ts`, `src/components/yield-history-chart.tsx` |
| W5 | P1 | LOC reduction, reduced drift, less duplicated logic | `worker/src/cron/yield-config.ts`, `worker/src/cron/yield-sync/*`, shared helpers |
| W6 | P0/P1 | Yield-aware CI, smoke coverage, and operator visibility | tests, scripts, docs, deploy workflow surfaces |

## W1 - Publish-Safety And Degraded-Run Hardening

### Goal

Ensure the cron never destroys or materially diverges current yield state before the new public snapshot is validated and publishable.

### Problems Closed

- Finding 1 directly
- part of findings 2 and 12 indirectly through better structured publication metadata

### Implementation

1. Rework the write order so that publication is part of the commit boundary.
   - Current unsafe order:
     1. persist rows
     2. prune rows/history
     3. build rankings payload
     4. attempt cache write
   - Target order:
     1. evaluate sources
     2. prepare staged writes and candidate rankings payload
     3. validate payload and publishability guard
     4. only then commit current-row mutations and bounded pruning

2. Introduce explicit non-destructive degraded-input behavior.
   - If upstream inputs are degraded, keep prior rows unless the run positively re-evaluated a row as absent under healthy inputs.
   - Retention must be row-identity-based:
     - `(stablecoin_id, source_key)`
   - Do not use coarse “coin resolved this run” semantics.

3. Split cleanup into safe and destructive phases.
   - Safe cleanup:
     - trim only rows fully superseded by known-good current rows
   - Destructive cleanup:
     - orphan deletion
     - stale row deletion for re-evaluated rows
     - long-horizon history pruning
   - Destructive cleanup must only run after successful snapshot publish.

4. Make publish failure observable in structured metadata.
   - distinguish:
     - schema failure
     - shrink guard failure
     - cache write failure
     - degraded-input retention mode

5. Add bounded retention rules.
   - Old rows retained during degraded runs must:
     - carry explicit degraded provenance
     - remain eligible for stale warnings
     - be bounded by TTL so a permanently removed source cannot linger indefinitely

### Acceptance Criteria

- A failed rankings-cache publication cannot leave `yield_data` pruned to a newer state than the published rankings cache.
- Degraded input runs retain prior rows when the system cannot positively confirm absence.
- Structured metadata distinguishes degraded retention from ordinary success.

### Validation

- Add worker tests for:
  - successful row writes + failed cache publish
  - degraded input run with retained previous rows
  - healthy run that positively removes a previously retained row
  - shrink-guard failure with no destructive cleanup
- Run:

```bash
npx vitest run worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts
```

## W2 - Adapter Registry Hardening And Coverage Closure

### Goal

Turn the handwritten adapter/config surface into a validated production registry with no silent gaps for yield-bearing assets.

### Problems Closed

- Findings 3, 4, 5, 6, 10

### Implementation

1. Replace parallel config maps with a unified per-coin yield adapter manifest.
   - Each yield-bearing asset should declare:
     - canonical source family
     - optional fallback source families
     - labels/types
     - deterministic adapter details if applicable
     - auto-discovery override details if applicable
     - exemption reason if intentionally incomplete
   - Derived registries can still exist for runtime speed, but they should be generated from one manifest source.

2. Introduce explicit deterministic adapter kinds.
   - Replace the single generic config shape with typed variants:
     - `erc4626_convert_to_assets`
     - `vault_exchange_rate`
     - `governance_rate`
     - `protocol_specific`
   - Each kind defines:
     - required fields
     - supported chains
     - validation constraints

3. Quarantine known-bad deterministic adapters immediately.
   - `dusd-dtrinity`
   - `reusd-re-protocol`
   - Required actions:
     - remove from the generic deterministic path or mark as quarantined
     - either add protocol-specific readers or explicitly downgrade them to non-deterministic coverage
     - document the rationale in the manifest

4. Close all uncovered yield-bearing assets.
   - `cetes-etherfuse`
   - `usg-tangent`
   - Also resolve metadata debt on:
     - `dusd-dtrinity`
     - `pusd-polaris`
     - `usg-tangent`

5. Make production completeness enforceable.
   - Add tests/guards that fail if a `yieldBearing` asset lacks:
     - strategy or explicit exemption
     - coherent label/type metadata
     - sufficient tracked contracts or explicit offchain-only rationale

6. Harden auto-lending override governance.
   - Every override must include:
     - justification
     - quality rationale
     - safety-bypass rationale if bypassed
     - expected source-link coverage

7. Complete source-link curation for the missing allowlist protocols.
   - `morpho-blue`
   - `lagoon`
   - `liqwid`
   - `lista-lending`
   - `loopscale`
   - `more-markets`
   - `navi-lending`
   - `overnight-finance`
   - `smardex-usdn`
   - `vesper`

### Acceptance Criteria

- Every yield-bearing coin is either:
  - fully configured, or
  - explicitly exempted with a checked reason.
- Broken deterministic adapters are no longer silently counted as healthy deterministic coverage.
- Missing source-link mappings are either filled or explicitly exempted.

### Validation

- New config-contract tests against the real registry:
  - all yield-bearing assets
  - all deterministic adapters
  - all auto-lending overrides
  - all allowlisted protocols
- Targeted runtime tests for new/changed adapters.
- Run:

```bash
npx vitest run worker/src/cron/__tests__/yield-resolve.test.ts worker/src/lib/__tests__/yield-source-links.test.ts
npx vitest run shared/lib/__tests__/stablecoins.test.ts
```

## W3 - Provenance And Freshness Accuracy

### Goal

Make the module truthful about when source data was actually observed and how strong the supporting inputs are.

### Problems Closed

- Finding 2 directly
- parts of findings 3 and 8 indirectly through clearer source reasoning

### Implementation

1. Extend source provenance per adapter family.
   - For `onchain`:
     - `sourceObservedAt`
     - `sourceAgeSeconds`
     - `comparisonAnchorObservedAt`
     - `comparisonAnchorAgeSeconds`
   - For `price-derived`:
     - `latestPriceSnapshotAt`
     - `latestPriceAgeSeconds`
     - `anchorSnapshotAt`
     - `anchorAgeSeconds`
     - `lookbackDays`
   - For `rate-derived`:
     - keep benchmark freshness, but distinguish benchmark age from token-specific observation semantics

2. Tighten price-derived eligibility rules.
   - Require the newest price snapshot to be within a defined freshness budget.
   - Differentiate:
     - insufficient history
     - stale latest point
     - stale anchor
     - thin window but acceptable

3. Add explicit degraded annotations for stale inputs.
   - Surface warnings when a row was computed from inputs older than expected cron cadence.

4. Improve public ranking provenance shape.
   - Add explicit provenance fields instead of relying on ambiguous `0` ages.
   - Preserve backward compatibility if this is done in stages.

5. Update frontend provenance renderers.
   - `src/app/yield/client.tsx`
   - `src/components/yield-detail-section.tsx`
   - show richer provenance without overwhelming the UI

### Acceptance Criteria

- On-chain rows no longer report freshness as implicit “now” when the comparison basis is older.
- Price-derived rows expose anchor age and latest input age.
- The UI can distinguish fresh, degraded, and stale fallback-derived rows.

### Validation

- Unit tests for provenance mapping and price-derived freshness rules.
- Regression tests for rankings payload schema.
- Run:

```bash
npx vitest run worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/api/__tests__/yield-rankings.test.ts
```

## W4 - Contract Alignment And Source-Aware Frontend History

### Goal

Remove contract drift and expose the backend’s source-aware history capability in the product.

### Problems Closed

- Findings 8 and 9 directly

### Implementation

1. Decide the canonical `yield-history` response contract.
   - Preferred option:
     - keep the API as an array if simplicity wins, and delete the stale shared `YieldHistoryResponse` interface
   - Alternative option:
     - upgrade the worker to return `{ current, history, methodology }`
   - Choose one; do not keep both concepts alive.

2. Upgrade the hook to expose source-aware history mode.
   - `useYieldHistory(stablecoinId, days, { mode, sourceKey })`

3. Upgrade the chart to support:
   - best-history mode
   - source-specific mode
   - switching from an alt source to its exact history

4. Extend the detail and leaderboard UIs.
   - Alt-source popovers should let the user inspect the chosen source’s history.
   - Source-switch state should be visible in the chart context, not only as a badge.

5. Update docs and shared schemas to match the actual final response shape.

### Acceptance Criteria

- Frontend can fetch and render history for a specific `sourceKey`.
- The shared type/schema matches the real worker response.
- Alt sources are not just listed; they are inspectable over time.

### Validation

- Worker API tests for:
  - invalid mode
  - source-specific mode
  - malformed warnings
  - normalized legacy source keys
- Frontend tests for:
  - source-specific chart mode
  - alt-source selection
  - best-history fallback

## W5 - Codebase Simplification And LOC Reduction

### Goal

Reduce complexity after the behavior is stabilized, so future adapter additions are safer and cheaper.

### Problems Closed

- Findings 6, 7, 11, 12

### Implementation

1. Split `yield-config.ts` by responsibility.
   - Suggested target structure:
     - `worker/src/cron/yield-config/manifest.ts`
     - `worker/src/cron/yield-config/protocol-labels.ts`
     - `worker/src/cron/yield-config/source-links.ts` or continue using worker lib if preferred
     - optional generated derived maps module

2. Pre-index resolver inputs.
   - Add computed maps before coin iteration:
     - `onChainConfigById`
     - `dlPoolById`
     - `dlPoolsBySymbol`
     - `autoOverridePoolById`
     - `resolvedKeysByCoin`

3. Mutualize duplicated helpers.
   - `buildOnChainSourceKey`
   - warning-signal parsing
   - any legacy key normalization shared between cron and API

4. Improve publication result typing.
   - Replace generic `validationFailures: 1` style reporting with structured reasons.

5. Ratchet hotspots if file-size pressure remains high.
   - Candidate hotspots:
     - `worker/src/cron/yield-config.ts`
     - `worker/src/cron/yield-sync/resolve.ts`
     - `worker/src/cron/yield-sync/evaluation.ts`

### Acceptance Criteria

- No duplicate source-key and warning parsing helpers remain across worker/API.
- Resolver control flow is shorter and more index-driven.
- Config ownership is clearer and parallel-map drift is reduced.

### Validation

- Full targeted yield suite.
- `npm run check:unused-code`
- `npm run check:hotspot-ratchet`

## W6 - Validation, Deploy, And Ops Hardening

### Goal

Make yield changes safer to ship and easier to detect when they regress in production.

### Problems Closed

- Finding 5 fully
- supports all other findings operationally

### Implementation

1. Add yield-specific contract tests against the real production registry.
   - This is the highest-value validation improvement.

2. Add yield-specific smoke checks.
   - Representative canaries must cover:
     - deterministic on-chain
     - curated DeFiLlama
     - auto-discovered lending
     - price-derived
     - rate-derived
   - Smoke should verify:
     - rankings endpoint returns data
     - canaries are present
     - provenance shape exists
     - no obviously broken fields (`null` where forbidden, negative APYs when invalid, etc.)

3. Add operator-facing health signals.
   - distinguish:
     - cache publication skipped
     - degraded retention mode
     - broken deterministic adapters
     - benchmark fallback mode
     - coverage completeness regression

4. Update docs/runbooks.
   - `docs/testing.md`
   - `docs/api-reference.md`
   - `docs/yield-intelligence.md`
   - `docs/yield-intelligence-timeline.md`
   - deploy/process docs if rollout procedure changes

### Acceptance Criteria

- Production adapter breakage can fail CI before deploy.
- Yield endpoint smoke verifies real canaries and provenance after deploy.
- Ops can distinguish data degradation from publication failure from adapter breakage.

### Validation

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Execution Sequence

### Phase 1

- W1 publish-safety and degraded-run hardening
- W6 real-registry validation tests
- immediate quarantine/fix decision for broken deterministic adapters

Exit criteria:

- no destructive publish/prune mismatch remains
- real-registry tests exist and pass
- broken deterministic adapters are either fixed, quarantined, or explicitly downgraded

### Phase 2

- W2 adapter manifest and coverage closure
- missing protocol source-link mappings

Exit criteria:

- all yield-bearing assets are fully configured or explicitly exempted
- no missing source-link mappings remain without explicit justification

### Phase 3

- W3 provenance/freshness accuracy

Exit criteria:

- on-chain and price-derived freshness are truthful and structured
- frontend provenance surfaces the new semantics

### Phase 4

- W4 contract alignment and source-aware frontend history

Exit criteria:

- shared types and worker response align
- user can inspect history by source

### Phase 5

- W5 simplification and mutualization
- residual W6 smoke/docs/ops work

Exit criteria:

- codebase is materially smaller/simpler in the yield surface
- delivery and ops guardrails are in place

## Suggested PR Breakdown

1. PR 1: publish-safety reorder + degraded retention + tests
2. PR 2: real-registry validation tests + deterministic adapter quarantine/fix scaffolding
3. PR 3: adapter manifest introduction + config migration
4. PR 4: coverage closure for remaining yield-bearing assets + source-link completion
5. PR 5: provenance/freshness schema and worker changes
6. PR 6: frontend provenance rendering + source-aware history hook/chart
7. PR 7: helper mutualization + resolver indexing + cleanup
8. PR 8: smoke/ops/docs finalization

## Per-Finding Traceability

| Finding | Primary workstream | Secondary workstream |
| --- | --- | --- |
| 1. Publish/prune mismatch | W1 | W6 |
| 2. Understated freshness provenance | W3 | W4 |
| 3. Rigid deterministic adapter model | W2 | W6 |
| 4. Coverage gaps and metadata debt | W2 | W6 |
| 5. Tests miss real production registry | W6 | W2 |
| 6. `yield-config.ts` monolith | W5 | W2 |
| 7. Resolver rescans instead of indexing | W5 | — |
| 8. Source-aware history unused in frontend | W4 | W3 |
| 9. Shared `yield-history` contract drift | W4 | — |
| 10. Missing source-link curation | W2 | W6 |
| 11. Duplicated helpers | W5 | — |
| 12. Weak publication failure detail | W1 | W5 |

## Open Implementation Decisions

These should be resolved before Phase 1 implementation begins:

1. Should `yield-history` stay an array response or move to an object response?
2. Should degraded-row retention live entirely in `yield_data`, or should a staging table/current-pointer model be introduced?
3. Should broken deterministic adapters be removed immediately from production config, or left present but quarantined with explicit degraded state?
4. Should the unified adapter manifest replace existing maps in one migration, or coexist temporarily with generated derived registries?

Recommended defaults:

1. Keep `yield-history` as an array unless there is a strong product need for the object wrapper.
2. Start with safer write ordering and row-identity retention before introducing staging tables.
3. Quarantine broken deterministic adapters immediately rather than silently counting them.
4. Introduce the unified manifest first, and generate legacy maps from it during migration.

## Risks

- A manifest refactor can create temporary drift if it lands before the generation path is stable.
- Richer provenance can become noisy unless the UI stays selective.
- Degraded-row retention must be bounded so removed sources do not linger indefinitely.
- Source-aware history UX can accidentally confuse users if best-history and source-history are not clearly labeled.

## Recommended First Ticket Set

If execution starts immediately, the first implementation batch should be:

1. Reorder publish/prune/cache flow and add degraded retention guardrails.
2. Add real-registry tests for yield-bearing completeness and deterministic adapter validity.
3. Quarantine or replace `dusd-dtrinity` and `reusd-re-protocol`.
4. Add missing source-link mappings for allowlisted lending protocols.
5. Draft the unified adapter manifest shape and migration path.

That sequence closes the highest-risk production issues before larger structural refactors begin.
