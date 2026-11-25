# Compliance Batch Mode

Use this mode for a bounded multi-coin review. It is read-only unless the caller already has explicit write authorization for the cohort or obtains it. Batch size does not expire that authorization. If delegation is unavailable, perform research and skeptical primary-source reopening sequentially and disclose that review was not independent.

## Select And Fan Out

- Require an ISO review date and enumerate base JSON filenames in `shared/data/stablecoins/coins`. Select the caller’s tracked roster; each ID appears once and carries its base path, optional compliance sidecar under `shared/data/stablecoins/domains/compliance`, symbol/name, status, peg, and regimes. Read the base and sidecar; do not accept IDs or paths from scratch output.
- Optional gap discovery may shortlist active coins missing a GENIUS or MiCA row; pre-launch coins join the roster only when primary register or filing evidence exists. Every active coin is in scope for both regimes, including DeFi CDPs, wrappers, vaults, funds, and commodity tokens; they receive explicit sourced exclusion rows when the evidence reaches high confidence and otherwise stay unassessed. Optional read-only landscape probes may supply current GENIUS rulemaking, MiCA-register, and EU-venue context, but never replace token-specific evidence.
- Split the coin set into N disjoint slices; run one read-only researcher per slice with the exact per-coin contract below, then run one independent read-only verifier per researched coin. A failed or empty slice does not authorize a write.

## Exact Per-Coin Researcher Contract

Prompt the researcher to read the base coin, the existing compliance sidecar, `shared/types/stablecoin-meta-compliance-schemas.ts`, `shared/lib/compliance-regime-state.ts`, `docs/genius-tracker.md`, and `docs/mica-tracker.md`. For every requested regime, it must:

1. Decide whether the regime applies; a sourced exclusion is an assessment (`assessed=true`). Use `assessed=false` when the evidence cannot support a row, not as a substitute for missing research.
2. Classify the result as `no-change`, `correct`, `add-new-row`, `remove-row`, or `unable-to-verify`; preserve good fields and explain uncertainty.
3. Follow the [GENIUS](../../../../docs/genius-tracker.md#sourcing--source-kinds) or [MiCA](../../../../docs/mica-tracker.md#data-sourcing--maintenance) primary-source order and, for MiCA, the [status criteria](../../../../docs/mica-tracker.md#status-criteria) and [boundary rules](../../../../docs/mica-tracker.md#boundary-rules); map token → legal issuer → exact public posture, and record consulted URLs with what each showed.
4. Return the `research` / `regimeProposal` envelopes in [batch-schema.md](batch-schema.md). Set `consequential=true` for a new/upgraded authorization claim, status escalation, removal, or downgrade of an existing strong claim. Supply full candidate JSON only for a correction or new row, otherwise `""`. A proposed GENIUS object includes reviewer `Pharos compliance research` and `reviewedAt` set to the review date; MiCA has no reviewer/date fields.

Use the response envelopes in [batch-schema.md](batch-schema.md); before any edit, parse candidate JSON with the regime schema in `shared/types/stablecoin-meta-compliance-schemas.ts`, then validate the proposed sidecar with `StablecoinComplianceSidecarSchema` and the merged coin with `StablecoinMetaAssetSchema` from `shared/lib/stablecoins/schema.ts`. The repository check validates files on disk after the approved write and regeneration; it does not accept scratch candidates.

## Adjudication Contract

The verifier independently reopens the base and sidecar, checks every proposed URL and highest-stakes authorization claim against primary sources, confirms the issuer is this token’s issuer, and checks current enums/cross-field rules. Default to rejection for unsupported upgrades. Return the `verify` / `regimeVerdict` envelopes in [batch-schema.md](batch-schema.md), with concrete issues.

Set `safeToAutoApply=true` only for a non-empty candidate editing an existing row, with no removal or downgrade, and no stronger authorization escalation unless that claim was already present and equally or better sourced. Limit it to reference refinement, descriptive fields, a more-conservative enum correction, or a date refresh. New rows need explicit approval covering their addition; prior cohort authorization that explicitly includes new rows satisfies this requirement. `unable-to-verify` makes no change and needs more research. Treat the flag as advisory, never as permission.

Return a deterministic manifest containing date, counts, safe changes, flagged changes, flags, gap proposals, regime-state notes, and per-coin verdict rows. The parent owns deduplication, approval, and merge; generation/check ownership follows the standalone versus coordinated-addition rule in [SKILL.md](../SKILL.md).
