---
name: compliance-research
description: Research and populate stablecoin GENIUS Act and EU MiCA compliance sidecars. Use when adding or auditing regulatory status, disclosures or regime state. Not for legal advice or reserve/custody metadata.
---

Read `docs/editorial-style.md` before writing; its `technical-evidence` register governs the prose.

# Compliance Research

## Trigger And Exclusions

Use for per-coin GENIUS and MiCA rows and for the central GENIUS regime state. Active coins are in scope for both regimes; pre-launch coins are in scope when primary register or filing evidence exists. Research-only requests stop at a proposal.

Not legal advice. Not for reserve, custody or report facts ([reserve-research](../reserve-research/SKILL.md)): `proofOfReserves.latestReport` in the base coin is the single report-date authority, so never restate its dates in a compliance row.

## Classify The Operation

Choose regime `genius`, `mica`, or `both`, then the operation: single-coin research or approved edit, bounded multi-coin batch, or regime-state transition. In `both` mode, research each regime independently; never infer one status from the other.

## Mandatory Core

- Read the coin's base entry and its sidecar under `shared/data/stablecoins/domains/compliance` if present. Compliance fields belong only in that sidecar; create it when absent, following `docs/process/stablecoin-research-sidecars.md` and `shared/lib/stablecoins/schema.ts`. `shared/types/stablecoin-meta-compliance-schemas.ts` owns the row schemas.
- `genius`: read `docs/genius-tracker.md` (including [source rules](../../../docs/genius-tracker.md#sourcing--source-kinds)) and `shared/lib/compliance-regime-state.ts`.
- `mica`: read `docs/mica-tracker.md`, including [status criteria](../../../docs/mica-tracker.md#status-criteria), [boundary rules](../../../docs/mica-tracker.md#boundary-rules) and [source rules](../../../docs/mica-tracker.md#data-sourcing--maintenance).
- Never claim authorization without primary regulator evidence naming the relevant entity and supporting the exact status. Prefer an omitted field or conservative status to a guess. Record conflicts and negative searches with their review date.
- "Not assessed" is absence of a row; it is not an out-of-scope finding.
- Statuses are informational and not a methodology score, with one exception: `genius.issuerEntity` seeds the Safety Score issuer key (`worker/src/lib/safety-score-v9/extension.ts`). Changing it is score-affecting.

## Branch Reads And Actions

- **Single coin:**
  1. Treat existing jurisdiction, license, peg and collateral as hypotheses. Decide whether the token is plausibly in scope before assigning a status.
  2. Search for candidates, then fetch primary regulator/register and issuer sources. Use browser inspection when a primary page blocks ordinary fetches or hides its list behind scripted or collapsed content, as venue restriction pages often do.
  3. Map token → legal issuer → exact authorization or public posture. Reject same-name affiliates and token-unspecific licenses. For MiCA, binding issuer EEA exclusion and the no-identifiable-issuer exemption take precedence over an EU venue restriction notice, and a wind-down announcement alone does not revoke `authorized` before the ESMA or national register records withdrawal.
  4. Apply the owning tracker's schema and conservative classification. Present the proposed object, source URLs/dates, access date and confidence; stop there for research-only requests.
  5. Before writes, establish approval for the proposed scope, then patch only the compliance sidecar. For GENIUS set the required reviewer and review date; for MiCA include references where its schema requires them. A verbatim external link title carries `quoted: true`.
- **Batch:** follow [batch mode](references/batch-mode.md) and its [response envelopes](references/batch-schema.md). Prior explicit cohort authorization persists across its batches; ask only for changes outside it. The parent reconciles evidence and owns every edit.
- **Regime state:** read [Regime state & effective date](../../../docs/genius-tracker.md#regime-state--effective-date). `GENIUS_REGIME_STATE` moves only by an explicitly reviewed update that records the qualifying issuance, source dates and statutory calculation; calendar time alone changes nothing, and per-coin statuses do not move with it.
- **Coordinated addition:** keep the primary-source and pre-edit schema validation duties, and return evidence, changed source paths, observed validation and unexercised integration checks in the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet); generation and checks follow its [Phase 7 pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate).

## Checks Owned By The Verifier

Standalone approved edits:

- `npm run bootstrap:generated`, `npm run check:stablecoin-data`, `npm run check:generated-artifacts`.
- `genius.issuerEntity` changed: the replay and movers gates owned by [safety-score-curation](../safety-score-curation/SKILL.md).
- Regime-state change: `npm run typecheck`, then confirm the compliance page after the Pages release the tracker requires.

## Completion Evidence

Report regime and operation, per-coin proposed versus applied objects, source URLs with dates and access date, confidence, negative searches, approval scope, changed paths, and observed versus unexercised checks.
