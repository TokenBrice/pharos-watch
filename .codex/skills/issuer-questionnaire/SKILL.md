---
name: issuer-questionnaire
description: Draft a short, prioritized questionnaire for a collaborating stablecoin team when public evidence cannot resolve important Pharos data or confidence gaps.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose. This skill drafts outreach only and never edits coin data.

# Issuer Questionnaire

Read the coin’s base file, all domain sidecars, current report card, `shared/lib/methodology-versions/current-version.json`, and `shared/types/safety-score-v9-wrapper.ts`. For keyed API access, check `PHAROS_API_KEY` in the ignored root `.env.local` without printing it.

## Select Questions

Inventory `scoreTrace.evidenceResponsibility.facts`, pillar evidence/reasons, binding caps, weakest pillar, unknown access fields, NR reasons, and sidecar review gaps. Use `scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs` to translate reason codes. For bounded-mechanism-review facts, inspect only this coin’s entry in `shared/data/safety-score-v9/mechanism-review-overlays-v1.json`.

Ask about issuer-undisclosed facts or low-confidence facts that a document, policy, contract, or monitoring field can resolve. Ask about measured adverse exposure only as mitigation/recovery. Do not ask the issuer to solve producer failures, missing integrations, unsupported methods, or anything Pharos can verify from public sources, APIs, contracts, or explorers.

Rank critical facts first, then binding-cap/weakest-pillar/evidence-ceiling facts, high-weight weak-evidence facts, and useful confidence upgrades. Merge related gaps. Default to 4–6 neutral, non-leading questions; each must name the evidence that would settle it and accept “not currently defined.”

## Deliverable

Write ignored scratch `agents/questionnaires/<id>-<YYYY-MM-DD>.md` with:

1. Asset/team/date and key identifiers.
2. Brief context on what Pharos already verifies and the public-evidence boundary.
3. One section per direct question: verified adjacent facts, requested items, and mapped exact fact/reason code.
4. One shared answer template: yes/no/not defined, explanation, URL or contract/function, effective date/block, change authority, and monitorable API/event.
5. A close explaining that evidence enables re-review but guarantees no score/classification change.

After answers arrive, route generic identity/contracts to `stablecoin-addition-orchestrator` or `stablecoin-identity-contracts`, reserves to `reserve-research`, compliance to `compliance-research`, and resilience overrides to `resilience-classify`.
