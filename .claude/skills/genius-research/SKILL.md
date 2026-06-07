---
name: genius-research
description: Research and populate U.S. GENIUS Act compliance data (the `genius` field) for a tracked stablecoin. Use when adding or auditing GENIUS applicability, authorization status, issuer pathway, regulator fields, enforcement/foreign-exception posture, or reserve/redemption disclosure in `shared/data/stablecoins/coins/*.json`.
---

# GENIUS Compliance Research

Research a stablecoin's standing under the U.S. **GENIUS Act** (Guiding and Establishing National Innovation for U.S. Stablecoins Act) and write a sourced `genius` object into the coin's per-coin JSON entry when the evidence supports it.

**`docs/genius-tracker.md` is the source of truth** for the `genius` schema, applicability/status criteria, the Zod cross-field rules, sourcing requirements, and legal framing. Read it before classifying — do not re-derive criteria from memory. This skill encodes the workflow; the spec encodes the rules. `docs/compliance-page.md` covers the page contract.

## Input
A stablecoin name, symbol, or ID from `shared/data/stablecoins/coins/*.json`, or a batch of them.

## Process

### Step 1: Read current state
Read the coin's entry in `shared/data/stablecoins/coins/*.json` (use `coins.generated.json` for a canonical runtime view; treat the runtime re-export as import-only). Note:
- `jurisdiction`, `flags.pegCurrency`, `flags.backing`, `collateral`, `pegMechanism` — a starting hypothesis for applicability, not truth.
- Whether `genius` already exists (verify and refresh rather than blindly replace).
- Whether the asset is even a GENIUS-scope **payment stablecoin**. DeFi CDPs, yield/savings wrappers, governance units, and tokenized funds are usually out of scope — leave `genius` undefined unless the coin is prominent and likely **confused** with a payment stablecoin.

### Step 2: The `genius` schema
Required: `applicability`, `authorizationStatus`, `issuerPathway`, `reviewer`, `reviewedAt` (`YYYY-MM-DD`). Object is `.strict()` — no unknown keys. See `docs/genius-tracker.md` for the full field table and enum values. Key dimensions: applicability, authorization status, issuer pathway, `primaryFederalRegulator`/`stateRegulator`, `foreignExceptionStatus`, `enforcementStatus`, `daspOfferSaleStatus`, reserve/redemption disclosure flags, `references`, `negativeEvidenceReview`.

**Zod cross-field rules (Zod-enforced — `check:stablecoin-data` fails otherwise):**
1. `ppsi-approved` / `state-qualified` / `official-application-pending` → need a `federal-register`, `federal-regulator`, or `state-regulator` reference.
2. `issuer-announced-intent` → need an `issuer-disclosure` / `issuer-filing` / regulator reference.
3. `no-public-authorization-found` → need a `negativeEvidenceReview`.
4. `reserveDisclosurePresent: true` → need `reserveDisclosureUrl`.
5. `foreignExceptionStatus: "registered-exception"` → need `foreignExceptionEvidence` with a federal reference.
6. `enforcementStatus: warning-or-notice | prohibited-or-revoked` → need a regulator reference.

### Step 3: Research the sources
Use `WebSearch` / `WebFetch` (fall back to agent-browser on 403). In descending authority for authorization claims:
1. **Federal Register** notices/rules.
2. **Federal regulators** — OCC (bulletins), Federal Reserve, FDIC, NCUA, FinCEN, OFAC, Treasury.
3. **State regulators** — for state-qualified pathways.
4. **Issuer filings / disclosures** — GENIUS-pathway statements, transparency pages, redemption policies, attestation hubs.
5. **Auditor reports** — reserve attestations.
6. **News** — weakest; never sufficient alone for an official status.

Map token → legal issuer entity → public posture. Confirm the entity matches *this* token, not a same-name affiliate.

### Step 4: Assign the dimensions
**Defer to the criteria tables in `docs/genius-tracker.md`.** Set `applicability` first (is it even a payment stablecoin?), then `authorizationStatus`, `issuerPathway`, and the qualifying fields. Record what is publicly present for reserve/redemption disclosure. When uncertain between two statuses, pick the **more conservative** one and explain in `notes`.

While the regime is in rulemaking (`GENIUS_REGIME_STATE.rulemakingPhase` in `shared/lib/compliance-regime-state.ts`), genuine `ppsi-approved` / `state-qualified` rows should be **exceedingly rare** — most honest answers are `issuer-announced-intent` or `no-public-authorization-found`.

### Step 5: Guardrails
- **Never fabricate an approval.** No `ppsi-approved` / `state-qualified` / `official-application-pending` without a regulator-grade reference naming this token's issuer.
- **`no-public-authorization-found` is a dated negative conclusion, not laziness** — populate `negativeEvidenceReview.sourcesChecked` with the registers/pages actually checked.
- **Leave `genius` undefined** for unassessed coins and the DeFi/wrapper/fund long tail. Use an explicit excluded/`not-applicable` row sparingly, only for prominent confusable tokens.
- **Regime is not effective during rulemaking** — do not imply it is.
- Informational, sourced tracking surface, **not legal advice**.

### Step 6: Present findings
Per coin: existing `genius` (or none), sources used with access dates, confidence (High/Medium/Low), and the proposed `genius` JSON object. If research-only, stop here. Wait for approval before applying.

### Step 7: Apply & verify
After approval, Edit the coin's JSON. **Place `genius` immediately after `jurisdiction`** (before `mica` if both are present, matching existing files). Set `reviewer: "Pharos compliance research"` and `reviewedAt` to today. Then:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
node scripts/build-data/build-client-registry.mjs
npm run check:stablecoin-data
```

Fix any schema failures before reporting done.

## Batch / audit mode
Work coins one at a time; present findings for 3-5 per approval round, then apply and continue — mirror `mica-research` / `reserve-research`. For a **broad MiCA + GENIUS pass across many coins**, use the saved `compliance-research` workflow (landscape → research → adversarial verify → reconcile), which orchestrates this skill's logic at scale and emits a corrections manifest for deterministic apply.

## Quality standards
- Every asserted status traces to a source; official statuses trace to a regulator-grade reference naming the issuer entity.
- Enum values exactly match `shared/types/core.ts`; omit optional fields rather than guess.
- The conservative call wins ties; the reasoning lands in `notes`.
