---
name: stablecoin-addition-orchestrator
description: Coordinate stablecoin additions, promotions and re-admissions from runtime gate via specialist routing to the Phase 7 pass. Use for new listings or promotions. Not for stubs or one-domain refreshes.
---

Read `docs/editorial-style.md` before writing and the current version from `shared/lib/methodology-versions/current-version.json` before using methodology terms.

# Stablecoin Addition Orchestrator

`docs/process/adding-a-stablecoin.md` is the workflow and completion contract; [Stablecoin Listing Policy](../../../docs/listing-policy.md) owns scope, listing classes and lifecycle. This skill sequences the gates and routes specialists; it does not restate the phases.

## Trigger And Exclusions

Use for an active listing, a researched pre-launch draft, a pre-launch promotion, a re-admission, or adding the parent of a tracked variant. Not for 72-hour stubs or milestone upkeep ([pre-launch-update](../pre-launch-update/SKILL.md)), a refresh of one domain on an existing coin (use that specialist directly), or quarantine, delisting and freezing (listing policy [Change Procedure](../../../docs/listing-policy.md#change-procedure)).

## Classify The Operation

| Operation | What changes |
| --- | --- |
| Active listing | Every gate below. |
| Pre-launch draft | Exempt from the runtime gate and the admission receipt; everything else applies. |
| Promotion | Every gate below; drop `launchPhase: "launched"` and its `listingStatusReview`. |
| Publicly issued, gate fails | Runtime gate FAIL, or own open questions the receipt cannot close: keep `status: "pre-launch"` with `launchPhase: "launched"` per [Launched, awaiting data](../../../docs/process/adding-a-stablecoin.md#launched-awaiting-data). Never force it active. |
| Re-admission | Meet [Re-Admission](../../../docs/listing-policy.md#re-admission) first, then unwind the retirement: `public/_redirects`, `shared/data/stablecoins/legacy-route-redirects.json`, `src/lib/removed-stablecoins.ts`, the retained `excluded` listing decision, and record the application in `docs/listing-policy.md`. |
| Parent of a tracked variant | Also re-author the child (`variantOf`, `variantKind`, sidecars, `stablecoin-variant` class), update the variant list in `shared/lib/__tests__/stablecoins.test.ts`, and attribute the child's Safety Score movement. |
| Existing-coin repair routed here by `recommendedSkill` in `scripts/lib/safety-score-v9-missing-data-work-types.ts` | No admission gates. Apply the work type's own instructions and likely repo areas under the owning schema or sidecar rules as a standalone approved edit, then its completion criteria. |

## Mandatory Core

1. Route the planned files. Settle lifecycle under [Phase 0](../../../docs/process/adding-a-stablecoin.md#phase-0---decide-what-you-are-adding) and scope under [Instrument Eligibility](../../../docs/listing-policy.md#instrument-eligibility).
2. Author the listing class before edits; it is a decision, never derived from `flags.navToken` or `mechanismArchetype`. Apply the fixed-par and not-a-fund tests and the guard's precedence in [Listing Classes](../../../docs/listing-policy.md#listing-classes). A fund share or NAV-priced claim is admissible only as a `tokenized-fund` under [Tokenized Fund Retention](../../../docs/listing-policy.md#tokenized-fund-retention): name the active non-fund asset that links it, or stop. An unresolved mechanism review means `review-hold`. Investor gating never decides class.
3. Before creating or promoting an active entry, run [stablecoin-runtime-price-marketcap-gate](../stablecoin-runtime-price-marketcap-gate/SKILL.md). Stop on FAIL for either price or supply. Keep its supply observation for the admission receipt.
4. Choose the canonical `ticker-issuer` ID, base file and canonical-order position. Confirm headroom under both caps in `shared/lib/safety-score-v9-capacity-limits.ts`.
5. Open one [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet) and give each specialist its scope and authorized paths. The packet is handoff data, not write authority; a research request alone never authorizes edits.
6. Before Phase 4 edits, pass the [Phase 3](../../../docs/process/adding-a-stablecoin.md#phase-3---classify-it-correctly) classification and the [Phase 3.5 editorial coverage gate](../../../docs/process/adding-a-stablecoin.md#phase-35---editorial-coverage-gate): every field in its table is filled or carries its accepted waiver.

## Branch Reads And Actions

Run specialists in this order; later ones read what earlier ones wrote.

1. Generic base metadata from structured APIs and primary issuer material: identity, collateral, peg mechanism, jurisdiction, links, `llamaId`, `geckoId`, `cmcSlug`, proof-of-reserves configuration, lifecycle fields. Existing values are hypotheses; never guess or replace stronger curated evidence.
2. [stablecoin-identity-contracts](../stablecoin-identity-contracts/SKILL.md) verifies proposed identity and deployments against primary and on-chain evidence before registry edits (`populate` and `discover` are skill modes, not CLI flags). Its `verify` CLI accepts only catalogued IDs, so it runs after the entry is authored. A deployment change must name the coupled Mint Authority and Bridge Risk owners; reject a contracts-only change that leaves them unresolved.
3. Sidecars per `docs/process/stablecoin-research-sidecars.md`: [reserve-research](../reserve-research/SKILL.md) for reserves, then the `collateralQuality` and `custodyModel` labels that read them; [mint-authority-research](../mint-authority-research/SKILL.md) for the Mint Authority profile and its required `headline` ([5f](../../../docs/process/adding-a-stablecoin.md#5f-mint-authority-review)); [compliance-research](../compliance-research/SKILL.md) for `genius`, `mica` or both. Risk-review fields follow that doc's ownership table.
4. Every other [Phase 5](../../../docs/process/adding-a-stablecoin.md#phase-5---evaluate-downstream-coverage-branches) branch is recorded as added, not applicable, or an intentional gap with its reason. Record the recent-launch annotation candidate that phase asks for unless `npm run candidates:annotations` already emits it from an ISO `launchDate`.
5. When the candidate's own open questions would exceed `NEW_ASSET_OPEN_QUESTION_LIMIT` (`scripts/ci/check-new-asset-evidence-packet.ts`), route overlays and gap classifications to [safety-score-curation](../safety-score-curation/SKILL.md) under [5i](../../../docs/process/adding-a-stablecoin.md#5i-safety-score-v9-scoreability). Use [issuer-questionnaire](../issuer-questionnaire/SKILL.md) only for issuer-only unknowns that remain after that.
6. Logo per [6a](../../../docs/process/adding-a-stablecoin.md#6a-logos), then [write-ai-summaries](../write-ai-summaries/SKILL.md) last: it reads the base file and every sidecar.

## Checks Owned By The Verifier

Specialists return changed sources and unexercised checks; they never regenerate shared artifacts. After every base, sidecar, overlay and downstream edit lands, own one [Phase 7](../../../docs/process/adding-a-stablecoin.md#phase-7---validate) pass, in this order:

1. `npm run logos:compact` when a raster logo changed (`npm run bootstrap:generated` does not run it).
2. `npm run bootstrap:generated`, then `npm run check:stablecoin-data`, the Phase 7 focused tests and `npm run check:generated-artifacts`.
3. For an active listing or promotion only, after the last coin, overlay or scorer edit: `npm run safety-score-v9:admit-receipt` and `npm run check:new-asset-evidence-packet` per [5j](../../../docs/process/adding-a-stablecoin.md#5j-safety-score-admission-receipt-new-asset-evidence-packet). A receipt emitted before step 2 is stale. Run `npm run test:v9-resource` when headroom under either cap is thin.
4. A later source edit invalidates steps 2–3; rerun them instead of reusing the result.

[Phase 8](../../../docs/process/adding-a-stablecoin.md#phase-8---push-merge-deploy-then-backfill) release and backfill and [Phase 9](../../../docs/process/adding-a-stablecoin.md#phase-9---post-deploy-verification) verification need separate release authorization.

## Completion Evidence

Finish the packet with: operation and lifecycle; listing class with the instrument-test rationale (and the linking asset for a `tokenized-fund`); admitted runtime path or exemption; changed base, sidecar, overlay and generated files; canonical order; identity, contracts and issuance ownership; each editorial and Phase 5 decision; receipt path and own versus inherited open questions; checks observed versus unexercised. List every post-deploy loop not yet observed with its re-check date: history backfill, first Safety Score capture, reserve, redemption, yield and mint/burn lane runs, and any `reviewBy` deadline. A successful deploy is not one of those observations.
