---
name: compliance-research
description: Research and populate tracked stablecoin compliance sidecars for the U.S. GENIUS Act, EU MiCA, or both. Use when adding or auditing authorization, applicability, pathway, or disclosure evidence.
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs the prose.

# Compliance Research

Choose regime `genius`, `mica`, or `both`. Read the coin’s base entry and the matching sidecar under `shared/data/stablecoins/domains/compliance` if present. Compliance fields belong only in that sidecar; create it when absent, following `docs/process/stablecoin-research-sidecars.md` and `shared/lib/stablecoins/schema.ts`.

For `genius`, read `docs/genius-tracker.md`, `shared/lib/compliance-regime-state.ts`, and [genius.md](references/genius.md). For `mica`, read `docs/mica-tracker.md` and [mica.md](references/mica.md). In `both` mode, research each regime independently; do not infer one status from the other.

## Workflow

1. Treat existing jurisdiction, license, peg, and collateral as hypotheses. Decide whether the token is plausibly in scope before assigning a status.
2. Use web search to locate candidates, fetch primary regulator/register and issuer sources, and use browser inspection only when a primary page blocks ordinary fetches. See `docs/process/agent-artifacts.md#harness-configuration` for harness adapters.
3. Map token → legal issuer → exact authorization/public posture. Reject same-name affiliates and token-unspecific licenses.
4. Apply the owning tracker’s schema and conservative classification. “Not assessed” is absence of a row; it is not an out-of-scope finding.
5. Present the proposed object, source URLs/dates, access date, and confidence. Stop there for research-only requests. Before writes, establish approval for the proposed scope. Prior explicit cohort authorization persists across its 3–5 coin batches; ask only for changes outside that authorization.
6. Patch only the compliance sidecar. For GENIUS set the required reviewer/review date; for MiCA include references where its schema requires them. Then run:

```bash
npm run bootstrap:generated
npm run check:stablecoin-data
```

## Guardrails

- Never claim authorization without primary regulator evidence naming the relevant entity and supporting the exact status.
- Prefer an omitted field or conservative status to a guess. Record conflicts and negative searches with their review date.
- Compliance metadata is informational, sourced, and not legal advice. It is not a methodology score.
- Broad audits may use a spawned read-only reviewer when authorized; the parent reconciles evidence and owns every edit.

## Batch mode

Use this mode for a bounded multi-coin review. It is read-only unless the caller already has explicit write authorization for the cohort or obtains it. Batch size does not expire that authorization. If delegation is unavailable, perform research and skeptical primary-source reopening sequentially and disclose that review was not independent.

### Select and fan out

- Require an ISO review date and enumerate base JSON filenames in `shared/data/stablecoins/coins`. Select the caller’s tracked roster; each ID appears once and carries its base path, optional compliance sidecar under `shared/data/stablecoins/domains/compliance`, symbol/name, status, peg, and regimes. Read the base and sidecar; do not accept IDs or paths from scratch output.
- Optional gap discovery may shortlist active USD-pegged payment coins missing a GENIUS row, and active tracked coins with an EU signal missing a MiCA row. Exclude DeFi CDPs, wrappers, governance/algorithmic units, funds, and keyword-only false positives. Optional read-only landscape probes may supply current GENIUS rulemaking, MiCA-register, and EU-venue context, but never replace token-specific evidence.
- Split the coin set into N disjoint slices; run one read-only researcher per slice with the exact per-coin contract below, then run one independent read-only verifier per researched coin. A failed or empty slice does not authorize a write.

### Exact per-coin researcher contract

Prompt the researcher to read the base coin, the existing compliance sidecar, `shared/types/stablecoin-meta-schemas.ts`, `shared/lib/compliance-regime-state.ts`, `docs/genius-tracker.md`, and `docs/mica-tracker.md`. For every requested regime, it must:

1. Decide whether the regime applies; use `assessed=false` for a genuine out-of-scope/unassessable coin, not for missing research.
2. Classify the result as `no-change`, `correct`, `add-new-row`, `remove-row`, or `unable-to-verify`; preserve good fields and explain uncertainty.
3. Use the regime’s primary-source order in [genius.md](references/genius.md) and [mica.md](references/mica.md), map token → legal issuer → exact public posture, and record consulted URLs with what each showed.
4. Return `id`, `mica`, `genius`, and optional `notes`. Each regime object returns `assessed`, `changeKind`, `consequential`, `confidence`, `summary`, and `proposedJson`; set `consequential=true` for a new/upgraded authorization claim, status escalation, removal, or downgrade of an existing strong claim. `proposedJson` is compact JSON for the full candidate object only for a correction or new row, otherwise `""`. A proposed GENIUS object includes reviewer `Pharos compliance research` and `reviewedAt` set to the review date; MiCA has no reviewer/date fields.

Use the response envelopes in [batch-schema.md](references/batch-schema.md); the caller parses candidate JSON, merges it, and runs the real schema check before any edit.

### Adjudication contract

The verifier independently reopens the base and sidecar, checks every proposed URL and highest-stakes authorization claim against primary sources, confirms the issuer is this token’s issuer, and checks current enums/cross-field rules. Default to rejection for unsupported upgrades. For each regime return one of `confirm-no-change`, `apply-correction`, `flag-for-approval`, `reject-proposal`, `unable-to-verify`, or `not-applicable`, plus `safeToAutoApply`, `isNewRow`, `finalJson`, `changeSummary`, and concrete `issues`.

Set `safeToAutoApply=true` only for a non-empty candidate editing an existing row, with no removal or downgrade, and no stronger authorization escalation unless that claim was already present and equally or better sourced. Limit it to reference refinement, descriptive fields, a more-conservative enum correction, or a date refresh. New rows need explicit approval covering their addition; prior cohort authorization that explicitly includes new rows satisfies this requirement. `unable-to-verify` makes no change and needs more research. Treat the flag as advisory, never as permission.

Return a deterministic manifest containing date, counts, safe changes, flagged changes, flags, gap proposals, regime-state notes, and per-coin verdict rows. The parent owns deduplication, approval, merge, and `npm run check:stablecoin-data`.
