---
name: genius-research
description: Research and populate the `genius` (U.S. GENIUS Act compliance) field for a tracked stablecoin. Use when adding or auditing GENIUS status, pathway, or disclosures in its compliance sidecar.
---

# GENIUS Research

Research a stablecoin's standing under the U.S. GENIUS Act (Guiding and Establishing National Innovation for U.S. Stablecoins Act) and write a sourced `genius` object into its routed compliance source when the evidence supports it.

## Read First

- Read `docs/genius-tracker.md` — the **source of truth** for the `genius` schema, applicability/status criteria, Zod cross-field rules, sourcing, and legal framing. Defer to it for classification; this skill is the workflow only. `docs/compliance-page.md` covers the page contract.
- Read the coin's base entry plus `shared/data/stablecoins/domains/compliance/<id>.json` when present (or `coins.generated.json` for a merged runtime view; the re-export is import-only). `genius` edits must match `shared/lib/stablecoins/schema.ts`. **Routing:** compliance research always belongs in the compliance sidecar; create it when absent and keep `genius`/`mica` out of the base file (`docs/process/stablecoin-research-sidecars.md`).
- Treat `jurisdiction` / peg / collateral as a starting hypothesis for applicability, not truth.
- `shared/lib/compliance-regime-state.ts` is the source of truth for the current rulemaking phase and effective date — check it before assigning any official authorization status.

## Schema

`genius` (`.strict()`). Required: `applicability`, `authorizationStatus`, `issuerPathway`, `reviewer`, `reviewedAt` (`YYYY-MM-DD`). Optional dimensions: `applicabilityBasis`, `issuerEntity`/`issuerDomicile`/`licensingRegulator`, `primaryFederalRegulator`, `stateRegulator`, `foreignExceptionStatus`/`foreignExceptionEvidence`, `enforcementStatus`, `daspOfferSaleStatus`, `reserveDisclosurePresent`/`reserveDisclosureUrl`, `redemptionPolicyPresent`, `monthlyAttestationPresent`, `latestReportDate`, `notes`, `references`, `negativeEvidenceReview`. Enum values: see `docs/genius-tracker.md`. Unlike `mica.references` (`{ label, url }`), every `genius` reference is `{ label, url, sourceKind }` — `sourceKind` is **required** (enum in `docs/genius-tracker.md`) and the cross-field rules below key off it.

**Zod cross-field rules** (`check:stablecoin-data` fails otherwise): (1) `ppsi-approved`/`state-qualified`/`official-application-pending` need a federal/state regulator or Federal Register reference; (2) `issuer-announced-intent` needs an issuer/regulator/filing reference; (3) `no-public-authorization-found` needs a `negativeEvidenceReview`; (4) `reserveDisclosurePresent:true` needs `reserveDisclosureUrl`; (5) `registered-exception` needs `foreignExceptionEvidence` with a federal reference; (6) enforcement action statuses need a regulator reference.

## Workflow

1. Read current state; decide if the asset is a GENIUS-scope **payment stablecoin** at all (DeFi CDPs, yield/savings wrappers, governance units, tokenized funds are usually out of scope — leave `genius` undefined unless prominent and confusable).
2. Research with `WebSearch` / `WebFetch` (browser fallback on 403 — claude-in-chrome/Playwright in Claude Code, `agent-browser` in Codex), in descending authority: Federal Register → federal regulators (OCC/Fed/FDIC/NCUA/FinCEN/OFAC/Treasury) → state regulators → issuer filings/disclosures → auditor reports → news (never alone for an official status). This ordering is authority guidance, not the full `sourceKind` enum — `shared/types/core.ts` holds all values (statutes, foreign regulators, regulator directories included).
3. Map token → legal issuer entity → public posture; confirm it is *this* token's issuer, not a same-name affiliate.
4. Assign `applicability` first, then `authorizationStatus`, `issuerPathway`, qualifying fields, and the disclosure flags per `docs/genius-tracker.md`. Tie → more conservative status; explain in `notes`. During rulemaking, genuine `ppsi-approved`/`state-qualified` are exceedingly rare.
5. Present the proposed `genius` object with sources, access dates, confidence. If research-only, stop. After approval, edit or create the compliance sidecar, set `reviewer: "Pharos compliance research"` and today's `reviewedAt`, then regenerate and validate:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
npm run bootstrap:generated
npm run check:stablecoin-data
```

## Guardrails

- Never fabricate an approval; official statuses require a regulator-grade reference naming this token's issuer.
- `no-public-authorization-found` is a dated negative conclusion — populate `negativeEvidenceReview.sourcesChecked`.
- Leave `genius` undefined for the DeFi/wrapper/fund long tail; explicit exclusions are sparing and reserved for prominent confusable tokens.
- Regime is not effective during rulemaking; do not imply it is. Informational, sourced, not legal advice.

## Batch / audit mode

Process coins one at a time, 3-5 per approval round (mirror `mica-research`). For a broad MiCA + GENIUS pass across many coins, use the saved `compliance-research` workflow which orchestrates research → adversarial verify → reconcile at scale.
