# Redemption Backstop Remediation Plan

Date: 2026-03-25
Source audit: `agents/audits/2026-03-25-redemption-backstop-audit.md`

## Objectives

1. Make live redemption-backstop data stricter and more truthful.
2. Make the codepath easier to reason about, validate, and evolve.

## Remediation Workstreams

### 1. Live reserve trust boundary

Problem:
- Redemption capacity previously accepted reserve-sync metadata using `fetchedAt` freshness alone and did not distinguish degraded sync states, weak fee-only adapters, or heterogeneous telemetry strength.

Remediation:
- Add explicit adapter redemption-telemetry capabilities:
  - `capacity = direct | proxy | none`
  - `fee = current-bps | none`
- Restrict reserve-sync capacity to fresh `ok` snapshots from adapters that explicitly expose immediate-capacity telemetry.
- Distinguish live direct capacity from live proxy capacity in the public confidence model.

Implemented in this pass:
- Adapter capability metadata in `shared/lib/live-reserve-adapters.ts`
- Redemption live-metadata eligibility in `worker/src/lib/redemption-backstop-live-metadata.ts`
- Direct vs proxy capacity confidence in `shared/lib/redemption-backstop-confidence.ts`
- Runtime gating + conservative fallback notes in `worker/src/lib/redemption-backstop-sources.ts`

### 2. Config/runtime compatibility guardrails

Problem:
- `pusd-plume` was configured as a dynamic reserve-sync route even though its adapter only emitted fee telemetry.
- Registry checks did not reject this class of mismatch.

Remediation:
- Remove fake dynamic-capacity configurations.
- Fail checks/tests when a `reserve-sync-metadata` route points at an adapter with no immediate-capacity telemetry.

Implemented in this pass:
- `pusd-plume` moved to reviewed documented-bound issuer semantics in `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- Registry checks strengthened in `scripts/check-redemption-backstops.ts`
- Consistency coverage added in `shared/lib/__tests__/redemption-backstop-consistency.test.ts`

### 3. Confidence honesty and user-facing explainability

Problem:
- All live reserve-sync routes collapsed into a single `dynamic` bucket.
- Proxy liquidity buckets could resolve `high` confidence as easily as direct redemption telemetry.
- Detail UI did not clearly separate fallback source provenance from route review timing.

Remediation:
- Split capacity fidelity into `live-direct`, `live-proxy`, `documented-bound`, `heuristic`, with legacy `dynamic` retained only for backward compatibility.
- Only `live-direct` + non-undisclosed fees can resolve `high` confidence.
- Show fallback provenance and route-review date together.
- Clarify whether capacity is direct live redemption telemetry, proxy telemetry, documented bound, or heuristic.

Implemented in this pass:
- Type/API/model updates in `shared/types/redemption.ts`
- Confidence rollup updates in `shared/lib/redemption-backstop-confidence.ts`
- Detail-card copy and provenance rendering in `src/components/stablecoin-detail/redemption-backstop-card.tsx`

### 4. Sync performance and history richness

Problem:
- Hourly redemption sync did repeated per-coin D1 reads for reserve metadata.
- History rows did not preserve enough detail for later audits or regression analysis.

Remediation:
- Batch-load reserve metadata once per redemption sync.
- Persist richer snapshot details into `details_json` without requiring a schema migration.

Implemented in this pass:
- Batch reserve metadata preload in `worker/src/lib/live-reserves-store.ts`
- Single-pass reuse in `worker/src/cron/sync-redemption-backstops.ts`
- Richer serialized details in `worker/src/lib/redemption-backstops-store.ts`

### 5. Documentation and methodology alignment

Problem:
- Public docs did not describe the stricter reserve-sync eligibility rules, direct-vs-proxy live confidence split, or reviewed-vs-fallback source semantics precisely enough.

Remediation:
- Update methodology versioning, redemption docs, API reference, and worker documentation to match the new behavior.

Implemented in this pass:
- `shared/lib/redemption-backstop-version.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`
- `src/app/methodology/sections/core-sections.tsx`

## Remaining Backlog

These items require additional evidence review or broader refactoring and should be planned as follow-up tranches rather than improvised in the same patch set.

### A. Freshness-evidence upgrades for reserve-sync routes

Routes still limited by missing source-grade freshness evidence:
- `usdo-openeden`
- `iusd-infinifi`
- `wsrusd-reservoir`

Recommended next step:
- Review each upstream payload and either:
  - expose a trustworthy source timestamp / verifiable freshness signal in the adapter, or
  - intentionally keep the route on reviewed documented-bound / fallback semantics rather than reintroducing weak live-capacity trust.

### B. Unreviewed route backlog

Still missing explicit route review:
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

Recommended next step:
- Route-review these coins, add explicit `docs[]`, and only then promote any remaining low-confidence heuristics.

### C. Heuristic-capacity cleanup backlog

Still heuristic and worth targeted review:
- `zarp-zarp`
- `cetes-etherfuse`
- `cgo-comtech`
- `dgld-gold-token-sa`
- `dusd-alto`
- `ussd-sonic-labs`
- `usdp-parallel`
- `uty-xsy`
- `dusd-dtrinity`
- `yousd-yield-optimizer`
- `yusd-aegis`
- `usn-noon`

Recommended next step:
- For each route, decide whether the honest long-term state is:
  - reviewed documented-bound,
  - reserve-sync direct/proxy,
  - or intentionally low-confidence heuristic.

### D. Config-surface simplification

Problem:
- The route config family files, especially `offchain-issuer.ts`, still contain too much repetitive object-literal boilerplate.

Recommended next step:
- Introduce small factory helpers for repeated reviewed issuer patterns and reviewed reserve-sync route patterns.
- Keep refactors mechanical and snapshot-tested; do not mix them with evidence-review changes.

## Acceptance Criteria For Follow-up Tranches

- No reserve-sync route can resolve live capacity from a fee-only adapter.
- No degraded reserve snapshot can influence redemption capacity or fee scoring.
- Proxy live telemetry never resolves `high` model confidence.
- Route review date and linked-source provenance remain visibly distinct on the detail page.
- Every reviewed route eventually has explicit `docs[]`.
- Freshness semantics for direct live-capacity routes are evidence-backed, not inferred from cron fetch time alone.
