---
name: safety-score-curation
description: Use when curating, refreshing, expiring, calibrating, or equivalence-testing evidence and publication inputs for the active Safety Score model. Not for unrelated scoring models or copy-only changes.
---

# Safety Score Curation

## Purpose

Route active-model curation and score-affecting refreshes through reviewed evidence, replay, and fail-closed publication gates. The stable `safety-score-v9` paths and commands do not identify the current methodology version; read it from `shared/lib/methodology-versions/current-version.json`.
Use owner documents for semantics; this skill coordinates queues, comparisons, artifacts, and handoff evidence.

Use `npm run research:dwellir-rpc --` for supplemental pinned on-chain evidence reads; see `docs/process/agent-artifacts.md#pinned-on-chain-evidence`.
Cite its provenance record (keyless URL, block, timestamp); never cite `latest` reads as evidence.

## Read first

- `shared/data/safety-score-v9/AGENTS.md`
- [Active model](../../../docs/report-cards.md#v10-model) and [Canonical Publication](../../../docs/process/report-cards-appendix.md#canonical-publication)
- Expiry sweep: [capture](../../../docs/process/safety-score-curation-expiry-sweep.md#1-capture-the-current-production-input), [missing-data registry](../../../docs/process/safety-score-curation-expiry-sweep.md#4a-generate-and-drain-the-typed-missing-data-registry), and [weekly close](../../../docs/process/safety-score-curation-expiry-sweep.md#6-close-the-weekly-sweep)
- Equivalence harness: [when](../../../docs/process/safety-score-equivalence-harness.md#when-to-use-it), [capture](../../../docs/process/safety-score-equivalence-harness.md#a-export-a-production-capture), [replay](../../../docs/process/safety-score-equivalence-harness.md#b-replay-a-capture-at-a-given-commit), [diff](../../../docs/process/safety-score-equivalence-harness.md#c-diff-a-baseline-replay-against-a-candidate-replay), and [post-deploy](../../../docs/process/safety-score-equivalence-harness.md#e-post-deploy-first-cycle-check)
- [Mechanism evidence](../../../docs/process/mechanism-overlay-evidence-standard.md#evidence-classes) and [requirements](../../../docs/process/mechanism-overlay-evidence-standard.md#process-requirements); [DDRR commands](../../../docs/process/ddrr-calibration.md#commands) and [guardrails](../../../docs/process/ddrr-calibration.md#guardrails)
- [Shock workflow](../../../docs/process/shock-coverage-refresh.md#what-the-workflow-does), [attestations](../../../docs/process/shock-coverage-refresh.md#replay-attestations-are-load-bearing), and [protocol artifacts](../../../docs/process/protocol-api-mechanism-refresh.md#artifact-contract)
- [ADR-3](../../../docs/architecture.md#architectural-decision-records), `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, and `scripts/lib/automation-registry.mjs`

## Procedure

1. **Classify in `docs/report-cards.md` and the policy JSON.** Route curation, producer, DDRR, or methodology work; never infer missing evidence from a schema gap.
2. **Capture/replay with `npm run safety-score-v9:replay`.** Permanent offline tooling uses stable V9 namespaces for the active model. Use the capture clock and preserve captured redemption by default; request `--rederive-current-redemption` only for the expiry sweep/current-curation scenario. Never combine it with accepted/embedded-registry captures or `--registry-ref`; allow registry mismatch only for an attributed curation/code comparison.
3. **Generate and drain the typed missing-data registry and curation worklist.** Run `npm run safety-score-v9:missing-data-registry` and `npm run safety-score-v9:curation-worklist` with the capture/output arguments from the linked missing-data procedure. Use `npm run safety-score-v9:expiry-queue` separately for preventive time-window review; it is not the complete missing-evidence inventory. Follow claim-group decisions, current primary evidence, and a named promote/reject/defer trigger.
   For the weekly expiry sweep, also run `npm run safety-score-v9:live-withheld -- --replay <same-replay> --output <path>`; preventive expiry and missing-data rows do not cover live-to-fallback grade drops. Drain the `DEP`/`RESV`, pre-expiry, and counterfactual lanes under the linked weekly-close contract.
   Curate mechanism overlays with the evidence date, never the capture date: date-only reviews are admitted only after their UTC day has elapsed (`isMechanismOverlayCurrent` in `worker/src/lib/safety-score-v9/extension-mechanism.ts`), so a same-day promotion starts with a capture after that boundary and temporarily re-attributes the component `method-unsupported`.
4. **Refresh with `docs/process/mechanism-overlay-evidence-standard.md`, `docs/process/shock-coverage-refresh.md`, `docs/process/protocol-api-mechanism-refresh.md`, and `docs/process/ddrr-calibration.md`.** Require evidence-backed overlays and shock attestations; keep protocol artifacts producer-only; treat DDRR as advisory.
   USDe/USDf reviewed weekly/manual protocol automation is permanent non-publishing evidence tooling. Strict replay needs original-byte canonical V2 or the exact hash-verified normalized-only V1; summary recognition and unavailable bodies are not success. Network-free replay requires local originals/cache, otherwise signed R2 reads and verified cache writes occur.
5. **Compare with `npm run safety-score-v9:diff` and `npm run safety-score-v9:movers`.** Malformed/duplicate cards or manifests fail. Use two independent captures at least 90 minutes apart; require normalized score-output equality for neutral changes or prospective reviewed grade/status movers. Close absent declarations/census/same-grade findings manually; unexpected movers stop release. Independently verify intended activation identity and source-revision/registry/clock/accepted-enrichment reproduction; an empty normalized diff is not bit-identical identity proof.
6. **Regenerate with `npm run generate:safety-score-v9-evaluation-build`.** Run `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`; never edit the generated manifest, and complete the post-deploy check.

## Verification

- `npm run safety-score-v9:replay`
- `npm run safety-score-v9:diff`
- `npm run safety-score-v9:movers`
- `npm run safety-score-v9:expiry-queue`
- `npm run safety-score-v9:live-withheld` (weekly expiry sweep)
- `npm run safety-score-v9:missing-data-registry`
- `npm run safety-score-v9:curation-worklist`
- `npm run generate:safety-score-v9-evaluation-build`
- `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`
- `npx vitest run worker/scripts/__tests__/replay-safety-score-v9.test.ts worker/scripts/__tests__/diff-safety-score-v9-replays.test.ts shared/types/__tests__/safety-score-v9-overlays.test.ts`

## Do not

- Invent, extrapolate, or date-bump evidence to clear a queue; missing evidence remains bounded or open.
- Bypass fail-closed admission or publication gates: global hold reasons retain the last accepted ratings; asset-local defects can publish technical pipeline gaps within the partial-publication allowance (`assessV9Publication` in `worker/src/lib/safety-score-v9/publication-assessment.ts`).
- Hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`; the registry-owned artifact must be regenerated and checked.
- Silence unexplained replay drift by declaring it expected; attribute curation and code separately.
- Version methodology as semver minor; ADR-3 requires numeric-decimal versioning and all four target updates.

## Handoff

Report work/assets, `sourceGeneration`, `baseInputGenerationId`, `clockSec`, evidence, replay/diff or movers, artifact id, methodology targets, risks.
