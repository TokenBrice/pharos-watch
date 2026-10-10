---
name: safety-score-curation
description: Use when curating, refreshing, expiring, calibrating, or equivalence-testing evidence and publication inputs for the active Safety Score model. Not for unrelated scoring models or copy-only changes.
---

# Safety Score Curation

## Trigger And Exclusions

Use for active-model curation and score-affecting refreshes, not other scoring models or copy-only edits. Stable `safety-score-v9` paths/commands do not identify the current methodology version; read `shared/lib/methodology-versions/current-version.json`.

## Classify The Operation

Select evidence curation, weekly expiry sweep, mechanism/shock/protocol producer refresh, DDRR calibration, equivalence testing, or methodology change before loading branch context. Never infer evidence from a schema gap.

## Mandatory Core

- `shared/data/safety-score-v9/AGENTS.md`; [Active model](../../../docs/report-cards.md#v10-model), [Canonical Publication](../../../docs/process/report-cards-appendix.md#canonical-publication), and [equivalence gate selection](../../../docs/process/safety-score-equivalence-harness.md#when-to-use-it).
- Inspect `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` for policy and `scripts/lib/automation-registry.mjs` for artifact ownership.
- Never invent, extrapolate, or date-bump evidence. Missing evidence stays bounded/open. Preserve fail-closed publication: global holds retain accepted ratings; asset-local defects may publish technical pipeline gaps only within `assessV9Publication`'s partial-publication allowance in `worker/src/lib/safety-score-v9/publication-assessment.ts`.
- Attribute code and curation separately; never silence unexplained replay drift or declare unexpected movers acceptable. Never hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`.

## Branch Reads And Actions

- **Curation/expiry:** read sweep [capture](../../../docs/process/safety-score-curation-expiry-sweep.md#1-capture-the-current-production-input) and [typed missing-data registry](../../../docs/process/safety-score-curation-expiry-sweep.md#4a-generate-and-drain-the-typed-missing-data-registry). Generate/drain `safety-score-v9:missing-data-registry` and `safety-score-v9:curation-worklist` with the linked capture/output arguments, claim-group decisions, current primary evidence, and named promote/reject/defer triggers. `safety-score-v9:expiry-queue` is preventive, not a complete missing-evidence inventory. For the **weekly sweep**, also read [weekly close](../../../docs/process/safety-score-curation-expiry-sweep.md#6-close-the-weekly-sweep), run `safety-score-v9:live-withheld -- --replay <same-replay> --output <path>`, and drain DEP/RESV, pre-expiry and counterfactual lanes; the other queues omit live-to-fallback grade drops.
- **Mechanism overlay:** read [evidence classes](../../../docs/process/mechanism-overlay-evidence-standard.md#evidence-classes) and [requirements](../../../docs/process/mechanism-overlay-evidence-standard.md#process-requirements). Use evidence dates, never capture dates. Date-only reviews enter after their UTC day elapses (`isMechanismOverlayCurrent` in `worker/src/lib/safety-score-v9/extension-mechanism.ts`); same-day promotion needs a later-boundary capture and temporarily re-attributes the component `method-unsupported`.
- **Shock producer:** read [workflow](../../../docs/process/shock-coverage-refresh.md#what-the-workflow-does) and [load-bearing attestations](../../../docs/process/shock-coverage-refresh.md#replay-attestations-are-load-bearing); require evidence-backed overlays and shock attestations.
- **Protocol producer:** read [artifact contract](../../../docs/process/protocol-api-mechanism-refresh.md#artifact-contract). USDe/USDf reviewed weekly/manual automation is permanent non-publishing evidence tooling. Strict replay needs original-byte canonical V2 or exact hash-verified normalized-only V1; summary recognition/unavailable bodies are not success. Network-free replay requires local originals/cache; otherwise signed R2 reads and verified cache writes occur.
- **DDRR:** read [commands](../../../docs/process/ddrr-calibration.md#commands) and [guardrails](../../../docs/process/ddrr-calibration.md#guardrails); results are advisory.
- **Pinned on-chain research:** use `npm run research:dwellir-rpc --` under [pinned-evidence rules](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence). Cite the keyless URL, block and timestamp provenance, never `latest`.
- **Replay/equivalence (any score-affecting change):** read harness [capture](../../../docs/process/safety-score-equivalence-harness.md#a-export-a-production-capture), [replay](../../../docs/process/safety-score-equivalence-harness.md#b-replay-a-capture-at-a-given-commit), [diff](../../../docs/process/safety-score-equivalence-harness.md#c-diff-a-baseline-replay-against-a-candidate-replay), and [post-deploy](../../../docs/process/safety-score-equivalence-harness.md#e-post-deploy-first-cycle-check). Pin the capture clock; preserve captured redemption by default. `--rederive-current-redemption` is only for expiry/current-curation scenarios, never accepted/embedded-registry captures or `--registry-ref`; registry mismatch is only for attributed code/curation comparison. Require two independent captures at least 90 minutes apart, normalized score-output equality for neutral changes or prospective reviewed grade/status movers. Malformed/duplicate cards/manifests fail. Manually close absent declarations/census/same-grade findings; unexpected movers stop release. Independently verify activation identity and source-revision/registry/clock/accepted-enrichment reproduction: an empty normalized diff is not bit-identical identity proof.
- **Methodology:** follow [ADR-3](../../../docs/architecture.md#architectural-decision-records), numeric-decimal versions and all four update targets, not semver minor.

## Checks Owned By The Verifier

The assigned verifier runs applicable checks after writers finish; report unrun requirements rather than claiming proof.

- Score-affecting work: `npm run safety-score-v9:replay`, `npm run safety-score-v9:diff`, `npm run safety-score-v9:movers`, with branch-owned capture/output arguments.
- Curation/sweep: the missing-data/worklist commands above; preventive expiry and weekly live-withheld only when applicable.
- Evaluation inputs: `npm run generate:safety-score-v9-evaluation-build`, then `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`.
- Replay/overlays: `npx vitest run worker/scripts/__tests__/replay-safety-score-v9.test.ts worker/scripts/__tests__/diff-safety-score-v9-replays.test.ts shared/types/__tests__/safety-score-v9-overlays.test.ts`.
- After authorized deployment, complete the linked first-cycle gate; local replay does not establish production acceptance.

## Completion Evidence

Report work/assets, `sourceGeneration`, `baseInputGenerationId`, `clockSec`, evidence, replay/diff/movers, artifact ID, methodology targets when applicable, actual verifier results, post-deploy acceptance or pending evidence, and risks.
