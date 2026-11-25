---
name: mint-authority-research
description: Research and author Mint Authority profiles and coupled Bridge Risk controls from primary sources and pinned reads. Use for additions, promotions, or re-reviews. Not for blacklist or oracle reviews.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose.

# Mint Authority Research

## Trigger And Exclusions

Use to review who can create durable native supply of a tracked asset and to author the result: a new or promoted asset's profile, a re-review after a control, proxy, Safe, cap or governance change, a missing-profile or open-question queue row, or the bridge route and control inventory that a multi-deployment profile depends on.

Not for:

- `blacklistabilityReview` and `oracleRisk` in the same risk-review sidecar: different evidence. Follow the [editing rules](../../../docs/stablecoin-data.md#editing-rules) and, in an addition, [stablecoin-addition-orchestrator](../stablecoin-addition-orchestrator/SKILL.md).
- Deployment discovery or `contracts[]` edits: [stablecoin-identity-contracts](../stablecoin-identity-contracts/SKILL.md).
- Incident reviews, gap classifications, replay and manifest work: [safety-score-curation](../safety-score-curation/SKILL.md).
- Scoring, posture derivation or display changes: methodology work under [Mint authority entry](../../../docs/mint-authority-scoring.md#mint-authority-entry).

## Classify The Operation

- **New profile:** no `mintAuthority` sidecar exists.
- **Re-review:** amend a profile after a control change, finding or expired scoped question.
- **Bridge coupling:** the asset has more than one deployment, so native-versus-bridge ownership must be reviewed with it.
- **Intentional gap:** evidence cannot support a profile; record the gap, never a guess.

## Mandatory Core

- Read [5f. Mint Authority review](../../../docs/process/adding-a-stablecoin.md#5f-mint-authority-review), [Mint Authority and Bridge Risk ownership](../../../docs/stablecoin-data.md#mint-authority-and-bridge-risk-ownership), [Mint Authority Review](../../../docs/stablecoin-data.md#mint-authority-review), and [Current V9 scope](../../../docs/mint-authority-scoring.md#current-v9-scope) with the posture or process sections it applies. `shared/types/stablecoin-meta-control-schemas.ts` owns the shape; the source file wins.
- Write only `mintAuthority` in `shared/data/stablecoins/domains/mint-authority/<id>.json` and, for bridge coupling, `bridgeRouteRisk` in `shared/data/stablecoins/domains/risk-review/<id>.json`. Never author these fields in the base coin file ([domain ownership](../../../docs/process/stablecoin-research-sidecars.md#domain-ownership)).
- Evidence is primary sources plus pinned reads under [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence): the exact native mint path, every role holder, proxy, implementation and admin, caps and who can raise them, Safe threshold, owners, modules and guards, timelock delay and exercise clock, key custody, incidents. The audits check breadth and ownership; they discover no facts.
- Unknown is not reviewed absence, and a failed read proves neither. Record what stays unknown as a scoped question on the exact control.
- Route by capability: native issuance belongs to Mint Authority, representations and transfer machinery to Bridge Risk. Never author the same capability in both, invent a native route, or copy a parent's or sibling's qualification.
- Never target a grade, add relief the evidence does not show, or refresh a review date without re-reading the evidence.
- Authority: research, write and commit on the task branch without a check-in. Stop and report instead of committing when primary sources or reads conflict on who controls issuance, a control cannot be read at a pin, the review surfaces a live compromise or unremediated incident, or an owning check fails.

## Branch Reads And Actions

- **New profile:** author the full profile with a `headline` within the budget the 5f rubric states. In a coordinated addition, return the issuance-ownership rows of the [handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet); the orchestrator owns generation.
- **Re-review:** amend only what the new evidence changes and keep prior observations that still hold. For an active asset the edit is score-affecting: run the replay and equivalence branch of [safety-score-curation](../safety-score-curation/SKILL.md). Re-curating `authorityPosture` can also move a published depeg verdict; name each posture change in the report.
- **Bridge coupling:** complete the route inventory and structured controls the ownership contract requires before referencing them from the profile. `npm run candidates:l2beat-bridge-routes` yields leads, never evidence.
- **Intentional gap:** leave the profile absent or the question open, and state the unanswered control, path or member in the report.
- **Standalone edit:** the author owns the single generation and check pass in [Phase 7](../../../docs/process/adding-a-stablecoin.md#phase-7---validate) after all coupled edits land.

## Checks Owned By The Verifier

- `npm run bootstrap:generated`, then `npm run check:stablecoin-data` and `npm run check:generated-artifacts`.
- `npm run audit:mint-authority-review` and `npm run audit:mint-bridge-ownership` ([Curation Audits](../../../docs/scripts.md#curation-audits)); neither gates a merge nor replaces pinned evidence.
- Score-affecting edits: the replay, diff and movers checks owned by safety-score-curation.
- `git diff --check`.

## Completion Evidence

Report per asset: operation class, sidecar paths changed, mint path and each control with its source and pin (chain, block, hash, time), ownership split between native and bridge, scoped questions and intentional gaps, posture before and after, audit and check results run versus not run, and expected score movement or the replay result. Publishing goes through [pharos-release-runner](../pharos-release-runner/SKILL.md) when asked.
