---
name: safety-score-curation
description: Curate, renew and equivalence-test active Safety Score evidence and inputs. Use for weekly sweeps, renewals, overlays, archetype reviews or score-affecting edits. Not for reserve slices or copy edits.
---

# Safety Score Curation

## Trigger And Exclusions

Use for active-model curation, evidence renewals and score-affecting refreshes. Stable `safety-score-v9` paths/commands do not identify the current methodology version; read `shared/lib/methodology-versions/current-version.json`. The advisory DDR branch below is the only other-model work housed here.

Not for reserve composition research ([reserve-research](../reserve-research/SKILL.md)), operational Worker review registries ([review-registry-renewal](../review-registry-renewal/SKILL.md)), mint-authority profiles ([mint-authority-research](../mint-authority-research/SKILL.md)), or copy-only edits.

## Classify The Operation

Select evidence curation, weekly expiry sweep, pre-boundary renewal, archetype classification, mechanism/shock/protocol producer refresh, DDR curation, equivalence testing, or methodology change before loading branch context. Never infer evidence from a schema gap.

## Mandatory Core

- `shared/data/safety-score-v9/AGENTS.md`; [Active model](../../../docs/report-cards.md#v10-model), [Canonical Publication](../../../docs/process/report-cards-appendix.md#canonical-publication), and [equivalence gate selection](../../../docs/process/safety-score-equivalence-harness.md#when-to-use-it).
- Inspect `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` for policy and `scripts/lib/automation-registry.mjs` for artifact ownership.
- Never invent, extrapolate, or date-bump evidence. Missing evidence stays bounded/open. Preserve fail-closed publication: global holds retain accepted ratings; asset-local defects may publish technical pipeline gaps only within `assessV9Publication`'s partial-publication allowance in `worker/src/lib/safety-score-v9/publication-assessment.ts`.
- Attribute code and curation separately; never silence unexplained replay drift or declare unexpected movers acceptable. Never hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`.

## Branch Reads And Actions

- **Curation/expiry:** read sweep [capture](../../../docs/process/safety-score-curation-expiry-sweep.md#1-capture-the-current-production-input) and [typed missing-data registry](../../../docs/process/safety-score-curation-expiry-sweep.md#4a-generate-and-drain-the-typed-missing-data-registry). Generate/drain `safety-score-v9:missing-data-registry` and `safety-score-v9:curation-worklist` with the linked capture/output arguments, claim-group decisions, current primary evidence, and named promote/reject/defer triggers. `safety-score-v9:expiry-queue` is preventive, not a complete missing-evidence inventory. Worklist rows name a recommended skill; reserve-composition rows go to [reserve-research](../reserve-research/SKILL.md). For the **weekly sweep**, also read [weekly close](../../../docs/process/safety-score-curation-expiry-sweep.md#6-close-the-weekly-sweep), run `safety-score-v9:live-withheld -- --replay <same-replay> --output <path>`, and drain DEP/RESV, pre-expiry and counterfactual lanes; the other queues omit live-to-fallback grade drops.
- **Renewal and ledger sentinels:** read [renew before the boundary](../../../docs/process/safety-score-curation-expiry-sweep.md#4b-renew-before-the-boundary-then-check-and-book-the-ledger-sentinels) and [renewals and curated families](references/renewals-and-families.md). A renewal re-verifies from current primary sources and writes its own `reviewedAt`; missing issuer evidence lapses fail-closed and is listed with its date or event trigger.
- **Archetype classification:** read [mechanism archetype](../../../docs/process/adding-a-stablecoin.md#hero-verdict-mechanism-archetype-and-attestor-tier-surfacing), [native-family admission](../../../docs/process/mechanism-overlay-evidence-standard.md#native-family-admission-and-grading) and [listing classes](../../../docs/listing-policy.md#listing-classes). Author `mechanismArchetype` with a resolved, sourced `mechanismArchetypeReview` in the base coin file. Resolving an unresolved review ends the `review-hold` listing class, so the same change needs an authored class in `shared/data/stablecoins/listing-decisions.json`.
- **Mechanism overlay:** read [evidence classes](../../../docs/process/mechanism-overlay-evidence-standard.md#evidence-classes) and [requirements](../../../docs/process/mechanism-overlay-evidence-standard.md#process-requirements). Use actual evidence pins, never capture dates. Date-only reviews enter after their UTC day elapses and temporarily re-attribute that day's admission gap `method-unsupported`; exact UTC timestamps enter at their instant (`isMechanismOverlayCurrent` in `worker/src/lib/safety-score-v9/extension-mechanism.ts`). Both retain original-start expiry; component-only reviews never renew siblings or an expired whole overlay.
- **Shock producer:** read [workflow](../../../docs/process/shock-coverage-refresh.md#what-the-workflow-does) and [load-bearing attestations](../../../docs/process/shock-coverage-refresh.md#replay-attestations-are-load-bearing); require evidence-backed overlays and shock attestations.
- **Protocol producer:** read [artifact contract](../../../docs/process/protocol-api-mechanism-refresh.md#artifact-contract). Keep protocol-API automation non-publishing; strict replay requires original-byte canonical V2 or the exact hash-verified normalized-only V1, never summary recognition or an unavailable body. Network-free replay requires local originals/cache; otherwise signed R2 reads and verified cache writes occur.
- **DDR:** for calibration read [commands](../../../docs/process/ddrr-calibration.md#commands) and [guardrails](../../../docs/process/ddrr-calibration.md#guardrails); results are advisory. Follow-up issues opened by `.github/workflows/ddr-curation-watch.yml` ask for sourced `windDownAnnouncedAt` and lifecycle curation in the base coin file, not a resolver change.
- **Pinned on-chain research:** use `npm run research:dwellir-rpc --` under [pinned-evidence rules](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence). Cite the keyless URL, block and timestamp provenance, never `latest`.
- **Replay/equivalence (any score-affecting change):** read harness [capture](../../../docs/process/safety-score-equivalence-harness.md#a-export-a-production-capture), [replay](../../../docs/process/safety-score-equivalence-harness.md#b-replay-a-capture-at-a-given-commit), [diff](../../../docs/process/safety-score-equivalence-harness.md#c-diff-a-baseline-replay-against-a-candidate-replay), and [post-deploy](../../../docs/process/safety-score-equivalence-harness.md#e-post-deploy-first-cycle-check). Pin the capture clock; preserve captured redemption by default. `--rederive-current-redemption` is only for expiry/current-curation scenarios, never accepted/embedded-registry captures or `--registry-ref`; registry mismatch is only for attributed code/curation comparison. A prepare-time base-only capture is not accepted-publication equivalence; export the [accepted publication](../../../docs/process/safety-score-equivalence-harness.md#accepted-publication-including-enrichment) for that claim. An ordinary replay scores the capture's embedded registry, so local curation edits show up only in the [full local-registry mover comparison](../../../docs/process/safety-score-equivalence-harness.md#full-local-registry-mover-comparison). Require two independent captures with different `sourceGeneration`: at least 90 minutes apart for that mover comparison, at least three hourly producer cycles apart for the [pre-activation sweep](../../../docs/process/safety-score-equivalence-harness.md#d-pre-activation-sweep). Require normalized score-output equality for neutral changes or prospective reviewed grade/status movers. Malformed/duplicate cards/manifests fail. Manually close absent declarations/census/same-grade findings; unexpected movers stop release. Independently verify activation identity and source-revision/registry/clock/accepted-enrichment reproduction: an empty normalized diff is not bit-identical identity proof.
- **Methodology:** follow [ADR-3](../../../docs/architecture.md#adr-3), numeric-decimal versions and all four update targets, not semver minor.

## Checks Owned By The Verifier

The assigned verifier runs applicable checks after writers finish; report unrun requirements rather than claiming proof.

- Score-affecting work: `npm run safety-score-v9:replay`, `npm run safety-score-v9:diff`, `npm run safety-score-v9:movers`, with branch-owned capture/output arguments.
- Curation/sweep: the missing-data/worklist commands above; preventive expiry and weekly live-withheld only when applicable.
- Evaluation inputs: `npm run generate:safety-score-v9-evaluation-build`, then `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`. That artifact hashes other generated inputs: after editing incident reviews, the emitter inventory or coin sidecars, run `npm run bootstrap:generated` first.
- Incident reviews or `shared/data/safety-score-v9/lane-screening-emitter-inventory-v1.json` changed: `npm run check:incident-review-keys`.
- Renewal: the sentinel check and `npm run safety-score-v9:expiry-queue` views in the [companion](references/renewals-and-families.md).
- Replay/overlays: `npx vitest run worker/scripts/__tests__/replay-safety-score-v9.test.ts worker/scripts/__tests__/diff-safety-score-v9-replays.test.ts shared/types/__tests__/safety-score-v9-overlays.test.ts`.
- After authorized deployment, complete the linked first-cycle gate; local replay does not establish production acceptance.

## Completion Evidence

Report work/assets, `sourceGeneration`, `baseInputGenerationId`, `clockSec`, evidence, replay/diff/movers, artifact ID, methodology targets when applicable, actual verifier results, post-deploy acceptance or pending evidence, issuer waits with their triggers, and risks.
