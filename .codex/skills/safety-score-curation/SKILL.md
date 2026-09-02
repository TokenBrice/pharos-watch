---
name: safety-score-curation
description: Use when curating, refreshing, expiring, calibrating, or equivalence-testing Safety Score V9 evidence and publication inputs.
---

# Safety Score Curation

## Purpose

Route V9 curation and score-affecting refreshes through reviewed evidence, replay, and fail-closed publication gates.
Use owner documents for semantics; this skill coordinates queues, comparisons, artifacts, and handoff evidence.

## Read first

- `shared/data/safety-score-v9/AGENTS.md`
- [V9 Model](../../../docs/report-cards.md#v9-model) and [Canonical Publication](../../../docs/report-cards.md#canonical-publication)
- Expiry sweep: [capture](../../../docs/process/safety-score-curation-expiry-sweep.md#1-capture-the-current-production-input), [missing-data registry](../../../docs/process/safety-score-curation-expiry-sweep.md#4a-generate-and-drain-the-typed-missing-data-registry), and [weekly close](../../../docs/process/safety-score-curation-expiry-sweep.md#6-close-the-weekly-sweep)
- Equivalence harness: [when](../../../docs/process/safety-score-equivalence-harness.md#when-to-use-it), [capture](../../../docs/process/safety-score-equivalence-harness.md#a-export-a-production-capture), [replay](../../../docs/process/safety-score-equivalence-harness.md#b-replay-a-capture-at-a-given-commit), [diff](../../../docs/process/safety-score-equivalence-harness.md#c-diff-a-baseline-replay-against-a-candidate-replay), and [post-deploy](../../../docs/process/safety-score-equivalence-harness.md#e-post-deploy-first-cycle-check)
- [Mechanism evidence](../../../docs/process/mechanism-overlay-evidence-standard.md#evidence-classes) and [requirements](../../../docs/process/mechanism-overlay-evidence-standard.md#process-requirements); [DDRR commands](../../../docs/process/ddrr-calibration.md#commands) and [guardrails](../../../docs/process/ddrr-calibration.md#guardrails)
- [Shock workflow](../../../docs/process/shock-coverage-refresh.md#what-the-workflow-does), [attestations](../../../docs/process/shock-coverage-refresh.md#replay-attestations-are-load-bearing), and [protocol artifacts](../../../docs/process/protocol-api-mechanism-refresh.md#artifact-contract)
- [ADR-3](../../../docs/architecture.md#architectural-decision-records), `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, and `scripts/lib/automation-registry.mjs`

## Procedure

1. **Classify in `docs/report-cards.md` and the policy JSON.** Route curation, producer, DDRR, or methodology work; never infer missing evidence from a schema gap.
2. **Capture/replay with `npm run safety-score-v9:replay`.** Use the harness clock; allow registry mismatch only for an attributed curation/code comparison.
3. **Drain with `npm run safety-score-v9:expiry-queue` and `npm run safety-score-v9:evidence-gaps`.** Follow claim-group decisions, current primary evidence, and a named promote/reject/defer trigger.
4. **Refresh with `docs/process/mechanism-overlay-evidence-standard.md`, `docs/process/shock-coverage-refresh.md`, `docs/process/protocol-api-mechanism-refresh.md`, and `docs/process/ddrr-calibration.md`.** Require evidence-backed overlays and shock attestations; keep protocol artifacts producer-only; treat DDRR as advisory.
5. **Compare with `npm run safety-score-v9:diff` and `npm run safety-score-v9:movers`.** Use two captures for pre-activation; require empty neutral diffs or a reviewed mover manifest. Unexpected movers stop release.
6. **Regenerate with `npm run generate:safety-score-v9-evaluation-build`.** Run `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`; never edit the generated manifest, and complete the post-deploy check.

## Verification

- `npm run safety-score-v9:replay`
- `npm run safety-score-v9:diff`
- `npm run safety-score-v9:movers`
- `npm run safety-score-v9:expiry-queue`
- `npm run safety-score-v9:evidence-gaps`
- `npm run generate:safety-score-v9-evaluation-build`
- `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`
- `npx vitest run worker/scripts/__tests__/replay-safety-score-v9.test.ts worker/scripts/__tests__/diff-safety-score-v9-replays.test.ts shared/types/__tests__/safety-score-v9-overlays.test.ts`

## Do not

- Invent, extrapolate, or date-bump evidence to clear a queue; missing evidence remains bounded or open.
- Bypass fail-closed publication: missing, malformed, stale, or incompatible score input holds the last accepted ratings.
- Hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`; the registry-owned artifact must be regenerated and checked.
- Silence unexplained replay drift by declaring it expected; attribute curation and code separately.
- Version methodology as semver minor; ADR-3 requires numeric-decimal versioning and all four target updates.

## Handoff

Report work/assets, `sourceGeneration`, `baseInputGenerationId`, `clockSec`, evidence, replay/diff or movers, artifact id, methodology targets, risks.
