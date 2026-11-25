---
name: issuer-questionnaire
description: Draft a prioritized questionnaire for a collaborating stablecoin team. Use when public evidence cannot resolve key Pharos data or confidence gaps. Not for public-source research or coin-data edits.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose. This skill drafts outreach only: it never edits coin data, never contacts the issuer, and does not replace research Pharos can do from public sources.

# Issuer Questionnaire

Read the coin’s base file, all domain sidecars, `shared/lib/methodology-versions/current-version.json`, and this coin’s entries in every curation file under `shared/data/safety-score-v9/` that names it: the gap classifications show which gaps are already recorded as issuer-undisclosed and which are simply unresearched. Read `shared/types/safety-score-v9-wrapper.ts` only for a wrapper or variant.

Then read the score state that exists for the asset:

- Published active coin: its card from `GET https://api.pharos.watch/api/report-cards/v9` ([Safety Score API](../../../docs/report-cards.md#api)), sending `PHAROS_API_KEY` from the ignored root `.env.local` as `X-API-Key` without printing it. The envelope’s `openEvidence` block already partitions questions into `open`, `issuer` and `documentation`.
- Unshipped coin blocked at admission: there is no card. Read `questions[]` in its receipt under `.github/artifacts/new-asset-evidence-packet/`; when none is committed, get the prospective receipt from the addition owner ([5j](../../../docs/process/adding-a-stablecoin.md#5j-safety-score-admission-receipt-new-asset-evidence-packet)) instead of writing one here.
- `tokenized-fund` rows publish no letter grade ([Listing Classes](../../../docs/listing-policy.md#listing-classes)). Rank their questions by the fund panel’s gaps (holdings, NAV source, redemption terms, investor eligibility) and by what dependent stablecoins inherit, not by caps or the weakest pillar.

## Select Questions

Inventory `scoreTrace.evidenceResponsibility.facts`, pillar evidence/reasons, binding caps, weakest pillar, unknown access fields, NR reasons, and sidecar review gaps. Decode public fact paths with `resolveEvidenceFactPath` in `shared/types/safety-score-v9-public-evidence-facts.ts`. For reason routing, take the typed gap-queue entry from `npm run safety-score-v9:missing-data-registry` or a replay, and pass its structured `path` with `reasonCode` to `descriptorForReason` in `scripts/lib/safety-score-v9-missing-data-work-types.ts`; public path strings are not that argument, and `missing-pillar-evidence` cannot be routed by code alone. The Markdown curation worklist is a replay-derived summary, not the reason-routing authority.

Ask about issuer-undisclosed facts or low-confidence facts that a document, policy, contract, or monitoring field can resolve. Ask about measured adverse exposure only as mitigation/recovery. Do not ask the issuer to solve producer failures, missing integrations, unsupported methods, or anything Pharos can verify from public sources, APIs, contracts, or explorers.

Rank critical facts first, then binding-cap/weakest-pillar/evidence-ceiling facts, high-weight weak-evidence facts, and useful confidence upgrades. Merge related gaps. Default to 4–6 neutral, non-leading questions; each must name the evidence that would settle it and accept “not currently defined.”

## Deliverable

Write ignored scratch `agents/questionnaires/<id>-<YYYY-MM-DD>.md` with:

1. Asset/team/date and key identifiers.
2. Brief context on what Pharos already verifies and the public-evidence boundary.
3. One section per direct question: verified adjacent facts, requested items, and mapped exact fact/reason code.
4. One shared answer template: yes/no/not defined, explanation, URL or contract/function, effective date/block, change authority, and monitorable API/event.
5. A close explaining that evidence enables re-review but guarantees no score/classification change.

Before delivering, confirm every question maps to a current fact or reason code and that none asks for something a public source, contract or explorer already answers. Report the file path, the score state read (card, receipt or neither, with its clock), the questions dropped as publicly answerable, and whether the questionnaire is drafted, sent by the owner, or awaiting a reply.

## When Answers Arrive

An issuer reply is a claim, not evidence. Re-verify every verifiable statement independently, with a pinned on-chain read or the live public primary page, before any owner records it as fact. A statement that cannot be verified is recorded only as an attributed issuer statement and usually leaves the gap issuer-undisclosed.

Route each answer to its owner; none of them is edited here:

- Identity and contracts: [stablecoin-identity-contracts](../stablecoin-identity-contracts/SKILL.md); a full addition or promotion: [stablecoin-addition-orchestrator](../stablecoin-addition-orchestrator/SKILL.md).
- Reserves, custody and the `collateralQuality` / `custodyModel` labels: [reserve-research](../reserve-research/SKILL.md). Compliance: [compliance-research](../compliance-research/SKILL.md).
- Mint Authority: [mint-authority-research](../mint-authority-research/SKILL.md). Oracle, bridge-route and blacklistability reviews: the risk-review sidecar under [Domain Ownership](../../../docs/process/stablecoin-research-sidecars.md#domain-ownership). Redemption routes: `docs/redemption-backstops.md`.
- Safety Score overlays, gap classifications, incident reviews and the replay they require: [safety-score-curation](../safety-score-curation/SKILL.md).
