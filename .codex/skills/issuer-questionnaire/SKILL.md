---
name: issuer-questionnaire
description: Draft a short, prioritized questionnaire for a stablecoin team collaborating on their Pharos listing. Use when an issuer reaches out (or the user asks for team/issuer questions) and Pharos needs their answers to resolve unknown data points or raise confidence on low-confidence facts in their entry.
---

Read `docs/editorial-style.md` before writing. Its universal rules and the named `technical-evidence` register govern all Pharos-owned prose; this skill adds only factual, sourcing, schema, and format requirements.

# Issuer Questionnaire

When a stablecoin team offers to collaborate, turn their entry's open data points into a small set of load-bearing questions. Use **4 to 6 by default** and keep the set focused. This skill drafts the outreach document only; it never edits coin data.

## Read First

- The coin's base entry `shared/data/stablecoins/coins/<id>.json` and every existing domain sidecar under `shared/data/stablecoins/domains/{reserves,mint-authority,compliance,risk-review}/<id>.json`.
- The live report card: `GET https://api.pharos.watch/api/report-cards/v9` with header `X-API-Key` (local key: `PHAROS_API_KEY` in the ignored root `.env.local`; never print the value). Filter `.cards[] | select(.id == "<id>")`.
- Read `shared/lib/methodology-versions/current-version.json` before interpreting report-card fields; the current Safety Score methodology and that source file win over remembered versions.
- Wrapper/risk-review fact vocabulary (`custodyEscrow`, `withdrawalTerms`, `leverage`, …): `shared/types/safety-score-v9-wrapper.ts`.

## Gap inventory

Mine, for the one asset:

1. `scoreTrace.evidenceResponsibility.facts`: the canonical open-data-point list: each fact's `reasonCode`, `responsibility` owner, `critical` flag, and `exactFactPath` (repeated reason codes are distinct component-level facts; keep them separate).
2. `pillars.*` (`evidenceLevel`, `reasons`), `caps[]` (especially `binding: true`), `bindingCap`, `weakestPillar`, `accessPosture.unknownFields`, `nrReasons`.
3. Sidecar review state: bounded or `not-published` verdicts, low-confidence notes, absent blocks (no reserve composition, unresolved `mintAuthority`, missing compliance data).
4. Translate reason codes into subject area and "what resolves this" with the `STREAMS` table in `scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs`. `bounded-mechanism-review` facts are not in any stream's `codes` list. For those, read the coin's entry in `shared/data/safety-score-v9/mechanism-review-overlays-v1.json` (large file; extract only this coin's object), which holds the decisive per-component rationales, quality verdicts, and unavailable-metric names.

## Ask vs. don't ask

- **Ask**: `issuer-undisclosed` facts; curated facts held at low confidence that a document, policy, or commitment could firm up; `measured-adverse` exposures only as mitigation/recovery-path questions (a measured dependency cannot be asked away).
- **Don't ask**: `producer-failed`, `integration-missing`, `method-unsupported`: Pharos-side work; note them for internal follow-up instead.
- **Don't ask** anything Pharos can establish itself from contracts, explorers, APIs, or public docs. Verify first; a self-answerable question costs credibility and a question slot.

## Prioritization

Rank the issuer-answerable gaps: `critical: true` facts → facts behind the binding cap, the weakest pillar, or an evidence ceiling (e.g. control-unverified 55) → high-weight facts on a pillar with weak/moderate `evidenceLevel` → confidence upgrades on already-bounded facts. Merge related gaps into one composite question instead of spending slots (e.g. one question covering both freeze-of-collateral and restricted-holder failure cases). Return the 4 to 6 most load-bearing questions unless the user explicitly asks for a different count or scope.

## Output contract

Write to `agents/questionnaires/<id>-<YYYY-MM-DD>.md` (ignored scratch; the file is forwarded to the team, not repo data):

1. **Header**: title naming the asset and team, date, asset symbol/ID, key identifiers (contract addresses, issuer entity).
2. **Context**: 2 to 3 sentences listing what Pharos already tracks and verifies for this asset (diligence and goodwill), then the scope statement: the questions are limited to facts Pharos cannot establish from the current contracts, APIs, or reviewed public documentation.
3. **Questions**: one section each; the heading is the direct question. Body: a short framing paragraph acknowledging verified adjacent facts ("Pharos already verifies X; the contracts do not establish Y"), then a bullet list of the specific items a complete answer covers, then `Maps to Safety Score fact:` naming the fact or reason code.
4. **Preferred answer format**: one shared template section (not per-question subsections) asking, for each question: an answer (`yes` / `no` / `not currently defined`); short explanation; source URL or contract address + function; effective date or observed block; the role that can change the answer; an API field or event Pharos can monitor, if available.
5. **Close**: a governing agreement, policy, or stable machine-readable field makes answers durable evidence; answers support a Pharos re-review but do not guarantee a score or classification change.

Questionnaire construction rule: keep the tone neutral and precise, never accusatory or leading. Every question must name the evidence that would settle it; `not currently defined` is a legitimate answer.

## After answers arrive

Route returned evidence to the owning research skill (`reserve-research`, `stablecoin-info-fetch`, `mica-research` / `genius-research`, `resilience-classify`); this skill never writes coin JSON.
